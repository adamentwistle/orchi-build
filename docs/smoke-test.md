# Smoke test

Runs the whole flow once in a private Herdr, with made-up data: planning, the switchboard, a worker's push, and a pull
request opened and merged on a scratch repo. Then the installer, in a scratch home. Takes about 30 minutes.

Every session runs Claude Code on Haiku at low effort, under the `~/.claude` profile. The skills are read by path from
the checkout under test, never linked into the profile. `<scratch>` is a throwaway folder, `<checkout>` is the Orchi
checkout under test, and `<repo>` is `<scratch>/orchi-smoke`.

## 1. Set up

1. Make `<scratch>/legwork`, a git repo with `projects/smoke.md`: frontmatter with `repo: <repo>`, a `## Vision` and a
   `## Log`. Commit it.
2. Clone the scratch repo: `git clone git@github-personal:adamentwistle/orchi-smoke.git <repo>`. Add `.legwork/` and
   `.claude/settings.local.json` to its `.git/info/exclude`. Give it `.claude/settings.local.json` with allow rules for
   `git`, `herdr` and `gh-personal pr create|edit|view|list|merge`, and deny rules for `git push origin main`,
   `git push --force` and `git push -f`.
3. Start the window: `scripts/herdr-dev up smoke <checkout>`, from a slug whose home in `~/.config/hd` has no
   `orchi-settings.json` yet. `herdr-dev` gives the window, its core, every terminal in it and every `run` the
   window's own `ORCHI_SETTINGS` and a launcher in `~/.config/hd/smoke/orchi-app` for the checkout's `bin/herdr`, and
   drops your `LEGWORK_DIR`, so sessions there never read your settings or tracker, or start your installed Orchi. It exits 1 when a step needs a terminal to answer
   (agent-browser, ticket sources); the window is still dressed.
4. Only now write `~/.config/hd/smoke/orchi-settings.json`: `claude_dir` `~/.claude`, `orchi_dir` `<checkout>`,
   `legwork_dir` `<scratch>/legwork`, `github.own_owners` `["adamentwistle"]`, `github.command` `gh-personal`. Written
   before `up`, the install would link the skills into `~/.claude`. `agent start` starts every session with the
   `claude_dir` it names.
5. Open a space in the repo: `herdr-dev run smoke herdr-app do space.new '{"name":"smoke","folder":"<repo>"}'`. Its
   terminal is `t1`. Below, `H` is `herdr-dev run smoke env HC_TERMINAL_ID=t1 ~/.config/hd/smoke/orchi-app/herdr`.

A session in a folder it hasn't seen stops at the trust question, and `agent start` returns `timeout`. Answer it with
`herdr-dev run smoke hc keys <pane> down enter`.

## 2. Planning

```
H agent start planner-smoke --kind claude --pane t1 -- --model haiku --effort low
H agent prompt t1 "Read <brief> with the Read tool and follow it exactly."
```

The brief points at `<checkout>/skills/roadmap-planning/SKILL.md`, names the project, the tracker and the one change
(a line at the end of the README), runs the ticket sweep with `PYTHONPATH=<checkout>/src python3 -m orchi tickets
--json`, and keeps the design doc local.

It passed if the tracker has a `## Roadmap 1` with the item, a `## Next prompt` of `/fanout smoke --merge`, and the
legwork repo has the commit.

## 3. Switchboard and orchestrator

The switchboard keeps its files in `~/.claude/switchboard`, the profile's own. Run this only when that folder isn't
there, so no real switchboard uses the profile; the clean-up then removes what the run made.

1. The switchboard, in a tab of its own in `<checkout>`:
   ```
   H tab create --cwd <checkout> --env CLAUDE_CONFIG_DIR=$HOME/.claude --env DISABLE_AUTO_UPDATE=true --label switchboard
   H pane rename <pane> switchboard
   H agent start switchboard --kind claude --pane <pane> -- --model haiku --effort low --settings <scratch>/switchboard-settings.json
   ```
   `switchboard-settings.json` holds the allow rules in `docs/setup.md`, plus deny rules for
   `switchboard-health-ctl on` and `off`, so the run never loads a launch agent.
2. The orchestrator, in a tab in `<repo>`: `H tab create --cwd <repo> --env DISABLE_AUTO_UPDATE=true --label
   orch-smoke`, then `H agent start orch-smoke ...` as above without `--settings`, then `/rename orch-smoke`. Its
   prompt points at the switchboard-protocol and fanout skills by path, says to run `/fanout smoke --merge` with
   `gh-personal`, allows merging, and asks for one `DECISION` (the README line) before it dispatches.
3. Prompt the switchboard to read `<checkout>/skills/switchboard/SKILL.md` and follow it as `/switchboard smoke`.
4. When it shows the decision, press Esc (`H agent send-keys switchboard escape`), then answer `smoke-2: A`.

