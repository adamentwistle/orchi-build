---
name: herdr
description: "Use when running inside Herdr (HERDR_ENV=1) and the task needs a second coding agent the user can watch and steer (codex, gemini, another claude doing real implementation or debugging), a process that must stay alive or be typed into (dev server, watcher, REPL, CI or deploy poll, secret or login prompt, approval dialog), parallel research that will need follow-up prompts, or when the user names Herdr, panes, tabs, or workspaces. Not for bounded read-and-report work; subagents cover that."
---

# Herdr

Herdr organizes terminals into workspaces, tabs, and panes, recognizes coding agents running inside panes, and exposes the current session through the `herdr` CLI.

Before issuing any control command, verify that this agent is running inside a Herdr-managed pane:

```bash
test "${HERDR_ENV:-}" = 1
```

If the check fails, say that you are not running inside Herdr and stop. Do not inspect or control the focused Herdr session from outside Herdr.

When the check passes, the `herdr` binary in `PATH` talks to the current session. Use it to inspect neighboring work, create terminal layout, start agents and commands, read output, and wait for state changes.

## Herdr pane or subagent?

A subagent (the Agent tool, including the `codex` agent type) is the default for delegated work. Pick a Herdr pane only when one of these observable conditions holds; otherwise use a subagent.

| Condition | Use |
|---|---|
| Bounded read, search, review, or summarize; only the final report matters | Subagent |
| Cross-model verdict only (review, judge, second opinion), no follow-up expected | `codex` subagent type |
| Codex or another agent kind doing implementation, debugging, or a task over roughly five minutes | Pane, `agent start --kind codex` |
| The agent may hit approval or question dialogs the user should answer | Pane |
| Parallel research where follow-up prompts to the same worker are likely | Panes, one named agent each |
| Process must stay alive: dev server, watcher, `tail -f`, REPL, test loop | Pane, `pane run` |
| Waiting on external state: CI, deploy, PR checks, a file another tool will write | Pane, `pane run` + `pane wait-output` |
| Command prompts for a secret, login, or interactive answer | Pane; the user types it, never the agent |
| The user wants to watch the work or redirect it mid-task | Pane |
| The user names Herdr, a pane, tab, or workspace | Pane |

Never wait on a pane or agent with a `sleep` loop in the calling session. Use `agent prompt --wait`, `agent wait`, or `pane wait-output`; they return on the state change and keep the calling context free.

### Codex in a pane

Codex is installed (`codex` on PATH) and is a supported kind. Start it like any other agent, passing model and effort after `--`:

```bash
herdr agent start reviewer --kind codex --pane <returned-pane-id> -- -m gpt-5.6-terra
herdr agent prompt reviewer "<self-contained task with file paths and acceptance criteria>" --wait --timeout 600000
```

Codex shares no conversation context; the prompt must carry everything. Use a pane rather than the `codex` subagent type when the run is long, may need approvals, or the user wants to see it. Use the subagent type when only the verdict is needed.

Codex behaviours seen in practice, and what to do:

- `agent start` returns `agent_not_ready` and `agent get` shows `blocked` with a "Do you trust the contents of this directory?" dialog on first use of a directory. When it is the user's own project directory, answer with `herdr agent send-keys <name> enter`, then `agent wait <name> --until idle`. Any other dialog: read it and ask the user.
- Codex may self-update on launch and exit with "Please restart Codex" after `agent start` already reported ready. The next `agent prompt` then returns `agent_prompt_stalled`. Run `pane read <pane_id>`; if the pane is back at a shell prompt, run `agent start` again in the same pane.
- Codex draws on the alternate screen, so a finished answer never appears in `agent read`, only the prompt does. Ask for file output in the codex prompt itself: "write the full answer as Markdown to <scratchpad path> and reply only with the file path". Writing outside the cwd raises an "Apply proposed file edits" approval; read it, answer with `send-keys <name> enter` (option 1), then `agent wait`, then read the file.
- `agent read` and `pane read` print plain text; every other command prints JSON. Do not pipe read output through a JSON parser.

## Learn the current CLI

The installed binary is the authority for command syntax. Start with:

```bash
herdr --help
```

Then print the relevant command group by running the group without a subcommand:

```bash
herdr agent
herdr pane
herdr workspace
herdr tab
herdr worktree
herdr terminal
herdr notification
herdr integration
herdr session
herdr machine
```

Do not run bare `herdr` for discovery; it launches or attaches the TUI. Do not probe a mutating nested command by omitting arguments. Commands such as `herdr workspace create` are valid with defaults and will execute.

Most control commands return JSON. Read identifiers and state from those responses instead of predicting them.

## Understand layout, panes, and agents

Choose the primitive that matches the job:

- Workspace, tab, and pane topology organize terminal locations.
- Pane commands control raw terminals, shells, tests, servers, input, and output.
- Agent commands control the recognized coding agent currently occupying a pane.

A pane exists whether or not it contains an agent. `agent start` requires an existing available shell pane and never creates, splits, or moves layout. Use pane commands for ordinary processes. Use agent commands when Herdr must validate agent identity or interpret `idle`, `working`, `blocked`, `done`, and `unknown` lifecycle states.

Agent commands accept either a unique live agent name or the pane ID currently hosting that agent. They do not accept terminal IDs or bare agent-kind labels. Names must match `[a-z][a-z0-9_-]{0,31}` and be unique among live agents. A name follows the current pane occupant and is cleared when that agent exits, is released, or is replaced. Suspending an agent with Ctrl+Z and running a non-agent command preserves its identity while the exact process remains alive. This does not preserve the original identity across another recognized agent taking over. A retained identity does not mean the agent is in the foreground; inspect the pane before sending input.

`idle` and `done` normally indicate the agent is ready for input; neither guarantees that an unfamiliar approval dialog was recognized or that a retained agent is in the foreground. The CLI/API uses the server's seen state to distinguish them; explicit focus commands mark the target seen, while reads do not. Each TUI client tracks viewed completions independently, so its Done badge can differ from the CLI or another client's badge. Antigravity and Grok can be idle while background tasks or subagents keep running, so a settled-state wait is not proof those jobs have finished. `blocked` means Herdr recognized an approval or question UI. `unknown` means an agent is present but Herdr cannot classify it confidently; it does not prove completion.

## Use IDs and caller context

Public IDs are opaque stable handles:

- workspace: `w1`
- tab: `w1:t1`
- pane: `w1:p1`

Closed tab and pane IDs are not reused. A pane moved into another workspace receives a new workspace-qualified pane ID. After `pane move`, continue with `.result.move_result.pane.pane_id` or the live agent name. The old value is reported as `.result.move_result.previous_pane_id`; only the moved process's inherited caller context keeps resolving that old ID, so do not use it as a general agent target.

Herdr injects the caller's context into each managed pane:

```bash
printf '%s\n' "$HERDR_WORKSPACE_ID" "$HERDR_TAB_ID" "$HERDR_PANE_ID"
```

Prefer `--current` when a pane command should target the calling pane. An omitted `pane split` target uses the calling pane when `HERDR_PANE_ID` is available, otherwise the focused pane. Other commands may use the UI-focused pane, which can belong to the user or another client.

Discover live state with:

```bash
herdr workspace list
herdr tab list --workspace "$HERDR_WORKSPACE_ID"
herdr pane current --current
herdr pane list --workspace "$HERDR_WORKSPACE_ID"
herdr agent list
```

Creation responses expose the IDs to use next. `workspace create` returns `.result.workspace`, `.result.tab`, and `.result.root_pane`. `tab create` returns `.result.tab` and `.result.root_pane`. `pane split` returns the new pane as `.result.pane`.

IDs and live agent names are scoped to one server. Two saved SSH machines can both have `w1:p1` or an agent named `reviewer`. Selecting a machine in the TUI does not retarget commands running in your pane: without `--machine`, they still use the inherited session and socket context.

To control a saved SSH machine, use the same global prefix for discovery and every later command:

```bash
herdr --machine <label-or-id> agent list
herdr --machine <label-or-id> pane list
herdr --machine <label-or-id> agent prompt <remote-agent-name> "Reply with your current status." --wait --timeout 120000
```

The selector must be an enabled saved profile ID or a unique, case-sensitive label, not an arbitrary SSH hostname. Commands use that profile's remote session without an open TUI. Do not combine `--machine` with `--session` or `--remote`. Discover IDs on that machine; inherited local IDs and `--current` do not identify remote panes.

