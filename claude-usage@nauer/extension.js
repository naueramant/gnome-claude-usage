// Claude Usage — GNOME Shell extension entry point.
//
// A top-bar indicator showing how much of your Claude plan's session/weekly
// limits you've used, with a drop-down comparing what your Claude Code usage
// would have cost at API list prices.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ClaudeClient, HttpError, configDirs} from './lib/api.js';
import {
    CRIT_COLOR, formatInterval, formatResetTime, levelColor, normalizeLimits, palette, pickLimits, setClockFormat,
} from './lib/format.js';
import {averageUtilization, recordWeek} from './lib/house.js';
import {UsageMenu} from './lib/menu.js';
import {PLANS, detectPlan} from './lib/pricing.js';
import {UsageRing} from './lib/ring.js';

const WINDOW_DAYS = 30;
// Re-fetch when the menu opens and the data is older than this.
const STALE_ON_OPEN_MS = 60_000;
// The profile (plan, renewal date) rarely changes.
const PROFILE_TTL_MS = 6 * 3600_000;
// Floor for the refresh interval, and the least time between two automatic
// usage fetches from any trigger (timer, menu open, wake, network change).
// /api/oauth/usage is undocumented and rate-limits hard: reportedly a handful
// of requests per access token per window, shared with Claude Code's own
// statusline. Community tools settled on caching it for 3-10 minutes.
const MIN_INTERVAL_S = 120;
// Fetch this long after a limit's reset time, so the server has caught up.
const RESET_GRACE_S = 5;
// Returned by a refresh task that didn't fetch, so "Updated" stays truthful.
const SKIPPED = Symbol('skipped');
const UNIT_SECONDS = {seconds: 1, minutes: 60, hours: 3600};
// Backoff after HTTP 429 when the server sends no Retry-After: doubles per
// consecutive 429, from the first value up to the cap.
// A 429 has been seen to persist for 30+ minutes, so start slow.
const RATE_LIMIT_BACKOFF_S = 5 * 60;
const RATE_LIMIT_BACKOFF_MAX_S = 30 * 60;

