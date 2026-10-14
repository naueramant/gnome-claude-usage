// Mock-data renderings of the Claude Usage menu sections, for README screenshots.
// Usage: index.html#limits | value | days | hours | house | topbar

const ACCENT = '#d97757';
const MENU_BG = '#36363a';
const WARN = '#f6d32d', CRIT = '#ff7b63', NEUTRAL = '#77767b';

const hexToRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const mix = (a, b, t) => {
    const x = hexToRgb(a), y = hexToRgb(b);
    return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
};
const pal = {
    accent: ACCENT,
    light: mix(ACCENT, '#ffffff', 0.45),
    ramp: ['rgba(255,255,255,0.08)', mix(MENU_BG, ACCENT, 0.4), mix(MENU_BG, ACCENT, 0.75),
        mix(ACCENT, '#ffffff', 0.2), mix(ACCENT, '#ffffff', 0.6)],
};
const levelColor = pct => (pct >= 90 ? CRIT : pct >= 75 ? WARN : pal.light);
const rampLevel = (v, max) => {
    if (v <= 0 || max <= 0) return 0;
    const r = v / max;
    return r >= 0.75 ? 4 : r >= 0.5 ? 3 : r >= 0.25 ? 2 : 1;
};
const money = v => `$${v.toFixed(2)}`;
const tokens = n => (n >= 100e6 ? `${Math.round(n / 1e6)}M` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${(n / 1e3).toFixed(1)}K`);
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = d => `${WEEKDAYS[(d.getDay() + 6) % 7]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;

// ── Mock data ───────────────────────────────────────────────────────────────
const LIMITS = [
    {label: 'Current session', pct: 48, reset: 'Resets in 2 h 14 m (16:42)'},
    {label: 'Weekly · all models', pct: 31, reset: 'Resets Mon 19 Oct, 09:00'},
    {label: 'Weekly · Opus', pct: 78, reset: 'Resets Mon 19 Oct, 09:00'},
];
const PRICE = 100;
const TOTAL = 462.70;
const FAMILIES = [['Opus', 71], ['Sonnet', 26], ['Haiku', 3]];
const TOKENS = [['Input', 3.1e6], ['Output', 1.4e6], ['Cache write', 11.8e6], ['Cache read', 204e6]];

// 30 days ending Wed 14 Oct 2026; weekends quieter, three days off.
const DAYS = (() => {
    const raw = [9, 14, 11, 16, 0, 3, 12, 18, 15, 22, 17, 0, 5, 19, 24, 20, 27, 14, 2, 0,
        16, 21, 38, 25, 19, 6, 4, 23, 28, 18];
    const sum = raw.reduce((a, b) => a + b, 0);
    const start = new Date(2026, 8, 15);
    return raw.map((r, i) => {
        const date = new Date(start);
        date.setDate(start.getDate() + i);
        const cost = Math.round(r / sum * TOTAL * 100) / 100;
        return {date, cost, tokens: Math.round(cost * 0.9e6)};
    });
})();

// Weekday × hour: a working-hours hump with a lunch dip and some evenings.
const HOURS = (() => {
    const out = [];
    for (let d = 0; d < 7; d++) {
        for (let h = 0; h < 24; h++) {
            let v = 0;
            if (h >= 8 && h <= 17) v = 6 + 5 * Math.sin((h - 8) / 9 * Math.PI);
            if (h === 12) v *= 0.45;
            if (h >= 20 && h <= 23) v = [2, 4, 3, 1][h - 20];
            if (d >= 5) v *= h >= 10 && h <= 16 ? 0.35 : 0.2;
            if (d === 4 && h >= 15) v *= 0.5;
            v *= 1 + 0.18 * Math.sin(d * 7.3 + h * 2.1);
            out.push(v < 0.6 ? 0 : v);
        }
    }
    return out;
})();

const HOUSE = {util: 68, weeks: 4};
const LEVELS = [
    {name: 'Tent', from: 0}, {name: 'Cabin', from: 40}, {name: 'House', from: 60},
    {name: 'Villa', from: 80}, {name: 'Castle', from: 95},
];

// ── DOM helpers ─────────────────────────────────────────────────────────────
const el = (tag, cls = '', text = null, style = '') => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== null) e.textContent = text;
    if (style) e.style.cssText = style;
    return e;
};
const add = (parent, ...kids) => (kids.forEach(k => parent.appendChild(k)), parent);
const bar = (segments, total, cls = 'bar') => {
    const b = el('div', cls);
    const sum = total ?? segments.reduce((a, s) => a + s.weight, 0);
    segments.forEach(s => add(b, el('div', 'seg', null, `background:${s.color};width:${s.weight / sum * 100}%;flex:none`)));
    return b;
};

