// Preferences window.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {configDirs} from './lib/api.js';
import {PLANS} from './lib/pricing.js';

/** An Adw.ComboRow bound to a string setting with a fixed set of choices. */
function choiceRow(settings, key, title, choices, subtitle = '') {
    const values = choices.map(([v]) => v);
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });
    const sync = () => {
        row.selected = Math.max(0, values.indexOf(settings.get_string(key)));
    };
    sync();
    row.connect('notify::selected', () => {
        const v = values[row.selected];
        if (v !== undefined && v !== settings.get_string(key))
            settings.set_string(key, v);
    });
    settings.connect(`changed::${key}`, sync);
    return row;
}

function readCredentials(settings) {
    for (const dir of configDirs(settings.get_string('claude-config-dir'))) {
        try {
            const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([dir, '.credentials.json']));
            const oauth = JSON.parse(new TextDecoder().decode(bytes)).claudeAiOauth;
            if (oauth?.accessToken)
                return {dir, oauth};
        } catch {}
    }
    return null;
}

export default class ClaudeUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(640, 860);

        const page = new Adw.PreferencesPage();
        window.add(page);

        page.add(this._accountGroup(settings));
        page.add(this._topBarGroup(settings));
        page.add(this._costGroup(settings));
        page.add(this._notifyGroup(settings));
    }

    _accountGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Account'});

        const status = new Adw.ActionRow();
        const button = new Gtk.Button({valign: Gtk.Align.CENTER});
        status.add_suffix(button);
        const syncStatus = () => {
            const enabled = settings.get_boolean('use-claude-credentials');
            const creds = readCredentials(settings);
            if (!enabled) {
                status.title = 'Disconnected';
                status.subtitle = 'Not reading your Claude Code login';
                button.label = 'Connect';
                button.add_css_class('suggested-action');
            } else if (creds) {
                const expired = creds.oauth.expiresAt && creds.oauth.expiresAt < Date.now();
                status.title = expired ? 'Signed in · token expired' : 'Signed in';
                status.subtitle = expired
                    ? 'Run `claude` once to refresh the login'
                    : 'Using your local Claude Code credentials';
                button.label = 'Sign out';
                button.remove_css_class('suggested-action');
            } else {
                status.title = 'Not signed in';
                status.subtitle = 'Run `claude` and /login, then reopen this window';
                button.label = 'Sign out';
                button.remove_css_class('suggested-action');
            }
        };
        // "Sign out" only stops this extension from reading the login; it
        // never touches Claude Code's own credentials.
        button.connect('clicked', () =>
            settings.set_boolean('use-claude-credentials', !settings.get_boolean('use-claude-credentials')));
        settings.connect('changed::use-claude-credentials', syncStatus);
        syncStatus();
        group.add(status);

        const planLabel = key => {
            if (key !== 'auto')
                return PLANS[key].name;
            const detected = settings.get_string('detected-plan');
            return detected ? `Auto-detect (${PLANS[detected]?.name ?? detected})` : 'Auto-detect';
        };
        const planKeys = ['auto', ...Object.keys(PLANS)];
        const plan = choiceRow(settings, 'plan', 'Plan',
            planKeys.map(k => [k, planLabel(k)]), 'Used to compare against API prices');
        group.add(plan);

        const price = new Adw.SpinRow({
            title: 'Monthly price (USD)',
            subtitle: '0 uses the plan’s list price',
            digits: 2,
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100000, step_increment: 1, page_increment: 10}),
        });
        settings.bind('custom-price', price, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(price);

        const dir = new Adw.EntryRow({
            title: 'Claude Code config directory (optional)',
            show_apply_button: true,
            text: settings.get_string('claude-config-dir'),
        });
        dir.connect('apply', () => {
            settings.set_string('claude-config-dir', dir.text.trim());
            syncStatus();
        });
        group.add(dir);

        return group;
    }

    _topBarGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Top bar'});

        group.add(choiceRow(settings, 'limit-to-show', 'Limit to show', [
            ['most-constrained', 'Most constrained'],
            ['session', 'Current session'],
            ['weekly', 'Weekly · all models'],
        ]));
        group.add(choiceRow(settings, 'display-mode', 'Display as', [
            ['ring-percent', 'Ring and percentage'],
            ['ring', 'Ring only'],
            ['percent', 'Percentage only'],
            ['session-weekly', 'Session and weekly'],
        ]));

        const position = new Adw.ActionRow({title: 'Position'});
        const toggles = new Adw.ToggleGroup({valign: Gtk.Align.CENTER});
        for (const [name, label] of [['left', 'Left'], ['center', 'Center'], ['right', 'Right']])
            toggles.add(new Adw.Toggle({name, label}));
        settings.bind('position', toggles, 'active-name', Gio.SettingsBindFlags.DEFAULT);
        position.add_suffix(toggles);
        group.add(position);

        const accent = new Adw.ActionRow({title: 'Accent colour'});
        const colorButton = new Gtk.ColorDialogButton({
            valign: Gtk.Align.CENTER,
            dialog: new Gtk.ColorDialog({with_alpha: false}),
        });
        const rgba = new Gdk.RGBA();
        if (rgba.parse(settings.get_string('accent-color')))
            colorButton.rgba = rgba;
        colorButton.connect('notify::rgba', () => {
            const c = colorButton.rgba;
            const hex = [c.red, c.green, c.blue]
                .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
            settings.set_string('accent-color', `#${hex}`);
        });
        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: 'Reset to default',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        reset.connect('clicked', () => {
            settings.reset('accent-color');
            rgba.parse(settings.get_string('accent-color'));
            colorButton.rgba = rgba;
        });
        accent.add_suffix(reset);
        accent.add_suffix(colorButton);
        group.add(accent);

        return group;
    }

    _costGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Cost comparison'});

        const pricing = new Adw.ActionRow({
            title: 'Price tokens with',
            subtitle: 'Per-model input, output and cache rates',
        });
        pricing.add_suffix(new Gtk.Label({label: 'Anthropic API list prices', css_classes: ['dim-label']}));
        group.add(pricing);

        group.add(choiceRow(settings, 'currency', 'Currency',
            ['USD', 'EUR', 'GBP', 'DKK', 'SEK', 'NOK'].map(c => [c, c])));

        const rate = new Adw.SpinRow({
            title: 'Exchange rate',
            subtitle: 'Units of the display currency per US dollar',
            digits: 4,
            adjustment: new Gtk.Adjustment({lower: 0.0001, upper: 100000, step_increment: 0.01, page_increment: 1}),
        });
        settings.bind('exchange-rate', rate, 'value', Gio.SettingsBindFlags.DEFAULT);
        const syncRate = () => (rate.visible = settings.get_string('currency') !== 'USD');
        settings.connect('changed::currency', syncRate);
        syncRate();
        group.add(rate);

        group.add(choiceRow(settings, 'heatmap-metric', 'Heatmap metric', [
            ['cost', 'API-equivalent cost'],
            ['tokens', 'Tokens (excl. cache reads)'],
        ]));

        return group;
    }

    _notifyGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Notifications & refresh'});

        const warn = new Adw.SwitchRow();
        const syncWarnTitle = () =>
            (warn.title = `Warn at ${settings.get_uint('warn-threshold')}% of a limit`);
        settings.connect('changed::warn-threshold', syncWarnTitle);
        syncWarnTitle();
        settings.bind('notify-warning', warn, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(warn);

        const threshold = new Adw.SpinRow({
            title: 'Warning threshold',
            subtitle: 'Percent of a limit',
            adjustment: new Gtk.Adjustment({lower: 50, upper: 100, step_increment: 5, page_increment: 10}),
        });
        settings.bind('warn-threshold', threshold, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('notify-warning', threshold, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(threshold);

        const reset = new Adw.SwitchRow({title: 'Notify when a limit resets'});
        settings.bind('notify-reset', reset, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(reset);

        const interval = new Adw.SpinRow({
            title: 'Refresh every',
            subtitle: 'Minutes',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1, page_increment: 5}),
        });
        settings.bind('refresh-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(interval);

        return group;
    }
}