Both installations must support machine API forwarding, and the remote server must already be running and API-compatible. Forwarding never installs, starts, or restarts a server and never falls back to Local. Local configuration, session management, installation commands, and interactive attachment are not forwarded. Remote worktree paths must be absolute, `~`, or start with `~/`; plugin link paths must be absolute. A connection failure does not prove a mutation was not applied: inspect remote state before retrying.

`herdr machine list` lists saved connection profiles, not a cross-machine pane inventory; add `--json` for scripts. Only add, remove, enable, or disable profiles when the user asks. Removing a profile disconnects the client but does not stop remote sessions. Interactive `machine add` discovers running remote sessions and may ask the user to pick one; non-interactive setup uses the remote default session unless `--remote-session` is explicitly supplied. Use `herdr machine status [<label-or-id>] --json` to diagnose a failing machine. `herdr machine reconnect` needs the user to complete SSH authentication in their terminal; do not run it for them. Setup asks before stopping an incompatible server and defaults to No; do not approve replacement without the user's consent. Experimental handoff is not part of `machine add`.

## Start and coordinate an agent

Default to a sibling pane in the current tab and the current working directory. Do not create a workspace, tab, worktree, or different cwd unless the user explicitly requests that topology or location.

Honor a direction requested by the user. Otherwise inspect the caller pane:

```bash
herdr pane layout --pane "$HERDR_PANE_ID"
```

Split a wide pane to the right and a narrow or tall pane down. Avoid repeated same-direction splits that create unusably narrow columns or short rows. Keep the user's focus in the calling pane and explicitly preserve the caller's working directory:

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus
```

Replace `right` with `down` when appropriate. Read the new pane ID from `.result.pane.pane_id`.

An available shell pane must be at its interactive prompt, with the shell itself in the foreground and no foreground command, editor, or agent running. Start a supported agent in that pane with a useful unique name:

```bash
herdr agent start reviewer --kind codex --pane <returned-pane-id>
```

Use the kind requested by the user. Run `herdr agent` to inspect the installed kind list and options. Pass native agent arguments only after `--`:

```bash
herdr agent start reviewer --kind codex --pane <returned-pane-id> -- <agent-args...>
```

A successful `agent start` returns only after Herdr detects the expected agent in the same pane and considers it ready for interactive input. If the agent is blocked during startup, the command returns `agent_not_ready` immediately but keeps the name available for `agent read` and `agent send-keys`. Wait until the agent becomes idle before prompting it. Startup defaults to a 30-second timeout.

Submit work through the agent surface:

```bash
herdr agent prompt reviewer "Review the current diff and report only actionable findings." --wait --timeout 120000
```

`agent prompt` honors the pane's live bracketed-paste mode and sends text followed by encoded Enter as one ordered submission. It reports successful submission only after both have been written; that alone does not prove the agent started a turn. For Codex on Windows, Herdr sends a paste boundary before Enter so submission does not depend on prompt size. It rejects an agent already waiting at an approval or question dialog with `agent_blocked` before sending any input. Inspect the blocked UI and ask the user before answering it. For normal agent work, `--wait` is enough: it waits for the first settled `idle`, `done`, or `blocked` state. Do not repeat those defaults with `--until`.

With `--wait`, a prompt sent from a non-working state must produce observed `working` or `blocked` activity. After submission, Herdr waits up to five seconds for that activity; unrelated `idle`, `done`, or session changes do not satisfy this gate. It returns `agent_prompt_stalled` if no activity is observed, or `timeout` if the caller's timeout expires first. The caller timeout includes submission time. Without a timeout, the settled-state wait is indefinite after activity is observed. This wait tracks lifecycle state, not an individual turn; if the agent is already working, completion of the active turn may satisfy it.

Use `--until` only for a state-specific workflow, such as waiting for an already-running agent to request input:

```bash
herdr agent wait reviewer --until blocked --timeout 120000
```

Without `--until`, standalone `agent wait` uses the same settled-state defaults as `agent prompt --wait`.

Use logical keys for interactive agent UI controls:

```bash
herdr agent send-keys reviewer esc
herdr agent send-keys reviewer ctrl+c
```

Herdr validates all keys before writing any bytes. Read the result through the resolved agent:

```bash
herdr agent get reviewer
herdr agent read reviewer --source recent-unwrapped --lines 120
```

If a wait fails or returns `blocked`, inspect `agent get` and `agent read` before deciding what input to send. A timeout or stalled response does not prove the prompt was never delivered; do not blindly submit it again. Use the pane surface only when raw terminal control is intentional.

## Run an ordinary command in another pane

Create a sibling pane with the same geometry rule, preserve the caller's working directory, and keep user focus unchanged:

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus
```

