# Setup

How the switchboard runs. Paths below use Orchi's settings in `~/.config/orchi/settings.json`: `orchi_dir` is Orchi's checkout, whose `bin/` holds the scripts, and `claude_dir` is the Claude Code profile folder. The switchboard keeps its files in `<claude_dir>/switchboard`. The examples use the defaults, `~/orchi-build` and `~/.claude`.

The switchboard is a Claude Code session, on Opus at high effort unless the session's Switchboard choice says otherwise, in a Herdr app terminal named `switchboard`.

## Starting the switchboard

The Orchi panel starts it in the app when a request needs one and the lock is free: `/switchboard resume` in `orchi_dir`, on the Switchboard choice. The health watcher starts it if it dies. To start it by hand, open a tab of its own in the Orchi checkout with your profile, then start Claude Code in it:

```
herdr tab create --cwd ~/orchi-build --env CLAUDE_CONFIG_DIR=$HOME/.claude --env DISABLE_AUTO_UPDATE=true --label switchboard
herdr pane rename <pane id from the output> switchboard
herdr agent start switchboard --kind claude --pane <pane id> -- --model opus --effort high
```

The directory must be `orchi_dir`. Claude Code stops at a "trust this folder" question in a directory it has not seen, and `herdr agent start` then fails with `agent_not_ready`. If that happens, answer the question in the pane (`herdr agent send-keys <pane id> down enter`) and start again.

`DISABLE_AUTO_UPDATE=true` stops oh-my-zsh asking to update when the shell starts. That question eats the first letter `herdr agent start` types, so `claude` arrives as `laude` and the start times out. The switchboard and the health watcher's restart pass it too. `herdr worktree create` has no `--env`, so fanout reads a worker pane before starting Claude and answers `n` if the question is showing.

In the new session type `/switchboard <project>` (a legwork project or orchestrator session name, several allowed), or `/switchboard resume` to pick up the state file. The skill loads only from that command, so "check in" or "watch" in any other session does not start a switchboard. Inside the switchboard session, "watch <project>" works too: it finds the project's `orch-<project>` pane and repo, adds it to the state file and starts the wait. The switchboard watches every repo from this one session.

There's one switchboard at a time. `<claude_dir>/switchboard/lock` records the owner's terminal and its start time, with `"herdr": "app"`, which the panel reads. The skill takes it with `bin/switchboard-lock take <terminal>` before it does anything else, and the health watcher and the panel check it before they start one. A live owner stops a `take` with exit 1 and one line saying where the switchboard is. An owner whose terminal has gone, or no longer runs Claude Code, is replaced, and so is one an older version recorded for a terminal Herdr pane, which the app has never heard of. If the app can't be asked, the lock holds and the line says so, and `switchboard-lock release` clears it by hand. `switchboard-lock show` prints where the running one is, or a line starting `free:`.

The model and effort are flags on the start line. Opus at high effort, because the switchboard uses few tokens, and on Sonnet at the default low effort it drifted from its skill. Orchestrators run on Opus at high effort too; the agents under them run on whatever model fits each task.

## Answering

The switchboard waits with a foreground `switchboard-wait`, which can run for up to 590 seconds. A message typed while it runs is not seen until it returns. So press Esc first, then type. Esc stops the wait within about a second and nothing is lost: the wait keeps a cursor, and the switchboard runs `--status` and starts a new wait after any interrupt.

Answer a decision with its letter, for example `smoke-1: A`. The switchboard passes your words through `bin/switchboard-answer`, which checks the id is open, sends `SWITCHBOARD ANSWER <id>: <answer>` to the pane and writes the `ANSWERED` line. To delegate, say what the delegation covers; it is recorded as a `<project>-gN GRANT` entry.

The Orchi panel answers the same way: Send runs `switchboard-answer` itself, and with `--board <file>` for a planner's board, `<claude_dir>/switchboard/planning/<session>.md`. An `ACTION` is a step only you can take, and it closes with `completed: <text>` through the same script.

