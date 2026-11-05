"""The engine every setup step runs on.

A step has a name, a check and, when Orchi can make the change itself, a fix. The check changes nothing and says ok,
needs a fix (and what), or broken (and why). Bare `orchi` checks each step in order, fixes what needs it and checks
again; `orchi doctor` only checks. Both exit non-zero while anything is still wrong.

A fix makes its changes through the Context it is given: write, link, folder, remove and ask. Those record what Orchi
creates, so uninstall removes only that, and back up anything that was already there before changing it. A step
that changes things another way names them in touches(), and they are backed up before its fix starts.

docs/adr/0002-orchi-steps.md has the reasons.
"""
import contextlib
import os
import re
import secrets
import sys
from collections import namedtuple

from orchi import store as store_mod
from orchi import system
from orchi.screen import BROKEN, FIXED, NEEDS_FIX, OK, STOPPED, Screen

EXIT_OK, EXIT_WRONG, EXIT_STOPPED = 0, 1, 130


class SetupError(Exception):
    """Something a step can't do, in one plain line."""


def last_line(text):
    """The last line of some output that says anything, or ''."""
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    return lines[-1] if lines else ""


class Check(namedtuple("Check", "status detail")):
    __slots__ = ()


def ok():
    return Check(OK, "")


def needs_fix(what):
    return Check(NEEDS_FIX, what)


def broken(why):
    return Check(BROKEN, why)


class Step:
    name = ""
    # Set by the engine when a run fixed this step, for a later step that acts on what changed.
    changed = False

    def check(self):
        """ok(), needs_fix(what) or broken(why). Changes nothing."""
        raise NotImplementedError

    def touches(self):
        """Paths the fix may change by means other than the Context, to back up before it starts."""
        return []

    def fix(self, ctx):
        """Make the change. May return a word or two saying what it did."""
        raise NotImplementedError

    def can_fix(self):
        return type(self).fix is not Step.fix


class Context:
    """What a fix changes things with."""

    def __init__(self, step, store, screen):
        self.step, self.store, self.screen = step, store, screen
        self.handled = set()

    def write(self, path, data, mode=None):
        """Make path hold data (text or bytes), replacing it whole, with mode if given."""
        path = store_mod.full(path)
        if path.is_dir() and not path.is_symlink():
            raise IsADirectoryError(f"{path} is a folder")
        if not self._before_change(path):
            try:
                with store_mod.shielded():
                    store_mod.replace_file(path, data, new=True, mode=mode)
                    self.store.own(path, "file", self.step.name)
                return
            except FileExistsError:
                self._before_change(path)
        mine = self.store.owns(path)
        with store_mod.shielded():
            store_mod.replace_file(path, data, mode=mode)
            if mine:
                self.store.own(path, "file", self.step.name)

    def link(self, target, path):
        """Make path a link to target."""
        path = store_mod.full(path)
        if path.is_symlink() and os.readlink(path) == os.fspath(target):
            return
        if path.is_dir() and not path.is_symlink():
            raise IsADirectoryError(f"{path} is a folder")
        if not self._before_change(path):
            try:
                with store_mod.shielded():
                    os.symlink(target, path)
                    self.store.own(path, "link", self.step.name)
                return
            except FileExistsError:
                self._before_change(path)
        mine = self.store.owns(path)
        temporary = None
        try:
            while temporary is None:
                temporary = path.parent / f".{path.name}.{secrets.token_hex(4)}"
                try:
                    with store_mod.shielded():
                        os.symlink(target, temporary)
                except FileExistsError:
                    temporary = None
            with store_mod.shielded():
                os.replace(temporary, path)
                if mine:
                    self.store.own(path, "link", self.step.name)
        except BaseException:
            if temporary is not None:
                with contextlib.suppress(OSError):
                    os.unlink(temporary)
            raise

    def folder(self, path):
        """Make path a folder, and any folder above it that is missing."""
        path = store_mod.full(path)
        missing = []
        here = path
        while not os.path.lexists(here):
            missing.append(here)
            here = here.parent
        if not here.is_dir():
            raise NotADirectoryError(f"{here} is not a folder")
        for folder in reversed(missing):
            self.handled.add(folder)
            with store_mod.shielded():
                folder.mkdir()
                self.store.own(folder, "folder", self.step.name)

    def remove(self, path):
        """Take away a file or link Orchi made and that is still what Orchi made, or a folder Orchi made that is
        empty. Anything else stays, whoever it belongs to. Returns whether it went."""
        path = store_mod.full(path)
        self.handled.add(path)
        if not os.path.lexists(path):
            self.store.disown(path)
            return False
        if not self.store.owns(path):
            return False
        folder = store_mod.kind(path) == "folder"
        if folder and os.listdir(path):
            return False
        with store_mod.shielded():
            os.rmdir(path) if folder else os.unlink(path)
            self.store.disown(path)
        return True

    def ask(self, question, choices):
        return self.screen.ask(question, choices)

    def ask_many(self, question, choices):
        return self.screen.ask_many(question, choices)

    def ask_text(self, question):
        return self.screen.ask_text(question)

    def ask_secret(self, question):
        return self.screen.ask_secret(question)

    def note(self, text):
        """Something for the closing line: where a backup is that matters, or how to undo what was done."""
        if text not in self.store.notes:
            self.store.notes.append(text)

    def run(self, argv, input=None, timeout=None, env=None, interactive=False):
        """Start a program through orchi.system. One that uses the terminal gets it to itself."""
        if not interactive:
            return system.run(argv, input=input, timeout=timeout, env=env)
        with self.screen.paused():
            return system.run(argv, input=input, timeout=timeout, env=env, interactive=True)

    def _before_change(self, path):
        """Back up what is at path unless Orchi made it. Returns whether anything was there."""
        self.handled.add(path)
        if not os.path.lexists(path):
            self.store.disown(path)
            return False
        if not self.store.owns(path):
            self.store.disown(path)
            self.store.backup(path)
        return True


