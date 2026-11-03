# 2. How `orchi` runs its steps

Accepted, 2026-11-03.

## Context

Bare `orchi` sets up or fixes and `orchi doctor` only checks (plan decisions 2, 17 and 18). Every later piece of
setup, from Herdr's content to the ticket sources, is a step on the same engine, and `orchi uninstall` must be able to
remove only what Orchi put there. These are the answers that shape it.

## Decision

- **A step** has a name, a check and, when Orchi can make the change itself, a fix. The check changes nothing and
  says ok, needs a fix (and what), or broken (and why). A step whose check says needs a fix but has no fix counts as
  broken. Bare `orchi` checks each step in order, fixes it when it needs it, then checks it again: a fix that doesn't
  take is broken. One step failing doesn't stop the rest.
- **The check is the truth.** The state file records each run, but no run skips a step because of it. A run that was
  stopped part way is simply run again: each step checks again and fixes what is still wrong.
- **One state folder**, `~/.local/state/orchi` (`$ORCHI_STATE` overrides, for tests), named only in
  `src/orchi/store.py`. It holds the lock, `state.json`, `owned.json` and `backups/`. Settings stay in
  `~/.config/orchi`, because a person edits those and Orchi writes these.
- **The lock** is an advisory lock (`flock`) on `lock` in the state folder, so the system lets it go when a run dies,
  however it dies, and a stale lock never needs clearing. Bare `orchi` holds it exclusively for the whole run. Doctor
  takes it shared, and only when the file is already there, so doctor never creates or writes anything.
- **Ownership records** list every file, link and folder a step created. A record is written straight after the
  thing is made, never before, so a run killed in between leaves a thing Orchi doesn't claim rather than a claim on
  something Orchi never made. Uninstall may then leave one of Orchi's files behind, but it never removes one of yours.
  Ctrl-C is held back while a thing and its record are being written, so it can't land between the two. Each record
  keeps what identifies the thing (device and inode, and for a file or link its size and modification time), so a
  file someone else puts at the same path later is theirs, not Orchi's: it is backed up before a change and uninstall
  leaves it. A change of mode or extended attributes leaves a file Orchi's; an edit to its contents makes it the
  user's.
  Changing a file Orchi already owns needs no backup and keeps it Orchi's, and so does a fix changing one named in
  `touches()` by other means; what such a fix makes at a path it named is recorded as Orchi's too.
- **Backups.** Before a step's fix runs, every existing path it names as one it may change, and that Orchi doesn't
  own, is copied into `backups/<run>/` under its full path. Writing any other existing file that Orchi doesn't own
  backs it up first too, so nothing is changed without a copy. The closing line names the run's backup folder. Files
  are replaced whole (temporary file, then rename), so a stop part way never leaves half a file. A new file or link
  is put in place only if nothing got there first; if something did, it is backed up like any other.
- **Output** is one line per step, a mark and the name in aligned columns, then what the check found or what the fix
  did, then one closing line. On a terminal it is coloured and the running step has a spinner. With `NO_COLOR` set,
  `TERM=dumb`, or output that isn't a terminal, it is the same lines with no escape codes. The colours are the
  terminal's own sixteen ANSI colours, which Orchi's themes set, so they are Orchi's palette in Herdr, dark or light,
  and nothing new is defined.
- **`--json`** is a global option, `orchi --json doctor`, as `cli.py` already plans for every command. It prints one
  JSON object with the same facts as the lines and nothing else on standard output.
- **Questions** are a numbered list read from `/dev/tty`, so they work under `curl | sh`, where standard input is the
  script. With no terminal to ask, the step is broken with one plain line naming the question; nothing waits.
- **Exit codes**: 0 when every step is ok, 1 when anything is still wrong or another run holds the lock, 2 for a usage
  error, 130 when stopped with Ctrl-C.

## Consequences

- B10 and B11 add steps to `src/orchi/steps.py` and use the fix context's write, link, folder and ask helpers, which
  take care of ownership and backups. A step that changes things by other means must name them in `touches()`.
- B12's uninstall reads `owned.json` and removes only what is listed and still Orchi's. A folder Orchi made, such as
  `~/.config` on a new machine, is recorded too, so uninstall removes a folder only when it is empty.
- A run killed between making a thing and recording it leaves that thing unclaimed: uninstall leaves it.
- Before the first run of bare `orchi` there is no lock file, so a doctor started then takes no lock. If a first run
  starts while it checks, its report can mix before and after. Doctor still changes nothing, and once any run has
  made the lock file, doctor waits for no one but says when a run is going. A bare `orchi` blocked by a doctor says
  a run is going without a pid, since doctor writes none.