It sends a push notification for an open `DECISION` or `ACTION`, a `DONE`, a blocked orchestrator pane and a weekly usage figure at 99%. Nothing else notifies. Push to the phone needs Remote Control on, and is untested.

## The state file

`<claude_dir>/switchboard/state.md` is the switchboard's memory: the projects it watches (`<project> <repo> <pane id>`), the last check-in per project, a `## paused` section while anything is paused, and a final `CYCLE <date>` line while it is asking to be cycled. Only the switchboard writes it. A crash, `/clear` or restart loses nothing, because `/switchboard resume` rebuilds from this file and the repos' `.legwork/switchboard.md` files.

At 300,000 tokens, or 60% of a smaller window, the switchboard finishes its event, writes `CYCLE` and ends its turn. The health watcher then sends `/clear`, `/rename switchboard` and `/switchboard resume`.

## Requests from the panel

The panel asks the switchboard for things by writing `<claude_dir>/switchboard/requests/<ms>-<random>.req`, then `hc send <switchboard> "SWITCHBOARD REQUESTS"`. A request is one line: `start <session>`, `run <project>`, `pause <project>` or `resume <project>`. `switchboard-wait` also watches the folder and exits 0 with one line, `requests`, so a request never waits out a 590 second wait. A wait does this with nothing to watch too, and every project paused counts as nothing to watch. The switchboard deletes a request once handled, refuses any other line and tells you. A planner writes `start <session>` the same way when it finishes, unless the session is set to Wait for me.

Pause works through a request too. The switchboard sends the orchestrator `SWITCHBOARD PAUSE`. The orchestrator stops safely, writes an `UPDATE` starting `Paused.` and ends its turn, and the switchboard then runs `switchboard-state paused <project>`, which is what the panel reads. `switchboard-wait` and the health watcher leave a paused project out, because it's idle on purpose, but it still counts as watched. Resume sends `SWITCHBOARD RESUME`, then `switchboard-state unpaused <project>`.

## The health watcher

`bin/switchboard-health` is a script, not an LLM. When it is switched on, a launch agent runs it once and then every 5 minutes. It checks that the switchboard pane is there and not blocked, cycles it when it asks, prompts it when a wait has stopped, and prompts it about an orchestrator that is blocked, idle with work outstanding, or has not moved for 60 minutes. It restarts a dead switchboard at most once an hour, but not when `state.md` is missing or watches nothing, because you may have closed it on purpose, and not when the lock has a live owner, because the switchboard is then somewhere the watcher can't see. The new terminal takes the lock before Claude Code starts in it. The restart is a tab named `switchboard` in the first space on this Mac, in `orchi_dir`. It prompts only an idle switchboard, at most one prompt a pass, and never sends Esc. Each alert fires once until the condition clears. A pass more than 15 minutes after the last one (the Mac slept) restarts the stall clocks, so a sleep is not read as a stall.

It runs only while the switchboard has something to watch. The switchboard switches it on when it starts watching a project (`/switchboard <project>`, "watch", "run" or `/switchboard resume`), and off when its last project writes `DONE` or you tell it to stop. The watcher also switches itself off after two passes in a row (10 minutes) that find nothing to watch: no `state.md`, or one that watches nothing and is not asking to be cycled. That covers a `/clear`, a closed pane or a crash before the switchboard's own `off`. It is off after every login or reboot.

By hand, from anywhere once `<claude_dir>/bin` is on your `PATH` (see "Linking the skills and scripts"):

```
switchboard-health-ctl on
switchboard-health-ctl status
switchboard-health-ctl off
```

`on` renders `launchd/orchi.switchboard-health.plist.template` into `<claude_dir>/switchboard/orchi.switchboard-health.plist`, runs `switchboard-health --once --dry-run` and shows its output, then loads the job with `launchctl bootstrap`. The dry run sends, starts and writes nothing, so read it before you rely on the watcher. The job then runs one pass at once and one every 5 minutes. `on` when it is already on says so and does nothing. `off` unloads the job, and says so when it is already off. `status` says whether it is loaded and describes the last line of `health.jsonl` in plain words: when, how many alerts, how many actions and errors.