def run(steps, fix, screen, store):
    """Check every step, and fix those that need it when fix is set. Returns the exit code."""
    command = "orchi" if fix else "doctor"
    with contextlib.ExitStack() as held:
        try:
            held.enter_context(store.lock() if fix else store.peek())
            record = {"command": command, "started": store_mod.now(), "pid": os.getpid(), "finished": False,
                      "stopped": False, "steps": [], "backup": None}
            if fix:
                store.save_run(record)
        except KeyboardInterrupt:
            screen.finish(_report(command, [], True, None, "Stopped.", ok=False))
            return EXIT_STOPPED
        except (store_mod.Busy, store_mod.StoreError) as e:
            return _not_started(screen, command, str(e))
        except OSError as e:
            return _not_started(screen, command, f"Orchi's state folder can't be used: {_why(e)}")
        return _run(steps, fix, screen, store, command, record)


def _not_started(screen, command, why):
    screen.finish(_report(command, [], False, None, why, ok=False))
    return EXIT_WRONG


NOT_READY = "Orchi is not ready for {} yet."
PLATFORMS = {"windows": "Windows", "linux": "Linux"}


def main(fix, as_json):
    from orchi import steps
    screen = Screen(sys.stdout, as_json=as_json)
    where = system.platform()
    if where != "darwin":
        # Nothing runs: the steps below are a Mac's.
        command = "orchi" if fix else "doctor"
        screen.finish(_report(command, [], False, None, NOT_READY.format(PLATFORMS.get(where, where)), ok=False))
        return EXIT_WRONG
    return run(steps.steps(), fix=fix, screen=screen, store=store_mod.Store())


def _run(steps, fix, screen, store, command, record):
    results = record["steps"]
    screen.begin([s.name for s in steps])
    stopped = False
    try:
        for step in steps:
            try:
                screen.running(step.name)
                status, detail = _one(step, fix, screen, store)
            except KeyboardInterrupt:
                status, detail, stopped = STOPPED, "", True
            results.append({"name": step.name, "status": status, "detail": detail})
            screen.result(step.name, status, detail)
            if stopped:
                break
    except KeyboardInterrupt:
        stopped = True
    # A second Ctrl-C waits until the run is recorded and the closing line is out, then only stops it.
    try:
        report = _close(fix, screen, store, command, record, stopped)
    except KeyboardInterrupt:
        return EXIT_STOPPED
    if stopped:
        return EXIT_STOPPED
    return EXIT_OK if report["ok"] else EXIT_WRONG


