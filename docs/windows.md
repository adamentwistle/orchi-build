# Orchi on Windows

Orchi's mods have a Windows side, and `scripts/install.ps1` installs them into the Herdr app there. The app is in
`%LOCALAPPDATA%\Programs\herdr-app`, and its folder is `~/.config/herdr-app`, as on the Mac.

This is parked. An earlier version of the port ran on a Windows PC; this tree's version hasn't been run on Windows.
`tests/windows` checks the Windows paths on any system.

## Install

```powershell
pwsh -File scripts/install.ps1                       # every mod that runs on Windows
pwsh -File scripts/install.ps1 -Mods space-agents    # only the mods named
pwsh -File scripts/install.ps1 -Legwork D:/legwork   # also tell the Legwork panel where the tracker is
pwsh -File scripts/install.ps1 -NoTheme              # leave the theme picker alone
```

It needs PowerShell 7 (`pwsh`). It does what `scripts/install.sh` does, with these differences:

- Every run first copies `keys.json`, `settings.json`, `view.json`, `layouts` and `mods` to `herdr-app-backup-<date>-<time>` next to the app's folder.
- Themes are copied, not linked. Windows symlinks need admin or developer mode.
- Mods are copied with `mod.json` first, then the folder is made to match the repo's, as `rsync --delete` does. `gpui-kit.d.ts`, `jsconfig.json` and `*.error` in the app's copy are kept.
- The layout is written without the blocks of any mod that isn't installed, so `-Mods` can leave any panel out.
- `keys/linear.json` is skipped while the Linear mod isn't installed. The other key files are merged in by scope.
- With Orchi, it writes the launcher folder `~/.local/libexec/orchi-app`: `herdr`, a shell script for Git Bash, and `herdr.cmd`, both running this checkout's `bin/herdr-adapter` with `python`.
- With `-Legwork`, it adds `legwork.dir` to `~/.config/herdr-app/linear.json`, and leaves anything else there, a Linear key included, as it was.
- It doesn't install the browser pane.

## Settings

Orchi's settings (`~/.config/orchi/settings.json`) work as on the Mac. On Windows set `orchi_dir` to this checkout,
because the Orchi panel runs `bin/switchboard-answer` from there and starts the switchboard in it, and `claude_dir` to
the profile folder `CLAUDE_CONFIG_DIR` names, if there is one. Paths can use forward slashes, such as `D:/src/orchi-build`.

## What changed in the mods

Each mod that runs an outside program checks `platform()` from the `os` module, through `platform.js`. In the app it
returns `"windows"`. On the Mac every path is as it was.

| Mac | Windows |
| --- | --- |
| `python3` | `python`. Windows has no `python3.exe`: the name runs the Microsoft Store stand-in, which exits 9009 and runs nothing |
| The session file named by `hc get`'s foreground pid | `hc get` names the shell (`pwsh.exe`) as the foreground process, with Claude Code under it. `win.py session` walks every process under the shell and reads `sessions/<pid>.json` for each, in the profile folders the settings give |
| `sh -c 'ls -t …'` to find a moved transcript | `win.py locate` |
| `mkdir`, `cp`, `rm` for pasted and dropped images | `win.py mkdir`, `copy` and `remove` |
| `osascript` for a pasted image | `win.py clipboard`, through Windows PowerShell's Forms clipboard |
| `zsh -ic` piping a line into `claude -p` | `win.py headless`, which finds `claude` on PATH and gives it the line on its input |
| `sleep` between reads of a screen | `win.py sleep` |
| `open` for a link in the plan view | `rundll32 url.dll,FileProtocolHandler` |
| Claude Code is the terminal's foreground process before a send | The status Claude Code reports, `claude-code`, because the foreground process is the shell |
| The chat column, 85% of the pane up to 1400 points | The pane's width, less 24 points each side |
| The folder watcher wakes the chat pane | The same, and the pane also rereads the thread every 3 seconds, because the watcher's paths may not match the transcript's |
| The shipped `tabs` mod, which draws no window buttons on the Mac | `windows-tabs`, a copy of `tabs` without them. `panel-buttons` draws them at the window's edge instead, after Herd. `install.ps1` points the layout's tab block at it and widens the panel buttons' block to 500 px |
| Ctrl and a number selects a space, as the rail's hover says | Alt and a number |

