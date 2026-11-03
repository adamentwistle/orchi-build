# The browser pane

`herdr-browser` gives an agent a real Chrome it drives by command, shown live in a Herdr terminal as a split or a tab. Someone watching can click and type in the same page.

## Why it's built this way

A mod can't hold a web view, but Herdr terminals show images through Kitty graphics. So the pane is an ordinary terminal running a small viewer, and split and tab come from Herdr's own commands. agent-browser owns the browser, so agents use its normal commands, and a browser can run with no pane at all.

```bash
herdr-browser open http://localhost:3000            # split right, or --split down, --tab, --headless
herdr-browser show                                  # a pane for a browser that's already running
herdr-browser do snapshot -i                        # any agent-browser command
herdr-browser close                                 # closes the browser and its pane
```

A person opens it from the tab bar's + menu: Browser starts a new tab with its own browser, on the address row. Closing the tab, or Ctrl+Q, closes that browser too, because the pane started it. A pane opened by `herdr-browser open` or `show` didn't start its browser, so Ctrl+Q there leaves it running. The entry is `config/programs.json`, because the menu lists any program with a `run` command, so the shipped menu is unchanged. It sits under Start an agent for that reason. `scripts/install.sh` writes the entry with the whole path of `~/.local/bin/herdr-browser`, not the bare name: the app starts a menu program from a login shell, and `~/.zshenv` can rewrite PATH there (see `docs/herdr-desktop.md`). An agent opens one as a side pane with `herdr-browser open`.

## How it works

- `browser/herdr-browser.mjs` is the command and the viewer. `browser/lib.mjs` is the logic that needs no terminal or browser, tested in `tests/browser/`.
- The viewer attaches over the DevTools Protocol to the session's front tab, and checks once a second for a different one. A check has a 2 second timeout and only one runs at a time. Three in a row that fail or time out mean the browser has gone, and the pane closes. A call to the page that gets no answer in 5 seconds, or meets a closed socket, fails instead of waiting.
- Frames come from `Page.startScreencast` as PNG, because Kitty graphics can't take JPEG, which is what agent-browser's own stream sends. Only the newest is drawn.
- Each frame goes to the image id that isn't on screen, is placed, and then the old one is removed. Sending to the id on screen blanks the pane until the new picture has decoded: on a page of noise in a 1000 wide window, 460 of 604 recorded frames were blank before this, and 0 of 601 after, with the app down from 74 to 49 percent of a core.
- A page that isn't moving sends no frames, so attaching also takes one screenshot.
- The page's size follows the pane. Chrome won't draw narrower than 500, and leaves the rest of the frame empty if asked, so a narrow pane gets a smaller view of a 500 wide page.
- Mouse, wheel, keys and paste go back through `Input.dispatch*`. Ctrl+L types an address and Ctrl+Q closes the pane, leaving the browser running.
- A split takes focus, so `show` hands it back when the caller's tab is on screen. `--tab` uses `hc run` with labels, because `tab.new` moves the window.
- `scripts/install-browser.sh`, run by `install.sh`, writes `~/.local/bin/herdr-browser`, with absolute paths to node and agent-browser, and the skill. The skill goes to every Claude config dir that exists: `CLAUDE_CONFIG_DIR`, the `claude_dir` setting and `~/.claude`, and the output names each. It skips both in a private window, which only gets the menu entry. Node needs to be 22 or later, for its built in WebSocket. With no node, no agent-browser or an old node it warns on stderr and carries on with the rest of the install.
- `pane` asks `agent-browser session list --json` whether the session is already running, to decide if it owns the browser. If that output isn't one it knows, the pane stops with an error rather than guess, since a wrong guess closes a browser someone else started.

## Cloudflare

Challenge pages stop it. The browser is headless, so its user agent says `HeadlessChrome` and `navigator.webdriver` is true, and a click from the pane arrives as a scripted event. The pane doesn't disguise any of that. A headed Chrome on a saved profile failed a real challenge too, so the pane doesn't offer one.
