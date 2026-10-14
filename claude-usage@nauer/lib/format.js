// Formatting and colour helpers shared by the indicator and the menu.

import GLib from 'gi://GLib';

export const WARN_COLOR = '#f6d32d';
export const CRIT_COLOR = '#ff7b63';
export const NEUTRAL_COLOR = '#77767b';
export const MENU_BG = '#36363a';

const LIMIT_LABELS = {
    session: 'Current session',
    weekly_all: 'Weekly · all models',
    weekly_opus: 'Weekly · Opus',
    weekly_sonnet: 'Weekly · Sonnet',
};

const LEGACY_LIMITS = [
    ['five_hour', 'session'],
    ['seven_day', 'weekly_all'],
    ['seven_day_opus', 'weekly_opus'],
    ['seven_day_sonnet', 'weekly_sonnet'],
];

function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function labelFor(kind, scope) {
    if (LIMIT_LABELS[kind])
        return LIMIT_LABELS[kind];
    const [head, ...rest] = kind.split('_');
    const tail = scope ?? rest.join(' ');
    return tail ? `${capitalize(head)} · ${capitalize(tail)}` : capitalize(head);
}

/**
 * Turn the `/api/oauth/usage` response into a flat list of limits.
 *
 * @returns {{kind: string, label: string, pct: number, resetsAt: string|null}[]}
 */
export function normalizeLimits(usage) {
    if (Array.isArray(usage?.limits) && usage.limits.length > 0) {
        return usage.limits.map(l => ({
            kind: l.kind,
            label: labelFor(l.kind, l.scope),
            pct: Math.round(l.percent ?? 0),
            resetsAt: l.resets_at ?? null,
        }));
    }
    return LEGACY_LIMITS
        .filter(([key]) => usage?.[key])
        .map(([key, kind]) => ({
            kind,
            label: LIMIT_LABELS[kind],
            pct: Math.round(usage[key].utilization ?? 0),
            resetsAt: usage[key].resets_at ?? null,
        }));
}

/**
 * The limits the top bar should show, in display order.
 *
 * @param {object[]} limits
 * @param {string} which 'most-constrained' | 'session' | 'weekly' | 'both'
 * @returns {object[]} empty when there's no data
 */
export function pickLimits(limits, which) {
    if (limits.length === 0)
        return [];
    const session = limits.find(l => l.kind === 'session');
    const weekly = limits.find(l => l.kind === 'weekly_all') ?? limits.find(l => l.kind.startsWith('weekly'));
    if (which === 'session')
        return [session ?? limits[0]];
    if (which === 'weekly')
        return [weekly ?? limits[0]];
    if (which === 'both' && session && weekly)
        return [session, weekly];
    return [limits.reduce((a, b) => (b.pct > a.pct ? b : a))];
}

export function hexToRgb(hex) {
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}

export function mix(a, b, t) {
    const x = hexToRgb(a), y = hexToRgb(b);
    return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

/** Bar/ring colour for a percentage; `light` is the accent tint used below 75%. */
export function levelColor(pct, light) {
    if (pct >= 90)
        return CRIT_COLOR;
    if (pct >= 75)
        return WARN_COLOR;
    return light;
}

export function palette(accent) {
    return {
        accent,
        light: mix(accent, '#ffffff', 0.45),
        // Heatmap ramp, empty → busiest.
        ramp: [
            'rgba(255,255,255,0.08)',
            mix(MENU_BG, accent, 0.4),
            mix(MENU_BG, accent, 0.75),
            mix(accent, '#ffffff', 0.2),
            mix(accent, '#ffffff', 0.6),
        ],
    };
}

/** Index into the 5-step ramp, scaled to the busiest cell. */
export function rampLevel(value, max) {
    if (value <= 0 || max <= 0)
        return 0;
    const r = value / max;
    if (r >= 0.75)
        return 4;
    if (r >= 0.5)
        return 3;
    if (r >= 0.25)
        return 2;
    return 1;
}

const CURRENCIES = {
    USD: {prefix: '$', suffix: ''},
    EUR: {prefix: '€', suffix: ''},
    GBP: {prefix: '£', suffix: ''},
    DKK: {prefix: '', suffix: ' kr'},
    SEK: {prefix: '', suffix: ' kr'},
    NOK: {prefix: '', suffix: ' kr'},
};

export function formatMoney(usd, currency = 'USD', rate = 1, decimals = 2) {
    const c = CURRENCIES[currency] ?? {prefix: '', suffix: ` ${currency}`};
    const v = usd * (currency === 'USD' ? 1 : rate);
    const d = Math.abs(v) >= 1000 ? 0 : decimals;
    return `${v < 0 ? '−' : ''}${c.prefix}${Math.abs(v).toFixed(d)}${c.suffix}`;
}

export function formatTokens(n) {
    if (n >= 100e6)
        return `${Math.round(n / 1e6)}M`;
    if (n >= 1e6)
        return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3)
        return `${(n / 1e3).toFixed(n >= 100e3 ? 0 : 1)}K`;
    return String(n);
}

let _clockFormat = null;

export function setClockFormat(fmt) {
    _clockFormat = fmt;
}

function timeFmt() {
    return _clockFormat === '12h' ? '%-l:%M %p' : '%H:%M';
}

function toLocal(iso) {
    if (!iso)
        return null;
    return GLib.DateTime.new_from_iso8601(iso, null)?.to_local() ?? null;
}

export function formatClock(dt) {
    return dt.format(timeFmt()).trim();
}

/** "00:29", or "Mon 19 Oct, 09:00" when not within the next 24 h. */
export function formatResetTime(iso) {
    const dt = toLocal(iso);
    if (!dt)
        return '';
    const now = GLib.DateTime.new_now_local();
    const diff = dt.difference(now) / 1e6; // µs → s
    if (diff < 86_400)
        return formatClock(dt);
    return `${dt.format('%a %-d %b')}, ${formatClock(dt)}`;
}

export function formatResetLine(limit) {
    const when = formatResetTime(limit.resetsAt);
    if (!when)
        return limit.pct >= 100 ? 'Limit reached' : '';
    if (limit.pct >= 100)
        return `Limit reached · resets at ${when}`;

    const dt = toLocal(limit.resetsAt);
    const secs = Math.max(0, dt.difference(GLib.DateTime.new_now_local()) / 1e6);
    if (secs < 86_400) {
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const span = h > 0 ? `${h} h ${m} m` : `${m} m`;
        return `Resets in ${span} (${when})`;
    }
    return `Resets ${when}`;
}

/** "Mon 14 Sep" for a YYYY-MM-DD key. */
export function formatDay(key) {
    const [y, m, d] = key.split('-').map(Number);
    return GLib.DateTime.new_local(y, m, d, 0, 0, 0).format('%a %-d %b');
}

/** "30 s", "5 min", "1 h 30 min" for a refresh interval in seconds. */
export function formatInterval(secs) {
    if (secs < 60)
        return `${secs} s`;
    if (secs < 3600)
        return secs % 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs / 60} min`;
    const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
    return m ? `${h} h ${m} min` : `${h} h`;
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