const REFRESH = '<svg viewBox="0 0 16 16"><path fill="#fff" d="M7.40625 1c-.613281.007812-1.234375.089844-1.847656.253906C2.285156 2.132812 0 5.109375 0 8.5s2.285156 6.367188 5.558594 7.242188c3.273437.878906 6.742187-.558594 8.4375-3.492188.277344-.480469.109375-1.089844-.367188-1.367188-.476562-.273437-1.089844-.109374-1.367187.367188-1.246094 2.160156-3.777344 3.207031-6.1875 2.5625C3.667969 13.167969 2 10.992188 2 8.5c0-2.496094 1.667969-4.667969 4.074219-5.3125 2.410156-.644531 4.941406.402344 6.1875 2.5625.058593.085938.125.164062.203125.226562l-.019532.015626L12.4375 6H11c-.550781 0-1 .449219-1 1 0 0 0 1 1 1h5V3s.003906-1-1-1c-.550781 0-1 .449219-1 1v1.6875l-.015625.011719-.011719.011719c-1.277344-2.179688-3.53125-3.519532-5.953125-3.691407C7.816406 1.003906 7.613281 1 7.40625 1m0 0"/></svg>';
const GEAR = '<svg viewBox="0 0 16 16"><path fill="#fff" d="M8 0c-.550781 0-1 .449219-1 1v.238281c0 .464844-.378906.902344-.820312 1.046875-.023438.007813-.042969.011719-.0625.019532-.445313.148437-1.007813.015624-1.28125-.359376L4.695312 1.75c-.15625-.214844-.390624-.359375-.652343-.398438-.261719-.042968-.53125.019532-.742188.175782-.449219.324218-.550781.949218-.222656 1.398437L3.21875 3.125c.277344.375.226562.953125-.050781 1.328125-.011719.015625-.023438.035156-.035157.050781-.273437.378906-.804687.601563-1.25.457032l-.230468-.074219C1.128906 4.714844.5625 5.003906.394531 5.527344c-.171875.527344.113281 1.089844.640625 1.261718l.222656.074219c.445313.144531.738282.636719.75 1.101563v.070312c.015626.464844-.304687.960938-.746093 1.105469l-.226563.070313c-.527344.171874-.8125.738281-.640625 1.261718.167969.523438.734375.8125 1.257813.640625l.230468-.074219c.445313-.144531.976563.078126 1.25.457032.011719.015625.027344.035156.039063.050781.277344.375.324219.953125.050781 1.328125l-.144531.203125c-.324219.445313-.226563 1.070313.222656 1.394531.445313.324219 1.070313.226563 1.394531-.21875l.144532-.199218c.273437-.378907.835937-.507813 1.277344-.359376.019531.007813.042968.011719.0625.019532C6.625 13.855469 7 14.292969 7 14.761719V15c0 .550781.449219 1 1 1s1-.449219 1-1v-.238281c0-.46875.378906-.90625.820312-1.046875.023438-.007813.042969-.015625.066407-.023438.441406-.144531 1.003906-.015625 1.277343.363282l.144532.199218c.324218.445313.949218.542969 1.394531.21875.445313-.324218.546875-.949218.222656-1.394531l-.148437-.203125c-.273438-.375-.226563-.953125.050781-1.328125.015625-.015625.027344-.035156.039063-.050781.273437-.378906.804687-.601563 1.25-.457032l.234374.078126c.523438.167968 1.085938-.121094 1.257813-.644532s-.117187-1.089844-.640625-1.257812l-.230469-.074219c-.445312-.144531-.734375-.640625-.746093-1.105469v-.070312c-.015626-.464844.300781-.957032.746093-1.101563l.230469-.074219c.523438-.171874.8125-.734374.640625-1.261718-.171875-.523438-.734375-.8125-1.257813-.640625l-.230468.074219c-.445313.144531-.980469-.078126-1.253906-.457032-.011719-.015625-.023438-.035156-.035157-.050781-.277343-.375-.324219-.953125-.050781-1.328125l.144531-.199219c.324219-.445312.226563-1.074219-.222656-1.398437-.214844-.15625-.480469-.21875-.742187-.179688-.265626.042969-.5.1875-.652344.402344l-.144532.195312c-.273437.378907-.835937.507813-1.28125.363282-.019531-.007813-.039062-.015625-.0625-.023438C9.378906 2.144531 9 1.707031 9 1.238281V1c0-.550781-.449219-1-1-1m0 4c.871094 0 1.675781.273438 2.332031.742188.003907.007812.011719.015624.019531.023437.011719.003906.019532.007813.03125.015625.660157.484375 1.160157 1.171875 1.421876 1.976562v.007813s.003906.003906.003906.007813c.292968.851562.15625 1.65625 0 2.457031 0 0-.003906.003906-.003906.007812v.003907c-.261719.800781-.757813 1.488281-1.414063 1.976562-.015625.003906-.027344.011719-.039063.019531-.007812.003907-.015624.011719-.019531.019531C9.675781 11.726562 8.871094 12 8 12c-.855469 0-1.644531-.265625-2.289062-.714844-.019532-.015625-.042969-.035156-.0625-.046875-.011719-.007812-.023438-.015625-.035157-.019531-.652343-.484375-1.148437-1.160156-1.40625-1.945312-.003906-.015626-.007812-.023438-.011719-.035157-.003906-.007812-.007812-.015625-.011718-.019531-.285156-.847656-.148438-1.644531 0-2.4375.003906-.007812.007812-.011719.011718-.019531.003907-.011719.007813-.023438.011719-.039063.261719-.785156.757813-1.460937 1.414063-1.945312.007812-.003906.019531-.007813.027344-.015625.019531-.011719.042968-.03125.058593-.046875C6.355469 4.265625 7.144531 4 8 4m0 0"/></svg>';

