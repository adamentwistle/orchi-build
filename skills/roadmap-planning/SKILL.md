---
name: roadmap-planning
description: Use when preparing a roadmap or running a planning session for a legwork project, such as "plan the next roadmap for <project>", "prepare a roadmap", or any session whose output is a design doc, a tracker Roadmap N and a queued /fanout prompt.
---

# Roadmap planning

Roadmaps are prepared in a planning session, separate from the switchboard.
The switchboard is execution only. A planning session works in the
project's repo and ends by queueing a `/fanout` prompt for the switchboard
to start. Load the `mattpocock-skills:grilling` and
`mattpocock-skills:domain-modeling` skills from the mattpocock-skills plugin,
and legwork's `legwork-tracker`; use those, not copies.

1. Inputs: the tracker file `<legwork_dir>/projects/<project>.md` (Vision, last log
   entries), the repo's `CONTEXT.md` and `docs/adr/`, and whatever the user
   brings (feedback, a roadmap doc, known gaps, a thread). Look up
   facts yourself; put only decisions to the user.

   Also sweep the ticket sources in `sources` in Orchi's settings, every
   session, with `orchi tickets` (never a source's own tool): open tickets
   in every state before done, and for Linear the teams in `linear.teams`.
   The sweep is read-only. Show the user a cross-check table, one line per
   ticket with the reason. A picked ticket's reference goes on the roadmap
   item. At the end of the session, propose one batched update for a single
   yes: picked tickets to Todo in the right project, duplicates closed with a
   comment. Write tickets, with `orchi tickets`, only after they say yes to
   that batch, or if their message asks for writes.

2. First time on a project with no `## Vision`: run the `legwork-tracker`
   Vision step before grilling. Never run a project on the switchboard
   before this check: the repo has a PR gate and allow rules for its test
   and build commands, and `.legwork/` is gitignored. If not, make the gate
   roadmap item 1.

   Also check the repo's gitignored `.claude/settings.local.json` allows
   `Bash(gh pr create:*)`, `Bash(gh pr edit:*)` and
   `Bash(git push origin fanout/*)` pushes from worktrees, plus
   `Bash(gh pr merge:*)` only on repos whose owner is in `github.own_owners`
   when the roadmap says merge;
   and denies `git push origin main`, `git push --force` and `git push -f`.
   Add missing rules now, never commit them on shared repos. With the merge
   rule in place the orchestrator merges a PR when it judges it ready (gate
   green, review clean); no merge word from the user is needed at the start. An
   orchestrator cannot pass the user's approval on for them, so a missing rule
   stalls the run.

3. Grill (`mattpocock-skills:grilling`), one question at a time with a
   recommendation, glossary and ADRs written as they land
   (`mattpocock-skills:domain-modeling`).

4. Output: a dated design doc with numbered decisions and a PR-sized,
   dependency-ordered build plan with a model per item. On a repo the user
   owns (an owner in `github.own_owners`), it lives in the repo's ideas or
   specs folder and goes up as a docs-only pull request. On a shared repo
   (any other owner), it stays LOCAL under `.legwork/` (gitignored) with any ADR
   or CONTEXT.md, and no pull request is opened for it; the orchestrator's
   PRs carry code, tests and the repo's normal docs only. Run rules and
   briefs follow switchboard-protocol's reviewer rule: reviewers are
   requested once /pr-review is clean.

5. Tracker: a `## Roadmap N` section (newest first, one item per PR, run
   rules, a "Needs you" list) and a `## Next prompt` of
   `/fanout <project> --merge`, then wrap (`legwork-tracker`) and commit
   the legwork repo. The orchestrator runs on Opus at high effort
   (`Model: opus`, `Effort: high`); each item names the model that fits
   it for the worker that builds it.

   Mark any item that changes the user's machine outside the repo (installing
   live skill copies, loading a launch agent, editing settings, starting
   long-lived sessions) as orchestrator-only, and list it under "Needs
   you": the permission check treats it as persistence and wants the user's
   own words in the orchestrator's session, and a worker will rightly not
   accept that approval second-hand. The next prompt asks for that word at
   the start.

6. Tell the user it is queued. The switchboard (the Claude Code pane
   `switchboard`) starts the run when they say "run
   <project>": open or reuse an `orch-<project>` pane, `/pickup <project>`,
   "run as written" with their merge authorisation, watch.
