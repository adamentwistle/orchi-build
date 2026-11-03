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

Orchi reads `~/.config/orchi/settings.json`. Every value has a default.

| Key | What it is | Default |
| --- | --- | --- |
| `claude_dir` | The Claude Code profile folder | `~/.claude` |
| `orchi_dir` | This checkout | `~/orchi-build` |
| `legwork_dir` | The legwork tracker | none |
| `github.own_owners` | GitHub owners that are yours | none |

## Use it

```bash
scripts/install.sh            # put the themes, mods, layout, keys and sounds into Herdr
uv tool install .             # install the `orchi` command from this checkout
scripts/herdr-dev             # run a private Herdr for testing
node --test tests/            # the panels' checks
python3 -m pytest bin/tests   # the scripts' checks
```

See `docs/setup.md` for the switchboard.

## Licence

MIT, see `LICENSE`. Parts come from other projects: see `NOTICE.md`.
