#!/usr/bin/env bash
# The browser pane's part of install.sh: the herdr-browser command, its skill, and its entry in the + menu.
# Wants R (the repo) and H (the app's home) from the caller. A private window (HERDR_APP_HOME set) gets only
# the + menu entry, and only when the command is already on this Mac.
set -euo pipefail
: "${R:?}" "${H:?}"
BIN="$HOME/.local/bin/herdr-browser"

install_command() {
  local N AB NV why=""
  N="$(command -v node || true)"
  AB="$(command -v agent-browser || true)"
  if [ -z "$AB" ]; then
    why="agent-browser is not on PATH"
  elif [ -z "$N" ]; then
    why="node is not on PATH"
  else
    NV="$("$N" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
    case "$NV" in
      ''|*[!0-9]*) why="could not read the version of node at $N" ;;
      *) if [ "$NV" -lt 22 ]; then why="node at $N is version $NV"; fi ;;
    esac
  fi
  if [ -n "$why" ]; then
    echo "WARNING: skipped herdr-browser: $why. It needs agent-browser and node 22 or later." >&2
    return 0
  fi

  local B="$HOME/.local/libexec/herdr-browser"
  mkdir -p "$B" "$HOME/.local/bin"
  rsync -a --delete "$R/browser/" "$B/"
  printf '#!/bin/sh\nAGENT_BROWSER_BIN="%s" exec "%s" "%s/herdr-browser.mjs" "$@"\n' "$AB" "$N" "$B" > "$BIN"
  chmod +x "$BIN"
  echo "wrote $BIN"

  # Claude Code reads skills from its config dir, which is wherever CLAUDE_CONFIG_DIR says. A shell that
  # doesn't set it would miss the profile in Orchi's settings (claude_dir in $ORCHI_SETTINGS, else
  # ~/.config/orchi/settings.json), so every one of these that exists gets the skill.
  local dirs=() d seen="" found=0 named
  named="$(python3 -I -c '
import json, os, sys
try:
    v = json.load(open(sys.argv[1])).get("claude_dir")
except Exception:
    v = None
if isinstance(v, str) and v.strip():
    print(os.path.expanduser(v.strip()).rstrip("/") or "/")
' "${ORCHI_SETTINGS:-$HOME/.config/orchi/settings.json}" 2>/dev/null || true)"
  [ -n "$named" ] && dirs+=("$named")
  [ -n "${CLAUDE_CONFIG_DIR:-}" ] && dirs+=("$CLAUDE_CONFIG_DIR")
  dirs+=("$HOME/.claude")
  for d in "${dirs[@]}"; do
    [ -d "$d" ] || continue
    case "$seen" in *"|$d|"*) continue ;; esac
    seen="$seen|$d|"
    mkdir -p "$d/skills/herdr-browser"
    cp "$R/skills/herdr-browser/SKILL.md" "$d/skills/herdr-browser/SKILL.md"
    echo "wrote the herdr-browser skill to $d/skills/herdr-browser"
    found=1
  done
  if [ "$found" = 0 ]; then
    mkdir -p "$HOME/.claude/skills/herdr-browser"
    cp "$R/skills/herdr-browser/SKILL.md" "$HOME/.claude/skills/herdr-browser/SKILL.md"
    echo "no Claude config dir found, wrote the skill to $HOME/.claude/skills/herdr-browser"
  fi
}

if [ -z "${HERDR_APP_HOME:-}" ]; then install_command; fi

# The + menu lists programs with a run command. The app starts it from a login shell, and docs/herdr-desktop.md
# notes ~/.zshenv can rewrite PATH there, so the entry holds the command's whole path rather than its name.
if [ -x "$BIN" ]; then
  python3 - "$H/programs.json" "$R/config/programs.json" "$BIN" <<'PY'
import json, os, sys
path, extra, command = sys.argv[1:4]
have = json.load(open(path)) if os.path.exists(path) else {}
new = json.load(open(extra))["programs"]
for entry in new.values():
    entry["run"] = [command, *entry["run"][1:]]
programs = have.setdefault("programs", {})
changed = any(programs.get(key) != entry for key, entry in new.items())
if changed:
    programs.update(new)
    json.dump(have, open(path, "w"), indent=2)
    print(f"added Browser to the + menu in {path}")
PY
else
  echo "WARNING: Browser is not in the + menu, because $BIN is not installed" >&2
fi
