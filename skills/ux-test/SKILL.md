---
name: ux-test
description: Install and use the UX testing stack (Playwright Test, the Playwright agents, the agent-browser CLI) in a Wails or Next project. Use when asked to set up UX or end-to-end testing in a project, scaffold Playwright into it, check a project with doctor, verify a UI change in a browser, or plan, write or heal a journey.
---

# ux-test

Setup links this folder into `<claude_dir>/skills`. Install agent-browser at the pin in
`versions.json` with `npm install -g agent-browser@<pin>`, then `agent-browser install`.
Doctor reports agent-browser MISSING until then. Edit the skill in Orchi's
`skills/ux-test/`, never in the link.

The stack in a target: Playwright Test with one smoke spec, the three Playwright agents
(planner, generator, healer) talking to the `playwright-test` MCP server bundled with
@playwright/test, a healer hook that keeps the healer inside `e2e/`, a `run-<dirname>`
project skill, and the agent-browser CLI for Claude's own checks. No standalone
Playwright MCP. chrome-devtools MCP only for performance and accessibility audits.

Target kinds: Wails (has `wails.json`) and Next (has the `next` dependency, no
`wails.json`). Vite is unsupported in version one.

## Scaffold a target

The script writes files and installs pinned dev dependencies. It never runs git and
never edits a file it did not create. Git is this procedure's job.

1. In the target, branch off an up-to-date main: `git switch -c ux-test/scaffold`.
   Run doctor (below) to see what is there.
2. Run `scripts/scaffold.sh <target>` from this skill's folder.
3. Read the status lines:
   - `WROTE` and `SAME`: nothing to do.
   - `SKIP`: the file exists and is not the scaffold's. Tell the user what it lacks. If
     they want a merge (a Playwright config, `.mcp.json`, `.claude/settings.json`),
     make the edit in-session and show the diff. Never script it.
   - `STOP`: report the reason and stop. The script never guesses a package manager
     or a kind.
4. Next only: fill `.github/workflows/ux-test.yml`. Copy into its `env:` block the
   values the target's own workflows set for the app to start (dummy service values,
   secrets by reference), and copy their registry auth step, if any, to the marked
   place before the install. Read `.npmrc` to see whether one is needed. Show the
   diff. Never edit the target's existing workflows.
5. Run `npx playwright test` from the target root. On Wails this starts `wails dev`
   (about 40 seconds cold) and opens the real app with the user's real data. On Next
   it starts `next dev` on port 3000 with the target's `.env.local`. If the app is
   already running on its port, the run reuses it and leaves it running.
6. Run the scaffold again. `git status` must show nothing new. A change means a bug in
   the scaffold: fix it in this skill, not in the target. On Next, `ux-test.yml` reports
   `SKIP` once its env is filled; that is expected.
7. Run doctor. Every MISSING or DRIFT line left is a merge to offer or a bug in the
   scaffold.
8. Commit the scaffolded files, then `/ship`. On Next, `ux-test.yml` must be green on
   the pull request and the target's other workflows must still pass.

What a Wails target gets, all at the repo root beside `go.mod`:

- `package.json` (`<dirname>-e2e`, only `@playwright/test` at the pin) and its lockfile.
  The package manager is detected from `frontend/`. The frontend lockfile is never touched.
- `playwright.config.ts`: webServer `wails dev` on http://localhost:34115 (or
  `devServer` from wails.json), SIGINT shutdown, output in `e2e/test-results`.
- `e2e/smoke.spec.ts`, `e2e/NATIVE.md` (hand-checked native behaviours, edit per app),
  `e2e/.gitignore`, `e2e/healer-hook.sh`.
- `.claude/settings.json` (the healer hook), `.claude/agents/playwright-test-*.md` and
  `.mcp.json`, both from `init-agents` run in a temporary copy.
- `.claude/skills/run-<dirname>/SKILL.md`, which the built-in `/run` finds first.

No CI workflow for Wails in version one.

What a Next target gets, at the repo root:

- `@playwright/test` at the pin added to the existing `package.json` and its lockfile,
  with the package manager detected at the root.
- `playwright.config.ts`: webServer `npx next dev --port 3000`, 180 second start
  timeout, output in `e2e/test-results`, HTML report in `e2e/playwright-report` on CI.
- `e2e/smoke.spec.ts`, `e2e/.gitignore`, `e2e/healer-hook.sh`.
- `.github/workflows/ux-test.yml`: the smoke spec on pull requests and pushes to main,
  actions pinned by hash, Chromium installed each run, the report uploaded on failure.
- `.claude/settings.json`, `.claude/agents/playwright-test-*.md`, `.mcp.json` and
  `.claude/skills/run-<dirname>/SKILL.md`, as for Wails.

## Run the app

Use the target's `run-<dirname>` skill. It holds the launch command, the URL, and how
to stop the server.

## Verify a UI change

The default for any UI change: agent-browser, one pass or fail line
plus one screenshot, nothing kept in the repo.

## Journeys, planner, generator, healer

A journey is written only when the user asks, the change fixes a bug a user hit, or the
flow touches money, auth or data loss. The planner runs on features, never on bug fixes.
The healer edits specs only; the hook enforces it.

The three agents are Claude Code subagents in the target's `.claude/agents/`, so they
run from a Claude Code session in the target, interactive or `claude -p`. From a script
use `claude -p "<prompt>" --permission-mode acceptEdits --max-turns 60 --output-format
json --no-session-persistence` with `CLAUDE_CONFIG_DIR` set, and `--allowedTools` as
below. The `.playwright-mcp/` directory the `playwright-test` server writes belongs in
the target's `.gitignore` (the scaffold does not add it; offer the one-line edit).

