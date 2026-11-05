# 5. The Herdr content steps

Accepted, 2026-11-03.

## Context

Two shell scripts put Orchi's content into the Herdr app. Plan decisions 16 to 18 make that work steps on the
engine in ADR 2: it copies from the package's data folder, records what it owns, backs up what it overwrites and never
deletes a file it didn't put there. These are the answers that shape the eight steps.

## Decision

- **One step per kind of content**, in this order: Themes, Mods, Layout, Keys, Sounds, App settings, Launcher,
  Browser pane. Each check lists what is missing or out of date, so doctor names the file. Each fix writes only those
  files.
- **Copied, never linked.** `orchi update` replaces the package's data folder, and may move it. A link into it would
  dangle, and Herdr doesn't reload a linked mod. The old script linked the themes. They are copied now, and a link
  from an older install is backed up and replaced. The browser command and the launcher are small scripts that hold
  an absolute path, so the browser's files are copied to `~/.local/libexec/herdr-browser`, where they survive the data
  folder moving. The launcher points into the data folder on purpose: it fails when that folder goes, where a link or
  the real `herdr` would not. Its check compares the path, so the next `orchi` run after an update writes the new one.
- **Ownership replaces the stop-before-losing-files guard.** The old script copied with `--delete`, so it stopped when
  that would lose a file. A step now removes a file only when Orchi made it, nobody has changed it since, and the
  package no longer ships it (`Context.remove`). A file in a mod's folder that Orchi didn't put there stays, as do the
  files the app generates. A file at one of Orchi's paths that isn't Orchi's, or was edited, is backed up and then
  replaced, like any other change.
- **The layout asks.** When the installed layout isn't Orchi's and holds a mod the shipped layout lacks, replacing it
  would lose a panel. The step asks once, "Replace it and keep a backup" or "Keep mine". With no terminal, or on "Keep
  mine", the step is broken and says which mod. A layout Orchi wrote is replaced without asking.
- **Merged files keep what is theirs.** `keys.json` takes Orchi's bindings, which win for the keys they name.
  `settings.json` adds only what is missing, at any depth, so a mute or a picked sound stays. `programs.json` gets
  Orchi's `herdr-browser` entry, with `run` holding the command's full path, and its other programs stay. A file that
  isn't a JSON object is broken and left as it is. The merge is made again just before the file is written. These
  files are backed up before the first change, since the app made them.
- **A private window** (app home not `~/.config/herdr-app`) shares `~/.local` and `~/.claude` with the real one, so
  it gets no launcher, browser command or skill, and the menu entry only when the command is already installed. With
  no command the step has nothing to do, so a machine without the browser can still run a private window. The
  tests run with `HOME` and `HERDR_APP_HOME` both in a temporary folder, which is the usual home of a new user.
- **The browser pane needs agent-browser and node 22 or later.** The old script warned and went on. The step is broken
  and says which is missing, because a menu entry for a command that isn't there is wrong. B11 installs them.
- **The skill** goes to each Claude profile folder that exists: the `claude_dir` setting, `CLAUDE_CONFIG_DIR` and
  `~/.claude`. With none, `~/.claude` is made.

## Dropped

- The `--force` flag, `HERDR_INSTALL_FORCE` and exit code 3. Nothing is lost now, so nothing needs forcing.
- A mod folder that is a link is no longer removed. It is the person's, so the step is broken and names it.
- Removing the `layout:orchi` scope from `keys.json`. Nothing in Orchi writes it, and deleting a person's keys
  isn't Orchi's to do.
- The `herdr-app status` errors line at the end. B11 reloads the app and reports its errors once, at the end of a
  whole run.

## Consequences

- `scripts/herdr-dev` runs `python3 -m orchi` from the checkout under test with its own `ORCHI_STATE` and
  `ORCHI_SETTINGS`, so a private window's records, backups and settings folder never mix with the real ones.
- B12's uninstall finds every file these steps wrote in `owned.json`, and a file the person edited since is theirs.
- A person who edits a file Orchi owns in the instant between the ownership check and the change can lose that edit
  with no backup. `Context.write`, `link` and `remove` share this window, and the lock only keeps other runs out. A
  fix for all three together is a later change to the engine, not part of this one.
