#!/usr/bin/env bash
# Healer hook, written by the ux-test scaffold. Registered in .claude/settings.json
# as a PreToolUse hook on Edit, Write and MultiEdit. When the calling agent is the
# Playwright healer, any edit outside e2e/ is denied: the healer fixes specs and
# reports app failures, it never changes app code. Everyone else passes through.
set -uo pipefail

input="$(cat)"
cwd="$(printf '%s' "$input" | node -e 'try { process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).cwd || "") } catch {}')"
# The repo root that holds the edited file's worktree. Claude's cwd follows it into
# a worktree, CLAUDE_PROJECT_DIR does not.
root="$(git -C "${cwd:-.}" rev-parse --show-toplevel 2>/dev/null || printf '%s' "${CLAUDE_PROJECT_DIR:-}")"

printf '%s' "$input" | ROOT="$root" node -e '
const fs = require("fs")
const path = require("path")
let i
try { i = JSON.parse(fs.readFileSync(0, "utf8")) } catch { process.exit(0) }
if (i.agent_type !== "playwright-test-healer") process.exit(0)

// Resolve symlinks on the nearest existing ancestor, since the file may not exist yet.
const real = (p) => {
  let dir = p, rest = []
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) { rest.unshift(path.basename(dir)); dir = path.dirname(dir) }
  return path.join(fs.realpathSync(dir), ...rest)
}
const file = (i.tool_input && i.tool_input.file_path) || ""
const root = process.env.ROOT
let rel = ""
if (root && file) rel = path.relative(real(root), real(path.resolve(i.cwd || root, file)))
if (rel.startsWith("e2e" + path.sep)) process.exit(0)

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: `The healer may only edit files under e2e/. ${file || "This file"} is app code or config: report the app failure instead of changing it.`,
  },
}))
'
