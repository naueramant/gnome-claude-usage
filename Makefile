# Claude Usage — GNOME Shell extension
#
#   make install    build and install into ~/.local/share/gnome-shell/extensions
#   make enable     enable it (log out/in first after the very first install on Wayland)
#   make pack       build a zip for extensions.gnome.org / manual install
#   make nested     try it in a nested GNOME Shell (devkit) without logging out
#   make help       list all targets

UUID        := claude-usage@nauer
SRC         := $(UUID)
BUILD       := build
DIST        := dist
ZIP         := $(DIST)/$(UUID).shell-extension.zip
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA      := $(SRC)/schemas/org.gnome.shell.extensions.claude-usage.gschema.xml

JS_FILES    := $(shell find $(SRC) -name '*.js')
EXTRA       := $(patsubst $(SRC)/%,--extra-source=%,$(wildcard $(SRC)/lib))

.PHONY: all help schemas check pack install uninstall enable disable reload \
        prefs nested logs scan clean

all: pack

help:
	@echo "Targets:"
	@echo "  schemas    compile the GSettings schema in place (for running from the source tree)"
	@echo "  check      compile schema strictly and syntax-check every JS module"
	@echo "  pack       build $(ZIP)"
	@echo "  install    pack, then install for the current user"
	@echo "  uninstall  remove the installed extension"
	@echo "  enable     enable the extension"
	@echo "  disable    disable the extension"
	@echo "  reload     disable + enable (X11 picks up code changes; Wayland needs a re-login or 'make nested')"
	@echo "  prefs      open the preferences window"
	@echo "  nested     run a nested GNOME Shell with the extension enabled"
	@echo "  logs       follow GNOME Shell logs filtered to this extension"
	@echo "  scan       run the transcript scanner and pretty-print its output"
	@echo "  clean      remove build output"

schemas: $(SRC)/schemas/gschemas.compiled

$(SRC)/schemas/gschemas.compiled: $(SCHEMA)
	glib-compile-schemas --strict $(SRC)/schemas

# Syntax-checks every module (node is only used as a parser) and runs the
# scanner end to end against your local transcripts.
check:
	glib-compile-schemas --strict --dry-run $(SRC)/schemas
	@for f in $(JS_FILES); do \
		node --input-type=module --check < $$f || { echo "syntax error in $$f"; exit 1; }; \
	done
	@gjs -m $(SRC)/lib/scanner.js > /dev/null
	@echo "OK"

$(ZIP): $(JS_FILES) $(SCHEMA) $(SRC)/metadata.json $(SRC)/stylesheet.css
	@mkdir -p $(DIST)
	gnome-extensions pack --force --out-dir=$(DIST) $(EXTRA) $(SRC)

pack: $(ZIP)

install: pack
	gnome-extensions install --force $(ZIP)
	@echo "Installed to $(INSTALL_DIR)."
	@echo "On Wayland, log out and back in once so GNOME Shell discovers it, then run 'make enable'."

uninstall:
	-gnome-extensions disable $(UUID)
	gnome-extensions uninstall $(UUID)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

reload: disable enable

prefs:
	gnome-extensions prefs $(UUID)

# GNOME 49+ replaced --nested with the mutter devkit.
nested: install
	@ver=$$(gnome-shell --version | grep -o '[0-9]\+' | head -1); \
	flag=--nested; [ "$$ver" -ge 49 ] && flag=--devkit; \
	echo "Starting gnome-shell $$flag (close the window to quit)…"; \
	env MUTTER_DEBUG_DUMMY_MODE_SPECS=1600x1000 SHELL_DEBUG=backtrace-warnings \
	    dbus-run-session -- sh -c "gnome-extensions enable $(UUID); gnome-shell $$flag --wayland"

logs:
	journalctl -f -o cat /usr/bin/gnome-shell | grep -i --line-buffered -E 'claude|$(UUID)|JS ERROR|Extension'

scan:
	gjs -m $(SRC)/lib/scanner.js | python3 -m json.tool | head -60

clean:
	rm -rf $(BUILD) $(DIST) $(SRC)/schemas/gschemas.compiled
