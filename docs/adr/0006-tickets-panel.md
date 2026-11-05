# 6. One tickets panel

Accepted, 2026-11-04.

## Context

The Linear panel listed Linear issues only, read them from Linear's API itself, and sent its changes through a Claude
Code runner that used Linear's own tools. ADRs 3 to 5 made `orchi tickets` the only thing that reads or writes a
ticket, across four sources. Plan decision 11 asks for one panel over every chosen source, with the Windows port's
Legwork ideas: work, personal and business filters, cards that brief like `/pickup`, and Pickup, Go and Send to Orchi.

## Decision

- **A new mod, `tickets`, that retires `linear`.** The folder is renamed, so its history follows it. A panel of four
  sources named after one would mislead. The Mods step removes the old folder's files, which Orchi made; the Layout
  step replaces Orchi's own layout, whose block is now `tickets`; the Keys step moves `ctrl-shift-y` to
  `mod.open:tickets`. The layout file keeps its name, `orchi.json`, because a new name would drop the layout the
  user picked. Shared values move from `linear.*` to `tickets.*`; the review screen's choices start fresh once.
- **Tickets come only from `orchi tickets --json`**, run with `~/.local/bin` first on `PATH`, where `uv tool install`
  puts the command. The panel calls no source's API. Problems a source reports show above the list, and the others
  still list. The legwork tracker's frontmatter is still read for what a project is (its repo, category and
  `linear:` line): that is the tracker, not a ticket read.
- **A ticket's project** is the legwork project it belongs to, the first that holds: your pick in the panel; for a
  legwork ticket, itself; for Linear, a project whose `linear:` line names it; for GitHub, a project whose repo's
  `origin` is that repo; for Markdown, a project whose repo holds the file. Go needs one for every ticket.
  `linear.legwork_projects` no longer counts here, because `orchi tickets` gives a Linear project's name, not its id.
- **A ticket's category** is its project's `category:`. The filters are All, Work, Personal and Business; a ticket
  with no project, or another category, shows under All only. The status buckets (Active, Backlog, In review) go,
  because the four sources' states don't share them.
- **Source filters** are the sources `orchi tickets` read, each its logo with a count. A card shows the logo, never
  the prefix. Legwork and Markdown get glyphs drawn for Orchi; Linear's and GitHub's marks are theirs, named in
  NOTICE.md.
- **Actions by source.** Every card: tick it, and Send to Orchi. Legwork: the card briefs like `/pickup`, and Pickup
  and Go start Claude Code in the project's repo with `/pickup <project>` or `/go <project>`. Linear only: Status,
  which runs `orchi tickets move <ref> <state> --yes` (the press is the yes), and Open in Linear. GitHub: Open in
  GitHub. A new read-only action, `orchi tickets states <ref>`, lists a Linear ticket's team states in board order
  for Status.
- **Gone with the runner.** Staged status changes, Update tickets, the pull request links staged from workers'
  runs, and Create project. They wrote through Linear's own tools, which ADR 3 retires. The switchboard and `/wrap`
  already move a ticket when its pull request opens or merges, through `orchi tickets`. A new legwork project is
  `/add`, as everywhere else. A pick stays in the panel; the planner puts a Linear ticket on its project's `linear:`
  line when it isn't there, so `/wrap` syncs it.
- **Go carries references.** The brief's tickets are `{"ref", "project", "repo"}`, such as
  `{"ref": "gh:acme/app#7", ...}`, and the planner's terminal label is `orchi.tickets=<ref>,<ref>`. Readers still take
  a brief's old `id`. The panels hold a ticket by its full reference, so a GitHub, legwork or Markdown ticket in a
  session is held too. The task still carries only the session id; the planner reads each ticket with
  `orchi tickets show <ref> --json`.
- **A test hook.** In a private home (`/.config/hd/`) only, `tickets.script` runs the steps in `tickets-script.json`
  and `tickets.dump` writes what the panel shows to `tickets-state.json`, so a journey can be checked without clicks,
  which aren't reliable on the app.

## Consequences

- Nothing in the mods reads a Linear key, and the panel works with any mix of sources, legwork alone included.
- A Linear status change is immediate. There is no staging to discard.
- A Linear ticket can no longer be added to a legwork project from the panel except through a session's planner.
