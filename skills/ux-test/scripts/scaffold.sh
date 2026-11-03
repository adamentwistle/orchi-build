#!/usr/bin/env bash
# ux-test scaffold. Installs the UX testing stack into a target: writes the files
# that are missing and installs the pinned dev dependencies. It never runs git
# (decision 3) and never edits a file it did not create (decision 4). Safe to
# re-run: a second run writes nothing.
#
# Usage: scaffold.sh <target>
#
# Output is one status line per step:
#   WROTE  file written from a template
#   SAME   file exists and matches what the scaffold would write
#   SKIP   file exists and differs; left alone, doctor reports what it lacks
#   INFO   a fact worth knowing, nothing to do
#   STOP   the scaffold cannot go on; the reason follows, nothing was guessed
#   DONE   finished; the next command follows
set -euo pipefail

SKILL="$(cd "$(dirname "$0")/.." && pwd)"
T="$(cd "${1:?usage: scaffold.sh <target>}" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

say() { printf '%-6s %s\n' "$1" "$2"; }
stop() { say STOP "$1"; exit 1; }

command -v node >/dev/null || stop "node is not on PATH"
. "$SKILL/scripts/lib.sh"

# Target kind (decision 6) and package manager (decision 17). Wails is detected in
# frontend/ and installed at the root; Next is both at the root.
detect_kind
case $kind in
  wails|next) ;;
  vite) stop "Vite target: unsupported in version one" ;;
  *) stop "unknown target kind: no wails.json, no next or vite dependency" ;;
esac
say INFO "kind: $kind"
detect_pm "$(pm_dir)"
[ -z "$pm_err" ] || stop "$pm_err"
[ -z "$pm_note" ] || say INFO "$pm_note"
target_vars
[ -n "$PW_PIN" ] || stop "no @playwright/test pin in versions.json"
if [ "$kind" = wails ]; then
  say INFO "package manager: $pm (from frontend/)"
  say INFO "dev server: http://$dev_server"
  command -v wails >/dev/null || say INFO "wails is not on PATH; the webServer block runs wails dev"
else
  say INFO "package manager: $pm"
  say INFO "dev server: http://$dev_server (next dev)"
fi

# place <source> <target-relpath>: write when missing, never touch an existing file.
# Leaves the status it printed in $placed.
place() {
  local dest="$T/$2"
  if [ ! -e "$dest" ]; then
    mkdir -p "$(dirname "$dest")"
    cp "$1" "$dest"
    placed=WROTE
    say WROTE "$2"
  elif cmp -s "$1" "$dest"; then
    placed=SAME
    say SAME "$2"
  else
    placed=SKIP
    say SKIP "$2 (exists and differs, not the scaffold's to edit)"
  fi
}

# tpl <template-relpath> [target-relpath]: render a template, then place it.
tpl() {
  local out
  out="$(mktemp "$tmp/tpl.XXXXXX")"
  render "$1" "$out"
  place "$out" "${2:-$1}"
}

# Files (decisions 5, 10, 12, 13, 14, 18, 19).
while read -r src dest; do
  tpl "$src" "$dest"
  [ "$dest" != .github/workflows/ux-test.yml ] || ci_placed=$placed
done < <(scaffold_files)

# Install @playwright/test at the pin, from the root (decisions 13, 17). The Wails
# root package.json template already carries the exact pin, so that case is a plain
# install that never rewrites it. A root package.json the scaffold did not write
# (every Next target) gets the dev dependency added, the one edit decision 3 allows.
have="$(dep "$T/package.json" @playwright/test)"
if [ -n "$have" ] && [ "$have" != "$PW_PIN" ]; then
  stop "@playwright/test is $have in package.json, the pin is $PW_PIN; change one of them first"
fi
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_ENABLE_AUTO_PIN=0
cd "$T"
case "$pm:${have:+pinned}" in
  npm:pinned) npm install --no-audit --no-fund ;;
  npm:) npm install --save-dev --save-exact --no-audit --no-fund "@playwright/test@$PW_PIN" ;;
  pnpm:pinned) corepack pnpm install ;;
  pnpm:) corepack pnpm add --save-dev --save-exact "@playwright/test@$PW_PIN" ;;
esac
npx --no-install playwright install chromium

# Playwright agents and .mcp.json (decision 8). init-agents overwrites .mcp.json
# wholesale, so it runs in a temporary copy and only its output is placed.
init_agents "$tmp/agents"
for a in planner generator healer; do
  place "$tmp/agents/.claude/agents/playwright-test-$a.md" ".claude/agents/playwright-test-$a.md"
done
place "$tmp/agents/.mcp.json" .mcp.json

if [ "$kind" = next ]; then
  [ "$pm" = pnpm ] && [ -z "$(json "$T/package.json" packageManager)" ] &&
    say INFO "no packageManager in package.json; pnpm/action-setup in ux-test.yml needs a version"
  if [ "$ci_placed" = SKIP ]; then
    say INFO "ux-test.yml differs from the template, as it should once its env is filled"
  else
    say INFO "ux-test.yml has an empty env block: copy the env values and registry auth from the target's workflows"
  fi
fi
say DONE "next: npx playwright test (from $T)"
