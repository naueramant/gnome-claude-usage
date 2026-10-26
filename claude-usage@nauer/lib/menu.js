// Content of the drop-down: plan header, then the sections (limits, value
// comparison, activity heatmaps, token house) in the user's order, and a
// footer. Built once, then updated in place from a state object.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {
    NEUTRAL_COLOR, WEEKDAYS, formatClock, formatDay, formatMoney, formatResetLine,
    formatTokens, levelColor, palette, rampLevel,
} from './format.js';
import {FRAME_MS, HouseScene, LEVELS, levelFor} from './house.js';

const USAGE_URL = 'https://claude.ai/settings/usage';

function vbox(styleClass, props = {}) {
    return new St.BoxLayout({style_class: styleClass, orientation: Clutter.Orientation.VERTICAL, ...props});
}

function hbox(styleClass, props = {}) {
    return new St.BoxLayout({style_class: styleClass, ...props});
}

function label(text, styleClass, props = {}) {
    return new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props});
}

function iconButton(iconName, accessibleName, onClick) {
    const b = new St.Button({
        style_class: 'cu-icon-button',
        accessible_name: accessibleName,
        can_focus: true,
        child: new St.Icon({icon_name: iconName, style_class: 'cu-icon'}),
    });
    b.connect('clicked', onClick);
    return b;
}

// GridLayout spacing isn't styleable, so it's set in (scaled) pixels here.
function gridBox(styleClass, rowSpacing, columnSpacing, props = {}) {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    return new St.Widget({
        style_class: styleClass,
        layout_manager: new Clutter.GridLayout({
            row_spacing: rowSpacing * scale,
            column_spacing: columnSpacing * scale,
            ...props,
        }),
    });
}

function stat(caption) {
    const box = vbox('cu-stat');
    box.add_child(label(caption, 'cu-caption'));
    const value = label('–', 'cu-stat-value');
    box.add_child(value);
    return {box, value};
}

/**
 * A horizontal bar split into weighted coloured segments. Used both for the
 * limit progress bars (one segment out of 100) and the model split.
 */
const SegmentBar = GObject.registerClass(
class SegmentBar extends St.Widget {
    _init(styleClass, gap = 0) {
        super._init({style_class: styleClass, x_expand: true});
        this._gap = gap;
        this._weights = [];
        this._total = 1;
    }

    setSegments(segments, total = null) {
        this.destroy_all_children();
        this._weights = segments.map(s => Math.max(0, s.weight));
        this._total = total ?? Math.max(1e-9, this._weights.reduce((a, b) => a + b, 0));
        for (const s of segments) {
            this.add_child(new St.Widget({
                style_class: 'cu-segment',
                style: `background-color: ${s.color};`,
            }));
        }
        this.queue_relayout();
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const children = this.get_children();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const visible = this._weights.filter(w => w > 0).length;
        const gap = this._gap * scale;
        const avail = Math.max(0, content.get_width() - gap * Math.max(0, visible - 1));
        let x = content.x1;
        children.forEach((child, i) => {
            const w = Math.min(content.x2 - x, Math.round(avail * this._weights[i] / this._total));
            child.allocate(Clutter.ActorBox.new(x, content.y1, x + Math.max(0, w), content.y2));
            if (w > 0)
                x += w + gap;
        });
    }
});

