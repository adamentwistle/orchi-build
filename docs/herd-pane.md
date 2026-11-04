# Herd panel

A side panel beside Tickets and Orchi, showing everything the session in view has started. The button sits with theirs in the tab bar, and it carries a red count when someone needs you. `panel-buttons` works that count out from the live terminals on every render, so it's right while the panel is hidden, and before Herdr has started the panel at all. The panel follows the focused session, and a focused worker shows its whole herd from the top. It stays beside a zoomed chat, because it isn't a pane in the tab.

The arrows at the top right take it to full width, which hides the terminals and lets the panel fill their room. Press them again to go back to the width it had. Opening another panel, or closing Herd, also brings the terminals back. `herdr-app do herd.full` does the same as the arrows.

It sits beside the progress pane rather than replacing it. The progress pane needs a session named `orch-<project>`, finds its own `fw-` workers, and has estimates. The Herd panel works on any session and walks the real tree, so it also finds a worker's own processes, such as `relay-bridge` under `fw-3-relay`.

## One colour, one meaning

Blue is thinking, cyan is reading, yellow is writing, purple is shell, grey is waiting. The same colours are on the map, in the words and on the ribbons. Red needs you, green is finished, hollow is queued. Light red reading `Quiet` means a working session has run no tool and written nothing for three minutes.

The same five icons are on the map's running nodes, so the colours aren't the only cue. A shell command that only waits, such as `hc wait` or `bugbot-wait`, counts as waiting, so an orchestrator doing its job doesn't look like one running a long command. An Agent call still open after 10 seconds is a foreground subagent run, so it reads `Waiting` and draws grey, not `Starting`.

## Reading it, top to bottom

- **The header:** the session, the plan's count, how many agents are running, this session among them, and how long it has run. The plan counts items, and Finished counts agents, so the two are different numbers.
- **Needs you:** a red card for each blocked session, saying why, with a Show button.
- **The map:** with no plan, the middle counts the agents going, this session among them, so a session on its own reads `1 running`. On its own it also says what it's doing, such as `Shell`, and the ring round the middle takes that colour. With a plan, the middle is the plan's count, inside a ring with one segment per plan item, each pointing at its node in that node's colour. The plan runs clockwise from twelve o'clock as a route round the orbit: solid where it's been, lit where it's going, dotted for what's left. Each running worker sits on its point in the colour of what it's doing, with that activity's icon inside, and grows with its transcript. The ring of short arcs round a node is its subagents, one arc each, and small squares going round it are its processes. Those round the middle belong to the session itself, one arc each from twelve o'clock in the order they started. A subagent that has a plan point of its own sits there, and isn't drawn round the middle as well. A worker's calls, and those of the subagents under it, spark in along its spoke. The session's own calls go out to a running node, and its subagents' send none, because they have no spoke. Rings and arcs are drawn in as many straight steps as it takes to stay within a quarter of a pixel of round. Only running nodes carry a label, and a press on any node names it. A press on a running node also opens its row. Past 28 places the last one reads `+N`, and a press names it `N more`.
- **The rows:** one per worker, with what it's doing now and for how long at the right, a ribbon of its last 30 minutes, and one line of status. Now is at the right of the ribbon, and a gap is thinking. Beside the time is how full its context window is, which turns yellow from 60%, as the sidebar's does. Once a turn is over, the status line ends with what it came to, such as `4m 10s, 12 tools, 1 failed`. A press on a call in the ribbon names it under the ribbon, as its tool and its file, the program a command ran, a pattern or a description, with how long it took and how long ago, and marks it. A second press, or a press on that line, hides it. A press opens the rest: the full status, the model and effort, the time so far, and Show terminal, which peeks at it over the tab.
- **Subagents and processes:** folded into one line under their worker, with a dot for each in the colour of what it's doing, and a press opens them. A fold stays open until it's pressed again.
- **Usage:** at the foot, the same meters as Orchi's: the 5-hour limit, the Fable weekly limit and the all-models weekly one, each with what's used, where its pace ends the window, and when it resets. They come from `~/.cache/orchi/usage.json`, which usage-watch keeps fresh (see `docs/usage-watch.md`), read at most every 15 seconds, so the Claude Code status line no longer needs to show them. A limit the file gives no reset time for is one the account doesn't have, so it's left out, as Orchi leaves it out. An account with no 5-hour limit gets `sessionUsage` 0 and no `sessionResetAt` there, so only Fable and All show. The helper is `mods/herd/meters.js`, a copy of `mods/orchi/usage.js` with `metersFrom` added.
- **Finished:** folded into one row with a count. Each entry has a bar sized against the longest, red if the terminal exited with an error. Past 40 the last line reads `+N`.

