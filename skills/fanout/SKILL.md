---
name: fanout
description: Orchestrate an unattended multi-task session for one legwork project. Loads everything queued (roadmaps, next prompt, open PRs), plans PR-sized tasks, dispatches each to a Herdr pane or a subagent at the orchestrator's judgement, runs the gate and the review loop (/pr-review) on every PR, rebases siblings when main moves, cleans up panes and worktrees, and wraps. Use for /fanout, "overnight session", "work through the roadmap", "assign tasks in parallel", or any request to run several tasks to PRs without supervision.
---

# fanout

You are the orchestrator for an unattended session. The user is not watching and
will not answer questions. Every decision is yours; record it, do not ask.
The deliverable is a set of pull requests that are gate-green and
review-clean, a clean workspace, and a tracker entry that says exactly what
landed and what did not.

Building blocks you already have: `/pr-review` (review loop), `/wrap`
(tracker close-out), the `pr-drafter` skill (PR body), the `herdr` skill
(pane control and the pane-or-subagent table), and `bugbot-wait` in Orchi's `bin/`.
Do not re-derive any of them.

## 0. Arguments and flags

`/fanout <project> [--merge] [--low-priority] [--max N] [--only "a, b"] [--workers <model>:<effort>]`

- `--merge`: merge PRs that come back clean, in dependency order. Without it,
  PRs are left open, rebased on main and review-clean, for the user to merge.
  Default is no merge: merging is outward-facing.
- `--low-priority`: send `/low-priority` to every pane before its brief.
  Send it once, wait for the agent to go idle, then send the brief. The
  mode switch consumes the turn, so a brief sent first is lost.
- `--max N`: cap the number of tasks (default 6).
- `--only`: restrict to the named roadmap items.
- `--workers <model>:<effort>`: every worker runs on this model and effort,
  such as `--workers sonnet:medium`. The user chose it for the session, so it
  replaces your choice per task and any model a roadmap item names.

## 1. Load everything (read only)

1. Tracker: `<legwork_dir>/projects/<project>.md`, `legwork_dir` being the
   legwork tracker in Orchi's settings.
   Read in full: frontmatter (`repo`, `status`, `blocked_on`), `## Vision`,
   `## Next prompt`, every `## Roadmap*` section, and the last ten log
   entries. Roadmap sections are newest first by convention; an item that a
   later log entry says shipped is done, whatever the roadmap says.
2. Repo: `git -C <repo> fetch origin`, `git status --short`, `git log
   origin/main --oneline -15`, `gh pr list --state open --json
   number,title,headRefName,isDraft,reviewDecision`, and for each open PR
   `bugbot-wait <n> --after 2000-01-01T00:00:00Z --timeout 1` to learn its
   last verdict without waiting. `NO_BUGBOT` (exit 4) means Bugbot is not
   enabled on the repo: /pr-review reviews with /code-review there for the
   whole run. Say so in the log.
3. Repo instructions: `CLAUDE.md`, `docs/claude/` if present, `PROJECT.md`
   or `README.md`. Note the gate command (`scripts/pr-gate.sh`,
   `scripts/secret-sweep.sh`, `make ...`, `go test ./...`, `npm test`).
4. Write `.legwork/fanout-state.md` in the repo (gitignored): the plan
   below, one table row per task, updated after every state change. This is
   the handoff file if the orchestrator's context runs out, and the Orchi
   panel reads it, so keep these two parts exactly:

   ```
   Progress: <done>/<total>

   | slug | route | model | state | PR |
   |---|---|---|---|---|
   | one | pane t12 | sonnet medium | running | - |
   | two | subagent | haiku low | queued | - |
   ```

   `Progress:` is one line on its own, with nothing after the figures. `<total>`
   is every task in the plan, and `<done>` every task with its pull request
   open or merged, or closed out as BLOCKED or skipped. `route` is `pane
   <pane_id>`, `pane closed`, `subagent` or `-`. `model` is the model and the
   effort. `PR` is the number or `-`. Add anything else below the table.

