# Setup migration

How setup moves the Linear API key out of `linear.json` and into the keychain, and the other old values into
`~/.config/orchi/settings.json`. This is for review before any of it is built (plan decisions 8, 12 and 26).

Two things move, and they are handled differently:

- **The key** is a secret. It moves only on a yes, after a backup, and the plaintext is removed only after the keychain
  has been read back.
- **The other values** are not secrets. They move without asking, because `settings.json` already wins over the old
  files and nothing is lost.

## Finding the key

Setup reads one file: `linear.json` in Herdr's app home, which is `$HERDR_APP_HOME`, else `~/.config/herdr-app` (the
same place the settings reader looks, `settings.old_dir()`). It looks at the `apiKey` field only. The key is there when
`apiKey` is a string that is not blank. Setup does not search anywhere else, does not read shell files, and does not
read the keychain to find it.

In a private window (Herdr's app home is not `~/.config/herdr-app`, as `scripts/herdr-dev` makes) setup does not touch
the keychain at all. The keychain is the user's one real login keychain, shared with every window, so a throwaway home
must never write to it. The step reports ok there.

## The question

One yes or no, asked at the terminal like every other question:

> Move your Linear API key from linear.json into the keychain?
> 1 Yes
> 2 No

Nothing else is asked about the key, and nothing is changed before the answer. With no terminal to ask (`curl | sh`
reads `/dev/tty`, so this means no terminal at all), the step is broken and says it needs a terminal. Nothing waits.

Two cases change the wording, still one yes or no:

- **The keychain already holds the same key.** An earlier run stopped after writing it. The question is "Remove your
  Linear API key from linear.json? It is already in the keychain." On yes, only the removal happens.
- **The keychain holds a different key.** Orchi never overwrites a keychain entry. The question is "Remove the Linear
  API key from linear.json? The keychain already holds a different one, which stays." On yes, only the removal happens.
  The removed key is in the backup.

## The backup

Taken by the step right after the yes and before anything else changes, with the engine's own backup (the same folder,
the same layout). It is not taken on a no, or each run that is answered no would leave another plaintext copy behind:

- **Where**: `~/.local/state/orchi/backups/<run>/<full path of linear.json>`, for example
  `~/.local/state/orchi/backups/2026-11-03T21-14-05/Users/me/.config/herdr-app/linear.json`. The closing line names
  the run's folder. Orchi never deletes a backup.
- **Mode**: the copy is mode 600 and every folder of the backups tree is mode 700, whatever the original was. Today the
  engine's backup keeps the original's mode and makes folders with the default mode, so this changes `store.py`: a
  backup folder is 700 and a copy drops group and other access. It applies to every backup, not only this one.
- **The cost**: the backup holds the plaintext key. It is the only copy that stays. The closing line says so, and
  the way to remove it is to delete the run's backup folder once the keychain works.
- **Restore**: `cp -p <backup file> ~/.config/herdr-app/linear.json`. To undo the keychain half too:
  `security delete-generic-password -s orchi-linear`. Both commands are in the closing line only when something was
  moved.

If the backup can't be taken, nothing else happens and the step is broken. A link is backed up as the file it points
at, since a copy of the link would not keep the key.

## Writing the key into the keychain

The key must not appear on a command line, because any process of the same user (and `ps`) can read another process's
arguments while it runs. `security add-generic-password -w <key>` would put it there.

Setup instead runs `/usr/bin/security -i`, which reads its commands from standard input, and sends the one command down
a pipe:

```
add-generic-password -a orchi -s orchi-linear -w <key>
```

The command line of the process is only `/usr/bin/security -i`. The key is in Orchi's memory and in the pipe, never in
an argument, the environment, a file or a log. Checked on this Mac: `security -i` takes its commands from a pipe, and it
exits 0 even when a command fails ("returned 1"), which is why the read-back below is what decides success, not the
exit code.

- It runs by its full path, without a shell, with output thrown away and a timeout of 120 seconds, since macOS may ask
  the user to allow it.
- The account is always `orchi` and the service `orchi-linear`, the name `orchi tickets` already reads
  (`src/orchi/tickets/keychain.py`). The item is made by `security`, so `security` can read it back without a prompt.
- Only keys made of letters, digits and `. _ ~ + / = -` go this way, which every Linear key is. Anything else is not
  passed to `security -i`, whose own quoting rules are not Orchi's to guess at. The step is broken, says which kind of
  character, and leaves `linear.json` alone.
- It never uses `-U`. An existing entry is never overwritten (see "The question").
- All keychain calls sit behind functions in `orchi.tickets.keychain` (`find_password` today, `store_password` new),
  the only code that starts `security`. Tests replace them.

## Reading it back, then removing the plaintext

1. Read the entry back with `find-generic-password -s orchi-linear -w` (the existing `find_password`; output comes back
   on a pipe, not an argument).
2. Compare it with the key from `linear.json`, with `hmac.compare_digest`.
3. Only if they are equal, rewrite `linear.json` without `apiKey`. Everything else in the file stays, in the same
   order, written whole (temporary file, then rename) and with the same permissions. If `linear.json` is a link, the
   file it points at is written and the link stays. The file stays the user's: it is not recorded as Orchi's.
