// Token house: a pixel-art home that upgrades with how much of your weekly
// limits you use on average. Level history is kept in the `weekly-history`
// setting as (week reset time, peak percent) pairs.

import Cairo from 'cairo';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {hexToRgb} from './format.js';

export const LEVELS = [
    {name: 'Tent', from: 0},
    {name: 'Cabin', from: 40},
    {name: 'House', from: 60},
    {name: 'Villa', from: 80},
    {name: 'Castle', from: 95},
];

export const FRAME_MS = 900;
const AVERAGE_WEEKS = 4;
const KEEP_WEEKS = 8;

/** 1-based level for an average utilization (0..100). */
export function levelFor(util) {
    let lvl = 1;
    LEVELS.forEach((l, i) => {
        if (util >= l.from)
            lvl = i + 1;
    });
    return lvl;
}

/**
 * Fold the latest limits into the weekly history.
 *
 * @param {Array<[number, number]>} history [resetsAt (unix s), peak pct]
 * @returns {Array<[number, number]>|null} the new history, or null if unchanged
 */
export function recordWeek(history, limits, nowSec = Date.now() / 1000) {
    const weekly = limits.filter(l => l.kind.startsWith('weekly') && l.resetsAt);
    if (weekly.length === 0)
        return null;
    const anchor = weekly.find(l => l.kind === 'weekly_all') ?? weekly[0];
    const dt = GLib.DateTime.new_from_iso8601(anchor.resetsAt, null);
    if (!dt)
        return null;
    // The reset timestamp jitters between responses; an hour is plenty.
    const ts = Math.round(dt.to_unix() / 3600) * 3600;
    const pct = Math.min(100, Math.max(...weekly.map(l => l.pct)));

    const next = history.map(([t, p]) => [t, p]);
    const last = next[next.length - 1];
    if (last && last[0] === ts) {
        if (pct <= last[1])
            return null;
        last[1] = pct;
    } else if (last && last[0] > nowSec) {
        // The current week's reset moved; it's still the same week.
        last[0] = ts;
        last[1] = Math.max(last[1], pct);
    } else {
        next.push([ts, pct]);
    }
    return next.slice(-KEEP_WEEKS);
}

/**
 * Average share of weekly limits used over the last four finished weeks,
 * falling back to the current week when none has finished yet.
 *
 * @returns {{util: number, weeks: number}|null} weeks = 0 means "this week so far"
 */
export function averageUtilization(history, nowSec = Date.now() / 1000) {
    const done = history
        .filter(([t]) => t <= nowSec && t > nowSec - AVERAGE_WEEKS * 7 * 86400)
        .slice(-AVERAGE_WEEKS);
    if (done.length > 0)
        return {util: Math.round(done.reduce((a, [, p]) => a + p, 0) / done.length), weeks: done.length};
    const current = history.find(([t]) => t > nowSec);
    return current ? {util: current[1], weeks: 0} : null;
}

// ── Scenes ─────────────────────────────────────────────────────────────────

const W = 48, H = 22;
const SKY = '#8ec5e8';
const C = {
    snow: '#596070', snowSh: '#c9bfa9', tree: '#2f6b3f', treeD: '#245433', treeL: '#4f8a58',
    red: '#a8322d', redD: '#7a221e', trim: '#e8e8e8', roof: '#3a3f4b', lit: '#cfe3f5', litW: '#9cc3e6',
    door: '#4a2f22', dark: '#24180f', stone: '#8b909a', stoneD: '#666b75', smoke: '#e3e8ee',
    smokeL: '#f4f6f9', wood: '#6b4a2f', fire: '#ff7b39', flame: '#f6d32d', cream: '#d9c48e',
    creamD: '#b39c5f', car: '#d9813a', carD: '#9c5523', glass: '#8fb3d9', flag: '#ff7b63',
    tent: '#c98a3c', tentD: '#8e5d24', pole: '#cfd6e0', tire: '#1a1a1a', grass: '#6fae4f',
    grassD: '#5a9440', cloud: '#ffffff', cloudD: '#dce9f4', sun: '#ffd95a', sunL: '#ffe88a',
    bird: '#3a3f4b', path: '#cfc6b4', ash: '#a88a5c',
};
const V = {
    white: '#e9edf2', whiteD: '#c4ccd6', clad: '#7a5638', cladD: '#5e412a', frame: '#2b2e36',
    dglass: '#3a4a5c', water: '#5fa8d3', waterL: '#a9d8f0', tv: '#8fb3d9', parasol: '#ff7b63',
};