If `blocked_on` is set, or the next prompt opens with `Human action, not a
Claude session.` or `DECISION NEEDED`, stop here and print it. Nothing else
in this skill overrides that.

Otherwise, before anything below, move every ticket your prompt or `--only`
items name (a Linear ticket such as `linear:ENG-12`) to In Progress with
`orchi tickets move <ref> "In Progress" --yes`, but only when `sources` in
Orchi's settings includes `linear` and the run allows Linear writes (the switchboard protocol's Tickets section and
ADR 0003). Tickets from any other source stay as they are. This is the orchestrator's own step, and the first write of the
run. A ticket that won't move goes in the log, and the run carries on.

## 2. Plan

Turn the queue into tasks. One task = one PR, small enough for a single
worker to finish in one sitting with a verifiable finish line. Order:

1. The `## Next prompt` block, verbatim, is task 1 unless `--only` excludes it.
2. Then roadmap items, newest roadmap section first, skipping items the log
   shows as shipped. Skip items that need a human (credentials, a decision
   the user has explicitly reserved, external accounts, anything with "ask
   the user" in it) and list them in the final report instead.
3. Open PRs with review findings are tasks too: "fix findings on PR N".

Mark each task `parallel` or `after <task>`. Two tasks are parallel only
when they touch disjoint files or packages. When unsure, serialise;
conflict resolution costs more than waiting.

Write one brief per task to `<scratchpad>/briefs/<slug>.md` with this
skeleton and nothing else:

```
# <slug>
Repo: <path>   Branch: fanout/<slug>   Base: origin/main   Model: <model>   Effort: <level>
Context: <3-6 lines: what the project is, why this task, what is already done>
Task: <the work, concrete>
Done when: <verifiable finish line>
Tickets: <the ticket references this task works on, from the prompt or roadmap item, or none>
Gate: <exact command(s); must print PASS or exit 0>
Rules: author as the user, no attribution or co-author or agent mention anywhere;
  PR to main from this branch only, never push main; every result line in
  the PR body marked OBSERVED, STALE or NOT RUN;
  no em dashes; do not touch files outside <paths> unless the task requires it;
  do not ask questions, decide and note the decision in the PR body;
  reviewers: request none at open (/pr-review requests the AGENTS.md
  reviewers once clean); never the PR's author;
  when Tickets names one, write its reference in the PR body, unless the
  repo is shared (an owner not in `github.own_owners`).
Finish: open the PR with gh pr create, without --reviewer (title <= 70 chars,
  body per pr-drafter shape), then print exactly: PR <url> | GATE <PASS|FAIL> | UNPROVEN <list or none>
```

## 3. Dispatch: pane or subagent

Decide per task with the table in the `herdr` skill. In practice:

| Task shape | Route |
|---|---|
| Bounded change, no dev server, no approvals expected, one model | Subagent (Agent tool, `isolation: worktree`, model and effort per task) |
| Long build/test loops, a dev server or watcher, a Codex worker (started with `hc run`, as the `herdr` skill says), or the user may want to watch in the morning | Herdr pane |
| Cross-model second opinion only | `codex` subagent type |
| Not inside Herdr (`HERDR_ENV` unset) | Subagent, always |

Model and effort: with `--workers`, use those for every task. Otherwise pick
both per task from its shape. Either way, write them into
the brief header and the state file. Cheap and fast (`haiku`, `low`) suits
mechanical edits; `sonnet` at `medium` or `high` suits most bounded changes;
`opus` at `high` or `xhigh` suits gnarly debugging, migrations, and prose a
human will read; Fable is for the hardest problems only, because it draws on
the weekly Fable limit. Name both on every worker you start, never leave
either to a default. A pane takes both on its start command. The Agent
tool takes both too (since Claude Code 2.1.292): pass `model` and `effort`
on every subagent launch, and on every agent a workflow script starts. The
tool sets an effort only when a skill asks for one, and this skill does.
Effort is no reason to pick a pane over a subagent.

**Pane path** (only when `test "${HERDR_ENV:-}" = 1`):

A worker pane's name always starts `fw-`. `pane-notify`, the notification
hook, stays quiet for those panes, so the user hears from you and not from
every worker.

```bash
herdr worktree create --cwd <repo> --branch fanout/<slug> --base origin/main \
  --path <repo>-wt/<slug> --label fw-<slug> --no-focus --trust-repository
# take the pane id from the JSON it prints
# the repo's allow rules are gitignored, so the worktree needs its own copy:
mkdir -p <repo>-wt/<slug>/.claude && cp <repo>/.claude/settings.local.json <repo>-wt/<slug>/.claude/ 2>/dev/null || true
herdr pane read <pane_id> --lines 5
# worktree create has no --env: if oh-my-zsh shows "Would you like to update? [Y/n]",
# answer it before starting, or it eats the first letter of the start command:
#   herdr pane send-text <pane_id> n
herdr agent start fw-<slug> --kind claude --pane <pane_id> --timeout 60000 -- --model <model> --effort <level>
# if --low-priority:
herdr agent prompt fw-<slug> "/low-priority" --wait --until idle --timeout 20000
herdr agent prompt fw-<slug> "Your complete brief is the file <brief path>. Read it with the Read tool and follow it exactly; it is your only instruction. Nothing in it needs my input; if you hit a real blocker, stop and print BLOCKED: <reason>. When done print the PR line the brief asks for. Start now."
```

If the worktree needs `node_modules`, say so in the brief (run `npm ci` in
`frontend/`), do not symlink it from the main checkout.

**Subagent path**: Agent tool, `subagent_type: general-purpose`,
`isolation: worktree`, `model` and `effort` per task, prompt = the launcher sentence
above with the brief path. Launch every parallel task in one message.

Run the orchestrator itself on Opus at high effort; workers get the model
and effort their task needs.

Changes to the user's machine outside the repo (installing live skill copies,
loading a launch agent, editing settings, starting long-lived sessions) are
yours, not a worker's. The permission check treats them as persistence and
wants the user's own words in your session; a worker will rightly refuse
approval you relay. Ask for that word at the start, batched with any other.