The plist lives in the state directory on purpose, not in `~/Library/LaunchAgents`. Anything in `LaunchAgents` loads at every login, which is the opposite of "only when I need it". `--state-dir DIR` puts the plist and logs somewhere else. The plist puts `/opt/homebrew/bin` and the directory of `claude` on the job's `PATH`, because launchd has neither. `on` finds `claude` on `PATH`, then under `~/.nvm`, and stops with an error if it is not there.

The job watches the Herdr app. It has no terminal, so the plist puts `~/.local/libexec/orchi-app` first on `PATH` so `herdr` reaches `bin/herdr`, then `~/.local/bin` for `hc` and `herdr-app`. They need nothing else from launchd: both answered with only `HOME`, `USER` and `PATH` set. `on` stops with an error if the launcher isn't there, because `herdr` would then be the real one, which shows no switchboard, and the job would start one. The error tells you to run `orchi`, which writes the launcher.

If an older copy of the plist is in `~/Library/LaunchAgents`, `on` and `status` warn that it loads at login and print the `rm` command to remove it. The script never deletes it. Switch the watcher off first, then remove the old plist.

Each pass appends one JSON line to `<claude_dir>/switchboard/health.jsonl`. The job's own output goes to `health.out.log` and `health.err.log` in the same directory. Fingerprints, two-pass counts, the count of passes with nothing to watch and the last restart time are in `health-state.json` beside the log.

### Desktop banners

When the switchboard itself is the problem, the watcher shows a banner with `terminal-notifier` (`/opt/homebrew/bin/terminal-notifier`). It exits 3 until notification permission is granted. Open System Settings, Notifications, find `terminal-notifier` and allow notifications. Until then a banner shows as a failed notification in `health.jsonl` and the alert stays open, so the next pass tries again.

## Notifications

Only orchestrator panes and normal Claude sessions notify. The switchboard pane, /fanout worker panes and subagents stay quiet. The Herdr app plays its own sounds (see `docs/space-agents.md`), so `bin/pane-notify`, a Claude Code hook, adds only a macOS banner, with `terminal-notifier`. It asks the app which terminal it runs in, from `HC_TERMINAL_ID` with `herdr pane current`, and says nothing anywhere else.

- quiet for a pane named or titled `switchboard`, a pane named `fw-<slug>` (fanout names every worker that way), a subagent, headless `claude -p` (it inherits the terminal id of the terminal that ran it), and a terminal the app cannot describe;
- Stop shows "<name>: done" with the first line of the last message;
- a permission prompt or a question shows "<name>: needs you". "Waiting for your input" after a done is quiet;
- <name> is the pane's name, else its title (an orchestrator's `orch-<project>`, a normal session's title), else its directory.

To switch it on, in `<claude_dir>/settings.json`, beside the hooks already there, with your home in place of `/Users/me`:

```json
"Stop": [ { "hooks": [ { "type": "command", "command": "/Users/me/.claude/bin/pane-notify", "timeout": 10 } ] } ],
"Notification": [ { "hooks": [ { "type": "command", "command": "/Users/me/.claude/bin/pane-notify", "timeout": 10 } ] } ]
```

Link it first (see "Linking the skills and scripts"). terminal-notifier must be allowed to notify (System Settings, Notifications). Where the hook cannot find it on its `PATH`, it shows the banner with `osascript`, which every Mac has. That banner comes from Script Editor, so allow Script Editor in Notifications too, or put `terminal-notifier` on the hook's `PATH`. After switching it on, end a turn in a normal pane and check a "<name>: done" banner appears. To switch it off, drop the two hook entries.

## Allow rules the switchboard session needs

