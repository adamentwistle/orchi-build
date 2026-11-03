# The Herdr desktop app

Notes for working on it. `herdr-app --skill` and `~/.config/herdr-app/AGENTS.md` are the full guides, and the app rewrites `AGENTS.md` on every start, so check there for anything that may have changed.

## Three programs

- **Herdr app** (`herdr-app`, 0.1.11): the window, in `~/Applications/Herdr.app`.
- **herdr-core** (`hc`): runs every terminal and agent, which keep running when the window closes.
- **`herdr`** (0.9.5, Homebrew): the older terminal program, with its own `~/.config/herdr/config.toml`. It's separate from the two above.

## Where things live

Everything is under `~/.config/herdr-app`, and edits apply within a second. A broken file keeps the last good version and leaves a `<name>.error` beside it.

- `themes/<name>.json`: colours. A new file appears in Settings by itself.
- `settings.json`: fonts, theme, zoom, sounds. A layout's own look wins over this.
- `layouts/<name>.json`: the window. The shipped ones are read-only, so use `layout.clone`.
- `mods/<name>/`: panels, in JavaScript that describes native UI. Clone shipped ones with `mod.clone`.
- `layouts/.state/`: clicks, such as the theme picked. Don't edit it.

The theme picker wins over everything, so a theme in `settings.json` does nothing on a layout where one was picked. Use `herdr-app do app.theme --name <theme>`, which sets the half that matches the theme's lightness.

## Checking a change

```bash
herdr-app check ~/.config/herdr-app/mods/<name>   # loads a mod once, reports errors
herdr-app status                                  # shows errors from files and mods
herdr-app shot /path/to/file.png                  # saves the last window frame
```

