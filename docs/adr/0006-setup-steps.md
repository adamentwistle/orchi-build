# 6. The setup steps, and the one-line installer

Accepted, 2026-11-04.

## Context

Plan decisions 16 and 18 make bare `orchi` the whole setup: it finds out what it can, asks the rest, installs what is
missing after a yes, and ends with Herdr showing Orchi. These are the answers that shape it. Each was put to the plan,
`CONTEXT.md` and the Vision before it was settled.

## Decision

- **A Mac only.** On Windows or Linux nothing runs, doctor included, and the closing line says Orchi is not ready for
  that system. Nothing in the steps below has a version for them.
- **Order.** The settings steps, then the tools, then the Claude steps, then the Herdr content, then the ticket
  questions, then usage-watch, then the Herdr reload. The tools come first because the browser pane needs node and
  agent-browser, and the reload is last because it acts on what the content steps changed (`Step.changed`, set by the
  engine when a fix took).
- **Every installer is the maker's own, run after a yes.** Apple's `xcode-select --install` (waited for up to 30
  minutes, then "finish the installer window, then run orchi again"), Homebrew's script, `brew install` for the GitHub
  CLI, terminal-notifier and node, `npm install -g agent-browser` and its own `install`, Claude Code's script at
  claude.ai, and the Herdr app and core scripts at releases.herdr.dev. Homebrew's script runs with the terminal because
  it asks for the password. One question per tool; a no is a broken step that says "not installed". A tool that needs
  another says so before asking ("needs Homebrew").
- **The GitHub CLI is whatever `github.command` names.** If it names something other than `gh` (a wrapper such as
  gh-personal), setup checks that command exists and never installs over it.
- **Everything setup starts goes through `orchi.system`.** `run`, `fetch`, `find`, `sleep` and `platform` are the only
  doors to the computer, and `orchi.tickets.keychain` is the door to the keychain. Tests replace both. The real ones
  also refuse while `ORCHI_NO_SYSTEM` is set, which the test suite sets for itself and every child it starts, so a test
  that runs the real command in a child process still cannot start an installer, read the keychain or load a launch
  agent. Tests that run the command in a child use `pkgtests/orchi_driver.py`, which has the settings and Herdr steps
  only.
- **Skills and commands are linked, not copied.** Claude Code reads them from `claude_dir`, so a link means an update
  of the package changes them in place, and the step points a link again when the data folder moves. The browser skill
  is left out, because the Browser pane step writes it. The planning skills (`grilling`, `domain-modeling`) come from
  the mattpocock-skills plugin, installed with `claude plugin install` under the profile, after a yes.
- **`claude_dir` is written** (the shell's `CLAUDE_CONFIG_DIR`, else `~/.claude`) so scripts, panels and sessions agree
  on one profile. One already set stays.
- **Folder trust is answered in the file Claude Code keeps it in**, `<claude_dir>/.claude.json`, for the Orchi folder
  and the legwork folder when they exist, after a backup of the file. That is the same answer pressing Yes gives.
  Sessions Orchi starts have `CLAUDE_CONFIG_DIR` set, so that is the file they read even for `~/.claude`. For
  `~/.claude`, `~/.claude.json` gets the answer too, because a plain `claude` reads that one, and
  `~/.claude/.claude.json` only when Claude Code has made it.
- **A private window leaves shared things alone.** With a Herdr app home that is not the usual one, the launch agent is
  not touched, and the Claude steps do nothing unless the private settings name a `claude_dir` of their own.
- **The questions are the listed ones.** Which of GitHub, Linear and Markdown to read (legwork is always on), the
  Linear key, and the Linear teams and projects. Each answer is saved in `settings.json`, "none" included, so it is
  asked once. The GitHub repos, the Markdown paths and the legwork folder are not asked: setup can't find them out and
  they are settings the user edits. When Linear is a source and a legwork folder is set, setup offers the line from
  `docs/legwork-sync.md` for `<legwork_dir>/house-rules.md`: nothing is written there without a yes, and a no is
  remembered in the state folder so it is not asked every run.
- **The Linear key** is typed with echo off, checked against Linear before it is kept, and stored with
  `keychain.store_password` (the command goes down a pipe to `security -i`, so the key is on no command line),
  then read back. A key Linear refuses, or the keychain doesn't keep, is never left behind. 
- **The migration** is two steps, "Old settings" (the old values into `settings.json`, no question) and "Linear key"
  (the key out of `linear.json` into the keychain, one yes or no, a backup first that only the owner can read). It is
  specified in `docs/setup-migration.md`, was reviewed before it was built, and uses the same writer. Setup never
  deletes a keychain entry, because a failed add and an add that met an unreadable item look the same. The backup is
  taken in the fix after the yes, not by the engine before the question, so a no leaves no plaintext copy. The tickets
  panel needed no change: it reads through `orchi tickets`, which already reads the keychain.
- **usage-watch** follows its spec: the first read in the foreground, then the launch agent in
  `~/Library/LaunchAgents`, rendered from the template with Orchi's own files and the settings path. No login, or a
  refused keychain, leaves the agent off and says so. A launch agent that points at an old data folder is loaded again.
- **The reload** switches the layout on screen to itself, which makes the app read it again, then reports the app's
  errors once. With no window open there is nothing to reload.
- **`install.sh`** is the short script at the root. It installs uv with uv's installer if missing, finds the latest
  release tag through the GitHub API, downloads that tag's source archive with curl and installs it with
  `uv tool install` (no git). `ORCHI_GITHUB_TOKEN` is passed to curl as a header read from standard input, so it is on
  no command line, in no file and in no output. It then runs `orchi`, with the terminal as its input when there is
  one, since Orchi asks its questions at the terminal itself.

## Consequences

- A run that is stopped part way, or fails at one step, is simply run again: every step checks first.
- The first run on a Mac with nothing asks about nine installs before it asks about tickets. That is the price of
  asking before each install.
- `orchi_dir` still defaults to `~/orchi-build`. Setup does not create it or point it at the installed package; that is
  for the switchboard work that follows.
