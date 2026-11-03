---
name: roadmap-planning
description: Use when preparing a roadmap or running a planning session for a legwork project, such as "plan the next roadmap for <project>", "prepare a roadmap", or any session whose output is a design doc, a tracker Roadmap N and a queued /fanout prompt.
---

# Roadmap planning

Roadmaps are prepared in a planning session, separate from the switchboard.
The switchboard is execution only. A planning session works in the
project's repo and ends by queueing a `/fanout` prompt for the switchboard
to start. Load the native skills `grilling`, `domain-modeling` and
`legwork-tracker` for it; use those, not copies.

1. Inputs: the tracker file `projects/<project>.md` (Vision, last log
   entries), the repo's `CONTEXT.md` and `docs/adr/`, and whatever Adam
   brings (feedback, a roadmap doc, known-gaps, a Slack thread). Look up
   facts yourself; put only decisions to Adam.

   Also sweep Linear in full, every session, with the Linear MCP directly:
   the teams in `linear.teams` in Orchi's settings, states
   Triage/Todo/Backlog/In Progress, no-project issues, and labels
   `src:slack`/`src:notion` (Adam's Slack and Notion commitments filed as
   issues). The sweep is read-only. Show Adam a
   cross-check table, one line per issue with the reason. A picked issue's
   id goes on the roadmap item. At the end of the session, propose one
   batched update for a single yes: picked issues to Todo in the right
   project, duplicates closed with a comment. Write to Linear only after he
   says yes to that batch, or if his message asks for writes.

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
   green, review clean); no merge word from Adam is needed at the start. An
   orchestrator cannot pass Adam's approval on for him, so a missing rule
   stalls the run.

3. Grill, one question at a time with a recommendation, glossary and ADRs
   written as they land (`domain-modeling`).

4. Output: a dated design doc with numbered decisions and a PR-sized,
   dependency-ordered build plan with a model per item. On a repo Adam
   owns (an owner in `github.own_owners`), it lives in the repo's ideas or
   specs folder and goes up as a docs-only pull request. On a shared repo
   (any other owner), it stays LOCAL under `.legwork/` (gitignored) with any ADR
   or CONTEXT.md, and no pull request is opened for it; the orchestrator's
   PRs carry code, tests and the repo's normal docs only. Run rules and
   briefs follow switchboard-protocol's reviewer rule: reviewers are
   requested once /pr-review is clean.

5. Tracker: a `## Roadmap N` section (newest first, one item per PR, run
   rules, what needs Adam) and a `## Next prompt` of
   `/fanout <project> --merge`, then wrap (`legwork-tracker`) and commit
   the legwork repo. The orchestrator runs on Opus at high effort
   (`Model: opus`, `Effort: high`); each item names the model that fits
   it for the worker that builds it.

   Mark any item that changes Adam's machine outside the repo (installing
   live skill copies, loading a launch agent, editing settings, starting
   long-lived sessions) as orchestrator-only, and list it under "Needs
   Adam": the permission check treats it as persistence and wants Adam's
   own words in the orchestrator's session, and a worker will rightly not
   accept that approval second-hand. The next prompt asks for that word at
   the start.

6. Tell Adam it is queued. The switchboard (the Claude Code pane
   `switchboard`) starts the run when he says "run
   <project>": open or reuse an `orch-<project>` pane, `/pickup <project>`,
   "run as written" with his merge authorisation, watch.
