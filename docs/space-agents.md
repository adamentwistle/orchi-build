# Spaces and agents in one list

`mods/space-agents` takes the place of the shipped `spaces` and `agents` blocks in `layouts/main-linear.json`. At the top is a Needs you inbox. Below it each space folds, and under it its agents sit in folds by status: Needs you, Done, Working, Idle. A status with no agents isn't drawn.

## How it works

- A space's icon is a small spark in the theme, not a colored letter, or a branch mark for a worktree. It glows in the theme's accent while an agent or sub-agent in the space is working, and a space waiting on you has the red mark instead.
- A space keeps what the `spaces` mod gives it: worktrees under their checkout, a header per machine, git after the name, the right-click menu and drag to reorder. Its git reading is that mod's, with `status.relativePaths=false` added so changed paths come from the checkout's top.
- A drag holds space ids, not places in the list, so a space closing mid-drag can't make it move the wrong one, or throw. Letting go anywhere in the sidebar, pressing outside it, or the pointer leaving it ends the drag, so no row is left faded.
- The chevron on a space or an agent acts on the press and stops it, along with its release and click, so folding doesn't select the space, start a drag or focus the agent. In case a stop doesn't hold, the row also ignores a press within 0.6 s of a chevron's. A press anywhere else on the row still selects or focuses. A status header folds when pressed anywhere.
- A folded space says how many agents it holds, with the most urgent status unless that's idle. So a folded space with a blocked agent still shows a red `!`.
- An agent counts as its most urgent sub-agent, as it did in the agents list, and a done agent you're looking at stays in Done until you leave it.
- Folds and each agent's last change are kept in the mod's `localStorage`, so they survive a restart. A fold for a space that's gone goes. On another machine it stays while that machine is away, because its spaces aren't listed then, and goes once the machine is connected, its layout has been read and the space isn't in it. Nothing is pruned before this computer's layout has been read.
- `agent.next` and `agent.prev` follow the drawn order, including agents in a fold.
- An agent's name is a tab someone named, else the name its terminal was given with `hc run --name` (`name` in `terminals()`), else its own title. Without the terminal's name, an agent whose program sets no title would read as its address, such as `t3`.
- On the rail there's no room for folds. Each space is its icon and number, which ctrl plus that number selects, with its agents below it, whatever's folded.
- An agent no listed space holds goes under "No space" at the end, so none goes missing.

## Needs you

- The inbox at the top lists every agent and sub-agent that's blocked, in any space, oldest first, with what it's waiting on. A press focuses it: `pane.focus` for an agent, `agent.focus` for a sub-agent with no pane. It isn't drawn when nothing is waiting, or on the rail.
- What it's waiting on is the agent's own report: `terminals()` gives `report.msg`, such as `answer: Which colour? (Red · Blue)` or `approve Bash: <command>`. A report sent through OSC 7501 needs its `msg` base64 encoded, or the message, and sometimes the whole report, is dropped. Without a message it says the report's kind (needs permission, has a question, needs a sign-in), and a sub-agent stopped on an error says so.
- Oldest is the terminal's `status_ms` when there is one. `terminals()` gave null there in testing, so it falls back to when this mod saw the state change, then to the app's `seq`.
- A blocked agent's row in its space shows the same reason on a second line.
- `cmd-shift-u` (`keys/space-agents.json`, merged by `orchi`) jumps to the agent that has waited longest. It reaches the sidebar only while it's shown, so not with the sidebar hidden.
- Nothing here answers a dialog: a press only takes you there. The chat pane has a safe way to answer, which reads the screen again and presses only if the dialog is still the one drawn on its card (`checkPress` in `mods/claude-chat/dialog.js`). The sidebar shows one line, not the options, so a press here couldn't show you what it would answer.

## The header and the rows

- The header counts what the list and the inbox show, across every space, so the three can't disagree. Working is every agent, sub-agent and worker drawn with a spinner, each once. Waiting on you is the inbox's length, so a blocked worker under a working agent counts. Done is what the Done folds hold, so a done agent you're looking at still counts until you leave it.
- When the shared key `chat.unseen`, which the chat pane writes, holds anything, the header shows how many unseen rows the chat pane has. It reads any shape: a count, a list, or a map of counts. Absent, it shows nothing.
- An agent row shows how full its session's context is, from 60% in the theme's yellow (`ansi3`), the point to wrap and start fresh. It's the same figure as the status line's `context:`, a share of the usable 80% of the window. `context.py` reads it every 20 s, run as `python3 -I -S` and stopping itself after 5 s: the terminal's foreground pid names a Claude Code session in `<config>/sessions/<pid>.json`, and the end of that session's transcript has the latest turn's usage. The transcript doesn't name the window, so it's 1M for a model from generation 5 on, one marked `[1m]` or one seen past 200k, and 200k otherwise. Only local Claude Code sessions get it, and only once their first turn has ended.
- A space whose checkout has a changed file that another checkout of the same repo also has changed gets a badge with how many, and the paths on hover. It comes from the status reading the list already makes, so it's as fresh as that: a command or a turn ending, a file change in a local repo, or once a minute while the window is in front.

## Sounds

`sounds/` holds three sounds, and its README says where each came from. `config/settings.json` gives the app two: `needs-you.mp3`, a doorbell, when an agent needs you, and `done.mp3`, a retro level passed sound, when one finishes while you aren't looking. The app has no sound for a worker, so this mod plays `worker.mp3`, one quiet note, when a terminal with a `parent` stops working or ends, whether you're looking or not. It looks with what render has already read, and a 2 s timer looks when render hasn't. Workers finishing within 1.5 s of each other play it once. Sounds off in Settings turns it off too.

A worker with a pane of its own is in `agents()`, so it gets the app's sounds, not this one. Claude Code's own subagents aren't terminals, so nothing here sees them finish.

## What's gone

- The agents list's Pin to the top.
- The agents list's sort menu, because the grouping is now the list.
- The machine name on an agent row, because the machine header above says it.
- The space's status dot on the rail, because its agents are listed under it.
- The colored letter avatars. Colors are still assigned, because the space picker draws them.

The shipped `spaces` and `agents` mods are untouched, and other layouts still use them.

## Not done

- Agent in a new worktree in the + menu. That menu is the shipped `new-menu`, and `programs.json` only describes programs (name, icon, `run`), with no way to say "in a new worktree". The shipped `worktree` dialog takes `{branch, tab?, argv?}`, so a button of our own could do it later.
- Answering a dialog from the inbox, for the reason above.

## Installing

`orchi` only adds settings that aren't there yet, at any depth, so a mute in Settings or a picked sound stays. It copies mods and never deletes a file it didn't put there, so an icon another checkout installed stays. It removes a file it installed only when the package no longer ships it and nobody has changed it. When the installed `main-linear` layout holds a mod this tree's doesn't, it names the mod and asks before replacing the layout, and keeps a backup. A fresh home with no `keys.json` or `settings.json` works, and a private home (`HERDR_APP_HOME` not the default) leaves `~/.local/libexec/orchi-app/herdr` alone. `scripts/herdr-dev up` and `install` print a failed run's output and exit code, and `session` escapes its folder in the JSON it sends.