`win.py` and `platform.js` are the same file in every mod that uses them, because a mod can't read outside its folder.
`tests/windows` checks the copies match.

Two smaller fixes apply on both systems, and change nothing on the Mac:

- A changed path from `watchFolder` is compared with slashes made forward and the drive letter in lower case, and a transcript is also known by its file name, which is the session's id.
- Trust in `.claude.json` is looked up with the folder as given and with forward slashes, which is how Claude Code keys Windows folders.

## Line endings

`.gitattributes` keeps LF on every platform. With `core.autocrlf=true` a Windows checkout would turn every file to CRLF,
and the dialog tests fail then, because the screen fixtures and the parser expect LF. The mods are copied into the app as
they are, so they stay LF there too.

## Orchi and the Legwork panel

Orchi's scripts reach panes through the `herdr` command. On Windows `herdr` may be the old terminal Herdr, which can't
see the app's terminals, so the launcher runs `bin/herdr-adapter`, which maps those calls onto the app's core. Sessions
the panels start get the launcher folder first on PATH, so `herdr` in them is the adapter, and every other terminal
keeps the real one. Orchi's scripts in `bin/` haven't been ported to Windows.

**The Legwork panel** is the Linear mod on Windows with no Linear key. It reads the legwork tracker (`legwork_dir` in
Orchi's settings, else `legwork.dir` in `linear.json`) and lists every project but the template and done or iceboxed
ones, one card each, with filters by category: Business, Work and Personal. A card starts closed, and opens to a briefing
like /pickup's: what the project is, its status, the latest log entry and the next prompt's task, finish line and model.
It offers Pickup and Go, which open a tab in the project's space (a new one named after the project when there's none),
show it, and start Claude Code with `/pickup <file>` or `/go <file>` as its first message, and Send to Orchi, which ticks
the project and opens the review screen. Review and Go work as they do for tickets. Go writes the brief with
`"source": "legwork"` and starts the planner with the ticket-session skill and a fixed sentence saying the brief holds
legwork projects, not Linear tickets.

**Orchi** lists projects of every category on Windows, where the Mac lists work ones. Everything it runs goes through
Windows equivalents:

| Mac | Windows |
| --- | --- |
| `awk` over `projects/*.md` | `win.py tracker`, which prints the same text |
| `ls`, `mkdir -p`, `rm`, `sleep`, `pbcopy` | `win.py list`, `mkdir`, `remove`, `sleep` and `copy-text` |
| `/bin/zsh -ic` starting Claude Code | `pwsh.exe -NoLogo -NoExit -Command` with a script that sets `HERDR_ENV`, `DISABLE_AUTO_UPDATE` and the launcher on PATH, then runs `claude`, every argument single-quoted with quotes doubled |
| `/usr/bin/env PATH=... switchboard-answer` | `python <orchi_dir>/bin/switchboard-answer` |
| `python3` for trust | `python`, with folders in forward slashes |
| `herdr agent list` and `agent read` for a switchboard in terminal Herdr | never asked: only the app runs there |
| A path is absolute when it starts `/` | `C:/` and `C:\` count too, and a tracker's repo comes back with forward slashes |

## Not covered

- Orchi's scripts in `bin/`, and the skills and commands, on Windows.
- The context share on a sidebar agent row: `context.py` looks up the terminal's foreground pid, which on Windows is the shell.
- `scripts/herdr-dev`, `scripts/build-themes.py`, `scripts/build-sounds.py` and `scripts/install-browser.sh`, which are Mac scripts.
