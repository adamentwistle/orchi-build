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
- **Tickets panel**: the panel that lists every chosen source's open tickets, read through `orchi tickets --json`.
  It replaced the Linear panel; see `docs/adr/0006-tickets-panel.md`.
- **A ticket's project**: the legwork project a ticket belongs to: the user's pick, the project itself for a legwork
  ticket, the `linear:` line for Linear, the repo's `origin` for GitHub, the repo folder holding a Markdown file.
- **Category**: a legwork project's `category:` (work, personal or business). A ticket's category is its project's.
- **Write**: a comment, a state change or a new ticket, made by `orchi tickets` on Linear or GitHub only. It is a
  plan until `--yes` or a yes typed at a terminal; see `docs/adr/0005-tickets-write-side.md`.
- **Sync**: `orchi tickets sync legwork:<project>`, which moves the Linear issues on a project's `linear:` line the
  way `/wrap` does.
- **The session's sources**: the ticket sources one planning session reads, the chosen ones unless the user
  unticked or added one at its start. They are passed with `--source`; settings don't change.
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
- **System seam**: `orchi.system` (programs, downloads, platform) and `orchi.tickets.keychain` (the keychain), the only
  doors setup uses to reach the computer. Tests replace them, and both refuse while `ORCHI_NO_SYSTEM` is set.
- **Update**: `orchi update`, which moves the installed `orchi` to the newest release and then runs the steps with the new
  code. See `docs/adr/0007-update-and-uninstall.md`.
- **Uninstall**: `orchi uninstall`, which removes what the ownership records say Orchi made and is still unchanged, and
  lists what it kept. The `orchi` command itself goes with `uv tool uninstall orchi`.
- **Installer**: the maker's own script or command for a tool, such as Homebrew's script or `claude.ai/install.sh`.
  Setup runs one only after the user says yes to that tool.
- **Outside text**: any text that comes from somewhere else, such as a Linear or GitHub name, title, state, label or body,
  a legwork or Markdown file's text, or a server's reply in an error. Orchi writes it to a terminal only through
  `orchi.plain` (control characters become spaces, so an escape code is shown as text and never acts), and to JSON
  with `plain.dumps`, which escapes them (`orchi tickets --json` uses `json.dumps` with its ASCII escapes, which does
  the same). Either way the JSON reads back as the exact text.
