# usage-watch

usage-watch keeps the usage cache fresh. Every five minutes it reads Claude Code's own login from the keychain, asks
Anthropic's usage endpoint how full each limit is, and writes the answer to one file. Herd, the Orchi panel, the chat
pane, usage-guard and switchboard-wait read that file. ccstatusline is optional and never a dependency.

`bin/usage-watch` is the script and `launchd/orchi.usage-watch.plist.template` its launch agent. Setup (B11) loads
the launch agent and adds the doctor step.

## Decisions

Reviewed and passed on 2026-11-03.

1. **Its own cache file.** usage-watch writes `~/.cache/orchi/usage.json`, not ccstatusline's
   `~/.cache/ccstatusline/usage.json`. The keys are the same, so each reader changes only its path. Sharing ccstatusline's
   file would mean two writers racing on one file whenever ccstatusline is also installed, and ccstatusline rewrites it
   readable by anyone on the Mac. The five readers moved to it with usage-watch.
2. **No dump, no fallback search.** ccstatusline falls back to `security dump-keychain` and tries every entry whose name
   starts with `Claude Code-credentials`. usage-watch never does either. It looks up the one name Claude Code itself uses
   for the profile, and if that isn't there, it stops.
3. **Five minutes.** One request every five minutes while the launch agent is loaded, 288 a day at most. ccstatusline
   asks every three minutes while a status line is on screen.
4. **No proxy.** It ignores `HTTPS_PROXY` and talks to Anthropic directly. A Mac that needs a proxy gets `offline` from
   doctor until proxy support is added.

## The login

Claude Code keeps its login in the login keychain as a generic password. It writes and reads it with `/usr/bin/security`.
In Claude Code 2.1.317 the entry is named like this:

- **Service**: `Claude Code-credentials`, plus `-` and the first 8 hex characters of the SHA-256 of the profile folder's
  path when the profile isn't the default. Claude Code adds that suffix whenever `CLAUDE_CONFIG_DIR` is set, hashing the
  path as given, in Unicode NFC form.
- **Account**: the `USER` environment variable, else the login name. A name with anything but letters, digits, `.`, `_`
  and `-` becomes `claude-code-user`.
- **Value**: JSON. The login is `claudeAiOauth.accessToken`. The same JSON holds a refresh token, which usage-watch never
  uses.

usage-watch works out the one name from Orchi's settings:

- `claude_dir` set: the service with the suffix, hashed from `claude_dir` exactly as the settings reader gives it
  (full path, `~` expanded, no trailing `/`). That is the path Orchi starts sessions with as `CLAUDE_CONFIG_DIR`.
- `claude_dir` not set: the plain `Claude Code-credentials`.
- `claude_dir` set to `~/.claude` and the suffixed entry missing: the plain name too. Both are Claude Code's entries for
  the same profile, depending on whether the session that signed in had `CLAUDE_CONFIG_DIR` set.

The lookup is one command, run without a shell, from its full path so nothing on `PATH` can stand in for it:

```
/usr/bin/security find-generic-password -a <account> -s <service> -w
```

`security`'s error output is thrown away. usage-watch reads the value from the pipe, takes `claudeAiOauth.accessToken`,
and drops the rest at once. It never runs `dump-keychain`, never searches by prefix, never reads any other entry, and
never writes, changes or deletes a keychain entry. It never refreshes the login either: Claude Code does that when it
runs, and usage-watch picks up the new login on its next pass.

`security` exit codes: 0 found; 44 no such entry (`no-login`); 36, a locked keychain, and a lookup that times out are
`keychain-locked`; anything else, such as a denied prompt, is `keychain-denied`. The lookup times out after 10 seconds, or 120 seconds for setup's first read.

## The endpoint