## Where the data comes from

| What | From |
| --- | --- |
| Who belongs to whom | `parent` in `hc ls --all --json` |
| Status, start, end, exit code, pid, arguments | `hc get` per terminal, once for a finished one |
| The session behind a terminal | `<claude_dir>/sessions/<pid>.json`, or the same under `~/.claude` |
| Tool calls, what each was for and whether a command only waits, model, transcript size, the last finished turn, tokens in context, subagents | `herd.py`, from the transcript and its `subagents` folder |
| The plan | `<cwd>/.legwork/fanout-state.md` |

`herd.py` reads the last 3 MB of a transcript and parses only lines naming a tool or a turn's length, plus the last reply with usage, from the end. It reads a running subagent's log but not a finished one's, nor one from an earlier transcript, which never gets `finished` and counts as ended. A read of a real transcript takes under 100 ms. It runs every 3 seconds, one at a time.

A plan file outlives its run, so it only counts for a session named `orch-`, or once someone in the tree is doing one of its items.

A session cleared part way starts a new transcript. `herd.py` follows the transcript that stopped within 60 seconds of this one starting, back to the process's start, for its subagents. Two sessions in one folder could be mistaken for each other this way, and a worker has its own folder, so it would take two people in one checkout.

## The extra figures

- **A turn's summary** comes from Claude Code's `turn_duration` line: its end and length, and the calls and `is_error` results inside that span. A turn that started before the 3 MB read counts only what's in it.
- **Context** is the input, cache creation and cache read tokens of the last reply that isn't a subagent's, as a share of 80% of the window, which is how the status line's `context:` reads. 73,893 tokens on a 1M window reads 9%, the status line's 9.2% rounded. The window is 1M for a model from generation 5 on, one marked `[1m]`, or one seen past 200k anywhere in the herd, and 200k otherwise. That is the rule `contextShare` in `mods/space-agents/tree.js` uses, so the sidebar and Herd show one number. The helper is `mods/herd/usage.js`, a copy that imports nothing.
- **What a call was for** is a path from the session's folder, or from home, a command's program and subcommand only (`git push`), a search pattern, an Agent description or a skill name. The rest of a command isn't kept.

## When a read goes wrong

`hc` calls time out after 8 seconds and `herd.py` after 20, and the next read starts as normal. A failed `hc ls`, a missing python3, a crash or bad output shows as a red line over the last good read, saying what went wrong. A session missing from three reads in a row counts as closed, so one bad read doesn't blank the panel. A new herd clears what was kept about finished terminals, because addresses come round again.

The clock ticks once a second. A tick more than two minutes late means the machine slept, and that stretch isn't counted as quiet or in how long an agent has been at something, so a working session doesn't read `Quiet 9h` after a night shut.

## Zoom

On Herdr 0.1.12 the app scales a path's numbers by the zoom itself, as it does `.w()`, so `pen` in `mods/herd/view.js` draws in the app's own pixels. A press's `local_position` and `bounds` are both window pixels, so `pressOffset` in `mods/herd/score.js` keeps the share of `bounds` the press is along, which holds at any zoom. `on_size_change` is window pixels too, so the fold heights in `mods/herd/main.js` and the panel size in `paneView` divide it by the zoom.

## Motion

Everything moves natively. The comet going round the orbit while anyone is working, the sparks along the spokes, the glow on a running node and the middle, rows and folds opening, and process squares between their one second steps all use `.spin`, `.transition`, `.spring` or `.loop`, so the panel renders once a second and still moves at the display's rate. Nothing is read while the panel can't be seen, or once the whole herd has finished, and coming back into view reads at once.

## Design rules

- Not text heavy, so a row is one line and the rest opens on a press. Queued items carry no label.
- "Be visual and not just text": colour and the ribbons carry the state, and the words back them up.
- A plain word for what's happening beats a code: `Waiting 6m`, `Needs you`, `Orchestrator`.
- Small figures align right, with the name on the left.
- Theme colours only: colours come from `theme()`, and it reads as one set with the Orchi panel.
- Nothing pops up. Details push the rows below them down, with a smooth slide.
- It's a side panel first. Full width is a choice, and it goes back with a press.
- Things that take a lot of room fold away. A count says what it counts, so plan items and finished agents can't be mistaken for each other.