Without allow rules the session stalls on a permission prompt. Put these in `<orchi_dir>/.claude/settings.local.json`, with your own paths in place of the defaults. It is local, so check it stays out of git with `git check-ignore .claude/settings.local.json`, and never commit it. Merge with any rules already there.

```json
{
  "permissions": {
    "allow": [
      "Bash(/Users/me/orchi-build/bin/switchboard-wait:*)",
      "Bash(~/orchi-build/bin/switchboard-wait:*)",
      "Bash(/Users/me/orchi-build/bin/switchboard-answer:*)",
      "Bash(~/orchi-build/bin/switchboard-answer:*)",
      "Bash(/Users/me/orchi-build/bin/switchboard-state:*)",
      "Bash(~/orchi-build/bin/switchboard-state:*)",
      "Bash(/Users/me/orchi-build/bin/switchboard-lock:*)",
      "Bash(~/orchi-build/bin/switchboard-lock:*)",
      "Bash(herdr agent list:*)",
      "Bash(herdr agent get:*)",
      "Bash(herdr agent read:*)",
      "Bash(herdr agent prompt:*)",
      "Bash(herdr agent start:*)",
      "Bash(herdr tab create:*)",
      "Bash(herdr pane current:*)",
      "Bash(herdr pane rename:*)",
      "Bash(herdr pane close:*)",
      "Bash(hc ls:*)",
      "Bash(ls ~/.claude/switchboard/requests*)",
      "Bash(rm ~/.claude/switchboard/requests/*)",
      "Bash(grep:*)",
      "Bash(tail:*)",
      "Bash(date:*)",
      "Bash(mkdir -p ~/.claude/switchboard)",
      "Bash(/Users/me/orchi-build/bin/usage-guard --check)",
      "Bash(~/orchi-build/bin/usage-guard --check)",
      "Bash(/Users/me/orchi-build/bin/switchboard-health-ctl on)",
      "Bash(~/orchi-build/bin/switchboard-health-ctl on)",
      "Bash(/Users/me/orchi-build/bin/switchboard-health-ctl off)",
      "Bash(~/orchi-build/bin/switchboard-health-ctl off)",
      "Bash(/Users/me/orchi-build/bin/switchboard-health-ctl status)",
      "Bash(~/orchi-build/bin/switchboard-health-ctl status)",
      "Read(~/Projects/**/.legwork/**)",
      "Read(~/legwork/**)",
      "Read(~/Projects/legwork/**)",
      "Read(~/.claude/switchboard/**)",
      "Edit(~/.claude/switchboard/planning/**)"
    ],
    "deny": [
      "Edit(~/.claude/switchboard/state.md)"
    ]
  }
}
```

What each group is for:

- The wait, answer, state and lock scripts, in both spellings, because the skill writes the path as `<orchi_dir>/bin/<script>`, which may come out with `~` or in full, and a rule matches the command as typed.
- `herdr agent list|get|read` to find panes and read their status line, `prompt` to relay and cycle, `start` and `tab create` to open an orchestrator pane for "run <project>". `pane current` and `pane rename` so the switchboard can give its own pane the name the health watcher looks for. `pane close` and `hc ls` to find and close a planner after a handover.
- `ls` and `rm` on `requests/` to take the panel's requests and delete each one once handled, and `Edit` on `planning/` for the `STARTED` line.
- `usage-guard --check` and `switchboard-health-ctl on|off|status` from `<orchi_dir>/bin`, in both spellings, so the switchboard can read usage and switch the health watcher on and off itself.
- `grep`, `tail` and `date` to read the switchboard files and take times.
- `Read` on the repos' `.legwork/` files, the legwork tracker and the state file's directory. No `Edit`: the state file changes only through `switchboard-state`, so the deny rule stops a hand edit (an `Edit` rule covers every file-writing tool; Claude Code ignores `Write(path)` rules).

`grep` and `tail` are allowed for any path, because a Bash rule cannot be limited to `*/.legwork/switchboard.md`. They only read. Push notifications use Claude Code's `PushNotification` tool, which needs no rule.