/** A W×H grid of colours (null = sky) for a level and animation frame 0..2. */
function scene(lvl, f) {
    const g = Array.from({length: H}, () => new Array(W).fill(null));
    const r = (x, y, w, h, c) => {
        for (let j = y; j < y + h; j++) {
            for (let i = x; i < x + w; i++) {
                if (i >= 0 && i < W && j >= 0 && j < H)
                    g[j][i] = c;
            }
        }
    };
    const p = (x, y, c) => r(x, y, 1, 1, c);

    const cloud = (x, y) => {
        r(x + 2, y, 3, 1, C.cloud);
        r(x, y + 1, 8, 1, C.cloud);
        r(x + 1, y + 2, 6, 1, C.cloudD);
    };
    const tree = cx => {
        r(cx, 9, 1, 1, C.tree);
        r(cx - 1, 10, 3, 2, C.tree);
        r(cx - 2, 12, 5, 2, C.tree);
        r(cx - 3, 14, 7, 2, C.treeD);
        r(cx, 16, 1, 2, C.wood);
        p(cx - 1, 10, C.treeL);
        p(cx - 2, 12, C.treeL);
        p(cx - 3, 14, C.treeL);
    };
    const smoke = (cx, cy) => {
        for (let k = 0; k < 3; k++) {
            const off = k * 3 + f;
            r(cx + Math.floor(off / 3), cy - off, off > 4 ? 1 : 2, 1, off > 4 ? C.smokeL : C.smoke);
        }
    };

    // Sky, sun, clouds, a bird and the lawn are shared by every level.
    cloud(2 + f, 2);
    cloud(22 + f, 4);
    r(40, 1, 4, 4, C.sun);
    [[40, 1], [43, 1], [40, 4], [43, 4]].forEach(([x, y]) => p(x, y, null));
    p(41, 2, C.sunL);
    const bx = 30 + f * 3;
    if (f === 1) {
        r(bx, 8, 3, 1, C.bird);
    } else {
        p(bx, 7, C.bird);
        p(bx + 2, 7, C.bird);
        p(bx + 1, 8, C.bird);
    }
    r(0, 18, W, 4, C.grass);
    [[3, 19, 4], [14, 20, 6], [30, 19, 5], [40, 21, 6]].forEach(([x, y, w]) => r(x, y, w, 1, C.grassD));

    if (lvl === 1) {
        tree(6);
        for (let i = 0; i < 6; i++) {
            r(20 - i, 12 + i, 2 * i + 1, 1, C.tent);
            if (i > 0)
                r(21, 12 + i, i, 1, C.tentD);
        }
        r(20, 15, 1, 3, C.dark);
        p(19, 16, C.dark);
        p(19, 17, C.dark);
        r(28, 18, 6, 1, C.ash);
        r(29, 17, 4, 1, C.wood);
        const flames = [
            [[30, 16, C.fire], [31, 16, C.flame], [30, 15, C.fire]],
            [[30, 16, C.flame], [31, 16, C.fire], [31, 15, C.fire], [31, 14, C.flame]],
            [[30, 16, C.fire], [31, 16, C.fire], [30, 15, C.flame], [30, 14, C.fire]],
        ];
        flames[f].forEach(([x, y, c]) => p(x, y, c));
    } else if (lvl === 2) {
        tree(6);
        tree(42);
        r(26, 5, 2, 4, C.stone);
        smoke(26, 4);
        r(18, 12, 12, 6, C.red);
        [21, 24, 27].forEach(x => r(x, 12, 1, 6, C.redD));
        r(18, 12, 1, 6, C.trim);
        r(29, 12, 1, 6, C.trim);
        for (let i = 0; i < 5; i++) {
            const half = 2 + Math.round(i * 1.25);
            r(24 - half, 7 + i, 2 * half, 1, C.roof);
            p(24 - half, 7 + i, C.snow);
        }
        r(22, 7, 4, 1, C.snow);
        r(19, 13, 4, 4, C.trim);
        r(20, 14, 2, 2, C.lit);
        r(25, 14, 2, 4, C.door);
    } else if (lvl === 3) {
        tree(6);
        tree(41);
        r(29, 3, 2, 4, C.stone);
        smoke(29, 2);
        r(15, 9, 18, 9, C.cream);
        r(15, 13, 18, 1, C.creamD);
        for (let i = 0; i < 5; i++) {
            const half = 3 + 2 * i;
            r(24 - half, 4 + i, 2 * half, 1, C.roof);
            p(24 - half, 4 + i, C.snow);
        }
        r(21, 4, 6, 1, C.snow);
        r(17, 10, 3, 2, C.lit);
        r(28, 10, 3, 2, C.lit);
        r(23, 10, 2, 2, C.litW);
        r(17, 14, 3, 2, C.lit);
        r(28, 14, 3, 2, C.litW);
        r(23, 14, 2, 4, C.door);
        r(22, 18, 4, 1, C.snowSh);
        [1, 4, 7, 10, 37, 40, 43, 46].forEach(x => r(x, 15, 1, 3, C.wood));
        r(0, 16, 12, 1, C.wood);
        r(36, 16, 12, 1, C.wood);
    } else if (lvl === 4) {
        tree(44);
        r(10, 12, 22, 6, V.white);
        r(10, 17, 22, 1, V.whiteD);
        r(10, 11, 6, 1, C.snow);
        r(12, 18, 12, 1, C.path);
        r(12, 13, 12, 4, C.litW);
        [15, 18, 21].forEach(x => r(x, 13, 1, 4, V.frame));
        r(26, 13, 3, 5, V.dglass);
        p(28, 15, C.lit);
        r(16, 7, 22, 5, V.clad);
        [17, 20, 32, 35].forEach(x => r(x, 7, 1, 5, V.cladD));
        r(19, 8, 12, 3, C.litW);
        [23, 27].forEach(x => r(x, 8, 1, 3, V.frame));
        r(28, 8, 3, 3, f === 1 ? V.tv : C.litW);
        r(15, 6, 23, 1, V.frame);
        r(15, 5, 23, 1, C.snow);
        r(37, 12, 1, 6, V.frame);
        r(32, 15, 5, 2, C.car);
        r(33, 14, 3, 1, C.carD);
        p(34, 14, C.glass);
        p(33, 17, C.tire);
        p(35, 17, C.tire);
        p(32, 15, C.lit);
        r(0, 18, 11, 2, C.path);
        r(1, 18, 9, 1, V.water);
        p(1 + f * 3, 18, V.waterL);
        p(8 - f * 2, 18, V.waterL);
        r(3, 13, 1, 5, V.frame);
        r(1, 12, 5, 1, V.parasol);
        r(2, 11, 3, 1, V.parasol);
    } else {
        tree(3);
        tree(44);
        r(12, 9, 24, 9, C.stone);
        for (let y = 10; y < 17; y += 2) {
            for (let x = 12 + ((y / 2) % 2) * 2; x < 36; x += 4)
                p(x, y, C.stoneD);
        }
        for (let x = 12; x < 36; x += 2)
            p(x, 8, C.stone);
        r(8, 4, 6, 14, C.stone);
        r(34, 4, 6, 14, C.stone);
        [8, 10, 12, 34, 36, 38].forEach(x => p(x, 3, C.stone));
        r(10, 7, 2, 2, C.lit);
        r(36, 7, 2, 2, C.lit);
        r(10, 12, 2, 2, C.litW);
        r(36, 12, 2, 2, C.litW);
        r(15, 11, 2, 2, C.lit);
        r(31, 11, 2, 2, C.lit);
        r(21, 12, 6, 6, C.dark);
        r(22, 11, 4, 1, C.dark);
        [22, 24, 26].forEach(x => r(x, 12, 1, 5, C.stoneD));
        r(21, 18, 6, 1, C.snowSh);
        [11, 37].forEach(x => {
            r(x, 0, 1, 3, C.pole);
            if (f === 0) {
                r(x + 1, 0, 3, 1, C.flag);
                r(x + 1, 1, 2, 1, C.flag);
            } else if (f === 1) {
                r(x + 1, 0, 2, 1, C.flag);
                r(x + 1, 1, 3, 1, C.flag);
            } else {
                r(x + 1, 0, 3, 2, C.flag);
            }
        });
    }
    return g;
}

