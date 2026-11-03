#!/usr/bin/env bash
# Links the themes into the Herdr app, copies the mods, sounds, layout and keys, and adds
# config/settings.json to its settings. Safe to re-run.
#   install.sh [--force]   --force (or HERDR_INSTALL_FORCE=1): copy even when it would lose files
set -euo pipefail
R="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
H="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
FORCE="${HERDR_INSTALL_FORCE:-0}"
[ "${1:-}" = "--force" ] && FORCE=1
MODS=(claude-chat herd linear linear-agent orch-pane orchi orchi-chrome pane-header panel-buttons plan-view space-agents)
# The app writes these into a mod's folder itself, so they're never the repo's to delete.
KEEP=(--exclude gpui-kit.d.ts --exclude jsconfig.json --exclude '*.error' --exclude __pycache__ --exclude '*.pyc')

mkdir -p "$H/themes" "$H/mods" "$H/layouts" "$H/sounds"

# Mods are copied with --delete, so a file another branch installed (a mod's icon that
# programs.json points at) would go. Look first, and stop unless forced.
lost=""
for m in "${MODS[@]}"; do
  [ -d "$H/mods/$m" ] && [ ! -L "$H/mods/$m" ] || continue
  gone="$(rsync -an --delete --itemize-changes "${KEEP[@]}" "$R/mods/$m/" "$H/mods/$m/" | sed -n 's/^\*deleting  *//p')"
  while IFS= read -r f; do [ -n "$f" ] && lost="$lost  mods/$m/$f"$'\n'; done <<< "$gone"
done
dropped="$(python3 -I -S - "$H/layouts/main-linear.json" "$R/layouts/main-linear.json" <<'PY'
import json, sys
def mods(path):
    try:
        node = json.load(open(path))
    except (OSError, ValueError):
        return set()
    out, todo = set(), [node]
    while todo:
        n = todo.pop()
        if isinstance(n, dict):
            if isinstance(n.get("mod"), str):
                out.add(n["mod"])
            todo.extend(n.values())
        elif isinstance(n, list):
            todo.extend(n)
    return out
for m in sorted(mods(sys.argv[1]) - mods(sys.argv[2])):
    print(m)
PY
)"
while IFS= read -r m; do [ -n "$m" ] && lost="$lost  layouts/main-linear.json would drop the mod $m"$'\n'; done <<< "$dropped"
if [ -n "$lost" ] && [ "$FORCE" != 1 ]; then
  printf 'Stopped: installing from %s would lose what is installed in %s:\n%s' "$R" "$H" "$lost" >&2
  echo "Install from the branch that has them, or run again with --force to lose them." >&2
  exit 3
fi
[ -n "$lost" ] && printf 'Forced, so these go:\n%s' "$lost"

for t in orchi-dark orchi-light; do
  ln -sfn "$R/themes/$t.json" "$H/themes/$t.json"
  echo "linked $H/themes/$t.json"
done

# Mods and the layout are copied, not linked: the app doesn't hot-reload a symlinked mod.
for m in "${MODS[@]}"; do
  [ -L "$H/mods/$m" ] && rm "$H/mods/$m"
  mkdir -p "$H/mods/$m"
  # Before anything else: a new folder with no "place": "none" yet joins the shown layout as a block.
  cp "$R/mods/$m/mod.json" "$H/mods/$m/mod.json"
  rsync -a --delete "${KEEP[@]}" "$R/mods/$m/" "$H/mods/$m/"
  echo "copied $H/mods/$m"
done
cp "$R"/sounds/*.mp3 "$H/sounds/"
[ -L "$H/layouts/main-linear.json" ] && rm "$H/layouts/main-linear.json"
cp "$R/layouts/main-linear.json" "$H/layouts/main-linear.json"
# A fresh home has no keys.json yet. The repo's bindings win for the keys they name.
python3 -I -S - "$H/keys.json" "$R"/keys/*.json <<'PY2'
import json, os, sys
path, *extras = sys.argv[1:]
keys = json.load(open(path)) if os.path.exists(path) else {}
keys.pop("layout:main-linear", None)
for extra in extras:
    for scope, entries in json.load(open(extra)).items():
        keys.setdefault(scope, {}).update(entries)
json.dump(keys, open(path, "w"), indent=2)
PY2

# Panel sessions find this first on PATH, and so reach the herdr wrapper in bin/. A launcher rather than a link, so
# it fails if this checkout goes, where a dangling link would fall through to the real herdr. A private home
# (scripts/herdr-dev) shares this path with the real one, so it's left alone there.
if [ "$H" = "$HOME/.config/herdr-app" ]; then
  A="$HOME/.local/libexec/orchi-app"
  mkdir -p "$A"
  # shellcheck disable=SC2016 # $@ is for the launcher to expand.
  printf '#!/bin/sh\nexec "%s/bin/herdr" "$@"\n' "$R" > "$A/herdr"
  chmod +x "$A/herdr"
  echo "wrote $A/herdr"
fi

# The herdr-browser command and skill, and Browser in the + menu. In its own script so tests can run it.
R="$R" H="$H" bash "$R/scripts/install-browser.sh"

# Only adds what's missing, at any depth: a value already there stays, so a mute in Settings
# (sounds.enabled false) or a picked sound survives a re-install.
python3 -I -S - "$H/settings.json" "$R/config/settings.json" <<'PY'
import json, os, sys
path, extra = sys.argv[1:3]
settings = json.load(open(path)) if os.path.exists(path) else {}
def fill(have, want):
    for key, value in want.items():
        if key not in have:
            have[key] = value
        elif isinstance(have[key], dict) and isinstance(value, dict):
            fill(have[key], value)
fill(settings, json.load(open(extra)))
json.dump(settings, open(path, "w"), indent=2)
PY
echo "updated $H/settings.json"

herdr-app status | grep '"errors"'
