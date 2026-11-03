---
name: switchboard-protocol
description: Use when running as a project orchestrator that reports to the switchboard, such as a long unattended run, a /go or /fanout session in a Herdr pane named orch-<project>, or any prompt that says to report to the switchboard.
---

# Switchboard protocol

You run one project for hours while the user works from a single switchboard thread.
The switchboard reads what you write to the switchboard file and relays answers back
into your pane. Decide what you can, and send up only what changes direction.

## Setup, once per session

- Your session is named `orch-<project>`, where `<project>` is the legwork
  slug. The user or the switchboard sets it with `/rename`, and it shows as your Herdr
  title. If `herdr pane current` shows a different title, write an `UPDATE`
  saying so.
- The switchboard file is `<repo>/.legwork/switchboard.md`. Create it if
  missing. The repo must gitignore `.legwork/`.
- Before any other work, write an `UPDATE` that says the run started and
  what it is for. The switchboard reads a `DONE` as the end of the run, so
  an old `DONE` must not stay the latest entry while you work.
- If this session is the step one of your open entries asked the user to start,
  such as an `ACTION` that says to run `/go`, your first entry closes it: a
  `DECIDED` whose first line is `Replaces <id>`.
- Your start prompt may name a run rules file, under
  `<claude_dir>/switchboard/run-rules/`. It holds what the user chose when they
  pressed Start: `workers`, then `prs` and `extra`, which are their own words.
  They win over the plan's run rules, and `prs` says what happens to pull
  requests. Follow `workers` unless it says `Auto`. Read it again after a cycle.
- Read `CONTEXT.md`, any ADRs and the project's `## Vision` before deciding
  anything. They are what you decide from.
- Reviewers: open pull requests with none; /pr-review requests the
  reviewers the repo's AGENTS.md names once it is clean on the current head.
  Never request the PR's author. PR bodies and
  commit messages go out without the user seeing them first.
- If the start prompt says you may merge pull requests that pass the gate,
  that covers every merge in this run. Do not escalate merges.
- After each merge, delete its branch yourself. `gh pr merge
  --delete-branch` leaves the remote branch behind while a worktree still
  has it checked out, and a squash merge leaves the local one. From the main
  checkout, never the worktree: remove the worktree, then
  `git push origin --delete <branch>`, then check
  `git ls-remote --heads origin <branch>` prints nothing and
  `git branch -D <branch>`. Run that check even when `--delete-branch`
  seemed to work. A branch you could not delete goes in your `DONE` with the
  error, never "left for the user" without one.

## Decide or escalate

Decide it yourself, and log it as `DECIDED`, unless one of these is true.
If one of the first four is, write a `DECISION` entry. If the last is, write
an `ACTION` entry:

- It has knock-on effects: a public interface, a data shape, another
  project, cost, an external system, or something hard to undo.
- It changes scope, the plan's direction, or the Vision's "Done means".
- The Vision's "Escalate when" names it.
- You cannot pick between the options on the evidence you have.
- It needs the user's hands: a step, an approval, a reinstall, a merge, a deploy.
  That never goes inside an `UPDATE` or `DONE`, because the switchboard only
  surfaces `DECISION` and `ACTION` entries, and never as an option in a
  `DECISION`, because the panel would have to guess a command out of a
  sentence. A choice that needs their hands afterwards is a `DECISION` first,
  then an `ACTION` once they have chosen.

Everything else is yours: implementation choices, ordering, library use
inside the plan, and fixes.

After writing a `DECISION` or `ACTION`, keep working on anything that does
not depend on it. Stop only when nothing is left that does not depend on it.

## Entry format

Append to the switchboard file. Newest last. The id is `<project>-<n>`.
Take `<n>` from the file each time you write: one more than the last
numbered heading in it, never from memory. The switchboard writes its `GRANT`
entries as `<project>-g<N>`, so they never take your numbers.
Stamp every entry with the output of `date '+%Y-%m-%d %H:%M'`, run at the
moment you write the entry. Never compose or estimate a time from memory.

