# Context

- **Orchi**: the product. Herdr's look and panels, the orchestration layer, the planning skills and the `orchi`
  command, all in this repo.
- **Legwork**: the tracker Orchi works from. A folder of project files, each with a next prompt and a log.
- **Ticket source**: a place work items come from. Legwork, GitHub, Linear or Markdown in the first release.
- **Ticket reference**: `<source>:<id>`, one ticket written as text.
- **Step**: one thing `orchi` checks and can fix, such as Herdr, the themes or the ticket sources.
- **Private home**: a throwaway Herdr and Claude home for tests, never a real one.
- **Check**: the part of a step that looks and changes nothing. It says ok, needs a fix, or broken.
- **Fix**: the part of a step that makes the change. Only bare `orchi` runs fixes; `orchi doctor` never does.
- **State folder**: `~/.local/state/orchi`, where `orchi` keeps its lock, its record of runs, what it owns and its
  backups.
- **Ownership record**: a line in the state folder naming a file, link or folder Orchi created, so uninstall removes
  only those.
- **Backup**: a copy of something a step is about to change, taken before the change, kept per run in the state folder.
