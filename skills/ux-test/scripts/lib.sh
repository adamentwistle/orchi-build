# Shared by scaffold.sh and doctor.sh: JSON reads, target detection and template
# rendering. Sourced, never run. Detection sets variables instead of exiting, so each
# caller decides what a problem means: the scaffold stops, doctor reports it.
#
# Callers set SKILL (the skill directory) and T (the target) before sourcing.

# json <file> <key>...: print the value at that key path, empty when missing.
json() { node -e 'let v = require(process.argv[1]); for (const k of process.argv.slice(2)) v = v == null ? v : v[k]; process.stdout.write(v == null ? "" : String(v))' "$@"; }

# dep <package.json> <name>: the version of a dev dependency or dependency, empty when absent.
dep() { local v; v="$(json "$1" devDependencies "$2")"; printf '%s' "${v:-$(json "$1" dependencies "$2")}"; }
has_dep() { [ -f "$T/package.json" ] && [ -n "$(dep "$T/package.json" "$1")" ]; }

# detect_kind: sets kind to wails, next or vite, empty when none fits.
detect_kind() {
  kind=
  if [ -f "$T/wails.json" ]; then
    kind=wails
  elif has_dep next; then
    kind=next
  elif has_dep vite; then
    kind=vite
  fi
}

# pm_dir: where the package manager is detected. Wails in frontend/, Next at the root.
pm_dir() { if [ "$kind" = wails ]; then printf '%s' "$T/frontend"; else printf '%s' "$T"; fi; }

# detect_pm <dir>: the lockfile decides, then packageManager. Sets pm to
# npm or pnpm, or pm_err to the reason there is none. pm_note carries a disagreement
# between the lockfile and packageManager, which the lockfile wins.
detect_pm() {
  local d="$1" locks="" declared="" f where="${1#"$T"}"
  where="${where#/}"; where="${where:-the root}"
  pm= pm_err= pm_note=
  for f in yarn.lock bun.lockb bun.lock; do
    if [ -f "$d/$f" ]; then pm_err="unsupported package manager: $f in $where"; return 0; fi
  done
  [ -f "$d/package-lock.json" ] && locks="$locks npm"
  [ -f "$d/pnpm-lock.yaml" ] && locks="$locks pnpm"
  [ -f "$d/package.json" ] && declared="$(json "$d/package.json" packageManager)" && declared="${declared%%@*}"
  set -- $locks
  case $# in
    2) pm_err="two lockfiles in $where: npm and pnpm, not guessing" ;;
    1)
      if [ -n "$declared" ] && [ "$declared" != "$1" ]; then
        pm_note="lockfile says $1, packageManager says $declared; the lockfile wins"
      fi
      pm="$1" ;;
    0)
      case "$declared" in
        npm|pnpm) pm="$declared" ;;
        yarn|bun) pm_err="unsupported package manager: packageManager is $declared" ;;
        *) pm_err="no lockfile or packageManager in $where, not guessing" ;;
      esac ;;
  esac
}

# target_vars: after detect_kind and detect_pm, sets the values templates use: name,
# dev_server, and for Next the CI values. Node comes from .nvmrc
# or .node-version, else 20; actions are pinned by hash in versions.json.
target_vars() {
  local f
  name="$(basename "$T")"
  PW_PIN="$(json "$SKILL/versions.json" target @playwright/test)"
  if [ "$kind" = wails ]; then
    dev_server="$(json "$T/wails.json" devServer)"
    dev_server="${dev_server:-localhost:34115}"
  else
    dev_server=localhost:3000
  fi
  uses_checkout="$(uses actions/checkout)"
  uses_setup_node="$(uses actions/setup-node)"
  uses_pnpm_setup="$(uses pnpm/action-setup)"
  uses_upload_artifact="$(uses actions/upload-artifact)"
  node_line="node-version: 20"
  for f in .nvmrc .node-version; do
    if [ -f "$T/$f" ]; then node_line="node-version-file: $f"; break; fi
  done
  case $pm in
    npm) pm_install="npm ci" ;;
    pnpm) pm_install="pnpm install --frozen-lockfile" ;;
    *) pm_install= ;;
  esac
}
uses() { printf '%s@%s # %s' "$1" "$(json "$SKILL/versions.json" actions "$1" sha)" "$(json "$SKILL/versions.json" actions "$1" version)"; }

# render <template-relpath> <out>: write the template for this kind with its values
# filled in. A line that is only __PM_SETUP__ becomes the package manager's CI setup steps.
render() {
  local src="$SKILL/templates/$kind/$1"
  awk -v f="$SKILL/templates/$kind/ci-setup-$pm.yml" \
    '$0 == "__PM_SETUP__" { while ((getline l < f) > 0) print l; next } { print }' "$src" |
    sed -e "s|__NAME__|$name|g" -e "s|__DEV_SERVER__|$dev_server|g" -e "s|__PW_PIN__|$PW_PIN|g" \
      -e "s|__NODE__|$node_line|g" -e "s|__PM_INSTALL__|$pm_install|g" \
      -e "s|__USES_CHECKOUT__|$uses_checkout|g" -e "s|__USES_SETUP_NODE__|$uses_setup_node|g" \
      -e "s|__USES_PNPM_SETUP__|$uses_pnpm_setup|g" -e "s|__USES_UPLOAD_ARTIFACT__|$uses_upload_artifact|g" > "$2"
  if [ -x "$src" ]; then chmod 755 "$2"; else chmod 644 "$2"; fi
}

# scaffold_files: the files the scaffold places for this kind, as "<template> <target
# path>" lines. The agent files and .mcp.json come
# from init-agents, not templates, and are not listed.
scaffold_files() {
  if [ "$kind" = wails ]; then
    printf '%s\n' "package.json package.json" "playwright.config.ts playwright.config.ts" \
      "e2e/smoke.spec.ts e2e/smoke.spec.ts" "e2e/NATIVE.md e2e/NATIVE.md"
  else
    printf '%s\n' "playwright.config.ts playwright.config.ts" "e2e/smoke.spec.ts e2e/smoke.spec.ts" \
      ".github/workflows/ux-test.yml .github/workflows/ux-test.yml"
  fi
  printf '%s\n' "e2e/.gitignore e2e/.gitignore" "e2e/healer-hook.sh e2e/healer-hook.sh" \
    "claude-settings.json .claude/settings.json" "run-skill.md .claude/skills/run-$name/SKILL.md"
}

# init_agents <dir>: run init-agents at the target's installed Playwright in a temporary
# copy, leaving .claude/agents/ and .mcp.json in <dir>. It overwrites
# .mcp.json wholesale, which is why it never runs in the target. The target's config
# is not copied: it only moves the seed spec init-agents writes, which nothing uses, and a
# config that imports a file beside it fails to load in the copy.
init_agents() {
  mkdir -p "$1"
  cp "$T/package.json" "$1/"
  ln -s "$T/node_modules" "$1/node_modules"
  (cd "$1" && npx --no-install playwright init-agents --loop=claude >/dev/null)
}