Each project repo's gitignored `.claude/settings.local.json` needs allow rules, with the command `github.command` names in place of `gh` (`gh-personal`, say), for `Bash(gh pr create:*)`, `Bash(gh pr edit:*)`, and `Bash(git push origin fanout/*)` style pushes from worktrees, plus `Bash(gh pr merge:*)` only on repos whose owner is in `github.own_owners`, when the roadmap says to merge. Add deny rules for `git push origin main`, `git push --force` and `git push -f`. Without the allow rules the permission classifier stalls a run waiting on an approval; never commit these rules on a shared repo.

## The herdr wrapper

`bin/herdr` lets Orchi's scripts and skills talk to the Herdr app with the commands they know. Every call goes to `bin/herdr-adapter`, which maps it onto the app's `hc`. Nothing in `bin/herdr` reaches the real `/opt/homebrew/bin/herdr`, which is the wrong Herdr in an app terminal. Whatever `HC_TERMINAL_ID`, `HERDR_PANE_ID` or `ORCHI_HERDR` hold, the call goes to the adapter. The adapter itself runs the real `herdr` only for `--help`, `-h`, `--version`, `-V`, `--skill` and no arguments, because the app has nothing to say for them.

Terminal Herdr is not supported. Where the app's `hc` does a job, nothing else does it: `switchboard-lock` has no second Herdr to ask, `pane-notify` takes the terminal from `HC_TERMINAL_ID`, and a lock an older version wrote for a terminal Herdr pane counts as a switchboard that has gone.

The wrapper is one `exec` in a shell script. `bin/tests/test_herdr_wrapper.py` proves the arguments, stdin, stdout, stderr, exit code, environment and process id all come through unchanged.

**It's on only for agents the app starts.** A shell line can't do this. `~/.zshenv` puts Homebrew first in every zsh, so `PATH` set when a terminal starts loses to the real `herdr`, and a line in `~/.zshrc` would change `herdr` in every other app terminal too, which Orchi doesn't do to a terminal it didn't start.

So `PATH` is set when Claude Code starts. The panels start it with `~/.local/libexec/orchi-app` first on `PATH`, and `agent start` here does the same, with `HERDR_ENV=1`, which `/fanout` checks before it uses panes, so an orchestrator hands both to its workers. When Orchi's settings set `claude_dir`, both also give the session `CLAUDE_CONFIG_DIR` set to it, so it runs under the profile the panels read, whatever `~/.zshrc` sets. That folder holds one file, a `herdr` launcher that `orchi` writes, which runs `bin/herdr`. If the folder it points at goes, such as when `orchi` is removed, the launcher fails rather than falling back to the real `herdr`. The next `orchi` run writes it again with the new path. Every other app terminal keeps the real one.

Two gaps follow from this. Typing `claude` by hand in such a terminal starts a session with the real `herdr`. A `zsh -c` command inside an agent gets the real one too, because of `~/.zshenv`. Claude Code's Bash tool keeps the launcher.

The Orchi panel isn't affected either way. `mods/orchi/sessions.js` calls `herdr agent list` by name, and that runs as a child of the app, with no `HC_TERMINAL_ID` and no `.zshrc`, so it reaches the real one.

### What is mapped

`agent list`, `get`, `read`, `prompt`, `wait`, `send-keys`, `rename` and `start`. `pane current`, `read`, `rename`, `send-text` and `close`. `tab create`. `workspace create`. `worktree create`, `list` and `remove`. No arguments, `--help`, `-h`, `--version`, `-V` and `--skill` go to the real `herdr`.

Any other call fails with `not_mapped`, because the real `herdr` is the wrong Herdr in an app terminal.

### How the app differs