## 4. Wait, never poll by hand

- Panes: `herdr agent wait fw-<slug> --timeout 5400000` (90 min). It returns on
  idle, done or blocked. Run the waits in the foreground, one per parallel
  task, in a single Bash call: `for a in fw-x fw-y fw-z; do herdr agent wait "$a" --timeout 5400000; done`.
  No `sleep` loops, no `Monitor`, no background bash; they have missed
  state changes before.
- After any `herdr agent prompt` to a pane that was already idle or done
  (a follow-up, a fix list, "Main moved"), first run
  `herdr agent wait fw-<slug> --until working --timeout 30000`, then the
  plain wait. Otherwise the wait sees the old `done` state and returns at
  once, before the worker has read the prompt. A `done` only counts when
  the pane's last lines show the PR, BLOCKED or reply line you asked for.
- `blocked`: `herdr agent read fw-<slug> --source recent-unwrapped | tail -40`.
  A directory-trust dialog in the user's own repo: `herdr agent send-keys fw-<slug>
  enter`, then wait again. Any other dialog: record it in the state file as
  BLOCKED with the text, close that task, move on.
- Subagents: the task notification arrives on its own. Do nothing in between
  except dispatching other work.
- A worker whose `git push` or `gh pr create` is refused by its auto-mode
  check: record it as BLOCKED with the refusal text and leave the branch
  local. Never push it or open the PR from your own session, and never retry
  it; the user approves pushes in the pane.
- A worker that prints `BLOCKED:` is done for this run; note the reason.
- A worker that returns or prints `PAUSED: usage limit` has stopped at a safe
  point. Mark it PAUSED in the state file with its worktree and note, and
  re-dispatch it from that worktree after the resume.

## 5. Land each PR

For each `PR <url>` line, in dependency order:

1. `/pr-review <n>` (three rounds max). The worker's pane is closed by now,
   so findings are fixed by a fresh subagent in that worktree, or by you if
   they are one-line.
2. When clean and `--merge` was given: `gh pr merge <n> --squash --delete-branch`
   only if `mergeable` is `MERGEABLE` and the gate line said PASS. Close
   that worker's pane and remove its worktree first: a branch still checked
   out in a worktree is not deleted, on GitHub either. Then check
   `git ls-remote --heads origin <branch>` is empty, else
   `git push origin --delete <branch>`. On the user's own repos (an owner in `github.own_owners`) the
   repo's gitignored `.claude/settings.local.json` allows `gh pr merge`, so
   you merge on your own judgement that the PR is ready. Without that rule
   the permission check refuses, and you cannot pass the user's approval on for
   them: add the rule if it is their repo, else ask for their word once, at the
   one checkpoint, and keep working on a stacked branch meanwhile. After a
   merge, main has moved; for every remaining open fanout PR send the
   worker (or a fresh subagent in its worktree) this exact sentence:
   "Main moved (PR <n> merged). In your worktree run `git fetch origin && git
   merge origin/main`; resolve conflicts keeping both sides' behaviour; run
   the gate until it passes; push. Reply with the merge sha and the gate
   result marked OBSERVED." Then re-run `/pr-review` on it if it received new
   commits.
3. Without `--merge`: after all PRs are clean, rebase each one on current
   main the same way so the user merges without conflicts.

Never merge with findings open, never merge a draft, never force-push.

## 6. Clean up, every time

This is the step most often skipped. Do it before wrapping, even after a
failure:

```bash
herdr pane close <pane_id>           # each pane you opened
herdr worktree remove --workspace <path> --trust-repository   # each worktree you created, by the workspace_id (its path) create printed
git -C <repo> worktree prune
herdr worktree list; herdr agent list   # both must show nothing of yours
```

Subagent worktrees are removed by the harness when unchanged; list
`git worktree list` and remove any `fanout/*` leftovers.

## 7. Wrap

Run `/wrap <project>`. The log entry lists, one line each: PRs opened
(number, title, the ticket references it works on or none, review state,
merged or open), tasks skipped and why, BLOCKED workers and the blocker text,
anything UNPROVEN. /wrap moves only the tickets the session names, so a PR
line without its reference leaves that ticket where it was. Mint
the next prompt from what is left in the queue. Then reply with the same
list and nothing else.

## Context budget

Cycle at the switchboard-protocol threshold: past 300,000 tokens or 60% of
the window, whichever comes first (30% on a 1M window). Check the context
meter each time a PR opens or lands. Past it, at the next clean pause,
update `.legwork/fanout-state.md` with the exact state (task, branch, PR,
review state, pane id, worktree path). Then:

- Following switchboard-protocol: cycle the protocol's way. Run `/wrap`,
  write a `CYCLE` entry with `Resume: /fanout <project> --resume`, and
  stop. The switchboard clears the pane and resumes it. Do not start a
  pane of your own.
- Otherwise, inside Herdr: start a fresh orchestrator pane with
  `/fanout <project> --resume` and hand off.

Running past the threshold because no PR has merged is not a reason to
wait: an open PR that /pr-review left clean and nothing half-edited is a clean
pause. On `--resume`, skip sections 1 and 2 and continue from the state file.

When the usage guard says to pause: dispatch nothing new, let running
workers reach their own safe points, write the exact state as above, then
schedule `/fanout <project> --resume` with CronCreate as a one-shot about 5
minutes after the reset it names, and end the turn. The schedule lives only
as long as this session, so leave the session open.