// ── Sections ────────────────────────────────────────────────────────────────
function header() {
    const row = el('div', 'h header');
    const text = add(el('div', 'v header-text x'),
        add(el('div', 'h title-row'), el('div', 'title', 'Claude usage'), el('div', 'pill', 'Max 5×', `background:${ACCENT}`)),
        el('div', 'subtitle', '$100/month · renews 1 Nov'));
    const b1 = el('div', 'icon-button'); b1.innerHTML = REFRESH;
    const b2 = el('div', 'icon-button'); b2.innerHTML = GEAR;
    return add(row, text, b1, b2);
}

function footer() {
    return add(el('div', 'h footer'), el('div', 'caption x', 'Updated 14:28 · every 5 min'), el('div', 'link', 'Open usage page ↗'));
}

function limits() {
    const card = el('div', 'v card limits');
    for (const l of LIMITS) {
        const c = levelColor(l.pct);
        add(card, add(el('div', 'v limit'),
            add(el('div', 'h'), el('div', 'strong x', l.label), el('div', 'strong', `${l.pct}%`, l.pct >= 75 ? `color:${c}` : '')),
            bar([{weight: l.pct, color: c}], 100),
            el('div', 'caption', l.reset)));
    }
    return card;
}

function value() {
    const card = el('div', 'v card');
    add(card, add(el('div', 'h card-head'), el('div', 'strong x', 'Value · last 30 days'), el('div', 'caption', 'at API list prices')));
    add(card, add(el('div', 'h value-grid'),
        add(el('div', 'v value-col x'), el('div', 'caption-strong', 'You paid'), el('div', 'big', money(PRICE))),
        add(el('div', 'v value-col x'), el('div', 'caption-strong', 'API would have cost'), el('div', 'big', money(TOTAL), `color:${pal.light}`))));
    add(card, el('div', 'body', `${(TOTAL / PRICE).toFixed(1)}× your plan price · ${money(TOTAL - PRICE)} saved`));
    const colors = [pal.light, pal.accent, NEUTRAL];
    // Gaps eat into the width, so scale segments against the bar like SegmentBar does.
    const fb = el('div', 'bar family');
    FAMILIES.forEach(([, p], i) => add(fb, el('div', 'seg', null, `background:${colors[i]};flex:${p} 1 0`)));
    add(card, fb);
    const legend = el('div', 'h legend-row');
    FAMILIES.forEach(([n, p], i) => add(legend, add(el('div', 'h legend-item'),
        el('div', 'dot', null, `background:${colors[i]}`), el('div', 'caption-strong', `${n} ${p}%`))));
    add(card, legend);
    const grid = el('div', 'token-grid');
    TOKENS.forEach(([n, v]) => add(grid, add(el('div', 'v stat'), el('div', 'caption', n), el('div', 'stat-value', tokens(v)))));
    return add(card, grid);
}

