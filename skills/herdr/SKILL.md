---
name: herdr
description: "Use when running in the Herdr app (HERDR_ENV=1) and the task needs a second coding agent the user can watch and steer (codex, another claude doing real implementation or debugging), a process that must stay alive or be typed into (dev server, watcher, REPL, CI or deploy poll, secret or login prompt, approval dialog), parallel research that will need follow-up prompts, or when the user names Herdr, panes, tabs, or terminals. Not for bounded read-and-report work; subagents cover that."
---

# Herdr

Orchi runs in the Herdr app. Every app terminal is an `hc` terminal with an address such as `t7`. Two commands reach them:

- `herdr`, in a terminal Orchi started, is Orchi's wrapper (`<orchi_dir>/bin/herdr`). It maps the agent, pane, tab and worktree commands below onto `hc`, and the switchboard and `/fanout` use only these.
- `hc` does everything else: plain programs, other agent kinds, waiting on output. `hc --skill` is its manual.

Before issuing any control command, check that this agent runs in an app terminal Orchi started:

```bash
test "${HERDR_ENV:-}" = 1 && test -n "${HC_TERMINAL_ID:-}"
```

If the check fails, say that you are not running inside Herdr and stop. Never run the `herdr` from Homebrew yourself: it is the older terminal program, the wrong Herdr here.

## Herdr terminal or subagent?

A subagent (the Agent tool, including the `codex` agent type) is the default for delegated work. Pick a terminal only when one of these holds; otherwise use a subagent.

| Condition | Use |
|---|---|
| Bounded read, search, review, or summarize; only the final report matters | Subagent |
| Cross-model verdict only (review, judge, second opinion), no follow-up expected | `codex` subagent type |
| Claude Code doing implementation or debugging the user may watch or steer | Terminal, `herdr agent start --kind claude` |
| Codex or another agent kind doing implementation, debugging, or a task over roughly five minutes | Terminal, `hc run --bg` |
| The agent may hit approval or question dialogs the user should answer | Terminal |
| Parallel research where follow-up prompts to the same worker are likely | Terminals, one named agent each |
| Process must stay alive: dev server, watcher, `tail -f`, REPL, test loop | Terminal, `hc run --bg` |
| Waiting on external state: CI, deploy, PR checks, a file another tool will write | Terminal, `hc run --bg` + `hc wait --output` |
| Command prompts for a secret, login, or interactive answer | Terminal; the user types it, never the agent |
| The user wants to watch the work or redirect it mid-task | Terminal |

Never wait on a terminal or agent with a `sleep` loop. Use `herdr agent prompt --wait`, `herdr agent wait`, `hc wait` or `hc wait --output`; they return on the state change.

## What `herdr` maps

| Group | Commands |
|---|---|
| `agent` | `list`, `get`, `read`, `prompt`, `wait`, `send-keys`, `rename`, `start` |
| `pane` | `current`, `read`, `rename`, `send-text`, `close` |
| `tab` | `create` |
| `workspace` | `create` |
| `worktree` | `create`, `list`, `remove` |

Any other call fails with `not_mapped`. Use `hc` for it instead. Commands print JSON, except `agent read` and `pane read`, which print plain text. Read ids and state from the JSON rather than predicting them.

A pane id is a terminal's address, such as `t7`. Agent commands take that address or a live agent name. Names match `[a-z][a-z0-9_-]{0,31}` and are unique among live agents. `herdr pane current` gives your own address.

## Start and coordinate a Claude Code agent

Open a tab of its own, which never moves the user's window, then start the agent in it:

```bash
herdr tab create --cwd "$PWD" --label reviewer --no-focus
# take the new pane id from the JSON it prints
herdr agent start reviewer --kind claude --pane <pane_id> --timeout 60000 -- --model sonnet --effort medium
herdr agent prompt reviewer "<self-contained task with file paths and acceptance criteria>" --wait --timeout 600000
```

Only `--kind claude` is mapped. Pass Claude Code's own arguments after `--`. For work in a worktree, `herdr worktree create --cwd <repo> --branch <branch> --base origin/main --path <path> --label <name> --no-focus` opens the worktree in a tab and prints its pane id.

`agent start` returns once Claude Code is ready. If it returns `agent_not_ready` or `timeout`, read the terminal with `herdr pane read <pane_id> --lines 10` before deciding anything. A "trust this folder" dialog in the user's own project is answered with `herdr agent send-keys <name> enter`; any other dialog, read it and ask the user.

`agent prompt --wait` waits for the first settled `idle`, `done` or `blocked` state after the prompt starts work. After prompting an agent that was already idle or done, run `herdr agent wait <name> --until working --timeout 30000` first, then the plain wait, or the wait sees the old state and returns at once. `--until idle` doesn't match an agent that is `done`. `blocked` means an approval or question is showing: read it before sending anything. A timeout or `agent_prompt_stalled` does not prove the prompt was lost; read before resending.

Read and steer:

```bash
herdr agent get reviewer
herdr agent read reviewer --source recent-unwrapped --lines 120
herdr agent send-keys reviewer esc
herdr agent send-keys reviewer ctrl+c
```

`--source` is `visible`, `recent` or `recent-unwrapped`; prefer `recent-unwrapped` for logs and transcripts. Claude Code keeps its prompt at the bottom of the screen, so on a tall terminal a short reply can sit further up than `tail -40` reaches. `herdr pane send-text` takes letters and digits only and always presses Enter, for answers like `n` to a shell question.

## Other agents and programs

`hc` starts them. Always use `--bg` and a name:

```bash
hc run --bg --name review --cwd "$PWD" -- codex -m gpt-5.6-terra
hc wait review
hc send review "<self-contained task>. Write the full answer as Markdown to <scratchpad path> and reply only with the path."
hc wait review --timeout 1800   # a check-in at the timeout is not the end: wait again while it is working
hc run --bg --name web --cwd "$PWD" -- npm run dev
hc read web --lines 40          # already says ready? then don't wait
hc wait web --output ready
```

`hc wait --output` matches only what is printed after the wait starts, so read first: a server that is already up never prints its line again.

Put `--` before the program, so its own flags never reach `hc`. Codex shares no conversation context; the task must carry everything. It draws on the alternate screen, so a finished answer may not show in `hc read`; ask for file output. A trust dialog on first use of a folder may need `hc keys <name> down enter`.

## Clean up what you created

Every terminal, tab or worktree this agent creates is closed by this agent, in the same turn its output is last needed. Leaving them open for the user to close is a defect.

Keep a list of the ids each creation returns. Then, for each one:

1. Save anything you still need from it to a file. A closed terminal's history is gone.
2. If an agent is still working, interrupt it: `herdr agent send-keys <name> ctrl+c`.
3. Close it: `herdr pane close <pane_id>` for an agent's terminal, `herdr worktree remove --workspace <path>` for a worktree, `hc kill <name>` then `hc rm <name>` for an `hc run` terminal.
4. Confirm with `herdr agent list` and `hc ls` that only your own are gone.

Keep a terminal open only when the user asked for it to stay, or when it hosts a process the user is still using, such as a dev server they are testing against. Say which were left open and why.

## Safety and coordination rules

- Use `--no-focus` on every `tab create` and `worktree create`. A new tab never moves the user's window.
- Target an address or a unique agent name. Never rely on whatever terminal has focus.
- Do not close terminals, tabs or worktrees you did not create unless the user asked.
- Use `--trust-repository` only after the user has verified the repository.
- Never stop or restart the app's core (`hc server stop` or `restart`) unless the user asks.
- Never attach to another terminal with `hc attach`; that is for a person.
