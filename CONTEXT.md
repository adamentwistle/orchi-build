# Context

- **Orchi**: the product. Herdr's look and panels, the orchestration layer, the planning skills and the `orchi`
  command, all in this repo.
- **Legwork**: the tracker Orchi works from. A folder of project files, each with a next prompt and a log.
- **Ticket source**: a place work items come from. Legwork, GitHub, Linear or Markdown in the first release.
- **Ticket**: one work item from a ticket source, in the same shape whatever its source: its reference, source, id,
  title, state, whether it is open, url, when it was updated, the project or repo it belongs to, its labels, and its
  body when it is read on its own. `orchi tickets` lists them; see `docs/adr/0004-tickets-read-side.md`.
- **Ticket reference**: `<source>:<id>`, one ticket written as text: `linear:ENG-12`, `gh:owner/repo#12`,
  `legwork:<project>` or `md:<file>#<anchor>`. A bare `ENG-12` is Linear's.
- **Step**: one thing `orchi` checks and can fix, such as Herdr, the themes or the ticket sources.
- **Private home**: a throwaway Herdr and Claude home for tests, never a real one.
- **Usage cache**: the JSON file of how full each Claude usage window is, `~/.cache/orchi/usage.json`, kept fresh by
  usage-watch. usage-guard reads it, and ccstatusline's file only as a fallback.
- **Bundled piece**: a skill or script Orchi ships for every user: pr-drafter, ux-test, usage-guard and pane-notify.
  None names a person, an employer or a work path, and each runs from the installed package's own copy.
- **Check**: the part of a step that looks and changes nothing. It says ok, needs a fix, or broken.
- **Fix**: the part of a step that makes the change. Only bare `orchi` runs fixes; `orchi doctor` never does.
- **State folder**: `~/.local/state/orchi`, where `orchi` keeps its lock, its record of runs, what it owns and its
  backups.
- **Ownership record**: a line in the state folder naming a file, link or folder Orchi created, so uninstall removes
  only those.
- **Backup**: a copy of something a step is about to change, taken before the change, kept per run in the state folder.
- **The user**: whoever installed Orchi. The skills, commands and panels never name a person. A panel speaks to the
  user as "you"; a skill speaks to the agent reading it as "you" and calls the person "the user"; a command, which the
  user types, speaks as "me". A path, owner or team in them is the setting that holds it, such as `<legwork_dir>`.
- **Usage cache**: `~/.cache/orchi/usage.json`, how full each Claude usage limit is. usage-watch writes it; Herd, the
  Orchi panel, the chat pane, usage-guard and switchboard-wait read it.
- **usage-watch**: the launch agent that reads Claude Code's own login from the keychain and keeps the usage cache fresh.
  See `docs/usage-watch.md`.
- **Content**: the themes, mods, layout, keys, sounds, config and browser files Orchi ships as package data
  (`orchi.paths.data_dir()`). The Herdr steps copy it into Herdr's app home.
- **Private window**: a Herdr whose app home is not `~/.config/herdr-app`, such as one from `scripts/herdr-dev`. It
  shares `~/.local` with the real one, so Orchi leaves the launcher, the browser command and the skill alone there.