def _close(fix, screen, store, command, record, stopped):
    """Record the run and show its closing line."""
    results = record["steps"]
    with store_mod.shielded():
        backup = str(store.backup_dir) if store.backup_dir else None
        report = _report(command, results, stopped, backup, notes=store.notes)
        if fix:
            record.update(finished=not stopped, stopped=stopped, ended=store_mod.now(), backup=backup,
                          summary=report["summary"])
            with contextlib.suppress(OSError):
                store.save_run(record)
        screen.finish(report)
    return report


def _one(step, fix, screen, store):
    """The status and detail for one step: checked, and fixed and checked again when that is wanted."""
    try:
        found = _checked(step)
    except Exception as e:
        return BROKEN, _why(e)
    if found.status != NEEDS_FIX:
        return found.status, found.detail
    if not step.can_fix():
        return BROKEN, found.detail
    if not fix:
        return NEEDS_FIX, found.detail
    ctx = Context(step, store, screen)
    try:
        touched = [store_mod.full(p) for p in step.touches()]
        was_there = {p: ctx._before_change(p) for p in touched}
        mine = {p for p in touched if store.owns(p)}
        ctx.handled.clear()
        try:
            did = step.fix(ctx)
        finally:
            for path in (p for p in touched if p not in ctx.handled):
                # What the fix made, or changed of Orchi's, by other means is still Orchi's, even if it then failed.
                if os.path.lexists(path) and (path in mine or not was_there[path]) and not store.owns(path):
                    store.own(path, store_mod.kind(path), step.name)
        again = _checked(step)
    except Exception as e:
        return BROKEN, _why(e)
    if again.status == OK:
        step.changed = True
        return FIXED, did or "fixed"
    return BROKEN, again.detail or found.detail


def _checked(step):
    """The step's check, which must give ok, needs-fix or broken."""
    found = step.check()
    if not isinstance(found, Check) or found.status not in (OK, NEEDS_FIX, BROKEN):
        raise ValueError(f"the check gave {found!r}, not ok, needs-fix or broken")
    return found


def _summary(changed, to_fix, needs_you, stopped, backup, notes=()):
    """What the run came to on one line, then the backup and each note on a line of their own."""
    parts = ["Stopped."] if stopped else []
    if changed:
        parts.append(f"Changed: {', '.join(changed)}.")
    if to_fix:
        parts.append(f"Run orchi to fix: {', '.join(to_fix)}.")
    if needs_you:
        parts.append(f"Needs you: {', '.join(needs_you)}.")
    if not parts:
        parts.append("All set.")
    lines = [" ".join(parts)]
    if backup:
        lines.append(f"Backup: {backup}")
    lines.extend(notes)
    return "\n".join(lines)


def _report(command, results, stopped, backup, summary=None, ok=None, notes=()):
    """The facts of a run: what --json prints, and what the closing line says."""
    def named(status):
        return [r["name"] for r in results if r["status"] == status]

    changed, to_fix, needs_you = named(FIXED), named(NEEDS_FIX), named(BROKEN)
    return {
        "command": command,
        "ok": (not stopped and all(r["status"] in (OK, FIXED) for r in results)) if ok is None else ok,
        "stopped": stopped,
        "steps": results,
        "changed": changed,
        "to_fix": to_fix,
        "needs_you": needs_you,
        "backup": backup,
        "summary": summary or _summary(changed, to_fix, needs_you, stopped, backup, notes),
    }


def _why(error):
    """An error as one plain line."""
    text = re.sub(r"^\[Errno \d+\] ", "", str(error)) or type(error).__name__
    return " ".join(text.split())
