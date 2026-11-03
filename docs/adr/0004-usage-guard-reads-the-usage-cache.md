# 4. usage-guard reads the usage cache, with one percent for every window

Accepted, 2026-11-03.

## Context

usage-guard asked a session to pause before a usage limit hit. It read ccstatusline's cache, so it worked only where
ccstatusline was installed. usage-watch now keeps Orchi's own cache, and ccstatusline is optional. ADR 0002 already
made `usage_guard_percent` the pause line for every window.

## Decision

- usage-guard reads `~/.cache/orchi/usage.json`. If that file is missing, older than an hour, holds an error or has no window left to judge (a usage that is a number
  with a reset still ahead), it reads `~/.cache/ccstatusline/usage.json` instead. If neither is usable it says nothing. Both paths are written once, in
  `bin/usage-guard`.
- `usage_guard_percent` stays the pause line for all three windows, as ADR 0002 set it. The five-hour window has no
  setting or derived value of its own. A window that resets within 15 minutes is left alone, so the five-hour window already avoids pausing when a
  pause would save nothing, and one number is easier to hold in your head than two.
- A window pauses at the percent exactly, not above it.

## Consequences

- A machine without ccstatusline is guarded as soon as usage-watch has written its first cache.
- Until usage-watch has run, a machine with ccstatusline is guarded as before.
