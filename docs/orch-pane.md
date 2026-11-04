# Orchestrator progress pane

A pane beside an orchestrator's terminal. At the top is the run: a ring of what's done and running, how long it has taken and about how long is left. Under that is one row per task, active first, then done, then not started. Every task has a lane on one shared time scale, so you can see what ran when and what overlapped. An estimate shows as dim ticks after the lane.

The button is at the right of the tab bar, in any tab holding a session named `orch-<project>`. A press opens the pane to the right of the terminal, and another closes it. If the tab is zoomed, as it is on the chat, the pane swaps in instead, because a split stays hidden behind a zoom. Closing it hands the view back.

## Where the data comes from

| What | From |
| --- | --- |
| The plan and its count | `<repo>/.legwork/fanout-state.md`: the `Progress:` line and the table |
| The newest update | The newest `UPDATE` on `<repo>/.legwork/switchboard.md` |
| Subagents | `agents.py`, from `<project>/<session>/subagents/agent-<id>.meta.json` and the `.jsonl` beside it |
| Pane workers | Live `fw-<slug>` terminals whose `parent` is this orchestrator, with `created_ms` from `hc get`, and `finished_ms` once one has gone |

Claude Code adds `finished` to a subagent's meta file when it ends, so a meta file without it means running. The start is the first timestamp in the subagent's own log, and the end is that log's last write. None of this reads the session's transcript, so a 55 MB transcript costs nothing. The helper takes about 35 ms on a run of 13 subagents.

A subagent joins a plan row when its description names the row's item, as "Item 1 tracking build" does for `r13-tracking (item 1)`, or names its slug. Anything else, such as a reviewer, gets its own row and doesn't count towards the plan's progress.

A run cleared part way keeps its earlier subagents: the helper also reads other sessions in the same project folder with the same custom title, touched since the run started. A pane worker's terminal goes when it ends, so the pane keeps the times it saw in `localStorage`, under a key for its own orchestrator, so two panes can't overwrite each other. One that ended while the pane wasn't reading gets its real end from `hc get`, once. A worker that ended while no pane was open has no times.

## Estimates

An estimate comes from the plan's tasks finished in this run: the median on the same model, or on every model when none matches. A subagent the plan doesn't name, such as a reviewer or an Explore run, gets its own row but doesn't count, so it can't pull the usual time down. Before anything has finished, no estimate shows at all. Past 1.25 times the usual time a task reads "running long". The run's time left is its slowest active task, plus the waiting tasks' usual times shared between the workers running now. A subagent that was stopped and sent more work counts its whole span, which stretches the estimate.

The clock ticks once a second, and a tick more than two minutes late means the machine slept. Those stretches are kept with the workers' times, and left out of every task's length and of how long a running one has gone, so a run across a night shut doesn't stretch the estimate.

## Reads

The pane reads every 5 seconds while its tab is in view and nothing else there is zoomed, and at once when it comes back into view. `hc` calls time out after 8 seconds and `agents.py` after 20, so one hung call can't freeze it. A missing python3, a crash or bad output shows as a red line over the last good read. The orchestrator's terminal has to be missing from three reads in a row to count as closed, and then the pane stops reading until it's back.