```
## <id> DECISION <YYYY-MM-DD HH:MM>
Attempted: <what you tried or looked at>
Uncertain: <the one thing you cannot settle>
Options: A) ... B) ... C) ...
Recommendation: <letter and why, one line>
Blocks: <what waits on this>
Meanwhile: <what you are doing instead>

## <id> ACTION <time>
Why: <why it needs the user, in one line>
Do: <what to do, in one line>
Where: <the terminal or place it happens>
Run: <optional: one exact command, starting with ! when it runs in the session>
Blocks: <what waits on this>
Meanwhile: <what you are doing instead>

## <id> UPDATE <time>
<one or two lines: milestone reached, plan changed, run stalled>

## <id> DECIDED <time>
<what, why, the alternative you rejected; one line>

## <id> CYCLE <time>
Resume: <exact command, usually /go <project> or /fanout <project> --resume>

## <id> DONE <time>
<the /fanout wrap list: PRs, review state, skipped, blocked, unproven>
```

A `DECISION` or `ACTION` that supersedes an earlier one carries `Replaces
<id>` on the line after its heading. Writing it closes the earlier entry; do
not also answer or decide the earlier one separately.

In an `ACTION`, `Run:` is one line the panel shows in full and can paste
into the terminal for the user to press Enter, or copy. Any control character or
newline in it takes the paste away, so keep it one plain command. A step that
needs a secret never puts it in an entry: say where it goes, and the user handles
it in the terminal.

Answers arrive in your pane as `SWITCHBOARD ANSWER <id>: <answer>`. Act on
them. An `ACTION` closes with `SWITCHBOARD ANSWER <id>: completed: <text>`:
check the result yourself, and raise a new entry if it isn't right. Any other
answer to an `ACTION` is the user replying instead of finishing the step: act on
what they say, and raise a new entry if the step is still needed, because that
answer closed the old one. An
answer that arrives after your `DONE` ends with a new `DONE`, because the
panels read anything else as a run still going. The same goes for work the user
gives you in the pane after a `DONE`: when you have nothing left to do, the
latest entry is a `DONE`, or the run shows as going for ever. A
`SWITCHBOARD GRANT <id>: ...` prompt is a delegation the user gave
the switchboard, already recorded in the switchboard file; note it and carry on.
Only the switchboard writes the `ANSWERED` line; you never write one, even
when the user answers in the pane directly instead of through the switchboard. In that
case, write a `DECIDED` entry whose first line is `Replaces <id>`, then a
line `User: "<their words>"`, quoted as they wrote them, as a `GRANT` entry
does. Without the `Replaces` line the entry stays open.

## Pause and resume

`SWITCHBOARD PAUSE` means the user wants this run stopped safely. Dispatch nothing
new, let running workers reach their own safe points, and write the exact
state to `.legwork/fanout-state.md`, the same pause `/fanout` makes before a
usage limit but with nothing scheduled. Then write an `UPDATE` whose first
line is `Paused.` and end your turn. The switchboard records the pause once it
sees that entry and your pane stopped.

`SWITCHBOARD RESUME` means carry on: write an `UPDATE` saying so, and pick up
from the state file.

## Context cycling

Cycle once context passes 300,000 tokens or 60% of the window, whichever
comes first. On a 1M window that is 30%, on a 200k window 60%. Quality
drops long before a big window fills. Finish the current step and find a
clean pause, meaning a task landed and nothing is half-edited. Then:

