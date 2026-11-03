# 2. The Herdr app is the only Herdr the scripts talk to

Accepted, 2026-11-03.

## Context

The orchestration scripts were written for two Herdrs: the terminal program and the app. `bin/herdr` chose between
them from `ORCHI_HERDR` and `HERDR_PANE_ID`, `switchboard-lock` recorded which one held the switchboard, and
`pane-notify` worked only in the terminal program. Orchi dresses the app, and the app's `hc` does every job the
scripts need.

## Decision

Every call to `bin/herdr` goes to `bin/herdr-adapter`, which maps it onto `hc`. The wrapper never runs the real
`herdr`, which is the wrong Herdr in an app terminal. Only the adapter does, for `--help`, `--version` and `--skill`.

- `ORCHI_HERDR`, and the choice by `HERDR_PANE_ID`, are gone.
- `switchboard-lock take` takes one terminal. The lock file still says `"herdr": "app"`, because the panel reads it.
  A lock an older version wrote for a terminal Herdr pane counts as gone, because `hc` has never heard of it.
- `pane-notify` takes its terminal from `HC_TERMINAL_ID` and shows only the banner. The app plays its own sounds.
- `usage-guard` pauses at `usage_guard_percent` from the settings, for every usage window alike.
- The restart of the switchboard opens `orchi_dir` from the settings, not the folder above `bin/`, because an
  installed `orchi` keeps its scripts inside its package.

## Consequences

- There is one Herdr to reason about, and no environment variable decides which.
- An orchestrator still running in terminal Herdr is not watched, locked or notified.
- The five-hour window used to pause at 97 percent and now pauses at the same percent as the others, 95 by default.