**Plan.** Prompt: "Use the playwright-test-planner subagent to write a test plan for
ONE feature: <name and file>". Tell it the seed file (`e2e/smoke.spec.ts`), the exact
element names to look for, at most four scenarios, no screenshots, and where to save the
plan (`specs/<feature>.md`, `planner_save_plan`). Tools: `Task,Read,Glob,Grep,LS,
mcp__playwright-test__*`. The planner starts the webServer itself and leaves it running,
so the generator's run finds the port busy: on Wails, where `reuseExistingServer` is
false, stop that server before the generator (check with `lsof -nP -iTCP:<port>`).

**Generate.** Prompt: "Use the playwright-test-generator subagent to turn
specs/<feature>.md into ONE spec at e2e/<feature>.spec.ts", one describe block, one test
per plan item. Name an existing journey to copy conventions from, and say it may edit
`e2e/` only. Add `Write,Edit,Bash(npx playwright test*)` to the tools. Then run the spec
yourself: the generator writes without checking every assertion against the app, so
expect one or two fixes by hand (such as an assertion that a name is in a list it can
never be in).

**Heal.** The healer only earns its keep on a spec that a real app change broke. Prompt:
"Use the playwright-test-healer subagent to fix the failing e2e/<feature>.spec.ts. The
app was changed on purpose in the last commit (<what changed>); the committed app code
is the truth and the spec is stale." Say explicitly that a stale locator is its job and
only real misbehaviour (crashes, wrong output) is reportable. Without that, an
uncommitted or unexplained app diff makes it stop and ask, which looks like a failure but
is the healer being careful. Tools: add `MultiEdit,Bash(git status*),Bash(git diff*)`.
Check the result with `git status --short`: only files under `e2e/` may have changed.

**Prove the healer on a new target** (once, as part of adoption): commit a rename of an
element the journey uses, run the healer, confirm one spec edit and nothing else, then
`git revert` both commits so the branch's net diff is the journey alone. Check the hook
directly by piping a fake PreToolUse payload with `"agent_type":"playwright-test-healer"`
and an app file path into `e2e/healer-hook.sh`: it must print a deny.

**Auth.** A journey behind a login needs a session the runner can mint without a human.
The pattern: a `globalSetup` in `e2e/` that creates a user and session through the
app's own auth admin API (for example a generated login link, from a local instance with its
service key) and saves `storageState` for the specs. Never loosen an app's
local auth bypass to make a test pass; that is a security default and the user decides.
A hand-exported `storageState` from the user's own browser is a stopgap for local runs
only, it expires and cannot run in CI. Not yet built for any target.

## Doctor

`scripts/doctor.sh [--json] <target>`, from this skill's folder, reports a target's
state and changes nothing in it. Run it before scaffolding, to see what the scaffold
will do, and after, to see what is left. Use `--json` when reading it yourself.

One line per check, each with its fix:

- `OK`: present and as expected. A file that differs from the template but still has
  what the skill needs is OK.
- `MISSING`: absent. For a file the scaffold never wrote (a target's own
  `.claude/settings.json`), it names what the file lacks, such as the healer hook
  registration. Offer the merge and make it in-session with the diff shown.
- `DRIFT`: off the pin in versions.json, an agent file that differs from `init-agents`
  at the pin, a changed healer hook, or ux-test.yml actions off the pinned hashes.
- `UNSUPPORTED`: a Vite target, yarn or bun, two lockfiles, or no package manager signal.
- `INFO`: the kind, the package manager, the dev server URL, no CI on Wails, and
  scaffolded files the target's `.gitignore` keeps local.

Exit 1 on any MISSING or DRIFT, 0 otherwise, 2 when doctor itself fails. The global
agent-browser pin is checked too, so every target reports it MISSING until it is
installed.

## Versions

`versions.json` pins everything the scaffold installs (`target`) and what the skill
installs globally (`global`). A bump is a pull request to this skill, and its
checklist includes re-running `init-agents` on every target.

Before any global install or pin bump, check the package, all from real output, and
put the results in the pull request:

1. Exact name. `npm view <name> name repository.url maintainers`: the repository is the
   one the skill expects, and `npm search <name>` shows which lookalikes exist so a typo
   cannot land on one (for agent-browser: `agent-browser-mcp`, `remote-agent-browser`
   and `pi-agent-browser-native` are unrelated).
2. Provenance. `npm view <name>@<pin> dist.attestations` shows a SLSA attestation, and
   `npm audit signatures` in a scratch install (`npm install --ignore-scripts`) says the
   attestation is verified.
3. Integrity. `npm pack <name>@<pin>` then `openssl dgst -sha512 -binary <tgz> | base64`
   matches `dist.integrity`. For a package that bundles a native binary, its sha256
   matches the digest on the GitHub release asset of the same tag
   (`gh api repos/<owner>/<repo>/releases/tags/v<pin> --jq '.assets[] | .name, .digest'`).
4. Vulnerabilities. `npm audit` in the scratch install, the GitHub advisory API
   (`/advisories?ecosystem=npm&affects=<name>`) and OSV (`api.osv.dev/v1/query`) all empty.
5. Install scripts and dependencies. `npm view <name>@<pin> dependencies` (fewer is
   better; agent-browser has none) and a read of `scripts/postinstall*` in the unpacked
   tarball: it must only touch its own directory and fetch from the package's own
   release URL, if anything.

agent-browser 0.38.1, the current pin, passed all five.
