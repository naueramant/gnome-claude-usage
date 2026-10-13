#!/usr/bin/env -S gjs -m
// Aggregates Claude Code transcripts (~/.claude/projects/**/*.jsonl) into the
// numbers the panel menu shows: API-equivalent cost, token totals, a per-day
// and a weekday-by-hour heatmap for the last N days.
//
// Runs as a separate process so GNOME Shell never blocks on parsing large
// transcripts. Results per file are cached under $XDG_CACHE_HOME and files are
// read incrementally from where the last run stopped.
//
// Usage: gjs -m scanner.js [--days 30] [--dir PATH]...
// Prints one JSON object on stdout.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {costOf, familyOf} from './pricing.js';

const CACHE_VERSION = 3;
const DAY_MS = 86_400_000;

function parseArgs(argv) {
    const opts = {days: 30, dirs: []};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--days')
            opts.days = Math.max(1, parseInt(argv[++i]) || 30);
        else if (argv[i] === '--dir')
            opts.dirs.push(argv[++i]);
    }
    if (opts.dirs.length === 0)
        opts.dirs = defaultConfigDirs();
    return opts;
}

function defaultConfigDirs() {
    const env = GLib.getenv('CLAUDE_CONFIG_DIR');
    if (env)
        return env.split(',').map(s => s.trim()).filter(Boolean);
    const home = GLib.get_home_dir();
    return [
        GLib.build_filenamev([GLib.get_user_config_dir(), 'claude']),
        GLib.build_filenamev([home, '.claude']),
    ];
}

function listTranscripts(dir, out) {
    let en;
    try {
        en = Gio.File.new_for_path(dir).enumerate_children(
            'standard::name,standard::type,time::modified,standard::size',
            Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return;
    }
    let info;
    while ((info = en.next_file(null))) {
        const path = GLib.build_filenamev([dir, info.get_name()]);
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            listTranscripts(path, out);
        } else if (path.endsWith('.jsonl')) {
            out.push({
                path,
                mtime: info.get_modification_date_time().to_unix() * 1000,
                size: info.get_size(),
            });
        }
    }
    en.close(null);
}

function cachePath() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-usage-gnome', 'scan.json']);
}

function loadCache() {
    try {
        const [, bytes] = GLib.file_get_contents(cachePath());
        const c = JSON.parse(new TextDecoder().decode(bytes));
        if (c.version === CACHE_VERSION)
            return c;
    } catch {}
    return {version: CACHE_VERSION, files: {}};
}

function saveCache(cache) {
    const path = cachePath();
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, JSON.stringify(cache));
}

// Read a file from `offset` to EOF.
function readFrom(path, offset) {
    const stream = Gio.File.new_for_path(path).read(null);
    try {
        if (offset > 0)
            stream.seek(offset, GLib.SeekType.SET, null);
        const chunks = [];
        let total = 0;
        for (;;) {
            const b = stream.read_bytes(1 << 20, null);
            const n = b.get_size();
            if (n === 0)
                break;
            chunks.push(b.toArray());
            total += n;
        }
        const buf = new Uint8Array(total);
        let pos = 0;
        for (const c of chunks) {
            buf.set(c, pos);
            pos += c.length;
        }
        return buf;
    } finally {
        stream.close(null);
    }
}

// Compact record: [key, timestampMs, model, input, output, write5m, write1h, read, fast, costUSD]
// costUSD is only set when Claude Code logged a cost itself (older versions, API-key users).
function parseLines(text, since, records) {
    for (const line of text.split('\n')) {
        if (!line.includes('"usage"'))
            continue;
        let e;
        try {
            e = JSON.parse(line);
        } catch {
            continue;
        }
        const m = e.message;
        const u = m?.usage;
        if (e.type !== 'assistant' || !u || !m.model || m.model.startsWith('<'))
            continue;
        const ts = Date.parse(e.timestamp);
        if (!(ts >= since))
            continue;

        const cw = u.cache_creation_input_tokens ?? 0;
        const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
        records.push([
            `${m.id ?? ''}:${e.requestId ?? e.uuid ?? ts}`,
            ts,
            m.model,
            u.input_tokens ?? 0,
            u.output_tokens ?? 0,
            Math.max(0, cw - w1h),
            w1h,
            u.cache_read_input_tokens ?? 0,
            u.speed === 'fast' ? 1 : 0,
            typeof e.costUSD === 'number' ? e.costUSD : null,
        ]);
    }
}