- `check` runs apart from the window, so `settings()`, `fonts()` and `panes()` there aren't the live ones. A mod's `console.log` isn't shown either. `writeTextFile` to a path that doesn't exist yet gets data out.
- `shot` shows what's on screen, so it can't confirm anything on a hidden tab, and a person using the window can move it.
- `tab.new` selects its tab and takes focus, even in a `space` that isn't selected. To open a tab without moving the window, start a terminal with `hc run` and `herdr.space` and `herdr.tab` labels. Herdr shows it as a tab of its own, and `tab.rename` names it about 0.4 s later. Don't move a window someone is using.
- `PATH` set when a terminal starts doesn't last: `~/.zshenv` puts Homebrew first in every zsh. Set it after zsh starts, as `mods/orchi/launch.js` does.
- A session in a folder Claude Code has no accepted entry for stops at the trust question, even if a parent folder is trusted. The flag is `hasTrustDialogAccepted` under `projects` in `<claude_dir>/.claude.json`. That question is yours to answer.
- `agent` in `herdr-app status` doesn't always name the newest terminal. After one press it read `win/t1`, on another machine, while the new terminal was `t2p`. Use `hc ls` to find where a terminal landed.
- A `--task` given to `tab.new` didn't reach a fresh Claude Code in testing. Use `hc send` once it's up.
- `hc` can only name a terminal when it starts one. `bin/herdr-adapter` keeps other names in the `orchi.name` label, so a mod reads both, as `terminalName` in `mods/orchi/sessions.js` does.
- Herdr stops a render at about 55 ms, and code that has just loaded runs far slower than that. A stopped render keeps the last frame under a "could not be re-rendered" banner, and Copy details gives a stack. "interrupted" in the log is QuickJS's message when the host stops a script. Nothing asks for another render by itself, so a panel that notes a render didn't finish and asks again each second gets there, because each try runs warmer.
- `hc send` joins whatever is unsent in the prompt, so anything half typed there goes with it. In Claude Code, `hc keys <t> ctrl+s` first sets the line aside until the next submit, but only press it while `› stashed` isn't showing: it's a toggle, and it replaces a held stash.
- A new Claude Code session hangs before its first request if a plugin touches `~/Desktop` while macOS is waiting on a permission dialog. After an update a fresh terminal can do this, and `ls ~/Desktop` hangs the same way.
- `hc wait` returns at once on a fresh agent, because it's idle before its first turn. `hc wait <t> --output <text> --timeout <s>` waits for real, as long as the text isn't in the prompt you sent.
- `hc wait <t> --output <text> --timeout <s>` also ends on a status, so on a blocked session it returns in about 0.03 s with `"reason":"status"`. It isn't a pause there.
- `hc attach` from a pseudo-terminal sizes a terminal for as long as it's attached, and the window's size comes back on detach. That's how to read a screen at a width the private window doesn't have.
- A new folder in `mods/` joins the shown layout as a block by itself, unless its `mod.json` has `"place": "none"`. Write `mod.json` first. Deleting a mod leaves that block behind, as an error in `herdr-app status`, until the block is taken out of the layout file.
- `pane.zoom` on the other pane of a tab swaps straight to it. On the pane already zoomed, it goes back to side by side. Zoom leaves focus where it was, so follow it with `pane.focus`.
- A mod that has started keeps running behind a zoom and in a tab that isn't shown.
- Typed in a terminal, `/model <name>` and `/effort <level>` save the choice as the default for new sessions. In the bare `/model` or `/effort` picker, `s` applies it to that session only.
- `hc send` from inside an hc terminal tags the text, and Claude Code treats a tagged `/command` as a chat message. A mod's `exec` has no `HC_TERMINAL_ID`, so its sends aren't tagged.
- `hc send` refuses while a session is blocked on a dialog. `hc keys` answers the dialog. The status report names it, such as `approve Bash: <command>`, and `hc read` shows the options.
- `claude -p --no-session-persistence --input-format stream-json --output-format stream-json --verbose` with `/usage` as its message prints the usage screen as text, with no turn and no cost. Its first message lists `slash_commands`, `terminal_slash_commands` and `skills`.
- `panes()` gives a mod pane no props, so anything another mod needs to know about it has to live in `shared`. `shared` is saved to `~/.config/herdr-app/shared.json` and survives a window restart.
- A mod pane split into a tab comes back after a window restart, with its zoom, its pane id and its `props()`.
- A key reaches a mod with the action `<mod>.<command>`, delivered to `nextCommand()`. `herdr-app do <mod>.<command>` reaches it too, which tests a mod's logic with no press. The comment in `gpui-kit.d.ts` shows a colon, which is out of date.
- `hc run -- claude` skips `~/.zshrc`, so the session has no `CLAUDE_CONFIG_DIR` and uses the default profile. Start it with `zsh -ic 'claude ...'`.
- `cliclick` presses aren't reliable on the tab bar. They need a held press (`dd:`, about 90 ms, `du:`), and there are stretches when none land even though a hand press works. A key sent with `cliclick kd:ctrl,shift t:j` missed too, so use a real `CGEvent` for keys.
- `scripts/install.sh` deletes what's in a folder it copies to, so don't give a mod here the name of one installed from somewhere else.
- `list` can't be scrolled from code: `track_scroll` is ignored, with only a line in the log. Use `v_virtual_list` and tell it the heights, and both come from `gpui-base`, not `gpui-kit`, as `TextView` does. Neither list's rows can hold a handler, so anything pressable has to be its own item.
- An exception in a list's row function blanks the list and leaves `herdr-app status` at `"errors": []`. Look in the log, which for a private window is `~/.config/hd/<slug>/window.log`.
- `on_size_change` is in window pixels. `.h()`, `.pt()` and, on 0.1.12, a virtual list's sizes are in the app's own, scaled by `settings().zoom`. On 0.1.10 the list's sizes were window pixels.
- `scripts/herdr-dev` runs a private Herdr, with its own window, app home and core, and never touches `~/.config/herdr-app` or the default core. The header of the script lists its commands: `up`, `install`, `run`, `session`, `shot`, `restart` and `down`, each with a slug. `~/.local/bin/herdr-dev` is the same file. Its home is `~/.config/hd/<slug>`. Use it for any check that needs a window. A `shot` takes about 1.2 s, so it can't show motion: a GIF made from shots runs at about 2 frames a second. For motion, record the screen region of the window with `ffmpeg` and `avfoundation`. Calling `shot` back to back holds back the app's async work, so leave gaps when something has to land. A window covered by another app stops drawing, and its shot is an old frame with no error: `herdr-dev shot <slug> <file> --front` reopens the window in front, waits 3 s for it to draw, takes the frame and gives focus back. The core and its sessions stay, and the layout comes back as it was.
- A private window can open under your own window and go unseen. `window.json` takes the display's id from `CGDisplayCreateUUIDFromDisplayID`, in lower case, and bounds in global coordinates, so a private window can open on the laptop screen. With no `display` it centres on the main one. Quit it and wait for its process to end before editing the file, or quitting writes the old bounds back.
- A window that's fully covered stops drawing, and `herdr-app do` can answer "the window did not answer". Private windows all open at the same bounds, so they cover each other. Quit one, change `bounds` in its `window.json`, then `herdr-dev up`, because quitting writes the file.
- A Claude Code started under another Claude Code inherits `CLAUDE_CODE_CHILD_SESSION` and doesn't save a transcript. It says so in its status area. A private Herdr started from a session hands it to every session inside, so start it with that variable unset.
- Geist Mono drops the space in ` --` here, in an `Editor` and in a plain element, so `node --test` draws as `node--test`. `TextView` isn't affected.
- `terminals()` gives `report`, which can be an object with `msg`, not a string. `child()` throws on an object.
- `hc send` can lose its Enter, most of all on a session that has just started or just after a multi-line send. The text stays in the prompt and the next send joins it. Read the prompt back before sending again. `hc send <t> ""` is an Enter that still refuses on a blocked session, which `hc keys <t> enter` doesn't.
- In Claude Code, one Ctrl+U clears one screen row of the prompt, and the next takes the line break. A path alone on its line in a paste attaches as an image.
- `Textarea` and `Input` bind enter, escape, up, down, tab and more under the context `Input`, and a binding beats `on_key_down`, so a handler above the text never hears those. Bind your own at the same depth, such as `Mine > Input`, and it wins because it was added later. Change the `key_context` name to bind a key only while it's wanted.
- `set_value` on a `TextareaState` doesn't fire `change`.
- A window that's fully covered stops rendering a mod, so a dump from it reads old state, and a hidden chat pane answers `unknown command` to `<mod>.<command>`. Check `stats.renders` moves before trusting a check.
- `image()` draws only from the app's own folder, relative to it. `window.dispatch_action` reaches Herdr's commands, so it can't press `input::Enter`. `cx.bind_keys` and `on_action` work on names of your own.
- `on_size_change` works on any element with an id, not just the root, including one drawn at `opacity(0)`. That's how to measure a row a list can't.
- `.line_height(23)` means 23 times the text size. Use `.line_height("23px")`.
- `scroll_to_bottom` uses the sizes from the last render. Called in the same handler that adds a row, it stops short of that row.
- Native motion enters `v_virtual_list`'s and `list`'s row function every frame, unlike `render`. It ran between 56 and 266 times a second in testing, while anything in the window animated. So it has to stay cheap, and it counts against the render limit.
- If a list's row function is stopped by the render limit, that frame draws the list empty, with no banner and nothing in `status`. It came back by the next shot, about 0.2 seconds later.
- `.transition` and `.spring` take a property name such as `height`, and the style method for it is `.h()`. `opacity`, `left` and `top` share their names.
- A spring starts from the last value it animated, so one that's missing for a frame doesn't move the element smoothly on the next. To place something with no motion, use `.spring(prop, { epsilon: 100000 })`, which lands in that frame, as does `.transition(prop, { duration: 0 })`. A 1 ms response lands a frame late. A new element with a `.spring` also lands at once, then springs on later changes.
- Herdr's `ease-out` is a cubic ease-out, not the browser's curve. Its spring takes the same response and damping as a textbook damped spring.
- A mod pane hidden behind a zoom keeps its timers but doesn't render, so `render` can't notice it's been hidden. Read `panes()` and `spaces()` from a timer.
- Timers that fall due during a slow frame run together with no frame between them. To draw something once and then change it, start the timer from `render`.
- `cx.timer` can be used from `render`, through the `cx` that `init` gets. `init` takes `(props, cx)`.
- `window` in a mod is the global with `paint_path`, not an import. `herdr` also exports a `window()` function, which is something else.
- `hc read <t> --lines N` can take 13 to 25 s and then add `[hc] incomplete: older output may be missing` under the screen, while plain `hc read <t>` took 0.03 s on the same terminal. Cause unknown. Read history only when it's needed, and drop that line before reading the bottom of a screen.
- In Claude Code's Bash prompt, the `│` mark on a command depends on the command, not the terminal: a line break or over 80 columns gets it. A shorter command has no mark, and wraps with none in a narrow split. Between the command and the question it can print a reason, such as `This command requires approval`, which takes the same mark when it's long.
- A Claude Code session's status can read `blocked` seconds before its dialog is drawn, because hooks run first, and it stays `blocked` for seconds after a key answers the dialog. Neither the status nor the screen alone says where a dialog is up to.
- A window that starts a session's core early keeps that core's environment: a core started from inside a Claude Code session passes `CLAUDE_CODE_CHILD_SESSION` to everything it runs, which turns transcript saving off. Restart the core to clear it.
- On 0.1.12 a path's numbers are the app's own: `PathBuilder` coordinates and stroke widths scale by `settings().zoom`, as `.w()` and `.left()` do. Before 0.1.12 they were window pixels. Draw paths in the app's own pixels, as `pen` in `mods/herd/view.js` does, or scaling them again puts them too far out. `"100%"` coordinates also work.
- A panel can fill the window: `layout.resize` the panel with `weight: 1` and `layout.hide` the `main` block, then `layout.show` and a `px` to go back. A node's `max` still caps it, and a `px` past the room makes the window grow.
- `.loop("opacity", { from, to, period })` and `.transition("left", ...)` run natively between renders, so a one second tick can still draw smooth motion. To send something across the screen, draw it once where it starts, then change `left` and `top` from `cx.timer.after` about 40 ms later.
- With the laptop shut there's only the external display, and a private window opens behind your own. Set its `bounds` to a stretch your window doesn't cover, and it stays uncovered and drawing.
- `hc ls --all --json` lists finished terminals with their `parent`, so a mod can walk a tree from it, and `hc get` still answers for them with `finished_ms` and `exit_code`.
- `.legwork/fanout-state.md` outlives its run, so an old one can still be in a repo.
- Terminals took Kitty images inline at 60 a second at 210 KB each. `t=f`, a file path, got no acknowledgement. They answer `CSI 16 t` with the cell size in pixels, 20 by 51 at 2x with the default font, and support mouse mode 1016, pixels. See `docs/browser-pane.md`.
- `herdr-app ls` gives each terminal's `pane`, which `pane.split` and `pane.focus` want. They don't take a terminal's address. `pane.split` takes focus. `space.new` doesn't select its space, and `space.select` takes `id`.
- `herdr-app shot` returns the last frame drawn, so a covered window gives an old one with no error. Check the window is on screen first.