function activityHead(view) {
    return add(el('div', 'h card-head'), el('div', 'strong x', 'Activity'),
        add(el('div', 'h segmented'),
            el('div', `seg-button${view === 'days' ? ' checked' : ''}`, 'By day'),
            el('div', `seg-button${view === 'hours' ? ' checked' : ''}`, 'By hour')));
}

function rampLegend() {
    const l = add(el('div', 'h ramp-legend'), el('div', 'tiny', 'Less'));
    pal.ramp.forEach(c => add(l, el('div', 'swatch', null, `background:${c}`)));
    return add(l, el('div', 'tiny', 'More'));
}

function detail(text) {
    return add(el('div', 'h detail'), el('div', 'body x', text), rampLegend());
}

function days() {
    const card = add(el('div', 'v card'), activityHead('days'));
    const values = DAYS.map(d => d.cost);
    const max = Math.max(...values);
    const busiest = values.indexOf(max);
    const offset = (DAYS[0].date.getDay() + 6) % 7;
    const cells = Math.ceil((offset + DAYS.length) / 7) * 7;
    const cols = cells / 7;

    const grid = el('div', 'day-grid', null, `--cols:${cols}`);
    const place = (e, col, row) => { e.style.gridColumn = col + 1; e.style.gridRow = row + 1; add(grid, e); };
    [[0, 'Mon'], [2, 'Wed'], [4, 'Fri'], [6, 'Sun']].forEach(([r, n]) => place(el('div', 'tiny', n), 0, r + 1));
    let lastMonth = -1;
    for (let c = 0; c < cells; c++) {
        const col = Math.floor(c / 7) + 1, row = (c % 7) + 1;
        const day = DAYS[c - offset];
        if (!day) { place(el('div', 'day-cell empty'), col, row); continue; }
        if (day.date.getMonth() !== lastMonth) {
            place(el('div', 'tiny', MONTHS[day.date.getMonth()]), col, 0);
            lastMonth = day.date.getMonth();
        }
        place(el('div', `day-cell${c - offset === busiest ? ' selected' : ''}`, null,
            `background:${pal.ramp[rampLevel(day.cost, max)]}`), col, row);
    }

    const active = DAYS.filter(d => d.cost > 0).length;
    let streak = 0;
    for (let i = DAYS.length - 1; i >= 0 && DAYS[i].cost > 0; i--) streak++;
    const stat = (k, v) => add(el('div', 'v stat'), el('div', 'caption', k), el('div', 'stat-value', v));
    const b = DAYS[busiest];
    add(card, add(el('div', 'h days-view'), grid, add(el('div', 'v day-stats x'),
        stat('Busiest day', `${fmtDay(b.date)} · ${money(b.cost)}`),
        stat('Active days', `${active} of ${DAYS.length}`),
        stat('Daily average', money(TOTAL / DAYS.length)),
        stat('Current streak', `${streak} days`))));
    return add(card, detail(`${fmtDay(b.date)} · ${tokens(b.tokens)} tokens · ${money(b.cost)}`));
}

function hours() {
    const card = add(el('div', 'v card'), activityHead('hours'));
    const max = Math.max(...HOURS);
    const total = HOURS.reduce((a, b) => a + b, 0);
    const busiest = HOURS.indexOf(max);
    const grid = el('div', 'hour-grid');
    const place = (e, col, row, span = 1) => { e.style.gridColumn = `${col + 1} / span ${span}`; e.style.gridRow = row + 1; add(grid, e); };
    [[0, 'Mon'], [2, 'Wed'], [4, 'Fri'], [6, 'Sun']].forEach(([r, n]) => place(el('div', 'tiny', n), 0, r));
    HOURS.forEach((v, i) => place(el('div', `hour-cell${i === busiest ? ' selected' : ''}`, null,
        `background:${pal.ramp[rampLevel(v, max)]}`), (i % 24) + 1, Math.floor(i / 24)));
    ['00', '06', '12', '18'].forEach((h, k) => place(el('div', 'tiny', h), k * 6 + 1, 7, 6));
    add(card, grid);
    const pad = n => String(n).padStart(2, '0');
    const d = Math.floor(busiest / 24), h = busiest % 24;
    return add(card, detail(`${WEEKDAYS[d]} ${pad(h)}:00–${pad(h + 1)}:00 · ${(max / total * 100).toFixed(1)}% of usage`));
}