export const UsageMenu = GObject.registerClass(
class UsageMenu extends St.BoxLayout {
    /**
     * @param {object} callbacks {refresh, preferences, connect, openUri}
     */
    _init(callbacks) {
        super._init({style_class: 'cu-menu', orientation: Clutter.Orientation.VERTICAL});
        this._cb = callbacks;
        this._view = 'days';
        this._selDay = null;
        this._selHour = null;
        this._state = null;
        this._opts = null;
        this._open = false;
        this._frame = 0;
        this._frameTimer = 0;

        this._buildHeader();
        this._body = vbox('cu-sections');
        this.add_child(this._body);
        this._sections = {
            limits: this._buildLimits(),
            value: this._buildValue(),
            activity: this._buildActivity(),
            house: this._buildHouse(),
        };
        this._buildFooter();

        this.connect('destroy', () => this._stopAnimation());
    }

    /** Called when the popup opens or closes; the house only animates while visible. */
    setOpen(open) {
        this._open = open;
        this._syncAnimation();
    }

    _applySections(order, hidden) {
        const ids = [...order.filter(id => this._sections[id]),
            ...Object.keys(this._sections).filter(id => !order.includes(id))];
        ids.forEach((id, i) => {
            const actor = this._sections[id];
            if (actor.get_parent() !== this._body)
                this._body.add_child(actor);
            this._body.set_child_at_index(actor, i);
            actor.visible = !hidden.includes(id);
        });
    }

    // ── Header ────────────────────────────────────────────────────────────
    _buildHeader() {
        const row = hbox('cu-header');
        const text = vbox('cu-header-text', {x_expand: true});
        const titleRow = hbox('cu-title-row');
        titleRow.add_child(label('Claude usage', 'cu-title'));
        this._planPill = label('', 'cu-pill');
        titleRow.add_child(this._planPill);
        text.add_child(titleRow);
        this._planLine = label('', 'cu-subtitle');
        text.add_child(this._planLine);
        row.add_child(text);

        this._refreshButton = iconButton('view-refresh-symbolic', 'Refresh now', () => this._cb.refresh());
        row.add_child(this._refreshButton);
        row.add_child(iconButton('emblem-system-symbolic', 'Preferences', () => this._cb.preferences()));
        this.add_child(row);
    }

    // ── Limits ────────────────────────────────────────────────────────────
    _buildLimits() {
        this._limitsCard = vbox('cu-card cu-limits');
        return this._limitsCard;
    }

    _renderLimits(state, pal) {
        this._limitsCard.destroy_all_children();

        if (['signed-out', 'disabled', 'expired'].includes(state.status) ||
            (state.limits.length === 0 && state.status !== 'loading')) {
            this._renderSignIn(state);
            return;
        }

        if (state.status === 'loading' && state.limits.length === 0) {
            this._limitsCard.add_child(label('Loading…', 'cu-caption'));
            return;
        }

        for (const lim of state.limits) {
            const box = vbox('cu-limit');
            const top = hbox('cu-limit-top');
            top.add_child(label(lim.label, 'cu-strong', {x_expand: true}));
            const color = levelColor(lim.pct, pal.light);
            const pct = label(`${lim.pct}%`, 'cu-strong');
            if (lim.pct >= 75)
                pct.set_style(`color: ${color};`);
            top.add_child(pct);
            box.add_child(top);

            const bar = new SegmentBar('cu-bar');
            bar.setSegments([{weight: Math.min(100, lim.pct), color}], 100);
            box.add_child(bar);

            const reset = formatResetLine(lim);
            if (reset)
                box.add_child(label(reset, 'cu-caption'));
            this._limitsCard.add_child(box);
        }

        if (state.status === 'offline' || state.status === 'error') {
            const when = state.limitsAt ? formatClock(GLib.DateTime.new_from_unix_local(state.limitsAt / 1000)) : '';
            const msg = state.status === 'offline'
                ? `Offline · showing limits from ${when}`
                : `Couldn't refresh limits (${state.error}) · from ${when}`;
            this._limitsCard.add_child(label(msg, 'cu-caption cu-warn-text'));
        }
    }

    _renderSignIn(state) {
        const messages = {
            'disabled': ['Disconnected', 'Reading your Claude Code credentials is turned off.', 'Connect'],
            'expired': ['Session expired', 'Couldn\'t refresh your Claude Code login. Run `claude` to sign in again, then retry.', 'Retry'],
            'signed-out': ['Sign in', 'Sign in with Claude Code (`claude`, then /login) to see your plan limits.', 'Retry'],
        };
        const [title, body, action] = messages[state.status] ??
            ['Limits unavailable', state.error || 'The usage service did not return any limits.', 'Retry'];

        const row = hbox('cu-signin');
        const text = vbox('cu-signin-text', {x_expand: true});
        text.add_child(label(title, 'cu-strong'));
        const bodyLabel = label(body, 'cu-caption');
        bodyLabel.clutter_text.line_wrap = true;
        bodyLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        text.add_child(bodyLabel);
        row.add_child(text);

        const button = new St.Button({style_class: 'cu-pill-button', label: action, can_focus: true});
        button.connect('clicked', () => (state.status === 'disabled' ? this._cb.connect() : this._cb.refresh()));
        row.add_child(button);
        this._limitsCard.add_child(row);
    }

    // ── Value ─────────────────────────────────────────────────────────────
    _buildValue() {
        const card = vbox('cu-card cu-value');
        const head = hbox('cu-card-head');
        head.add_child(label('Value · last 30 days', 'cu-strong', {x_expand: true}));
        head.add_child(label('at API list prices', 'cu-caption'));
        card.add_child(head);

        const grid = hbox('cu-value-grid');
        const paid = vbox('cu-value-col', {x_expand: true});
        paid.add_child(label('You paid', 'cu-caption-strong'));
        this._paid = label('–', 'cu-big');
        paid.add_child(this._paid);
        const api = vbox('cu-value-col', {x_expand: true});
        api.add_child(label('API would have cost', 'cu-caption-strong'));
        this._apiTotal = label('–', 'cu-big');
        api.add_child(this._apiTotal);
        grid.add_child(paid);
        grid.add_child(api);
        card.add_child(grid);

        this._valueLine = label('', 'cu-body');
        card.add_child(this._valueLine);

        this._familyBar = new SegmentBar('cu-bar cu-family-bar', 2);
        card.add_child(this._familyBar);
        this._familyLegend = hbox('cu-legend-row');
        card.add_child(this._familyLegend);

        const tokens = gridBox('cu-token-grid', 0, 6, {column_homogeneous: true});
        this._tokenStats = {};
        ['Input', 'Output', 'Cache write', 'Cache read'].forEach((name, i) => {
            const s = stat(name);
            s.box.x_expand = true;
            tokens.layout_manager.attach(s.box, i, 0, 1, 1);
            this._tokenStats[name] = s.value;
        });
        card.add_child(tokens);
        return card;
    }

    _renderValue(state, pal, opts) {
        const money = v => formatMoney(v, opts.currency, opts.rate);
        const scan = state.scan;
        const price = state.plan?.price ?? 0;

        this._paid.text = price > 0 ? money(price) : '–';

        if (!scan) {
            this._apiTotal.text = '–';
            this._valueLine.text = state.scanError
                ? `Couldn't read Claude Code transcripts: ${state.scanError}`
                : 'Reading Claude Code transcripts…';
            this._familyBar.setSegments([]);
            this._familyLegend.destroy_all_children();
            return;
        }

        const total = scan.totals.cost;
        this._apiTotal.text = money(total);
        this._apiTotal.set_style(`color: ${pal.light};`);

        if (price <= 0) {
            this._valueLine.text = 'Set your plan price in Preferences to compare';
        } else if (total >= price) {
            this._valueLine.text = `${(total / price).toFixed(1)}× your plan price · ${money(total - price)} saved`;
        } else {
            this._valueLine.text = `Pay-as-you-go would have been ${money(price - total)} cheaper`;
        }

        const colors = [pal.light, pal.accent, NEUTRAL_COLOR, '#5e5c64'];
        const fams = scan.families.filter(f => f.cost > 0);
        const shown = fams.slice(0, 3);
        const rest = fams.slice(3).reduce((a, f) => a + f.cost, 0);
        if (rest > 0)
            shown.push({name: 'Other', cost: rest});

        this._familyBar.setSegments(shown.map((f, i) => ({weight: f.cost, color: colors[i]})));
        this._familyLegend.destroy_all_children();
        shown.forEach((f, i) => {
            const item = hbox('cu-legend-item');
            item.add_child(new St.Widget({style_class: 'cu-dot', style: `background-color: ${colors[i]};`, y_align: Clutter.ActorAlign.CENTER}));
            item.add_child(label(`${f.name} ${Math.round(f.cost / total * 100)}%`, 'cu-caption-strong'));
            this._familyLegend.add_child(item);
        });
        if (shown.length === 0)
            this._familyLegend.add_child(label('No Claude Code activity in the last 30 days', 'cu-caption'));

        this._tokenStats['Input'].text = formatTokens(scan.totals.input);
        this._tokenStats['Output'].text = formatTokens(scan.totals.output);
        this._tokenStats['Cache write'].text = formatTokens(scan.totals.cacheWrite);
        this._tokenStats['Cache read'].text = formatTokens(scan.totals.cacheRead);
    }

    // ── Activity ──────────────────────────────────────────────────────────
    _buildActivity() {
        const card = vbox('cu-card cu-activity');
        const head = hbox('cu-card-head');
        head.add_child(label('Activity', 'cu-strong', {x_expand: true}));
        const seg = hbox('cu-segmented');
        this._dayTab = new St.Button({style_class: 'cu-seg-button', label: 'By day', can_focus: true});
        this._hourTab = new St.Button({style_class: 'cu-seg-button', label: 'By hour', can_focus: true});
        this._dayTab.connect('clicked', () => this._setView('days'));
        this._hourTab.connect('clicked', () => this._setView('hours'));
        seg.add_child(this._dayTab);
        seg.add_child(this._hourTab);
        head.add_child(seg);
        card.add_child(head);

        this._daysView = hbox('cu-days-view');
        this._dayGrid = gridBox('cu-day-grid', 4, 4);
        this._daysView.add_child(this._dayGrid);
        const stats = vbox('cu-day-stats', {x_expand: true});
        this._busiest = stat('Busiest day');
        this._activeDays = stat('Active days');
        this._dailyAvg = stat('Daily average');
        this._streak = stat('Current streak');
        for (const s of [this._busiest, this._activeDays, this._dailyAvg, this._streak])
            stats.add_child(s.box);
        this._daysView.add_child(stats);
        card.add_child(this._daysView);

        this._hourGrid = gridBox('cu-hour-grid', 3, 2);
        card.add_child(this._hourGrid);

        const detail = hbox('cu-detail');
        this._detail = label('', 'cu-body', {x_expand: true});
        this._detail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        detail.add_child(this._detail);
        const legend = hbox('cu-ramp-legend');
        legend.add_child(label('Less', 'cu-tiny'));
        this._rampSwatches = [];
        for (let i = 0; i < 5; i++) {
            const sw = new St.Widget({style_class: 'cu-swatch', y_align: Clutter.ActorAlign.CENTER});
            this._rampSwatches.push(sw);
            legend.add_child(sw);
        }
        legend.add_child(label('More', 'cu-tiny'));
        detail.add_child(legend);
        card.add_child(detail);
        return card;
    }

    _setView(view) {
        this._view = view;
        this._renderActivity();
    }

    _metric(cell) {
        return this._opts.metric === 'tokens' ? cell.tokens : cell.cost;
    }

    _dayDetail(day) {
        if (!day || day.messages === 0)
            return `${formatDay(day.date)} · no usage`;
        const money = formatMoney(day.cost, this._opts.currency, this._opts.rate, day.cost >= 100 ? 0 : 2);
        return `${formatDay(day.date)} · ${formatTokens(day.tokens)} tokens · ${money}`;
    }

    _hourDetail(i, total) {
        const pad = n => String(n).padStart(2, '0');
        const d = Math.floor(i / 24), h = i % 24;
        const v = this._metric(this._state.scan.hours[i]);
        const share = total > 0 ? v / total * 100 : 0;
        return `${WEEKDAYS[d]} ${pad(h)}:00–${pad((h + 1) % 24)}:00 · ${
            share > 0 ? `${share.toFixed(1)}% of usage` : 'no usage'}`;
    }

    _cell(styleClass, color, selected, accessibleName, onPick) {
        const b = new St.Button({
            style_class: `${styleClass}${selected ? ' selected' : ''}`,
            style: `background-color: ${color};`,
            accessible_name: accessibleName,
            can_focus: true,
            track_hover: true,
        });
        b.connect('clicked', onPick);
        b.connect('notify::hover', () => {
            if (b.hover)
                this._detail.text = accessibleName;
            else
                this._detail.text = this._selectedDetail ?? '';
        });
        return b;
    }

    _renderActivity() {
        const isDays = this._view === 'days';
        this._dayTab.checked = isDays;
        this._hourTab.checked = !isDays;
        this._daysView.visible = isDays;
        this._hourGrid.visible = !isDays;

        const scan = this._state?.scan;
        const pal = palette(this._opts.accent);
        this._rampSwatches.forEach((sw, i) => sw.set_style(`background-color: ${pal.ramp[i]};`));

        if (!scan) {
            this._dayGrid.destroy_all_children();
            this._hourGrid.destroy_all_children();
            this._selectedDetail = '';
            this._detail.text = '';
            return;
        }

        if (isDays)
            this._renderDays(scan, pal);
        else
            this._renderHours(scan, pal);
        this._detail.text = this._selectedDetail;
    }

    _renderDays(scan, pal) {
        const grid = this._dayGrid;
        const lm = grid.layout_manager;
        grid.destroy_all_children();

        const days = scan.daily;
        const values = days.map(d => this._metric(d));
        const max = Math.max(0, ...values);
        let busiest = 0;
        values.forEach((v, i) => {
            if (v > values[busiest])
                busiest = i;
        });
        if (this._selDay === null || this._selDay >= days.length)
            this._selDay = busiest;

        [[0, 'Mon'], [2, 'Wed'], [4, 'Fri'], [6, 'Sun']].forEach(([row, name]) =>
            lm.attach(label(name, 'cu-tiny cu-row-label'), 0, row + 1, 1, 1));

        const [y, m, d] = days[0].date.split('-').map(Number);
        const first = GLib.DateTime.new_local(y, m, d, 0, 0, 0);
        const offset = first.get_day_of_week() - 1; // Mon = 0
        const cells = Math.ceil((offset + days.length) / 7) * 7;
        let lastMonth = -1;
        let labelledCol = -1;

        for (let c = 0; c < cells; c++) {
            const col = Math.floor(c / 7) + 1;
            const row = (c % 7) + 1;
            const i = c - offset;
            const day = days[i];
            if (!day) {
                lm.attach(new St.Widget({style_class: 'cu-day-cell cu-cell-empty'}), col, row, 1, 1);
                continue;
            }
            // Label a column with its month whenever the month changes.
            const month = Number(day.date.slice(5, 7));
            if (month !== lastMonth) {
                if (labelledCol !== col) {
                    const dt = GLib.DateTime.new_local(Number(day.date.slice(0, 4)), month, 1, 0, 0, 0);
                    lm.attach(label(dt.format('%b'), 'cu-tiny cu-month-label'), col, 0, 1, 1);
                    labelledCol = col;
                }
                lastMonth = month;
            }

            const text = this._dayDetail(day);
            lm.attach(this._cell('cu-day-cell', pal.ramp[rampLevel(values[i], max)], i === this._selDay, text, () => {
                this._selDay = i;
                this._renderActivity();
            }), col, row, 1, 1);
        }
        this._selectedDetail = this._dayDetail(days[this._selDay]);

        const money = v => formatMoney(v, this._opts.currency, this._opts.rate);
        const b = days[busiest];
        this._busiest.value.text = values[busiest] > 0
            ? `${formatDay(b.date)} · ${this._opts.metric === 'tokens' ? `${formatTokens(b.tokens)}` : money(b.cost)}`
            : '–';
        this._activeDays.value.text = `${scan.activeDays} of ${days.length}`;
        this._dailyAvg.value.text = this._opts.metric === 'tokens'
            ? formatTokens(Math.round(days.reduce((a, x) => a + x.tokens, 0) / days.length))
            : money(scan.totals.cost / days.length);
        this._streak.value.text = `${scan.streak} ${scan.streak === 1 ? 'day' : 'days'}`;
    }

    _renderHours(scan, pal) {
        const grid = this._hourGrid;
        const lm = grid.layout_manager;
        grid.destroy_all_children();

        const values = scan.hours.map(h => this._metric(h));
        const max = Math.max(0, ...values);
        const total = values.reduce((a, b) => a + b, 0);
        let busiest = 0;
        values.forEach((v, i) => {
            if (v > values[busiest])
                busiest = i;
        });
        if (this._selHour === null)
            this._selHour = busiest;

        [[0, 'Mon'], [2, 'Wed'], [4, 'Fri'], [6, 'Sun']].forEach(([row, name]) =>
            lm.attach(label(name, 'cu-tiny cu-row-label'), 0, row, 1, 1));

        values.forEach((v, i) => {
            const text = this._hourDetail(i, total);
            lm.attach(this._cell('cu-hour-cell', pal.ramp[rampLevel(v, max)], i === this._selHour, text, () => {
                this._selHour = i;
                this._renderActivity();
            }), (i % 24) + 1, Math.floor(i / 24), 1, 1);
        });
        ['00', '06', '12', '18'].forEach((h, k) =>
            lm.attach(label(h, 'cu-tiny cu-hour-label'), k * 6 + 1, 7, 6, 1));

        this._selectedDetail = this._hourDetail(this._selHour, total);
    }

    // ── Token house ───────────────────────────────────────────────────────
    _buildHouse() {
        const section = vbox('cu-house-section');

        const card = vbox('cu-card cu-house');
        const head = hbox('cu-card-head');
        head.add_child(label('Token house', 'cu-strong'));
        this._houseLevel = label('', 'cu-pill cu-level-pill');
        head.add_child(this._houseLevel);
        card.add_child(head);

        this._houseScene = new HouseScene({x_align: Clutter.ActorAlign.CENTER, accessible_name: 'Token house scene'});
        card.add_child(this._houseScene);

        this._houseLine = label('', 'cu-body');
        this._houseLine.clutter_text.line_wrap = true;
        this._houseLine.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        card.add_child(this._houseLine);

        const progress = vbox('cu-house-progress');
        const progressTop = hbox('cu-house-progress-top');
        this._houseNext = label('', 'cu-caption', {x_expand: true});
        progressTop.add_child(this._houseNext);
        this._houseUtil = label('', 'cu-caption');
        progressTop.add_child(this._houseUtil);
        progress.add_child(progressTop);
        this._houseBar = new SegmentBar('cu-bar');
        progress.add_child(this._houseBar);
        card.add_child(progress);

        const tiers = gridBox('cu-house-tiers', 0, 6, {column_homogeneous: true});
        this._houseTiers = LEVELS.map((lvl, i) => {
            const box = vbox('cu-tier', {x_expand: true});
            const bar = new St.Widget({style_class: 'cu-tier-bar', x_expand: true});
            const name = label(lvl.name, 'cu-tiny', {x_align: Clutter.ActorAlign.CENTER});
            box.add_child(bar);
            box.add_child(name);
            tiers.layout_manager.attach(box, i, 0, 1, 1);
            return {bar, name};
        });
        card.add_child(tiers);
        section.add_child(card);

        return section;
    }

    _renderHouse(state, pal, opts) {
        const house = state.house;
        const util = house?.util ?? 0;
        const lvl = levelFor(util);
        const name = LEVELS[lvl - 1].name;

        this._houseLevel.text = `Lv ${lvl} · ${name}`;
        this._houseLevel.set_style(`color: ${pal.light};`);
        this._houseScene.setScene(lvl, opts.houseAnimate ? this._frame : 0);

        if (!house) {
            this._houseLine.text = 'Your house grows with how much of your weekly limits you use. ' +
                'It starts once a weekly limit has been read.';
        } else if (house.weeks === 0) {
            this._houseLine.text = `You've used ${util}% of your weekly limits so far this week.`;
        } else {
            const span = house.weeks === 1 ? 'last week' : `on average over the last ${house.weeks} weeks`;
            this._houseLine.text = `You used ${util}% of your weekly limits ${span}.`;
        }

        const next = LEVELS[lvl];
        const from = LEVELS[lvl - 1].from;
        this._houseNext.text = next
            ? `Next: ${next.name} at ${next.from}% · ${next.from - util} ${next.from - util === 1 ? 'point' : 'points'} to go`
            : 'Max level · every token put to work';
        this._houseUtil.text = `${util}%`;
        this._houseBar.setSegments([{
            weight: next ? (util - from) / (next.from - from) * 100 : 100,
            color: pal.light,
        }], 100);

        this._houseTiers.forEach((t, i) => {
            t.bar.set_style(`background-color: ${i < lvl ? pal.light : 'rgba(255,255,255,0.15)'};`);
            t.name.set_style(`color: ${i + 1 === lvl ? '#ffffff' : 'rgba(255,255,255,0.55)'};`);
        });
    }

    _syncAnimation() {
        const o = this._opts;
        const run = this._open && o && o.houseAnimate && this._sections.house.visible;
        if (!run) {
            this._stopAnimation();
            return;
        }
        if (this._frameTimer)
            return;
        this._frameTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
            this._frame = (this._frame + 1) % 3;
            this._houseScene.setScene(levelFor(this._state?.house?.util ?? 0), this._frame);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopAnimation() {
        if (this._frameTimer)
            GLib.source_remove(this._frameTimer);
        this._frameTimer = 0;
    }

    // ── Footer ────────────────────────────────────────────────────────────
    _buildFooter() {
        const row = hbox('cu-footer');
        this._updated = label('', 'cu-caption', {x_expand: true});
        row.add_child(this._updated);
        const link = new St.Button({style_class: 'cu-link', label: 'Open usage page ↗', can_focus: true});
        link.connect('clicked', () => this._cb.openUri(USAGE_URL));
        row.add_child(link);
        this.add_child(row);
    }

    // ── Update ────────────────────────────────────────────────────────────

    /**
     * @param {object} state see Indicator._state
     * @param {object} opts {accent, currency, rate, metric, interval, sections,
     *   hiddenSections, houseAnimate}
     */
    update(state, opts) {
        // Selections are indices into the scan, so they don't survive a new one.
        if (state.scan !== this._shownScan || opts.metric !== this._opts?.metric) {
            this._selDay = null;
            this._selHour = null;
            this._shownScan = state.scan;
        }
        this._state = state;
        this._opts = opts;
        const pal = palette(opts.accent);

        const plan = state.plan;
        this._planPill.visible = !!plan;
        if (plan) {
            this._planPill.text = plan.name;
            this._planPill.set_style(`background-color: ${pal.accent};`);
            const parts = [];
            if (plan.price > 0)
                parts.push(`${formatMoney(plan.price, opts.currency, opts.rate, 0)}/month`);
            if (plan.renews)
                parts.push(`renews ${plan.renews.format('%-d %b')}`);
            this._planLine.text = parts.join(' · ') || 'Plan price not set';
        } else {
            this._planLine.text = state.status === 'loading' ? 'Loading…' : 'Plan unknown';
        }

        this._refreshButton.reactive = !state.busy;
        this._refreshButton.opacity = state.busy ? 128 : 255;

        this._applySections(opts.sections, opts.hiddenSections);
        this._renderLimits(state, pal);
        this._renderValue(state, pal, opts);
        this._renderActivity();
        this._renderHouse(state, pal, opts);
        this._syncAnimation();

        const every = `every ${opts.interval}`;
        this._updated.text = state.updatedAt
            ? `Updated ${formatClock(GLib.DateTime.new_from_unix_local(state.updatedAt / 1000))} · ${every}`
            : every;
    }
});
