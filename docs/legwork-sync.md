# Legwork's Linear sync

`orchi tickets sync` moves the Linear issues on a legwork project's `linear:` line the way `/wrap` does, so legwork
needs no Linear tools of its own (`docs/adr/0005-tickets-write-side.md`). Legwork doesn't know Orchi. One line in
its house rules, `<legwork_dir>/house-rules.md`, hands the sync over, and setup offers to add it:

```
- After `/wrap` or `/shelve` updates a project that has a `linear:` line, sync its Linear issues with `orchi tickets sync legwork:<project> --pr <url> --yes`, one `--pr` for each pull request this session opened or merged, instead of moving them yourself; when this session's rules say no Linear writes, run `orchi tickets sync legwork:<project> --dry-run` and report what it would change.
```

Without the line, `/wrap` works as it did. To see what a sync would do on its own:

```
orchi tickets sync legwork:<project> --dry-run
```