function isNetworkError(e) {
    return e instanceof GLib.Error && (
        e.matches(Gio.ResolverError, Gio.ResolverError.NOT_FOUND) ||
        e.matches(Gio.ResolverError, Gio.ResolverError.TEMPORARY_FAILURE) ||
        e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NETWORK_UNREACHABLE) ||
        e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.HOST_UNREACHABLE) ||
        e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CONNECTION_REFUSED) ||
        e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT));
}

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/** Next occurrence of the subscription's day-of-month, from its start date. */
function nextRenewal(iso) {
    const start = iso ? GLib.DateTime.new_from_iso8601(iso, null)?.to_local() : null;
    if (!start)
        return null;
    const now = GLib.DateTime.new_now_local();
    const day = start.get_day_of_month();
    for (let add = 0; add < 3; add++) {
        const first = GLib.DateTime.new_local(now.get_year(), now.get_month(), 1, 0, 0, 0).add_months(add);
        const daysInMonth = first.add_months(1).add_days(-1).get_day_of_month();
        const candidate = first.add_days(Math.min(day, daysInMonth) - 1);
        if (candidate.compare(now) > 0)
            return candidate;
    }
    return null;
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Claude usage');
        this._ext = extension;
        this._settings = extension.getSettings();
        this._client = new ClaudeClient(extension.path);
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        setClockFormat(this._interface.get_string('clock-format'));

        this._state = {
            status: 'loading', // ok | loading | signed-out | disabled | expired | offline | error
            error: '',
            limits: [],
            limitsAt: 0,
            plan: null,
            scan: null,
            scanError: '',
            updatedAt: 0,
            busy: false,
        };
        this._profile = null;
        this._profileAt = 0;
        this._notified = {};
        this._prevLimits = {};
        this._running = new Set();
        this._timer = 0;
        this._resetTimer = 0;

        this._buildPanel();
        this._menuContent = new UsageMenu({
            refresh: () => this.refresh({force: true}),
            preferences: () => {
                this.menu.close();
                this._ext.openPreferences();
            },
            connect: () => this._settings.set_boolean('use-claude-credentials', true),
            openUri: uri => {
                this.menu.close();
                Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
            },
        });
        this.menu.actor.add_style_class_name('claude-usage-popup');
        this.menu.box.add_child(this._menuContent);

        this.menu.connect('open-state-changed', (_m, open) => {
            this._menuContent.setOpen(open);
            if (open && Date.now() - this._state.updatedAt > STALE_ON_OPEN_MS)
                this.refresh();
        });

        this._settingsIds = [
            'limit-to-show', 'display-mode', 'accent-color', 'currency', 'exchange-rate',
            'heatmap-metric', 'plan', 'custom-price', 'sections', 'hidden-sections',
            'house-animate', 'weekly-history',
        ].map(k => this._settings.connect(`changed::${k}`, () => this._render()));
        this._settingsIds.push(
            this._settings.connect('changed::refresh-interval', () => this._schedule()),
            this._settings.connect('changed::refresh-unit', () => this._schedule()),
            this._settings.connect('changed::use-claude-credentials', () => this.refresh()),
            this._settings.connect('changed::claude-config-dir', () => this.refresh()));
        this._interfaceId = this._interface.connect('changed::clock-format', () => {
            setClockFormat(this._interface.get_string('clock-format'));
            this._render();
        });

        // The interval timer doesn't run while suspended, so catch up on
        // resume, and again once the network is back.
        this._sleepId = Gio.DBus.system.signal_subscribe('org.freedesktop.login1',
            'org.freedesktop.login1.Manager', 'PrepareForSleep', '/org/freedesktop/login1',
            null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                const [sleeping] = params.deepUnpack();
                if (!sleeping) {
                    this._schedule();
                    this.refresh();
                }
            });
        this._network = Gio.NetworkMonitor.get_default();
        this._networkId = this._network.connect('network-changed', (_m, available) => {
            if (available && ['offline', 'error'].includes(this._state.status))
                this.refresh();
        });

        this._render();
        this._schedule();
        this.refresh();
    }

    _intervalSeconds() {
        const unit = UNIT_SECONDS[this._settings.get_string('refresh-unit')] ?? 60;
        return Math.max(MIN_INTERVAL_S, this._settings.get_uint('refresh-interval') * unit);
    }

    _buildPanel() {
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box claude-usage-panel'});
        // One ring + label per limit shown; the second is used for 'both'.
        this._slots = [0, 1].map(() => ({
            ring: new UsageRing(),
            label: new St.Label({style_class: 'claude-usage-label', y_align: Clutter.ActorAlign.CENTER}),
        }));
        this._sep = new St.Label({text: '·', style_class: 'claude-usage-sep', y_align: Clutter.ActorAlign.CENTER});
        const [first, second] = this._slots;
        box.add_child(first.ring);
        box.add_child(first.label);
        box.add_child(this._sep);
        box.add_child(second.ring);
        box.add_child(second.label);
        this.add_child(box);
    }

    _opts() {
        return {
            accent: this._settings.get_string('accent-color') || '#d97757',
            currency: this._settings.get_string('currency'),
            rate: this._settings.get_double('exchange-rate'),
            metric: this._settings.get_string('heatmap-metric'),
            interval: formatInterval(this._intervalSeconds()),
            sections: this._settings.get_strv('sections'),
            hiddenSections: this._settings.get_strv('hidden-sections'),
            houseAnimate: this._settings.get_boolean('house-animate'),
        };
    }

    _resolvePlan() {
        const setting = this._settings.get_string('plan');
        const detected = detectPlan(this._profile, this._creds);
        const key = setting === 'auto' ? detected : setting;
        if (detected && this._settings.get_string('detected-plan') !== detected)
            this._settings.set_string('detected-plan', detected);
        if (!key)
            return null;

        const custom = this._settings.get_double('custom-price');
        const base = PLANS[key] ?? PLANS.custom;
        return {
            key,
            name: base.name,
            price: custom > 0 ? custom : base.price,
            renews: nextRenewal(this._profile?.organization?.subscription_created_at),
        };
    }

    _render() {
        const opts = this._opts();
        this._state.plan = this._resolvePlan();
        this._state.house = averageUtilization(this._weeklyHistory());
        this._renderPanel(opts);
        this._menuContent.update(this._state, opts);
    }

    _renderPanel(opts) {
        const s = this._state;
        const mode = this._settings.get_string('display-mode');
        const light = palette(opts.accent).light;
        const limits = ['signed-out', 'disabled', 'expired'].includes(s.status)
            ? [] : pickLimits(s.limits, this._settings.get_string('limit-to-show'));

        this.remove_style_class_name('claude-usage-dim');
        this._sep.visible = limits.length > 1;
        this._slots.forEach((slot, i) => {
            const shown = i === 0 || i < limits.length;
            slot.ring.visible = shown && mode !== 'percent';
            slot.label.visible = shown && mode !== 'ring';
            if (i < limits.length)
                this._renderSlot(slot, limits[i], light);
        });

        if (limits.length === 0) {
            const {ring, label} = this._slots[0];
            ring.setState(0, '#ffffff', 'dashed');
            label.text = '–';
            label.set_style(null);
            this.add_style_class_name('claude-usage-dim');
        }
    }

    _renderSlot({ring, label}, limit, light) {
        if (limit.pct >= 100) {
            ring.setState(1, CRIT_COLOR, 'full');
            const when = formatResetTime(limit.resetsAt);
            label.text = when ? `Resets ${when}` : 'Limit reached';
            label.set_style(`color: ${CRIT_COLOR};`);
            label.visible = true;
            return;
        }
        const color = levelColor(limit.pct, light);
        ring.setState(limit.pct / 100, color);
        label.text = `${limit.pct}%`;
        label.set_style(limit.pct >= 75 ? `color: ${color};` : null);
    }

    _schedule() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._intervalSeconds(), () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this._render();
    }

    /** Refetch at the earliest upcoming reset, so the top bar doesn't lag it. */
    _scheduleResetRefresh() {
        if (this._resetTimer)
            GLib.source_remove(this._resetTimer);
        this._resetTimer = 0;
        const now = Date.now() / 1000;
        const next = Math.min(...this._state.limits
            .map(l => GLib.DateTime.new_from_iso8601(l.resetsAt ?? '', null)?.to_unix() ?? Infinity)
            .filter(t => t > now));
        if (!Number.isFinite(next))
            return;
        this._resetTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            Math.ceil(next - now) + RESET_GRACE_S, () => {
                this._resetTimer = 0;
                this.refresh({force: true});
                return GLib.SOURCE_REMOVE;
            });
    }

    /**
     * Limits and the transcript scan refresh independently, so a slow scan
     * never holds back the top bar.
     *
     * @param {object} [opts]
     * @param {boolean} [opts.force] fetch limits even within MIN_INTERVAL_S of
     *   the last fetch (manual refresh, a limit just reset); a 429 backoff
     *   still applies
     */
    refresh({force = false} = {}) {
        const dirs = configDirs(this._settings.get_string('claude-config-dir'));
        return Promise.all([
            this._run('limits', () => this._refreshLimits(dirs, force)),
            this._run('scan', () => this._refreshScan(dirs)),
        ]);
    }

    async _run(task, fn) {
        if (this._running.has(task))
            return;
        this._running.add(task);
        this._state.busy = true;
        this._render();
        try {
            if (await fn() !== SKIPPED && task === 'limits')
                this._state.updatedAt = Date.now();
        } catch (e) {
            if (isCancelled(e))
                return;
            logError(e, `claude-usage: ${task} refresh failed`);
        } finally {
            this._running.delete(task);
            this._state.busy = this._running.size > 0;
        }
        if (this._client)
            this._render();
    }

    async _refreshLimits(dirs, force) {
        const s = this._state;
        if (!this._settings.get_boolean('use-claude-credentials')) {
            Object.assign(s, {status: 'disabled', limits: [], error: ''});
            this._creds = null;
            return;
        }

        this._creds = await this._client.readCredentials(dirs);
        if (!this._creds) {
            Object.assign(s, {status: 'signed-out', limits: [], error: ''});
            return;
        }
        const token = this._creds.accessToken;
        if (this._creds.expiresAt && this._creds.expiresAt < Date.now()) {
            // Claude Code refreshes the token itself; we don't touch its
            // refresh token so we never invalidate its login.
            Object.assign(s, {status: 'expired', limits: [], error: ''});
            return;
        }

        // Rate limited, or fetched moments ago: keep showing the last limits.
        if (Date.now() < (this._backoffUntil ?? 0) ||
            (!force && Date.now() - (this._fetchedAt ?? 0) < MIN_INTERVAL_S * 1000))
            return SKIPPED;
        this._fetchedAt = Date.now();

        try {
            if (!this._profile || Date.now() - this._profileAt > PROFILE_TTL_MS) {
                this._profile = await this._client.fetchProfile(token).catch(e => {
                    if (isCancelled(e))
                        throw e;
                    return this._profile;
                });
                this._profileAt = Date.now();
            }
            const usage = await this._client.fetchUsage(token);
            this._backoffS = 0;
            Object.assign(s, {status: 'ok', limits: normalizeLimits(usage), limitsAt: Date.now(), error: ''});
            this._notify(s.limits);
            this._recordWeek(s.limits);
            this._scheduleResetRefresh();
        } catch (e) {
            if (isCancelled(e))
                throw e;
            if (e instanceof HttpError && e.status === 401) {
                Object.assign(s, {status: 'expired', limits: [], error: ''});
            } else if (e instanceof HttpError && e.status === 429) {
                this._backoffS = Math.min(RATE_LIMIT_BACKOFF_MAX_S,
                    this._backoffS ? this._backoffS * 2 : RATE_LIMIT_BACKOFF_S);
                const wait = e.retryAfter || this._backoffS;
                this._backoffUntil = Date.now() + wait * 1000;
                s.status = 'error';
                s.error = `rate limited, retrying in ${formatInterval(wait)}`;
            } else if (isNetworkError(e)) {
                s.status = 'offline';
            } else {
                s.status = 'error';
                s.error = e instanceof HttpError ? `HTTP ${e.status}` : e.message;
                console.warn(`claude-usage: ${e.message}`);
            }
        }
    }

    async _refreshScan(dirs) {
        try {
            this._state.scan = await this._client.scanTranscripts(dirs, WINDOW_DAYS);
            this._state.scanError = '';
        } catch (e) {
            if (isCancelled(e))
                throw e;
            this._state.scanError = e.message;
            console.warn(`claude-usage: ${e.message}`);
        }
    }

    _weeklyHistory() {
        return this._settings.get_value('weekly-history').deepUnpack().map(([t, p]) => [Number(t), p]);
    }

    _recordWeek(limits) {
        const next = recordWeek(this._weeklyHistory(), limits);
        if (next)
            this._settings.set_value('weekly-history', new GLib.Variant('a(xu)', next));
    }

    _notify(limits) {
        const warnAt = this._settings.get_uint('warn-threshold');
        const warn = this._settings.get_boolean('notify-warning');
        const reset = this._settings.get_boolean('notify-reset');

        for (const l of limits) {
            const prev = this._prevLimits[l.kind];
            if (warn && l.pct >= warnAt && this._notified[l.kind] !== l.resetsAt) {
                this._notified[l.kind] = l.resetsAt;
                // Don't nag on the very first fetch after login/enable.
                if (prev) {
                    const body = l.pct >= 100
                        ? `Limit reached. Resets ${formatResetTime(l.resetsAt)}.`
                        : `${l.pct}% used. Resets ${formatResetTime(l.resetsAt)}.`;
                    this._sendNotification(`${l.label}: ${l.pct}%`, body);
                }
            }
            if (reset && prev && prev.pct >= warnAt && l.pct < prev.pct && prev.resetsAt !== l.resetsAt)
                this._sendNotification(`${l.label} has reset`, `You're at ${l.pct}% again.`);
            this._prevLimits[l.kind] = l;
        }
    }

    _sendNotification(title, body) {
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Claude usage', iconName: 'dialog-information-symbolic'});
            this._source.connect('destroy', () => (this._source = null));
            Main.messageTray.add(this._source);
        }
        const n = new MessageTray.Notification({source: this._source, title, body});
        this._source.addNotification(n);
    }

    destroy() {
        if (this._timer)
            GLib.source_remove(this._timer);
        if (this._resetTimer)
            GLib.source_remove(this._resetTimer);
        this._timer = this._resetTimer = 0;
        Gio.DBus.system.signal_unsubscribe(this._sleepId);
        this._network.disconnect(this._networkId);
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._interface.disconnect(this._interfaceId);
        this._source?.destroy();
        this._client.destroy();
        this._client = null;
        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // 'Session and weekly' moved from the display style to what to show.
        if (this._settings.get_string('display-mode') === 'session-weekly') {
            this._settings.set_string('limit-to-show', 'both');
            this._settings.set_string('display-mode', 'ring-percent');
        }
        this._addIndicator();
        this._positionId = this._settings.connect('changed::position', () => {
            this._indicator?.destroy();
            this._addIndicator();
        });
    }

    _addIndicator() {
        this._indicator = new Indicator(this);
        const position = this._settings.get_string('position');
        const index = position === 'right' ? 0 : -1;
        Main.panel.addToStatusArea(this.uuid, this._indicator, index, position);
    }

    disable() {
        this._settings.disconnect(this._positionId);
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
