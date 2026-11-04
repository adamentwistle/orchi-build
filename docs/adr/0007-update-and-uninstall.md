# 7. `orchi update` and `orchi uninstall`

Accepted, 2026-11-04.

## Context

Plan decisions 16 to 18 say the installed `orchi` command updates itself and removes what it made, and the Vision's
"Done means" says the README covers install, update and uninstall. These are the answers that shape them. Each was put
to the plan, `CONTEXT.md` and the Vision before it was settled.

## Decision

### Update

- **The newest release is GitHub's latest release**, the same one `install.sh` installs: `GET /repos/<repo>/releases/latest`,
  then the source archive at `/repos/<repo>/tarball/<tag>`. `ORCHI_REPO`, `ORCHI_API_URL` and `ORCHI_GITHUB_TOKEN` mean
  what they mean in `install.sh`. A draft or pre-release is never the latest, so it is never installed.
- **Orchi downloads the archive itself** (`orchi.system.get`), not with curl, so a test can serve it from this
  computer. The token goes in a request header, is never on a command line, in a file or in output, and is dropped when
  a redirect leaves the host it was meant for. A page is HTTPS only, except a server at the address 127.0.0.1 or ::1 (a
  test server; the name `localhost` is not trusted, since the hosts file decides where it goes), which is asked directly,
  never through a proxy named in the environment.
- **Installing is `uv tool install --force <archive>`**, as `install.sh` does. The archive is in a temporary folder
  that is gone afterwards.
- **Newest is decided by the number in the tag**, `v0.2.0` against the running `orchi.__version__`. The same or
  a higher version is "newest". A development build such as `0.3.0.dev1` counts by its leading numbers: it moves to
  that version once it is released, and is never taken back to an older one. A tag that
  is not a version number changes nothing and says so. With `--json` the one object is printed after the steps, so `ok`
  says whether they worked.
- **One line says what happened**: `Updated Orchi from 0.1.0 to 0.2.0.`, `Orchi 0.2.0 is the newest.`, or one plain line
  for what stopped it. A failure changes nothing and exits 1; "newest" exits 0.
- **Then the new Orchi runs the steps.** The running program is the old code, so after the install it starts the new
  `orchi` (found with `uv tool dir --bin`, never by searching PATH, which may hold an older copy) as a child with the terminal, and its exit code is update's. The steps
  refresh the content and ask what they need, as bare `orchi` does.
- **`--json`** prints one object with `from`, `to`, `updated` and the summary, and the steps run on the terminal as
  before.

### Uninstall

- **It reads the ownership records and nothing else.** A record is removed only when what is at the path is still what
  Orchi made (`Store.owns`). A file, link or folder the user changed or replaced is kept, and named with the reason.
  A path that is already gone only loses its record.
- **A folder goes only when it is empty** once what Orchi made inside it has gone, deepest first.
- **The usage-watch launch agent is unloaded before its file goes** (`launchctl bootout`), even when the file was
  deleted by hand, since launchd keeps a job loaded without it. Only "not loaded" (exit 113) from `launchctl print`
  means there is nothing to unload; any other failure, or one `bootout` refuses, keeps the file and says so. The file's
  owner is checked again after the question, so an agent the user swapped in meanwhile is left loaded.
- **It keeps, and says it kept**: files Orchi made that the user changed, folders that still hold something, the
  backups, the Linear key in the keychain (read to see whether it is there, never changed), and the usage cache in
  `~/.cache/orchi`, which usage-watch writes and no step records. Programs setup installed, the planning skills plugin
  and the folder-trust answers are the user's too, and are not removed.
- **A user's file Orchi added to** (a `keys.json` that was there first) is the user's, and stays as it is now, with the
  copy taken before in the backups.
- **`settings.json` goes only if Orchi made it and it is unchanged.** That is the same rule as every other record: it
  is Orchi's until the user writes to it.
- **It asks once**, one question naming how many files, links and folders it will remove, before anything is
  removed. `--yes` skips the question for agents. With nothing to remove it asks nothing. With no terminal and no
  `--yes` it removes nothing and says so.
- **It holds the lock** bare `orchi` holds, so it never overlaps a run.
- **It runs on any system.** It only reads the records; the launch agent is only touched when there is a record for it.
- **The `orchi` command itself is not removed** by itself. The last line says `uv tool uninstall orchi`.
- **A rerun changes nothing.** Removed records are dropped; kept ones stay and are listed again. What went is recorded
  as gone however the removal ends, Ctrl-C included, and a folder it can't read is kept and counts as a problem (exit 1).
  A launch agent that will not unload keeps its record, even when its file is gone, so the next run tries again. An
  unreadable folder is a problem (exit 1) even when nothing else is left to remove.

## Consequences

- The state folder, with `owned.json`, `state.json`, the lock and the backups, stays after uninstall. It is the record
  of what was kept, and the backups are the user's way back.
- `Store.disown_many` drops many records in one write.