One host, one path, one method:

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <login>
anthropic-beta: oauth-2025-04-20
User-Agent: orchi-usage-watch/<version>
```

- HTTPS only, with the system's certificate check. A redirect is never followed; it counts as `endpoint-changed`.
- The URL is a constant in the code, not a setting. Nothing in the settings, the environment or a response can send
  the login anywhere else.
- Timeout 10 seconds. The login goes only in that header, in memory: never on a command line, in the environment, in a
  file or in a log.

The answer is JSON. usage-watch maps it to the cache keys the readers already use, the way ccstatusline 2.2.27 does:

| Cache key | From the answer |
|---|---|
| `sessionUsage`, `sessionResetAt` | `five_hour.utilization` and `.resets_at`; else the `limits[]` entry with `kind` `session` (`percent`, `resets_at`) |
| `weeklyUsage`, `weeklyResetAt` | `seven_day.utilization` and `.resets_at`; else the `limits[]` entry with `kind` `weekly_all` |
| `fableUsage`, `fableResetAt` | the `limits[]` entry with `kind` `weekly_scoped` whose `scope.model.display_name` contains "fable", any case |

- `five_hour: null` means the account has no 5-hour limit. It becomes `sessionUsage` 0 with no `sessionResetAt`, which
  the readers already take as "no limit". Nothing is taken from `limits[]` for it.
- A `limits[]` entry with a 0 `percent` and no `resets_at` is a placeholder and is skipped, and so is one with no
  usable `percent`; the next entry of the same kind is used.
- A usage that isn't a number from 0 to 100 counts as missing.
- A reset time that isn't an ISO 8601 date and time of at most 40 characters counts as missing.
- A key with no value is left out of the cache rather than written as null.
- If the answer gives neither a session nor a weekly number, the endpoint has changed shape: `endpoint-changed`. A
  null `five_hour` alone doesn't count as a session number.

## The cache file

`~/.cache/orchi/usage.json`, only ever written after a good answer:

```json
{
  "sessionUsage": 29,
  "sessionResetAt": "2026-09-19T23:41:00+00:00",
  "weeklyUsage": 40,
  "weeklyResetAt": "2026-09-21T08:00:00+00:00",
  "fableUsage": 9,
  "fableResetAt": "2026-09-21T08:00:00+00:00",
  "updatedAt": "2026-09-19T20:41:07Z"
}
```

- Usage values are percentages from 0 to 100, as the endpoint gives them, whole or not. Reset times are rewritten in
  UTC to the second, as `YYYY-MM-DDTHH:MM:SS+00:00`, a form every reader parses, Python 3.9's included. `updatedAt` is when usage-watch got the answer, in UTC.
- It holds nothing about the login or the account: no token, no fingerprint of one, no email, no organisation.
- The folder `~/.cache/orchi` is made with mode 700 if it doesn't exist. If it is a symlink, isn't the user's, or
  others can write to it, usage-watch writes nothing and logs `<folder> is not a private folder`. With nowhere to keep
  its state, it logs that on every pass. Any other error with the folder or its files is one log line too, never a
  traceback. The file is mode 600.
- Each write goes to a temporary file in the same folder, made with mode 600, then renamed over the old file, so a reader
  never sees half a file.
- A failed pass leaves the file as it was. usage-guard ignores a file more than an hour old, by its modified time, and
  then reads ccstatusline's file if that is installed (`docs/adr/0004-usage-guard-reads-the-usage-cache.md`). The
  panels and switchboard-wait show the last numbers it holds, however old, as they did with ccstatusline's file;
  `updatedAt` says when they are from, and doctor names usage-watch broken once they are more than an hour old.

## The state file

`~/.cache/orchi/usage-watch.json`, mode 600, written after every pass. Doctor and setup read it; nothing else does.

```json
{
  "status": "ok",
  "checkedAt": "2026-09-19T20:41:07Z",
  "okAt": "2026-09-19T20:41:07Z",
  "nextAt": "2026-09-19T20:46:07Z",
  "retryAt": null,
  "failures": 0,
  "http": 200
}
```

`status` is one of:

| Status | Meaning | Next try |
|---|---|---|
| `ok` | The cache was written | 5 minutes |
| `no-login` | No keychain entry under the one name | 1 hour |
| `keychain-denied` | The read was refused | 1 hour |
| `keychain-locked` | The keychain is locked, or the read timed out | 5 minutes, doubling to 1 hour |
| `login-expired` | The endpoint said 401 or 403 | 15 minutes, doubling to 1 hour |
| `rate-limited` | The endpoint said 429 | its `Retry-After` (seconds or a date), else 5 minutes, at most 1 hour |
| `offline` | No connection, a timeout, or a 5xx | 5 minutes, doubling to 1 hour |
| `endpoint-changed` | A redirect, any other 4xx but 408, an answer that isn't JSON, or no session or weekly number in it | 1 hour |

The file is read only when it is a plain file of at most 64 KB, without following a symlink. A field of the wrong
type reads as null, and a file that can't be read, or has no known `status`, reads as no state at all.

A launch agent pass more than 30 seconds before `nextAt` does nothing; the 30 seconds keep launchd's timer from
skipping a pass that is due. No pass goes before `retryAt`. `failures` counts the passes in a row that ended in this status, so the doubling starts over when the status
changes.
`retryAt` is when a 429's `Retry-After` ends, or null when the last answer gave none; `--now` waits only for this one.
`http` is the status code, or null when no request was made.

## Running

**Launch agent.** `orchi.usage-watch`, from `launchd/orchi.usage-watch.plist.template`, runs `bin/usage-watch` once
every 300 seconds (`StartInterval`) and once when loaded, as a background process. One pass and it exits; it holds no
login between passes. Setup loads it with `launchctl bootstrap gui/<uid>`, so it runs in the user's login session where
the keychain is open.

**On demand.**

- `usage-watch`: one pass, skipped if before `nextAt`. This is what the launch agent runs.
- `usage-watch --now`: one pass even before `nextAt`, but never before `retryAt`, so a `Retry-After` is always honoured. Prints one line:
  the status. Setup uses it.
- `usage-watch --status [--json]`: reads the state file, asks `launchctl` whether the launch agent is loaded, and
  prints the status, or why it is broken. It never touches the keychain or the network. Exit 0 when it isn't broken,
  1 when it is. Doctor uses it.

A lock file, `~/.cache/orchi/usage-watch.lock`, mode 600, held with `flock`, keeps two passes from running at once. A
launch agent pass that finds it held exits without doing anything; `--now` waits for it. The lock is opened without
following a symlink.

It is a Python 3.9 script on the standard library only, like the other launch agent scripts, so it runs on
`/usr/bin/python3`. That needs the developer command-line tools, which setup already checks for; without them,
`/usr/bin/python3` is only an installer.

## Setup's first read

Setup (B11) makes the first keychain read happen while the user is at the screen:

1. Setup runs `usage-watch --now` in the foreground, in the user's terminal, before the launch agent is loaded. Its step
   shows as running while the read waits, up to 120 seconds.
2. If macOS asks whether `security` may read the entry, the dialog appears then. "Always Allow" lets the launch agent's
   later reads through without asking again.
3. `ok`: setup loads the launch agent. `no-login`: setup says to sign in to Claude Code and leaves the launch agent off.
   `keychain-denied`: setup says so and leaves it off. Any other status: setup loads it anyway, since those clear up on
   their own.

## Doctor

Doctor's step runs `usage-watch --status --json` and changes nothing. Its `broken` is the reason, or null. In order:

| `broken` | When |
|---|---|
| `cache folder not private` | `~/.cache/orchi` is a symlink, isn't the user's, or others can write to it |
| `never ran` | there is no state file |
| `endpoint changed`, `no login`, `keychain denied` | the last pass's status |
| `launch agent not loaded` | `launchctl print gui/<uid>/orchi.usage-watch` fails |
| `login expired`, `offline`, `rate limited`, `keychain locked` | `okAt` is more than an hour old, and that is the last status |
| `no usage for over an hour` | `okAt` is more than an hour old for any other reason |

Doctor shows the reason on the step's line, such as `usage-watch  endpoint changed`.

## What it never does

- Read any keychain entry but the one named above, or list or dump the keychain.
- Write, change or delete anything in the keychain.
- Send the login anywhere but `https://api.anthropic.com/api/oauth/usage`.
- Put the login on a command line, in the environment, in a file, or in any output.
- Log or print the login, the keychain value, the endpoint's answer, or the text of an exception from the request.
  Its log, `~/.cache/orchi/usage-watch.log` (the launch agent's standard error), gets one line when the status changes:
  the time, the status and the HTTP code.
- Refresh the login, or call any other Anthropic endpoint.

## Tests

The build's tests never touch the real keychain or the network:

- The keychain read and the request are functions passed in. Tests pass fakes: a keychain that returns a made-up value
  or an exit code, and an endpoint that returns a made-up status, headers and body.
- Every test runs with `HOME` and `ORCHI_SETTINGS` pointing at a temporary folder.
- A guard fixture makes starting any program and opening any network connection raise for the whole file, so a test
  that reached the keychain, `launchctl` or the endpoint would fail. Tests prove the guard trips for each of the three.
- Tests cover each status, the backoff for each, a `Retry-After` given in seconds and as a date, the file modes, the
  atomic write, the lock, the one-name lookup for each `claude_dir` case, and that no output or log line contains the
  fake login.

## Prior art

- **ccstatusline** (Matthew Breedlove, MIT, version 2.2.27, `github.com/sirmalloc/ccstatusline`). usage-watch takes from
  it the endpoint, the `anthropic-beta` header, the mapping from the answer to the cache keys, and the key names the
  readers already use. No code is copied; the Python is written fresh. `NOTICE.md` gets a line for it.
- **Claude Code 2.1.317**. The entry's name, account and value come from reading the program Claude Code ships, and the
  name was checked on one Mac with a single named lookup that printed no value.

## Still unknown

- **Whether macOS prompts at all.** Claude Code writes the entry with `/usr/bin/security`, so `security` is probably
  already on the entry's access list and no prompt appears. The fresh-account check in Release (R3) shows which.
- **Exit codes for a refused prompt.** 44 for no entry and 36 for a locked keychain are the codes Claude Code itself
  checks; which code a denied or cancelled prompt gives isn't known, so every other non-zero code is `keychain-denied`.
- **Path normalising.** Claude Code hashes the profile path as it receives it. A `CLAUDE_CONFIG_DIR` with a trailing `/`
  or a symlink in it gives a different name from the settings' cleaned path, and usage-watch would report `no-login`.
- **The endpoint is not a published API.** Its shape has changed before (`limits[]` arrived after the `five_hour` and
  `seven_day` buckets). `endpoint-changed` and doctor are the guard.
- **Other sign-ins.** A Claude Code using a custom sign-in server (`CLAUDE_CODE_CUSTOM_OAUTH_URL`) or
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` names its entry differently. usage-watch doesn't support those and reports
  `no-login`.
- **Other platforms.** macOS only. Windows and Linux keep the login in a file, not covered here.