It passed if:

- `~/.claude/switchboard/state.md` lists `smoke`, its repo and its pane.
- The switchboard showed the decision as written and tried a push notification.
- Esc left no `switchboard-wait` for the repo.
- The answer reached the orchestrator, which went back to work, and the file has `ANSWERED smoke-2: A`.

## 4. A worker's push

The orchestrator writes the brief, makes the worktree with `herdr worktree create`, starts `fw-readme-line` on Haiku
and sends the brief.

It passed if the worker pushed `fanout/readme-line` and printed `PR <url> | GATE PASS | UNPROVEN none`.

## 5. The pull request, merged

The orchestrator reviews it with `/pr-review` (`bugbot-wait` says `NO_BUGBOT`, so `/code-review`), closes the worker
pane, removes the worktree and merges with `gh-personal pr merge <n> --squash --delete-branch`. If the auto-mode check
refuses the merge, it writes an `ACTION`; answer it through the switchboard (`smoke-6: merge it`).

It passed if:

- The pull request is merged and `git -C <repo> ls-remote --heads origin` lists only `main`.
- The orchestrator wrote `DONE`, and the switchboard took `smoke` out of the state file and stopped.

## 6. The installer, in a scratch home

1. List `~/.local/bin`, `~/.local/share/uv/tools` and `~/.local/state/orchi` to compare later.
2. Run everything below with `env -i`, keeping only `HOME=<scratch>/home`, `USER`, `LOGNAME`, `SHELL`, `LANG`,
   `TERM`, `TMPDIR`, `PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, `HERDR_APP_HOME=$HOME/herdr-app`,
   `HERDR_TELEMETRY=0` and `ORCHI_NO_SYSTEM=1`. That drops `CLAUDE_CONFIG_DIR`, every `XDG_*` and every `HC_*`.
3. First print where `uv tool dir --bin`, Orchi's state folder, Herdr's app home and the Claude folder would land
   (the last three from `orchi.store`, `orchi.herdr` and `orchi.settings`). Every one must be under `<scratch>/home`.
4. Without a token, the README's one line:
   `curl -fsSL https://raw.githubusercontent.com/adamentwistle/orchi-build/main/install.sh | sh`.
5. With one, read in the same command and passed only to that process, inside the `env -i` list, because `env -i`
   clears an assignment in front of it: `env -i <the list> ORCHI_GITHUB_TOKEN="$(gh-personal auth token)" sh <
   install.sh`.
6. `<scratch>/home/.local/bin/orchi update` and `<scratch>/home/.local/bin/orchi doctor`, with the same environment.
   The `PATH` above doesn't have that folder.

It passed if:

- Without the token, as a stranger runs it, it found the latest release, downloaded it, uv installed `orchi` into the
  scratch home, and `orchi` ran its steps. Steps that need the system say they were refused, or that they need a
  terminal.
- With the token, the checkout's own `install.sh` did the same. The line without one runs main's installer, as a
  stranger gets it, so a change to `install.sh` is tested only here.
- `orchi update` said in one line that the download is refused while `ORCHI_NO_SYSTEM` is set. Checking the newest
  needs GitHub, so run it once more without `ORCHI_NO_SYSTEM`, only after
  `gh-personal api repos/adamentwistle/orchi-build/releases/latest -q .tag_name` shows the installed version: it
  then says `Orchi <version> is the newest.` and starts nothing.
- `orchi doctor` ran and listed every step.
- The three listings from the start have not changed.

## 7. Clean up

`scripts/herdr-dev down smoke`. Then check no `claude` started by the run is left, and remove
`~/.claude/switchboard`, which the run made (it wasn't there before step 3).

## Things to know

- An orchestrator that goes idle without `CYCLE` or `DONE` is reported once, by the next wait. The wait's cursor
  remembers the pane's state, so later waits run normally. The switchboard nudges it rather than stopping to ask.
- `herdr agent prompt --wait` fails with `agent_prompt_stalled` on `/clear` and `/rename`, because they never show a
  working state even though they land. The skills skip `--wait` for those and check the pane instead.
- Auto mode refuses a session's edit of the `.claude/settings.local.json` of the folder it runs in, as changing its
  own permissions. Write the repo's allow rules before the planning session.
- On Haiku, the orchestrator may make a one-line change itself, with no worker and no review. Its prompt has to say to
  dispatch a worker pane and to review with `/pr-review`.
- Start the orchestrator's work before prompting the switchboard. A switchboard whose first wait finds the pane
  already done may stop to ask rather than wait again.
- On Haiku, the review subagent can report clean after a very short run, and the auto-mode check may then refuse a
  merge chained with other commands as a merge without review.
