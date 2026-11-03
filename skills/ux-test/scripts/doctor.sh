#!/usr/bin/env bash
# ux-test doctor. Reports a target's state against the skill: its kind and package
# manager, every file the scaffold places, the pins in versions.json, the agent files
# against init-agents at the pin, and the global agent-browser (decision 16). Read-only:
# it never writes to the target, and it runs init-agents only in a temporary copy.
#
# Usage: doctor.sh [--json] <target>
#
# Output is one line per check, with the fix after it where there is one:
#   OK           present and as the skill expects
#   MISSING      absent
#   DRIFT        present, but off the pin or the template
#   UNSUPPORTED  outside version one (a Vite target, yarn or bun)
#   INFO         a fact worth knowing, nothing to do
# --json prints {target, kind, exit, checks: [{status, check, detail, fix}]} instead.
#
# Exit 1 on any MISSING or DRIFT, 0 otherwise, 2 when doctor itself fails.
set -Eeuo pipefail
trap 'echo "doctor: failed at line $LINENO" >&2; exit 2' ERR

fail() { echo "doctor: $1" >&2; exit 2; }

as_json=
[ "${1:-}" != --json ] || { as_json=1; shift; }
[ $# -eq 1 ] || fail "usage: doctor.sh [--json] <target>"
[ -d "$1" ] || fail "no such directory: $1"
command -v node >/dev/null || fail "node is not on PATH"

SKILL="$(cd "$(dirname "$0")/.." && pwd)"
T="$(cd "$1" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
. "$SKILL/scripts/lib.sh"
[ -n "$(json "$SKILL/versions.json" target @playwright/test)" ] || fail "no @playwright/test pin in versions.json"

SCAFFOLD="run $SKILL/scripts/scaffold.sh $T"
checks="$tmp/checks.tsv"
: > "$checks"
# report <status> <check> <detail> [fix]
report() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "${4:-}" >> "$checks"; }

finish() {
  local code=0
  ! cut -f1 "$checks" | grep -qxE 'MISSING|DRIFT' || code=1
  if [ -n "$as_json" ]; then
    node -e '
      const [file, target, kind, code] = process.argv.slice(1)
      const checks = require("fs").readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
        const [status, check, detail, fix] = l.split("\t")
        return fix ? { status, check, detail, fix } : { status, check, detail }
      })
      console.log(JSON.stringify({ target, kind: kind || null, exit: Number(code), checks }, null, 2))
    ' "$checks" "$T" "${kind:-}" "$code"
  else
    while IFS=$'\t' read -r status check detail fix; do
      printf '%-11s %s: %s%s\n' "$status" "$check" "$detail" "${fix:+. Fix: $fix}"
    done < "$checks"
  fi
  exit "$code"
}

# Kind (decision 6). Anything but Wails or Next ends the report here.
detect_kind
case $kind in
  wails|next) report INFO kind "$kind" ;;
  vite) report UNSUPPORTED kind "Vite target, unsupported in version one"; finish ;;
  *) report UNSUPPORTED kind "no wails.json, no next or vite dependency"; finish ;;
esac

# Package manager (decision 17). Without one, the checks that need it are skipped.
detect_pm "$(pm_dir)"
where=root; [ "$kind" != wails ] || where=frontend/
if [ -n "$pm_err" ]; then
  report UNSUPPORTED "package manager" "${pm_err#unsupported package manager: }" "leave exactly one npm or pnpm lockfile in $where"
else
  report INFO "package manager" "$pm (from $where)"
fi
[ -z "$pm_note" ] || report INFO "package manager" "$pm_note"
case $pm in
  npm) install="npm install" ;;
  pnpm) install="corepack pnpm install" ;;
  *) install="install with the package manager" ;;
esac
install="$install (from the root)"

target_vars
url="http://$dev_server"
report INFO "dev server" "$url"
if [ "$kind" = wails ]; then
  command -v wails >/dev/null || report INFO wails "not on PATH; the webServer block runs wails dev"
  report INFO CI "none: Wails journeys run locally in version one"
fi

# Pins (decision 9): the root package.json, then what is installed.
if [ ! -f "$T/package.json" ]; then
  report MISSING "@playwright/test" "no package.json at the root" "$SCAFFOLD"
  install=$SCAFFOLD
