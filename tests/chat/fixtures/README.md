# Fixtures

Screens from Claude Code 2.1.316, read with `hc read` on throwaway Haiku sessions. The paths, names and figures in them
are made up.

- `picker-<model>-<effort>.txt`: the `/model` picker with the cursor on that model and the effort line at that level, read just before `s` was pressed, in the five-row layout (a session without the inherited child-session marker). 131 columns by 36 rows.
- `picker-long-*.txt`: the 13-row layout a session with the child-session marker gets, with full names. `picker-long-scrolled.txt` has the cursor on the last row, so the list has scrolled. `picker-long-haiku-low.txt` was read at 120 columns by 40 rows and copied from the screen text.
- `picker-narrow-*.txt`: pickers at 42 columns by 24 rows. Claude Code draws them another way, with family names only and the effort line cut off.
- `status-<model>-<effort>.txt`: the bottom of the screen with a `ccstatusline` status line, after the model and effort were set.
