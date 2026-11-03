---
name: run-__NAME__
description: Launch __NAME__ (a Next app) and drive it in a browser. Use when asked to run, start or screenshot __NAME__, or to check a UI change in the running app.
---

# Run __NAME__

Written by the ux-test scaffold. The launch values match the webServer block in
`playwright.config.ts`.

## Launch

From the repo root:

```
npx next dev --port 3000
```

- The app is served at http://localhost:3000.
- It prints `Ready` when the server is up. Each route compiles on its first request,
  so the first page load is slow. Wait on the page, not on a sleep.
- If something already answers on that URL, use it and do not start a second server.
- `next dev` reads `.env.local`, so the app talks to whatever services those values
  point at.

## Drive

Use the agent-browser CLI with one `--session` id per worktree: `open` the URL,
`snapshot -i` for refs, `click`, `fill` or `press` on `@refs`, `wait` on an element,
text or URL (never a bare sleep), re-snapshot after the page changes, and `screenshot`
to confirm what changed.

## Stop

Run `agent-browser close`. Stop `next dev` only if you started it.
