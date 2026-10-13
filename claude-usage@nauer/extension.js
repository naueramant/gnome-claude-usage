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
    CRIT_COLOR, formatResetTime, levelColor, normalizeLimits, palette, pickLimit, setClockFormat,
} from './lib/format.js';
import {UsageMenu} from './lib/menu.js';
import {PLANS, detectPlan} from './lib/pricing.js';
import {UsageRing} from './lib/ring.js';

const WINDOW_DAYS = 30;
// Re-fetch when the menu opens and the data is older than this.
const STALE_ON_OPEN_MS = 60_000;
// The profile (plan, renewal date) rarely changes.
const PROFILE_TTL_MS = 6 * 3600_000;

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

        this._buildPanel();
        this._menuContent = new UsageMenu({
            refresh: () => this.refresh(),
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
            if (open && Date.now() - this._state.updatedAt > STALE_ON_OPEN_MS)
                this.refresh();
        });

        this._settingsIds = [
            'limit-to-show', 'display-mode', 'accent-color', 'currency', 'exchange-rate',
            'heatmap-metric', 'plan', 'custom-price',
        ].map(k => this._settings.connect(`changed::${k}`, () => this._render()));
        this._settingsIds.push(
            this._settings.connect('changed::refresh-interval', () => this._schedule()),
            this._settings.connect('changed::use-claude-credentials', () => this.refresh()),
            this._settings.connect('changed::claude-config-dir', () => this.refresh()));
        this._interfaceId = this._interface.connect('changed::clock-format', () => {
            setClockFormat(this._interface.get_string('clock-format'));
            this._render();
        });

        this._render();
        this._schedule();
        this.refresh();
    }

    _buildPanel() {
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box claude-usage-panel'});
        this._ring = new UsageRing();
        this._label = new St.Label({style_class: 'claude-usage-label', y_align: Clutter.ActorAlign.CENTER});
        this._sep = new St.Label({text: '·', style_class: 'claude-usage-sep', y_align: Clutter.ActorAlign.CENTER});
        this._label2 = new St.Label({style_class: 'claude-usage-label', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._ring);
        box.add_child(this._label);
        box.add_child(this._sep);
        box.add_child(this._label2);
        this.add_child(box);
    }

    _opts() {
        return {
            accent: this._settings.get_string('accent-color') || '#d97757',
            currency: this._settings.get_string('currency'),
            rate: this._settings.get_double('exchange-rate'),
            metric: this._settings.get_string('heatmap-metric'),
            interval: this._settings.get_uint('refresh-interval'),
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
        this._renderPanel(opts);
        this._menuContent.update(this._state, opts);
    }

    _renderPanel(opts) {
        const s = this._state;
        const mode = this._settings.get_string('display-mode');
        const light = palette(opts.accent).light;
        const limit = pickLimit(s.limits, this._settings.get_string('limit-to-show'));
        const noData = !limit || ['signed-out', 'disabled', 'expired'].includes(s.status);

        this._sep.visible = false;
        this._label2.visible = false;
        this._label.visible = mode !== 'ring';
        this._ring.visible = mode !== 'percent';
        this.remove_style_class_name('claude-usage-dim');

        if (noData) {
            this._ring.setState(0, '#ffffff', 'dashed');
            this._label.text = '–';
            this._label.set_style(null);
            this.add_style_class_name('claude-usage-dim');
            return;
        }

        if (limit.pct >= 100) {
            this._ring.setState(1, CRIT_COLOR, 'full');
            const when = formatResetTime(limit.resetsAt);
            this._label.text = when ? `Resets ${when}` : 'Limit reached';
            this._label.set_style(`color: ${CRIT_COLOR};`);
            this._label.visible = true;
            return;
        }

        const color = levelColor(limit.pct, light);
        this._ring.setState(limit.pct / 100, color);
        this._label.text = `${limit.pct}%`;
        this._label.set_style(limit.pct >= 75 ? `color: ${color};` : null);

        if (mode === 'session-weekly') {
            const session = s.limits.find(l => l.kind === 'session');
            const weekly = s.limits.find(l => l.kind === 'weekly_all');
            if (session && weekly) {
                this._ring.setState(session.pct / 100, levelColor(session.pct, light));
                this._label.text = `${session.pct}%`;
                this._label.set_style(session.pct >= 75 ? `color: ${levelColor(session.pct, light)};` : null);
                this._label2.text = `${weekly.pct}%`;
                this._label2.set_style(weekly.pct >= 75 ? `color: ${levelColor(weekly.pct, light)};` : null);
                this._sep.visible = true;
                this._label2.visible = true;
            }
        }
    }

    _schedule() {
        if (this._timer)
            GLib.source_remove(this._timer);
        const minutes = Math.max(1, this._settings.get_uint('refresh-interval'));
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this._render();
    }

    async refresh() {
        if (this._state.busy)
            return;
        this._state.busy = true;
        this._render();
        try {
            const dirs = configDirs(this._settings.get_string('claude-config-dir'));
            await Promise.all([this._refreshLimits(dirs), this._refreshScan(dirs)]);
            this._state.updatedAt = Date.now();
        } catch (e) {
            if (isCancelled(e))
                return;
            logError(e, 'claude-usage: refresh failed');
        } finally {
            this._state.busy = false;
        }
        if (this._client)
            this._render();
    }

    async _refreshLimits(dirs) {
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
            Object.assign(s, {status: 'ok', limits: normalizeLimits(usage), limitsAt: Date.now(), error: ''});
            this._notify(s.limits);
        } catch (e) {
            if (isCancelled(e))
                throw e;
            if (e instanceof HttpError && e.status === 401) {
                Object.assign(s, {status: 'expired', limits: [], error: ''});
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
        this._timer = 0;
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
