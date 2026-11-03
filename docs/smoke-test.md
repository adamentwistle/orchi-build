# Smoke test

Checks the plumbing before a real run. Takes about 15 minutes.

You need two Herdr tabs: a throwaway orchestrator and the switchboard.

## Tab 1: the orchestrator

1. Make a throwaway git repo that ignores `.legwork/`, with a `.legwork/switchboard.md` holding one `UPDATE` entry.
2. Open a tab in it with your profile (`claude_dir`) and start Claude Code on Haiku:
   ```
   herdr tab create --cwd <repo> --env CLAUDE_CONFIG_DIR=$HOME/.claude --label orch-smoke --no-focus
   herdr agent start orch-smoke --kind claude --pane <pane id> -- --model haiku
   ```
   A new directory stops at the trust question and the start returns `agent_not_ready`. Answer it in the pane (`herdr agent send-keys <pane id> down enter`).
3. Type `/rename orch-smoke`, then keep it busy: ask it to run `perl -e 'sleep 580'` in the foreground. An idle orchestrator with no `CYCLE` or `DONE` is reported as soon as a wait starts (see below).

## Tab 2: the switchboard

1. Start it as `docs/setup.md` says, then type `/switchboard smoke` with the repo path and the pane.
2. Append a `DECISION` to the repo's switchboard file by hand, in the protocol's shape.
3. Answer it with its id and a letter, pressing Esc first if a wait is running.
4. Append a `DONE` entry.
5. Switch the health watcher on, read its status, switch it off: `bin/switchboard-health-ctl on`, `status`, `off`.

## It passed if

- The switchboard wrote `<claude_dir>/switchboard/state.md` with the project.
- It showed the decision as written and tried a push notification.
- `switchboard-answer` sent `SWITCHBOARD ANSWER <id>: A` to the orchestrator and wrote the `ANSWERED` line.
- On `DONE` it tried a push notification, removed the project from the state file and stopped.
- Esc left no `switchboard-wait` process and an empty pids file.
- The health watcher logged one pass with no alerts and no errors.

## Things to know

- An orchestrator that goes idle without `CYCLE` or `DONE` is reported once, by the next wait. The wait's cursor remembers the pane's state, so later waits run normally. The switchboard nudges it rather than stopping to ask.
- `herdr agent prompt --wait` fails with `agent_prompt_stalled` on `/clear` and `/rename`, because they never show a working state even though they land. The skills skip `--wait` for those and check the pane instead.
