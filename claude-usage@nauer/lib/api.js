// Talks to the claude.ai usage endpoints with the OAuth token Claude Code
// stores locally, and runs the transcript scanner and Claude Code's login
// refresh in subprocesses.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

const API = 'https://api.anthropic.com/api/oauth';
// A scan normally takes well under a second; give up on one that hangs.
const SCAN_TIMEOUT_S = 60;
// `claude auth status` may need a round trip to refresh the token.
const LOGIN_TIMEOUT_S = 30;
// Where Claude Code's installers put it, for when the shell's PATH lacks them.
const CLAUDE_PATHS = ['.local/bin/claude', '.claude/local/claude', '.npm-global/bin/claude', '.bun/bin/claude'];

export class HttpError extends Error {
    constructor(status, message, retryAfter = 0) {
        super(message);
        this.status = status;
        // Seconds the server asked us to wait (Retry-After), or 0.
        this.retryAfter = retryAfter;
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

/** Path of the `claude` executable, or null when it isn't installed. */
export function findClaude() {
    return GLib.find_program_in_path('claude') ??
        CLAUDE_PATHS.map(p => GLib.build_filenamev([GLib.get_home_dir(), p]))
            .find(p => GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) ?? null;
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
     * The `claudeAiOauth` block of Claude Code's credentials file and the
     * directory it was found in, or null when the user isn't signed in.
     *
     * @param {string[]} dirs
     * @returns {Promise<{dir: string, oauth: object}|null>}
     */
    async readCredentials(dirs) {
        for (const dir of dirs) {
            const file = Gio.File.new_for_path(GLib.build_filenamev([dir, '.credentials.json']));
            try {
                const [bytes] = await file.load_contents_async(this._cancellable);
                const oauth = JSON.parse(new TextDecoder().decode(bytes)).claudeAiOauth;
                if (oauth?.accessToken)
                    return {dir, oauth};
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
        // Not get_status(): it returns a Soup.Status enum, and GJS throws on
        // codes the enum lacks (e.g. 429).
        const status = msg.status_code;
        if (status !== Soup.Status.OK) {
            const retryAfter = parseInt(msg.response_headers.get_one('Retry-After') ?? '', 10);
            throw new HttpError(status, `${path}: HTTP ${status}`, Number.isFinite(retryAfter) ? retryAfter : 0);
        }
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
        return JSON.parse(await this._communicate(proc, 'scanner', SCAN_TIMEOUT_S));
    }

    /**
     * Have Claude Code refresh its expired login. `claude auth status`
     * refreshes and saves the token as any start of Claude Code does, so the
     * refresh token Claude Code holds stays valid; redeeming it here instead
     * would log Claude Code out.
     *
     * @param {string} dir config directory holding the credentials
     * @returns {Promise<boolean>} false when Claude Code isn't installed
     */
    async refreshLogin(dir) {
        const claude = findClaude();
        if (!claude)
            return false;
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        // Claude Code finds its default directories itself.
        if (!configDirs('').includes(dir))
            launcher.setenv('CLAUDE_CONFIG_DIR', dir, true);
        await this._communicate(launcher.spawnv([claude, 'auth', 'status', '--json']),
            '`claude auth status`', LOGIN_TIMEOUT_S);
        return true;
    }

    /** stdout of `proc`, killing it after `timeoutS`; throws if it failed. */
    async _communicate(proc, what, timeoutS) {
        let timedOut = false;
        const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutS, () => {
            timedOut = true;
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        let stdout, stderr;
        try {
            [stdout, stderr] = await proc.communicate_utf8_async(null, this._cancellable);
        } catch (e) {
            proc.force_exit();
            throw e;
        } finally {
            if (!timedOut)
                GLib.source_remove(timer);
        }
        if (timedOut)
            throw new Error(`${what} timed out after ${timeoutS} s`);
        if (!proc.get_successful())
            throw new Error(`${what} failed: ${stderr?.trim()}`);
        return stdout;
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
    }
}
