// Talks to the claude.ai usage endpoints with the OAuth token Claude Code
// stores locally, and runs the transcript scanner in a subprocess.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

const API = 'https://api.anthropic.com/api/oauth';

export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/**
 * Claude Code config directories, in lookup order.
 *
 * @param {string} override comma-separated list from the settings, or ''
 * @returns {string[]}
 */
export function configDirs(override) {
    const list = override || GLib.getenv('CLAUDE_CONFIG_DIR');
    if (list)
        return list.split(',').map(s => s.trim()).filter(Boolean)
            .map(s => s.startsWith('~/') ? GLib.build_filenamev([GLib.get_home_dir(), s.slice(2)]) : s);
    return [
        GLib.build_filenamev([GLib.get_user_config_dir(), 'claude']),
        GLib.build_filenamev([GLib.get_home_dir(), '.claude']),
    ];
}

export class ClaudeClient {
    constructor(extensionPath) {
        this._extensionPath = extensionPath;
        this._cancellable = new Gio.Cancellable();
        this._session = new Soup.Session({
            timeout: 20,
            user_agent: 'claude-usage-gnome/1',
        });
    }

    /**
     * The `claudeAiOauth` block of Claude Code's credentials file, or null
     * when the user isn't signed in.
     *
     * @param {string[]} dirs
     */
    async readCredentials(dirs) {
        for (const dir of dirs) {
            const file = Gio.File.new_for_path(GLib.build_filenamev([dir, '.credentials.json']));
            try {
                const [bytes] = await file.load_contents_async(this._cancellable);
                const oauth = JSON.parse(new TextDecoder().decode(bytes)).claudeAiOauth;
                if (oauth?.accessToken)
                    return oauth;
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    throw e;
            }
        }
        return null;
    }

    async _get(path, token) {
        const msg = Soup.Message.new('GET', `${API}/${path}`);
        msg.request_headers.append('Authorization', `Bearer ${token}`);
        msg.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
        msg.request_headers.append('Accept', 'application/json');

        const bytes = await this._session.send_and_read_async(
            msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        const status = msg.get_status();
        if (status !== Soup.Status.OK)
            throw new HttpError(status, `${path}: HTTP ${status}`);
        return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    }

    fetchUsage(token) {
        return this._get('usage', token);
    }

    fetchProfile(token) {
        return this._get('profile', token);
    }

    /**
     * Run lib/scanner.js in a separate gjs process.
     *
     * @param {string[]} dirs
     * @param {number} days
     */
    async scanTranscripts(dirs, days) {
        const gjs = GLib.find_program_in_path('gjs') ?? '/usr/bin/gjs';
        const argv = [gjs, '-m', `${this._extensionPath}/lib/scanner.js`, '--days', String(days)];
        for (const d of dirs)
            argv.push('--dir', d);

        const proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        const [stdout, stderr] = await proc.communicate_utf8_async(null, this._cancellable);
        if (!proc.get_successful())
            throw new Error(`scanner failed: ${stderr?.trim()}`);
        return JSON.parse(stdout);
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
    }
}