function drawScene(canvas, lvl, frame, w, h) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const cr = canvas.getContext('2d');
    const W = 48, H = 22, cw = canvas.width, ch = canvas.height;
    const radius = 10 * (w / 336) * dpr;
    cr.beginPath(); cr.roundRect(0, 0, cw, ch, radius); cr.clip();
    cr.fillStyle = SKY; cr.fillRect(0, 0, cw, ch);
    const g = scene(lvl, frame);
    const xs = i => Math.round(i * cw / W), ys = j => Math.round(j * ch / H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!g[y][x]) continue;
        cr.fillStyle = g[y][x];
        cr.fillRect(xs(x), ys(y), xs(x + 1) - xs(x), ys(y + 1) - ys(y));
    }
}

function levelFor(u) { let l = 1; LEVELS.forEach((x, i) => { if (u >= x.from) l = i + 1; }); return l; }

function house() {
    const util = HOUSE.util, lvl = levelFor(util);
    const card = el('div', 'v card');
    add(card, add(el('div', 'h card-head'), el('div', 'strong', 'Token house'),
        el('div', 'pill', `Lv ${lvl} · ${LEVELS[lvl - 1].name}`, `background:rgba(255,255,255,.12);color:${pal.light}`)));
    const cv = el('canvas', 'scene');
    drawScene(cv, lvl, 1, 336, 154);
    add(card, cv);
    add(card, el('div', 'body', `You used ${util}% of your weekly limits on average over the last ${HOUSE.weeks} weeks.`));
    const next = LEVELS[lvl], from = LEVELS[lvl - 1].from;
    add(card, add(el('div', 'v house-progress'),
        add(el('div', 'h'), el('div', 'caption x', `Next: ${next.name} at ${next.from}% · ${next.from - util} points to go`), el('div', 'caption', `${util}%`)),
        bar([{weight: (util - from) / (next.from - from) * 100, color: pal.light}], 100)));
    const tiers = el('div', 'tiers');
    LEVELS.forEach((l, i) => add(tiers, add(el('div', 'v tier'),
        el('div', 'tier-bar', null, `background:${i < lvl ? pal.light : 'rgba(255,255,255,0.15)'}`),
        el('div', 'tiny', l.name, `color:${i + 1 === lvl ? '#fff' : 'rgba(255,255,255,0.55)'}`))));
    return add(card, tiers);
}

function ring(pct, color, full = false) {
    const s = 16, lw = Math.max(1.5, s * 0.14), r = s / 2 - lw / 2 - 0.5, c = s / 2;
    const frac = full ? 1 : pct / 100;
    const a = -Math.PI / 2, b = a + frac * 2 * Math.PI;
    const arc = frac >= 1
        ? `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="${lw}"/>`
        : `<path d="M ${c + r * Math.cos(a)} ${c + r * Math.sin(a)} A ${r} ${r} 0 ${frac > 0.5 ? 1 : 0} 1 ${c + r * Math.cos(b)} ${c + r * Math.sin(b)}" fill="none" stroke="${color}" stroke-width="${lw}" stroke-linecap="round"/>`;
    const track = full ? '' : `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="${lw}"/>`;
    const span = el('span');
    span.innerHTML = `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" style="display:block">${track}${arc}</svg>`;
    return span;
}

function topbar() {
    const strip = el('div', 'topbar');
    const ind = (...kids) => add(strip, add(el('div', 'ind'), ...kids));
    ind(ring(48, pal.light), el('span', '', '48%'));
    ind(ring(48, pal.light), el('span', '', '48%'), el('span', 'sep', '·'), ring(31, pal.light), el('span', '', '31%'));
    ind(ring(82, WARN), el('span', '', '82%', `color:${WARN}`));
    ind(ring(100, CRIT, true), el('span', '', 'Resets 16:42', `color:${CRIT}`));
    return strip;
}


const popup = (...kids) => add(el('div', 'popup'), ...kids);
const VIEWS = {
    limits: () => popup(header(), limits(), footer()),
    value: () => popup(value()),
    days: () => popup(days()),
    hours: () => popup(hours()),
    house: () => popup(house()),
    full: () => popup(header(), limits(), value(), days(), house(), footer()),
    topbar,
};
document.getElementById('root').appendChild(VIEWS[location.hash.slice(1) || 'full']());
