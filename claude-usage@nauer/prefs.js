// Preferences window.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {configDirs} from './lib/api.js';
import {PLANS} from './lib/pricing.js';

// Menu sections, in their default order.
const SECTIONS = {
    limits: ['Limits', 'Session and weekly usage bars'],
    value: ['Value', 'Plan price vs. API cost, models and tokens'],
    activity: ['Activity heatmap', 'Last 30 days by day or by hour'],
    house: ['Token house', 'Pixel home that upgrades as you use your limits'],
};

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
        window.set_default_size(640, 680);
        // Breakpoints need an explicit minimum size.
        window.set_size_request(360, 300);

        const icons = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        const iconDir = GLib.build_filenamev([this.path, 'icons']);
        if (!icons.get_search_path().includes(iconDir))
            icons.add_search_path(iconDir);

        const pages = [
            ['Account', 'avatar-default-symbolic', [this._accountGroup(settings), this._refreshGroup(settings)]],
            ['Top bar', 'cu-topbar-symbolic', [this._topBarGroup(settings)]],
            ['Panel', 'cu-panel-symbolic', [this._sectionsGroup(settings), this._houseGroup(settings)]],
            ['Cost', 'cu-cost-symbolic', [this._costGroup(settings)]],
            ['Alerts', 'preferences-system-notifications-symbolic', [this._alertsGroup(settings)]],
        ];
        const stack = new Adw.ViewStack();
        for (const [title, iconName, groups] of pages) {
            const page = new Adw.PreferencesPage();
            groups.forEach(g => page.add(g));
            stack.add_titled_with_icon(page, title, title, iconName);
        }

        // Adw.PreferencesWindow only keeps its tabs in the header when the
        // wide icon-beside-label style fits (~760 px for five tabs), so build
        // our own header with the compact icon-above-label tabs instead.
        const switcher = new Adw.ViewSwitcher({
            stack,
            policy: Adw.ViewSwitcherPolicy.NARROW,
            margin_top: 6,
            margin_bottom: 6,
        });
        const bottomBar = new Adw.ViewSwitcherBar({stack});
        const view = new Adw.ToolbarView({content: stack});
        view.add_top_bar(new Adw.HeaderBar({title_widget: switcher}));
        view.add_bottom_bar(bottomBar);
        window.content = view;

        const narrow = new Adw.Breakpoint({condition: Adw.BreakpointCondition.parse('max-width: 540sp')});
        narrow.add_setter(switcher, 'visible', false);
        narrow.add_setter(bottomBar, 'reveal', true);
        window.add_breakpoint(narrow);
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
                    ? 'Refreshed automatically through Claude Code on the next update'
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
        const group = new Adw.PreferencesGroup({title: 'Indicator'});

        group.add(choiceRow(settings, 'limit-to-show', 'Show', [
            ['most-constrained', 'Most constrained'],
            ['session', 'Current session'],
            ['weekly', 'Weekly · all models'],
            ['both', 'Session and weekly'],
        ]));
        group.add(choiceRow(settings, 'display-mode', 'Display as', [
            ['ring-percent', 'Ring and percentage'],
            ['ring', 'Ring only'],
            ['percent', 'Percentage only'],
        ]));

        const position = new Adw.ActionRow({title: 'Position'});
        const toggles = new Adw.ToggleGroup({valign: Gtk.Align.CENTER});
        for (const [name, label] of [['left', 'Left'], ['center', 'Center'], ['right', 'Right']])
            toggles.add(new Adw.Toggle({name, label}));
        settings.bind('position', toggles, 'active-name', Gio.SettingsBindFlags.DEFAULT);
        position.add_suffix(toggles);
        group.add(position);

        const accent = new Adw.ActionRow({title: 'Accent colour', subtitle: 'Used for bars, ring and heatmap'});
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

    _sectionsGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Sections',
            header_suffix: new Gtk.Label({
                label: 'Drag to reorder',
                css_classes: ['dim-label', 'caption'],
                valign: Gtk.Align.END,
            }),
        });
        const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
        group.add(list);

        const order = () => {
            const saved = settings.get_strv('sections').filter(id => SECTIONS[id]);
            return [...saved, ...Object.keys(SECTIONS).filter(id => !saved.includes(id))];
        };
        const move = (id, to) => {
            const o = order();
            const from = o.indexOf(id);
            if (from < 0 || to < 0 || to >= o.length || from === to)
                return;
            o.splice(from, 1);
            o.splice(to, 0, id);
            settings.set_strv('sections', o);
        };

        const rows = {};
        let focusId = null;
        const build = () => {
            list.remove_all();
            for (const [i, id] of order().entries()) {
                const [title, subtitle] = SECTIONS[id];
                const row = new Adw.SwitchRow({
                    title,
                    subtitle,
                    active: !settings.get_strv('hidden-sections').includes(id),
                    tooltip_text: 'Drag, or press Alt+Up / Alt+Down, to reorder',
                });
                row.add_prefix(new Gtk.Image({icon_name: 'list-drag-handle-symbolic', css_classes: ['dim-label']}));
                row.connect('notify::active', () => {
                    const hidden = settings.get_strv('hidden-sections').filter(h => h !== id);
                    if (!row.active)
                        hidden.push(id);
                    settings.set_strv('hidden-sections', hidden);
                });

                let hot = [0, 0];
                const drag = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
                drag.connect('prepare', (_src, x, y) => {
                    hot = [x, y];
                    return Gdk.ContentProvider.new_for_value(id);
                });
                drag.connect('drag-begin', src => src.set_icon(new Gtk.WidgetPaintable({widget: row}), ...hot));
                row.add_controller(drag);

                const drop = new Gtk.DropTarget({actions: Gdk.DragAction.MOVE});
                drop.set_gtypes([GObject.TYPE_STRING]);
                drop.connect('drop', (_target, dragged) => {
                    // Rebuilding the list from inside the drop handler would
                    // destroy this controller mid-emission.
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        move(dragged, order().indexOf(id));
                        return GLib.SOURCE_REMOVE;
                    });
                    return true;
                });
                row.add_controller(drop);

                const keys = new Gtk.ShortcutController();
                for (const [trigger, delta] of [['<Alt>Up', -1], ['<Alt>Down', 1]]) {
                    keys.add_shortcut(new Gtk.Shortcut({
                        trigger: Gtk.ShortcutTrigger.parse_string(trigger),
                        action: Gtk.CallbackAction.new(() => {
                            focusId = id;
                            move(id, i + delta);
                            return true;
                        }),
                    }));
                }
                row.add_controller(keys);

                rows[id] = row;
                list.append(row);
            }
            if (focusId) {
                rows[focusId]?.grab_focus();
                focusId = null;
            }
        };
        build();
        settings.connect('changed::sections', build);
        settings.connect('changed::hidden-sections', () => {
            const hidden = settings.get_strv('hidden-sections');
            for (const [id, row] of Object.entries(rows))
                row.active = !hidden.includes(id);
        });

        return group;
    }

    _houseGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Token house'});
        const animate = new Adw.SwitchRow({title: 'Animate scene'});
        settings.bind('house-animate', animate, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(animate);
        return group;
    }

    /** "Refresh every [n] [seconds|minutes|hours]"; switching unit keeps the duration. */
    _intervalRow(settings) {
        // No seconds: the usage endpoint rate-limits anything under ~2 min.
        const units = [['minutes', 'Minutes', 60, 2, 1440], ['hours', 'Hours', 3600, 1, 24]];
        // Move an older seconds-based or sub-2-minute setting onto the new floor.
        const secs = settings.get_uint('refresh-interval') * ({seconds: 1, minutes: 60, hours: 3600}[settings.get_string('refresh-unit')] ?? 60);
        if (secs < 120 || settings.get_string('refresh-unit') === 'seconds') {
            settings.set_uint('refresh-interval', Math.min(1440, Math.max(2, Math.ceil(secs / 60))));
            settings.set_string('refresh-unit', 'minutes');
        }
        const unitOf = () => units.find(([id]) => id === settings.get_string('refresh-unit')) ?? units[1];

        const row = new Adw.SpinRow({
            title: 'Refresh every',
            subtitle: 'Minimum 2 minutes (Anthropic rate limit)',
            adjustment: new Gtk.Adjustment({step_increment: 1, page_increment: 10}),
        });
        const unit = new Gtk.DropDown({
            model: Gtk.StringList.new(units.map(([, name]) => name)),
            valign: Gtk.Align.CENTER,
        });
        row.add_suffix(unit);

        let syncing = false;
        const sync = () => {
            syncing = true;
            const [, , , lower, upper] = unitOf();
            unit.selected = units.indexOf(unitOf());
            row.adjustment.lower = lower;
            row.adjustment.upper = upper;
            row.value = settings.get_uint('refresh-interval');
            syncing = false;
        };
        row.connect('notify::value', () => {
            if (!syncing && row.value !== settings.get_uint('refresh-interval'))
                settings.set_uint('refresh-interval', row.value);
        });
        unit.connect('notify::selected', () => {
            const [id, , secs, lower, upper] = units[unit.selected];
            if (syncing || id === settings.get_string('refresh-unit'))
                return;
            const total = settings.get_uint('refresh-interval') * unitOf()[2];
            const amount = Math.min(upper, Math.max(lower, Math.round(total / secs)));
            settings.set_uint('refresh-interval', amount);
            settings.set_string('refresh-unit', id);
        });
        settings.connect('changed::refresh-interval', sync);
        settings.connect('changed::refresh-unit', sync);
        sync();
        return row;
    }

    _refreshGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Refresh'});
        group.add(this._intervalRow(settings));
        return group;
    }

    _alertsGroup(settings) {
        const notify = new Adw.PreferencesGroup({title: 'Notifications'});

        const warn = new Adw.SwitchRow({title: 'Warn when nearing a limit'});
        settings.bind('notify-warning', warn, 'active', Gio.SettingsBindFlags.DEFAULT);
        notify.add(warn);

        const threshold = new Adw.SpinRow({
            title: 'Warning threshold',
            subtitle: 'Percent of a limit',
            adjustment: new Gtk.Adjustment({lower: 50, upper: 100, step_increment: 5, page_increment: 10}),
        });
        settings.bind('warn-threshold', threshold, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('notify-warning', threshold, 'sensitive', Gio.SettingsBindFlags.GET);
        notify.add(threshold);

        const reset = new Adw.SwitchRow({title: 'Notify when a limit resets'});
        settings.bind('notify-reset', reset, 'active', Gio.SettingsBindFlags.DEFAULT);
        notify.add(reset);

        return notify;
    }
}