Read the new pane ID from `.result.pane.pane_id`, then run and inspect the command:

```bash
herdr pane run <returned-pane-id> "just test"
herdr pane wait-output <returned-pane-id> --match "test result" --timeout 120000
herdr pane read <returned-pane-id> --source recent-unwrapped --lines 120
```

`pane run` queues command text and Enter together; success acknowledges admission, not command execution. On macOS, `pane run` and `agent start` reject a command that exceeds the terminal's current canonical line-input limit before queuing it. Wait for the interactive shell prompt before retrying. The check covers this submission, not an earlier incomplete line or a later terminal-mode change. `pane wait-output` searches the selected snapshot immediately, so output that already exists can match. Use `--match <text>` for a literal substring or `--regex <pattern>` for a Rust regular expression. Omitting `--timeout` allows an indefinite wait.

Use the read source that matches the task:

- `visible`: the currently rendered viewport.
- `recent`: recent rendered output, including soft wraps.
- `recent-unwrapped`: recent output with soft wraps joined; prefer it for logs and transcripts.
- `detection`: the plain-text bottom-buffer snapshot used for agent detection.

Use `--format ansi` when colors and terminal styling are evidence. Otherwise use text.

`--lines` asks Herdr for more rows from the pane's available screen and host scrollback. Alternate-screen rows do not enter ordinary host scrollback. For supported idle agents, Herdr can collect application-owned history and restore the viewport afterward, but not every application or response can be recovered this way.

If a larger recent read still does not reveal the completed response, ask the agent to write it as Markdown in a temporary directory and reply only with the file path, then read that file on the same machine. Use this only as a fallback; do not request file output in the initial prompt.

## Clean up what you created

Every pane, tab, workspace, or worktree this agent creates is closed by this agent, in the same turn its output is last needed. Leaving panes open for the user to close is a defect.

Keep a running list of created IDs as each creation response returns them. Then, for each one, in order:

1. Save anything you still need from it to a file (`agent read` or `pane read`, written to the scratchpad or project). A closed pane's scrollback is gone.
2. If an agent is still working, interrupt it: `herdr agent send-keys <name> ctrl+c`.
3. Close it: `herdr pane close <pane_id>`, one call per pane. For a tab, workspace, or worktree you created, use `tab close`, `workspace close`, or `worktree remove`.
4. Confirm with `herdr pane list --workspace "$HERDR_WORKSPACE_ID"` (or `agent list`) that only your own handles are gone.

Keep a pane open only when the user asked for it to stay, or when it hosts a process the user is still using (a dev server they are testing against). Say which panes were left open and why.

## Safety and coordination rules

- Use `--no-focus` for background work unless the user asked to switch context.
- Use `--current`, an explicit pane ID, or a unique agent name. Do not rely on another client's focused pane.
- Parse IDs from JSON responses. Do not derive them from sidebar order or examples.
- Do not close workspaces, tabs, panes, or sessions you did not create unless the user explicitly asked. Ordinary CLI/API closes do not inherit the TUI's last-pane confirmation. `workspace close --group` closes the primary workspace and its linked worktree workspaces; never add it merely to bypass `workspace_group_close_required`.
- Use `--trust-repository` only after the user has verified the repository. It grants per-request Git trust; it is not a routine retry for a failed worktree command.
- Client and server versions can differ after an update. Check `herdr status` before relying on new server features. A missing method is not permission to stop or upgrade a server.
- Never run `herdr server stop` from an active session unless the user explicitly intends to stop the server and its pane processes.
- Never kill the main Herdr process. Use named test sessions for experiments that need an isolated server.
- CLI server errors are JSON on stderr with exit status 1. CLI syntax errors exit with status 2.