- A pane id and a terminal id are the `hc` address, such as `t7`. Names are kept in the `orchi.name` label, because `hc` can only name a terminal when it starts one.
- `state_change_seq` is the terminal's turn count.
- `agent_session` is missing, because `hc` doesn't report it. `switchboard-health` confirms a `/clear` by the `context:` figure on the status line reading 0.0% instead, as the switchboard does for an orchestrator.
- `tab create` and `worktree create` open a tab in the caller's space, and fail if the caller has no space. `--focus` and `--workspace` are refused, so a new tab never moves the window.
- `workspace create` opens a labelled tab in the first space on this Mac, from `herdr-app ls`, because the watcher that calls it has no terminal and so no space. It returns `workspace`, `tab` and `root_pane` as `herdr` does, and fails with `no_space` if the window is closed or every space is on another machine.
- A new tab comes from `hc run` with `herdr.space` and `herdr.tab` labels, never from `tab.new`, which selects the tab and takes focus even in a space that isn't shown. The shell runs under `/usr/bin/env` when `--env` is given, because `hc run` has no `--env`.
- The `workspace_id` of `worktree create` is the worktree's path, which is what `worktree remove --workspace` takes.
- `agent start` fails with `no_launcher` if `~/.local/libexec/orchi-app/herdr` isn't there, because the agent would reach the real `herdr`.
- `agent prompt` sends with `HC_TERMINAL_ID` removed. From a terminal, `hc send` adds an `<hc from=...>` tag, and Claude Code then answers `/clear` or `/rename` as text instead of running it.
- `agent prompt` presses Ctrl+S first when Claude Code is running and no `› stashed` hint shows. `hc send` adds to whatever is unsent and presses Enter, so a command left by Put in terminal would run with the text joined on. Claude Code puts the line back after the submit, including after `/clear`. Text typed over a held stash still goes, because Ctrl+S would replace the stash.
- `pane send-text` takes letters and digits only, because `hc send` always presses Enter.
- `hc` keeps its terminals on other machines out of the list.
- As with the real `herdr`, `--until idle` doesn't match an agent that is `done`.
- Claude Code keeps its prompt at the bottom of the screen, so on a tall terminal a short reply can sit further up than `tail -40` reaches.

## Linking the skills and scripts

Claude Code reads the skills and commands from `claude_dir`, so link them there from the checkout. Then a pull is the install. A few scripts go in `<claude_dir>/bin`, which goes on your `PATH`: add `export PATH="$HOME/.claude/bin:$PATH"` to `~/.zshrc`. Put only these there, not the whole of `bin/`, because `bin/herdr` on every shell's `PATH` would change `herdr` in every app terminal (see "The herdr wrapper").

```
O=~/orchi-build C=~/.claude    # your orchi_dir and claude_dir
mkdir -p "$C/skills" "$C/commands" "$C/bin"
for s in switchboard-protocol switchboard roadmap-planning fanout ticket-session herdr pr-drafter ux-test; do ln -sfn "$O/skills/$s" "$C/skills/$s"; done
for c in fanout pr-review ship; do ln -sfn "$O/commands/$c.md" "$C/commands/$c.md"; done
for b in bugbot-wait usage-guard switchboard-health-ctl pane-notify; do ln -sfn "$O/bin/$b" "$C/bin/$b"; done
```

A skill that's already a real folder in `<claude_dir>/skills` has to be moved out first, or the link lands inside it.

`usage-guard` also works as the profile's UserPromptSubmit and PostToolUse hook, and `pane-notify` as its Stop and Notification hook (see Notifications), so keep those links in place while the hooks point at them. The hook asks a session to pause when any usage limit reaches `usage_guard_percent` in Orchi's settings, 95 when unset. That is one percent for the 5-hour window and both weekly limits. It reads `~/.cache/orchi/usage.json`, which usage-watch keeps fresh, and falls back to ccstatusline's `~/.cache/ccstatusline/usage.json` where that is installed. Nothing needs ccstatusline.

The legwork skills (`legwork-tracker`, `/wrap`, `/go`, `/add`, `/log`, `/pickup`, `/shelve`, `/vision`) live in the legwork tracker repo, not here.