1. Run `/wrap <project>` so the next prompt carries the exact state. The
   minted prompt's first line must be `Follow the switchboard-protocol
   skill.` so the next session keeps reporting.
2. Write a `CYCLE` entry with the resume command.
3. Stop. The switchboard sends `/clear` and the resume command.

## Usage budget

Read `budget:` in the frontmatter of `projects/<project>.md` in the legwork
repo. Check usage with `<orchi_dir>/bin/usage-guard --check` at every
cycle and after every pull request lands (`<orchi_dir>` is Orchi's checkout,
from Orchi's settings).

- `budget: <N>`: once the weekly all-models or Fable figure passes N%, write
  a `DECISION`: A) land what is open and stop, B) carry on, C) stop now.
- `budget: off`, or no `budget:` line: no threshold.
- Whatever the setting, at 99% on either weekly figure: finish the current
  step, write a `DECISION`, and start nothing new until it is answered.
- When a `DECISION` is a budget or spend question and the user has not
  answered by the time work would stall, take the least-spend reversible
  option, mark the `DECIDED` entry "provisional, taken while the user was
  unanswered", and carry on. Credentials, security defaults and anything
  outward-facing still wait for an answer.

## Running /fanout under this protocol

Where the fanout skill and this protocol disagree, this protocol wins:

- **Context:** use `CYCLE` with `Resume: /fanout <project> --resume` instead
  of fanout's fresh-pane handoff. Update `.legwork/fanout-state.md` first.
- **Items that need a human:** write an `ACTION` instead of only listing
  them in the final report.
- **Review loop:** `/pr-review` on every PR. It decides the review: Bugbot
  when GitHub shows it on the repo, `/code-review` otherwise.

## Tickets

`orchi tickets` is how you read and write tickets, with `--json`, whatever
their source. Never use a source's own tool for them.

The tracker log and the pull requests are the record of the run. Tickets in
Linear change only when both hold:

- `sources` in Orchi's settings includes `linear`.
- The user allowed Linear writes for this run, in the start prompt, the run
  rules or the plan's run rules. A run whose prompt or plan says "No Linear
  writes" makes none.

Then, as your first step, before any other work, move the tickets your start
prompt names to In Progress. For each PR, reuse the roadmap item's ticket, or
create one on the first team in `linear.teams`: title is the PR title,
description is one line on what and why plus the PR link. Do this at dispatch
time, before the PR opens. Move it to In Progress when the PR opens, and to
Done when it merges (or a "Delivered" style final state when the PR is handed
to a maintainer unmerged, if the team has one, otherwise leave it In Review).
Add a comment saying what landed and the PR number each time you move it.
Writes stay inside the teams in `linear.teams`.

Without both, write nothing to Linear, and leave ticket moves to `/wrap`.

A ticket reference never appears in a PR title, body, commit or doc on a
shared repo (any owner not in `github.own_owners`); only on repos whose owner
is in `github.own_owners` and in the tracker.

## Quality gate, for every feature

1. **Grill first.** Run the `mattpocock-skills:grilling` skill on any new
   feature before planning it. On Fable, Opus 5.5 or gpt-6-astra, answer the
   questions yourself from the docs and the Vision, and record the answers
   in `CONTEXT.md` or an ADR (the `mattpocock-skills:domain-modeling`
   skill). On any other model, send steering questions up as `DECISION`s.
2. **Test first.** Write the failing test and commit it before the code.
   It must fail on the base commit for the reason the feature fixes. For a
   bug report, the first test is the reporter's exact phrasing or steps.
   Any state the change adds gets one test per re-dispatch path (recovery,
   reload, retry, cancel with a call in flight, reopen).
3. **Adversarial review before ready.** Have the `codex` agent review the
   diff. Verify each finding with a separate subagent before fixing it.
   Fix the confirmed ones and note the rejected ones in the PR body. Each
   confirmed finding is its own commit, regression test committed failing
   first. When Codex is unavailable (spend cap, outage), an Opus
   adversarial review with each finding verified by a separate subagent
   stands in. Record it as a `DECIDED`, not a `DECISION`, and name the
   kind of review it was in the PR body.
4. **UI changes:** verify the journey with the `ux-test` skill, in a
   private Herdr home (`<orchi_dir>/scripts/herdr-dev`), never the user's
   running app.
5. **Tests stay out of real user state.** Run them with `HOME` pointed at a
   temporary folder. Anything that touches a keychain, credential store or
   app config needs a test proving it used a scratch copy, before its first
   run. A brief saying so is not enough.
6. **Review loop:** also run `/pr-review`. It decides the review: Bugbot
   when GitHub shows it on the repo, `/code-review` otherwise.
7. **Renames and ID swaps** sweep every reference site: constants, tests,
   user-visible copy, docs and the comments that describe the old order.

A PR is ready only when all the steps that apply have passed, each marked
OBSERVED in the PR body, and the body names what was NOT RUN and why,
including steps only a maintainer can run.