4. The step's check runs again and must find no `apiKey` in the file and a keychain entry equal to the key it held.

Nothing else is removed. `linear.json` itself, `orchi.json` and the other fields stay where they are.

## No, and failure

- **No**: nothing changes. The step is broken and says "linear.json still holds your Linear API key". It asks again on
  the next run, which is how `Layout` treats "Keep mine". Doctor names it the same way. The old Linear panel keeps
  working from `linear.json` meanwhile.
- **The keychain write fails** (denied, locked, timed out, `security` missing): `linear.json` is untouched. The step
  is broken with one plain line that says what failed. Orchi never deletes a keychain entry: an add that failed
  because an item was already there, which Orchi could not read, looks the same as one that never happened, and that
  item is the user's. A stray entry is harmless; the next run reads it, and asks the "already in the keychain" question.
- **The read-back is empty or different**: the same: nothing in `linear.json` changes and the step is broken.
- **The run is stopped, or killed, between the write and the removal**: the key is in the keychain and still in
  `linear.json`. The next run asks the "already in the keychain" question and finishes the move. The backup from the
  first run is still there.
- **The rewrite of `linear.json` fails**: the key is in the keychain and still in the file, as above. The step is broken
  and says the file can't be written.
- **`linear.json` isn't valid JSON, or isn't an object**: setup leaves it alone, as `read_object` does elsewhere. The
  step is broken and names the file.

Orchi does not record the keychain entry in its ownership records, which list files, links and folders. The key is the
user's, so `orchi uninstall` leaves the entry and says so.

## The other values

Setup moves these into `~/.config/orchi/settings.json`, the same way `settings.resolve()` already reads them, so the
effective settings do not change:

| Old file | Old value | settings.json key |
|---|---|---|
| `orchi.json` | `workerLimit` | `worker_limit` |
| `linear.json` | `teams` | `linear.teams` |
| `linear.json` | `repos` | `linear.repos` |
| `linear.json` | `legwork.dir` | `legwork_dir` |
| `linear.json` | `legwork.projects` | `linear.legwork_projects` |

- A value moves only if it is valid, and only if `settings.json` does not already set that key. It is the value
  `settings.resolve()` gives, so a bad old value is dropped, not copied. A value equal to the default is not copied.
- `settings.json` is written whole, keeping every key already in it. If it is missing it is made, and it is recorded as
  Orchi's. If it exists and Orchi didn't make it, it is backed up first by the engine, like any other file.
- The old files stay as they are, apart from the removed `apiKey`. They are the user's. The settings reader goes on
  reading them for any key `settings.json` leaves out, which can no longer matter once the key is in `settings.json`.
- This part asks nothing. If `settings.json` is not valid JSON, the step is broken, names the file, and writes nothing.

## The tickets panel

Nothing to change. The panel that replaced the Linear panel (`mods/tickets`) reads tickets through `orchi tickets`,
which already looks in the keychain under `orchi-linear`, so it keeps working after the key moves. No mod reads the key
out of `linear.json`.

## Tests

- Every keychain call goes through `orchi.tickets.keychain`, which every test replaces with a fake that keeps its
  entries in a dict. A guard (the top `conftest.py` already has one) fails any test that starts `security`.
- The fake `store_password` records the arguments it was given, and a test asserts the key is in none of them and
  in none of the environment, the way the real call is made: the command's argument list is exactly
  `["/usr/bin/security", "-i"]` and the key is in `input`.
- A test proves a real run would have used a scratch copy: with `HOME`, `HERDR_APP_HOME` and `ORCHI_STATE` in a
  temporary folder, the only `linear.json` the step can see is the temporary one, and a private window never reaches
  the fake.
- Cases: yes with a clean keychain; yes with the same key already there; yes with a different key there; no; no
  terminal; the write failing; the read-back empty; the read-back different; a key with a character `security -i`
  won't take; the run stopped between the write and the removal, then rerun; a rerun after a finished move changing
  nothing; `linear.json` a link; `linear.json` not valid JSON; a backup that can't be taken; the backup being mode 600
  inside a 700 folder; the key never in the closing line, the `--json` output, an error or the state folder's
  `state.json`.
- The other values: each row of the table; a value already in `settings.json`; an invalid old value; a value equal to
  the default; `settings.json` missing, present and not Orchi's, present and not JSON; a rerun changing nothing.

## What is not proven by tests

The real `security -i add-generic-password` has not been run, because no test or build run may write to the real
login keychain. A check on a fresh account on another Mac, before release, proves it once.

## Decisions for the reviewer

1. The backup keeps the plaintext key on disk until the user deletes it. The alternative is a backup that has the key
   field cut out, which could not restore the file. This spec keeps the restorable one.
2. A "No" leaves the step broken and asked again every run. The alternative is to remember the "No" in the state
   folder, which adds state for the sake of one question.
3. The keychain entry is not an ownership record, and `orchi uninstall` leaves it.
4. No mod change is needed: the tickets panel reads through `orchi tickets`, which reads the keychain.
5. Backup folders become mode 700 and their copies drop group and other access, for every step.