/** The scene for one level, drawn at whatever size the stylesheet gives it. */
export const HouseScene = GObject.registerClass(
class HouseScene extends St.DrawingArea {
    _init(props = {}) {
        super._init({style_class: 'cu-house-scene', ...props});
        this._level = 1;
        this._frame = 0;
        this._grid = scene(1, 0);
    }

    setScene(level, frame) {
        if (level === this._level && frame === this._frame)
            return;
        this._level = level;
        this._frame = frame;
        this._grid = scene(level, frame);
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const radius = 10 * (w / 336);
        const xs = i => Math.round(i * w / W);
        const ys = j => Math.round(j * h / H);
        const fill = hex => {
            const [r, g, b] = hexToRgb(hex).map(v => v / 255);
            cr.setSourceRGB(r, g, b);
        };

        cr.newSubPath();
        cr.arc(w - radius, radius, radius, -Math.PI / 2, 0);
        cr.arc(w - radius, h - radius, radius, 0, Math.PI / 2);
        cr.arc(radius, h - radius, radius, Math.PI / 2, Math.PI);
        cr.arc(radius, radius, radius, Math.PI, 3 * Math.PI / 2);
        cr.closePath();
        cr.clip();

        fill(SKY);
        cr.paint();

        cr.setAntialias(Cairo.Antialias.NONE);
        for (let y = 0; y < H; y++) {
            let x = 0;
            while (x < W) {
                const c = this._grid[y][x];
                if (!c) {
                    x++;
                    continue;
                }
                let x2 = x;
                while (x2 + 1 < W && this._grid[y][x2 + 1] === c)
                    x2++;
                fill(c);
                cr.rectangle(xs(x), ys(y), xs(x2 + 1) - xs(x), ys(y + 1) - ys(y));
                cr.fill();
                x = x2 + 1;
            }
        }
        cr.$dispose();
    }
});
