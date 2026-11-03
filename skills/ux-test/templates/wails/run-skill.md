---
name: run-__NAME__
description: Launch __NAME__ (a Wails app) and drive it in a browser. Use when asked to run, start or screenshot __NAME__, or to check a UI change in the running app.
---

# Run __NAME__

Written by the ux-test scaffold. The launch values match the webServer block in
`playwright.config.ts`.

## Launch

From the repo root:

```
wails dev
```

- The app is served at http://__DEV_SERVER__, with the Go bindings bridged into the
  browser. Vite's own port serves the page without them, so do not use it.
- `wails dev` also opens the native window. Leave it open: closing it stops the server.
- There is no readiness line. Poll http://__DEV_SERVER__ until it answers. A cold build
  takes about 40 seconds.
- If something already answers on that URL, use it and do not start a second server.
- This is the real app with the user's real app data.

## Drive

Use the agent-browser CLI with one `--session` id per worktree: `open` the URL,
`snapshot -i` for refs, `click`, `fill` or `press` on `@refs`, `wait` on an element,
text or URL (never a bare sleep), re-snapshot after the page changes, and `screenshot`
to confirm what changed.

## Stop

Run `agent-browser close`. Stop `wails dev` only if you started it, with Ctrl-C (SIGINT):
that lets it stop its frontend watcher, which a plain kill leaves running.