else
  have="$(dep "$T/package.json" @playwright/test)"
  if [ -z "$have" ]; then
    report MISSING "@playwright/test" "not in package.json" "$SCAFFOLD"
    install=$SCAFFOLD
  elif [ "$have" != "$PW_PIN" ]; then
    report DRIFT "@playwright/test" "$have in package.json, the pin is $PW_PIN" \
      "set it to exactly $PW_PIN, or bump versions.json in a ux-test pull request"
  else
    report OK "@playwright/test" "$PW_PIN in package.json"
  fi
fi
installed=
[ ! -f "$T/node_modules/@playwright/test/package.json" ] ||
  installed="$(json "$T/node_modules/@playwright/test/package.json" version)"
if [ -z "$installed" ]; then
  report MISSING "@playwright/test install" "not in node_modules" "$install"
elif [ "$installed" != "$PW_PIN" ]; then
  report DRIFT "@playwright/test install" "$installed in node_modules, the pin is $PW_PIN" "$install"
else
  report OK "@playwright/test install" "$installed in node_modules"
fi

# Chromium at the revision the installed Playwright expects.
browsers="$T/node_modules/playwright-core/browsers.json"
if [ -n "$installed" ] && [ -f "$browsers" ]; then
  cache="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/Library/Caches/ms-playwright}"
  [ "$(uname)" = Darwin ] || cache="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
  rev="$(node -e 'const b = require(process.argv[1]).browsers.find((b) => b.name === "chromium"); process.stdout.write(b ? b.revision : "")' "$browsers")"
  if [ -d "$cache/chromium-$rev" ]; then
    report OK chromium "revision $rev installed"
  else
    report MISSING chromium "revision $rev not in $cache" "npx playwright install chromium (from the root)"
  fi
fi

# Healer hook registration (decision 12): a PreToolUse entry whose matcher covers Edit,
# Write and MultiEdit and that runs e2e/healer-hook.sh.
hook_registered() {
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    const covers = (m) => !m || m === "*" || ["Edit", "Write", "MultiEdit"].every((t) => new RegExp(`^(?:${m})$`).test(t))
    const ok = ((s.hooks && s.hooks.PreToolUse) || []).some((e) =>
      covers(e.matcher) && (e.hooks || []).some((h) => /e2e\/healer-hook\.sh/.test(h.command || "")))
    process.exit(ok ? 0 : 1)
  ' "$1" 2>/dev/null
}

# ux-test.yml actions against the hashes in versions.json (decision 18). Prints the
# drifted ones, nothing when all match.
action_drift() {
  node -e '
    const fs = require("fs")
    const pins = require(process.argv[2]).actions
    const out = []
    for (const m of fs.readFileSync(process.argv[1], "utf8").matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@(\S+)/g)) {
      const pin = pins[m[1]]
      if (pin && m[2] !== pin.sha) out.push(`${m[1]}@${m[2].slice(0, 12)} (pin ${pin.version})`)
    }
    process.stdout.write(out.join(", "))
  ' "$1" "$SKILL/versions.json"
}

# Files the scaffold places (decisions 4, 5, 10, 12, 13, 14, 18, 19). The same bytes as
# the template are OK. A file that differs is one the scaffold will not touch, so doctor
# says what it lacks, and the fix is an in-session merge, never a script.
merge="merge it in-session from templates/$kind, diff shown"
while read -r src dest; do
  f="$T/$dest"
  if [ ! -e "$f" ]; then
    report MISSING "$dest" "absent" "$SCAFFOLD"
    continue
  fi
  render "$src" "$tmp/rendered"
  if cmp -s "$tmp/rendered" "$f"; then
    report OK "$dest" "as the scaffold wrote it"
    continue
  fi
  case $dest in
    package.json)
      report INFO "$dest" "not the scaffold's; the @playwright/test lines above cover it" ;;
    playwright.config.ts)
      lacks=
      grep -q webServer "$f" || lacks="$lacks, a webServer block"
      grep -qF "$url" "$f" || lacks="$lacks, the URL $url"
      grep -qE "testDir:[[:space:]]*['\"]\\.?/?e2e" "$f" || lacks="$lacks, testDir e2e"
      if [ -n "$lacks" ]; then
        report MISSING "$dest" "not the scaffold's and lacks ${lacks#, }" "$merge"
      else
        report OK "$dest" "not the scaffold's, has the webServer on $url and testDir e2e"
      fi ;;
    e2e/smoke.spec.ts)
      report INFO "$dest" "differs from the template: edited, or written by an older scaffold" ;;
    e2e/NATIVE.md)
      report OK "$dest" "edited for this app" ;;
    e2e/.gitignore)
      if grep -q test-results "$f"; then
        report OK "$dest" "ignores test-results"
      else
        report MISSING "$dest" "does not ignore test-results" "$merge"
      fi ;;
    e2e/healer-hook.sh)
      report DRIFT "$dest" "differs from the template" "delete it and $SCAFFOLD" ;;
    .claude/settings.json)
      if hook_registered "$f"; then
        report OK "$dest" "not the scaffold's, registers the healer hook"
      else
        report MISSING "$dest" "not the scaffold's and does not register the healer hook" \
          "merge the PreToolUse entry from templates/$kind/claude-settings.json in-session, diff shown"
      fi ;;
    .claude/skills/run-*/SKILL.md)
      if grep -qF "$url" "$f"; then
        report OK "$dest" "edited, still launches on $url"
      else
        report DRIFT "$dest" "does not name $url, the webServer URL" "$merge"
      fi ;;
    .github/workflows/ux-test.yml)
      drift="$(action_drift "$f")"
      if [ -n "$drift" ]; then
        report DRIFT "$dest" "actions off the versions.json hashes: $drift" "repin them to versions.json"
      else
        report OK "$dest" "env filled in, actions at the pinned hashes"
      fi ;;
  esac
  [ "$dest" != e2e/healer-hook.sh ] || [ -x "$f" ] ||
    report DRIFT "$dest" "not executable" "chmod +x $dest"
