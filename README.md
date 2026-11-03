# Orchi

Orchi dresses the [Herdr](https://github.com/ogulcancelik/herdr) desktop app for running many Claude Code agents at
once: its own look, panels for tickets, agents and progress, and an orchestration layer that plans work, hands it to
agents and answers for you when they need a decision.

## What's here

| Path | What it is |
| --- | --- |
| `themes/`, `scripts/build-themes.py` | Orchi's dark and light themes, and the script that builds them from its palette |
| `config/` | The Herdr settings that go with them, and the browser's entry in the + menu |
| `mods/` | The panels: chat, Herd, progress, Linear, Orchi, the sidebar list and chrome, plan view |
| `layouts/`, `keys/` | The layout that holds the panels, and their keys |
| `sounds/` | The alert sounds, with their sources |
| `browser/` | The browser pane agents drive |
| `bin/` | The orchestration scripts: the switchboard, the herdr wrapper, hooks |
| `skills/`, `commands/` | The Claude Code skills and commands for planning and orchestration |
| `launchd/` | The switchboard's health watcher job |
| `docs/` | How each piece works, and setup |
| `tests/`, `bin/tests/` | The checks |

## Settings

Orchi reads `~/.config/orchi/settings.json` (`$ORCHI_SETTINGS` for the scripts). Every key can be left out, and then
its default holds. `src/orchi/settings.schema.json` is the schema. No secret ever goes in this file.

| Key | What it is | Default |
| --- | --- | --- |
| `claude_dir` | The Claude Code profile folder sessions Orchi starts run under | Claude Code's own, `~/.claude` |
| `orchi_dir` | Orchi's checkout | `~/orchi-build` |
| `legwork_dir` | The legwork tracker | none |
| `worker_limit` | Workers that can run at once, across every run, from 1 to 50 | `6` |
| `usage_guard_percent` | How full a usage limit gets, from 1 to 100, before usage-guard pauses a session | `95` |
| `sources` | The ticket sources planning reads: `legwork`, `github`, `linear`, `markdown` | `["legwork"]` |
| `github.own_owners` | GitHub users and organisations that are yours | none |
| `github.repos` | GitHub repos whose issues are tickets, as `owner/repo` | none |
| `github.command` | The command that runs gh, such as `gh-personal` | `gh` |
| `linear.teams` | Linear teams to pull in, by key | none, so the issues assigned to you |
| `linear.projects` | Linear projects to pull in, by id | none |
| `linear.repos` | The folder each Linear team works in, by team key | none |
| `linear.legwork_projects` | The legwork project each Linear project belongs to, by Linear project id | none |
| `markdown.paths` | Markdown task files, or folders of them | none |

Legwork is always a source. The Linear API key is never a setting: it is `LINEAR_API_KEY` when that is set, else the
keychain's generic password under the service `orchi-linear`. Until setup moves them, `workerLimit` in
`~/.config/herdr-app/orchi.json`, and `teams`, `repos`, `legwork.dir` and `legwork.projects` in
`~/.config/herdr-app/linear.json`, count for any of these keys the file leaves out.

## Use it

```bash
scripts/install.sh            # put the themes, mods, layout, keys and sounds into Herdr
uv tool install .             # install the `orchi` command from this checkout
orchi tickets                 # the open tickets of every chosen source; --json for agents
orchi tickets show ENG-12     # one ticket by its reference
scripts/herdr-dev             # run a private Herdr for testing
node --test tests/            # the panels' checks
python3 -m pytest bin/tests   # the scripts' checks
```

See `docs/setup.md` for the switchboard.

## Licence

MIT, see `LICENSE`. Parts come from other projects: see `NOTICE.md`.
