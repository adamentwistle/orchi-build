# 5. Writing tickets: a plan, then a yes

Accepted, 2026-11-03.

## Context

ADR 0003 makes `orchi tickets` the only way a skill writes a ticket, and ADR 0004 gives it the read side. The
skills need three writes: a comment, a state change and a new ticket. Legwork's `/wrap` also keeps the Linear issues
linked to a project in step with it, through Linear's own tools. A write is outward-facing, so none happens by
accident: not from an agent that forgot a flag, and not from a test.

## Decision

Writes are Linear and GitHub only. Legwork and Markdown are files the user and `/wrap` edit, and a write to one is a
usage error.

- `orchi tickets comment <ref> <text>` adds a comment.
- `orchi tickets move <ref> <state>` sets the state, after a comment when `--comment` gives one. A Linear state is
  one of the team's, by name, and `--project <name>` puts the issue in one of the team's projects too. A Linear
  issue never moves to an earlier state on its board, such as Done back to In Progress, unless `--back` says so,
  so a skill's "move it to In Progress" can't undo later work. A GitHub state is `open` or `closed`.
- `orchi tickets create --team <key> <title>` or `create --repo <owner/repo> <title>` makes a ticket, with `--body`,
  and for Linear `--state`.
- `orchi tickets sync legwork:<project>` does the Linear part of `/wrap`, below.

Every write is a plan first: one line per change, such as `linear:ENG-12  state  In Progress to In Review`, and one
per ticket left alone with the reason. Then:

- `--yes` makes the changes, for agents.
- Without it, on a terminal, it asks once, and only `y` or `yes` makes them. `--json` never asks, so its output
  stays one JSON object.
- With neither, or with `--dry-run`, it prints the plan and changes nothing. Without `--dry-run` that exits 1 with
  "Nothing changed", so an agent that left out `--yes` can tell.

A write reaches only what settings choose: a source in `sources`, a Linear team in `linear.teams` when that names
any, a repo in `github.repos`, checked against where the ticket is now. Anything else is never written: it is named
as a problem, in a dry run too, and the command exits 1. A ticket's comment
goes before its state change; when one of its changes fails, the rest of that ticket's are not tried, the other
tickets' still are, and the command exits 1. The key and gh go through the same seams as reads (`linear.post`,
`github.run`), so the same fakes cover them.

### sync

`sync` reads the project's file and does what legwork's tracker skill says `/wrap` does to Linear:

- **Which issues.** Those on the file's `linear:` line that this session worked on: named in the newest log entry,
  named after the project on the command line (`orchi tickets sync legwork:birch linear:ENG-12`), or named in the
  title, body or branch of one of the session's pull requests. The session's pull requests are the GitHub pull
  request links in the newest log entry and any `--pr <url>`, read with gh.
- **Which pull request is an issue's.** The session's pull requests that name it. When none of them names any
  linked issue, all of them are every worked issue's.
- **The move**, the first that fits: a merged pull request is Done with its link; an open pull request that isn't a
  draft is In Review with its link; a project now `done` with a commit or release link in its newest log entry is
  Done with that link; a project `done` with neither stays In Progress and says why; anything else is In Progress. An issue already
  Done or Canceled, or Duplicate, is left alone. Nothing moves backwards or to Triage, so an issue already at or
  past the move on its board stays.
- **The comment**, only with a move to Done or In Review: `Legwork session <date>: moved to <state>.` and the link
  on the next line. The date is the newest log entry's.
- **The project.** An issue with no project goes in the one team project whose name is the legwork project's
  `name:`, when exactly one has it. Matching on a summary as well is left to a person.
- **Shelved.** A project at `icebox` cancels every linked issue not already Done or Canceled, with `Shelved in
  legwork on <date>.`

A pull request that can't be read stops the sync before any change, because without it the moves could be wrong.
An issue that can't be read is named and the others carry on.

`sync` is wired into legwork by one house-rules line, `docs/legwork-sync.md`, which setup offers. Legwork never
needs Orchi.

### The session's sources

`orchi tickets --json` names the sources it read, `sources`. A planning session that sweeps tickets opens by
showing those ticked; the user can untick one or add one, and the session passes its own set with `--source` on
every call. Settings don't change. A ticket session reads only the tickets ticked for it, so it has no sweep and no
check.

## Consequences

- An agent that forgets `--yes` writes nothing and is told so; a person at a terminal is asked.
- `sync --dry-run` shows exactly what a `/wrap` would change, so the first live sync on a new machine can be
  checked first.
- Linear's own tools are no longer needed by any skill. The Linear panel still has its own until the tickets panel
  replaces it.