done < <(scaffold_files)

# Agent files and .mcp.json against init-agents at the pin (decisions 8, 13). Only
# possible when the pin is what is installed.
generated= why="@playwright/test $PW_PIN is not installed"
if [ "$installed" = "$PW_PIN" ] && [ -f "$T/package.json" ]; then
  if init_agents "$tmp/agents" 2>"$tmp/init-agents.err"; then
    generated=1
  else
    why="init-agents failed in a temporary copy: $(tail -1 "$tmp/init-agents.err")"
  fi
fi
for a in planner generator healer; do
  dest=".claude/agents/playwright-test-$a.md"
  if [ ! -e "$T/$dest" ]; then
    report MISSING "$dest" "absent" "$SCAFFOLD"
  elif [ -z "$generated" ]; then
    report INFO "$dest" "present, not compared: $why"
  elif cmp -s "$tmp/agents/$dest" "$T/$dest"; then
    report OK "$dest" "matches init-agents at $PW_PIN"
  else
    report DRIFT "$dest" "differs from init-agents at $PW_PIN" "delete it and $SCAFFOLD"
  fi
done
dest=.mcp.json
if [ ! -e "$T/$dest" ]; then
  report MISSING "$dest" "absent" "$SCAFFOLD"
elif [ -n "$generated" ] && cmp -s "$tmp/agents/$dest" "$T/$dest"; then
  report OK "$dest" "matches init-agents at $PW_PIN"
elif [ -n "$(json "$T/$dest" mcpServers playwright-test)" ]; then
  report OK "$dest" "not the scaffold's, has the playwright-test server"
else
  report MISSING "$dest" "not the scaffold's and has no playwright-test server" \
    "merge the playwright-test entry from init-agents in-session, diff shown"
fi

# Next only: pnpm/action-setup needs a version from packageManager (decision 18).
if [ "$kind" = next ] && [ "$pm" = pnpm ] && [ -z "$(json "$T/package.json" packageManager)" ]; then
  report INFO "packageManager" "not set; pnpm/action-setup in ux-test.yml needs a version"
fi

# Scaffolded files the target's .gitignore keeps out of the repo: they work, but only here.
if git -C "$T" rev-parse --git-dir >/dev/null 2>&1; then
  ignored="$( (scaffold_files | cut -d' ' -f2; printf '%s\n' .mcp.json .claude/agents/playwright-test-{planner,generator,healer}.md) |
    { git -C "$T" check-ignore --no-index --stdin || true; } | tr '\n' ' ')"
  [ -z "$ignored" ] || report INFO gitignored "${ignored% }: local to this checkout, never committed"
fi

# The global agent-browser pin (decisions 8, 15).
AB_PIN="$(json "$SKILL/versions.json" global agent-browser)"
if ! command -v agent-browser >/dev/null; then
  report MISSING agent-browser "not on PATH" "npm install -g agent-browser@$AB_PIN, then agent-browser install"
else
  ab="$(agent-browser --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  if [ "$ab" = "$AB_PIN" ]; then
    report OK agent-browser "$ab"
  else
    report DRIFT agent-browser "${ab:-unknown version}, the pin is $AB_PIN" "npm install -g agent-browser@$AB_PIN"
  fi
fi

finish