function scanFile(file, entry, since) {
    // Re-read from scratch when the file was truncated or rewritten.
    const appendOnly = entry && file.size >= entry.size && entry.offset <= file.size;
    const start = appendOnly ? entry.offset : 0;
    const records = appendOnly ? entry.records : [];

    const bytes = readFrom(file.path, start);
    const lastNl = bytes.lastIndexOf(0x0a);
    const consumed = lastNl + 1;
    if (consumed > 0)
        parseLines(new TextDecoder().decode(bytes.subarray(0, consumed)), since, records);

    return {mtime: file.mtime, size: file.size, offset: start + consumed, records};
}

function localDayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function scan({days, dirs}) {
    const now = Date.now();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const windowStart = new Date(today);
    windowStart.setDate(windowStart.getDate() - (days - 1));
    const since = windowStart.getTime();

    const files = [];
    for (const dir of dirs)
        listTranscripts(GLib.build_filenamev([dir, 'projects']), files);

    const cache = loadCache();
    const nextFiles = {};
    // Last write wins: streamed responses log the same message several times.
    const byKey = new Map();

    for (const f of files) {
        if (f.mtime < since)
            continue;
        let entry = cache.files[f.path];
        try {
            if (!entry || entry.mtime !== f.mtime || entry.size !== f.size)
                entry = scanFile(f, entry, since);
        } catch (e) {
            printerr(`claude-usage: skipping ${f.path}: ${e.message}`);
            continue;
        }
        entry.records = entry.records.filter(r => r[1] >= since);
        nextFiles[f.path] = entry;
        for (const r of entry.records)
            byKey.set(r[0], r);
    }

    try {
        saveCache({version: CACHE_VERSION, files: nextFiles});
    } catch (e) {
        printerr(`claude-usage: could not write cache: ${e.message}`);
    }

    const dayIndex = new Map();
    const dayList = [];
    for (let i = 0; i < days; i++) {
        const d = new Date(windowStart);
        d.setDate(d.getDate() + i);
        const key = localDayKey(d.getTime());
        dayIndex.set(key, i);
        dayList.push({date: key, cost: 0, tokens: 0, messages: 0});
    }
    const hours = Array.from({length: 7 * 24}, () => ({cost: 0, tokens: 0}));
    const totals = {cost: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0};
    const families = {};

    for (const [, ts, model, input, output, write5m, write1h, read, fast, logged] of byKey.values()) {
        const cost = logged ?? costOf(model, {input, output, write5m, write1h, read, fast: !!fast});
        // Cache reads dominate raw counts and say little about activity.
        const tokens = input + output + write5m + write1h;

        totals.cost += cost;
        totals.input += input;
        totals.output += output;
        totals.cacheWrite += write5m + write1h;
        totals.cacheRead += read;
        totals.messages++;

        const fam = familyOf(model);
        families[fam] = (families[fam] ?? 0) + cost;

        const di = dayIndex.get(localDayKey(ts));
        if (di !== undefined) {
            dayList[di].cost += cost;
            dayList[di].tokens += tokens;
            dayList[di].messages++;
        }

        const d = new Date(ts);
        const hi = ((d.getDay() + 6) % 7) * 24 + d.getHours();
        hours[hi].cost += cost;
        hours[hi].tokens += tokens;
    }

    let streak = 0;
    // Today without usage yet doesn't break a streak that ran through yesterday.
    for (let i = days - 1; i >= 0; i--) {
        if (dayList[i].messages > 0)
            streak++;
        else if (i !== days - 1)
            break;
    }

    return {
        generatedAt: now,
        days,
        totals,
        families: Object.entries(families)
            .map(([name, cost]) => ({name, cost}))
            .sort((a, b) => b.cost - a.cost),
        daily: dayList,
        hours,
        activeDays: dayList.filter(d => d.messages > 0).length,
        streak,
        filesScanned: Object.keys(nextFiles).length,
    };
}

try {
    print(JSON.stringify(scan(parseArgs(ARGV))));
} catch (e) {
    printerr(`claude-usage: scan failed: ${e.message}\n${e.stack}`);
    System.exit(1);
}
