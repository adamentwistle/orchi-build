"""The engine: steps are checked, and fixed only by bare `orchi`; doctor changes nothing; ownership, backups, the
lock and the record of runs hold up when a fix fails, is stopped with Ctrl-C, or the run is killed."""
import io
import json
import os
import signal
import subprocess
import sys

import pytest

from engine_help import DRIVER, child_env, home, snapshot  # noqa: F401
from orchi import engine, screen, store


class FileStep(engine.Step):
    """Makes sure a file holds some text."""

    def __init__(self, name, path, text):
        self.name, self.path, self.text = name, path, text

    def check(self):
        if not self.path.exists():
            return engine.needs_fix("missing")
        return engine.ok() if self.path.read_text() == self.text else engine.needs_fix("out of date")

    def touches(self):
        return [self.path]

    def fix(self, ctx):
        ctx.write(self.path, self.text)


class Fixed(engine.Step):
    def __init__(self, name, result):
        self.name, self.result = name, result

    def check(self):
        return self.result


class Fixable(Fixed):
    """A step with a fix that does nothing, so its check decides."""

    def fix(self, ctx):
        pass


def run(steps, fix, as_json=False):
    out = io.StringIO()
    code = engine.run(steps, fix=fix, screen=screen.Screen(out, as_json=as_json), store=store.Store())
    return code, out.getvalue()


def closing(output):
    """The closing lines: everything after the blank line under the steps."""
    return output.rstrip("\n").split("\n\n")[-1]


# The step model

def test_a_check_says_ok_needs_a_fix_or_broken():
    assert engine.ok().status == "ok"
    assert engine.needs_fix("missing") == ("needs-fix", "missing")
    assert engine.broken("no disk") == ("broken", "no disk")


def test_a_step_with_nothing_to_fix_is_ok_in_both_modes(home):
    for fix in (True, False):
        code, out = run([Fixed("Fine", engine.ok())], fix=fix)
        assert code == 0
        assert out.splitlines()[0].split() == ["✓", "Fine"]


# Bare orchi

def test_bare_orchi_fixes_what_needs_it(home):
    code, out = run([FileStep("First file", home / "a", "A"), FileStep("Second file", home / "b", "B")], fix=True)
    assert code == 0
    assert (home / "a").read_text() == "A" and (home / "b").read_text() == "B"
    assert "Changed: First file, Second file." in closing(out)


def test_a_fix_is_checked_again_and_one_that_does_not_take_is_broken(home):
    class Stubborn(FileStep):
        def fix(self, ctx):
            ctx.write(self.path, "something else")

    code, out = run([Stubborn("Stubborn", home / "a", "A")], fix=True)
    assert code == 1
    assert "out of date" in out.splitlines()[0]
    assert closing(out).startswith("Needs you: Stubborn.")


def test_a_fix_that_fails_breaks_its_step_and_the_rest_still_run(home):
    class Failing(FileStep):
        def fix(self, ctx):
            raise OSError("disk full")

    code, out = run([Failing("Failing", home / "a", "A"), FileStep("Second file", home / "b", "B")], fix=True)
    assert code == 1
    assert "disk full" in out.splitlines()[0]
    assert (home / "b").read_text() == "B"


def test_a_check_that_fails_is_broken(home):
    class Crashing(engine.Step):
        name = "Crashing"

        def check(self):
            raise ValueError("bad value")

    code, out = run([Crashing()], fix=True)
    assert code == 1
    assert "bad value" in out.splitlines()[0]


def test_a_step_that_needs_a_fix_but_has_none_is_broken(home):
    code, out = run([Fixed("Manual", engine.needs_fix("set it by hand"))], fix=True)
    assert code == 1
    assert out.splitlines()[0].split()[0] == "✗"
    assert closing(out) == "Needs you: Manual."


def test_a_broken_step_makes_bare_orchi_exit_non_zero(home):
    code, out = run([Fixed("Fine", engine.ok()), Fixed("Bad", engine.broken("no disk"))], fix=True)
    assert code == 1
    assert closing(out) == "Needs you: Bad."


# Doctor

def test_doctor_changes_nothing(home):
    (home / "c").write_text("yours")
    steps = [FileStep("First file", home / "a", "A"), FileStep("Third file", home / "c", "C")]
    run(steps, fix=True)
    (home / "a").unlink()
    (home / "c").write_text("yours again")
    before = snapshot(home)
    code, out = run(steps, fix=False)
    assert snapshot(home) == before
    assert code == 1
    assert closing(out) == "Run orchi to fix: First file, Third file."


def test_doctor_on_a_new_machine_creates_no_state_folder(home):
    run([FileStep("First file", home / "a", "A")], fix=False)
    assert not store.state_dir().exists()
    assert list(home.iterdir()) == []


def test_doctor_exits_zero_when_everything_is_ok(home):
    code, out = run([Fixed("Fine", engine.ok())], fix=False)
    assert code == 0
    assert closing(out) == "All set."


def test_doctor_names_what_needs_fixing_and_what_needs_you(home):
    code, out = run([Fixable("Fixable", engine.needs_fix("missing")), Fixed("Bad", engine.broken("no disk"))],
                    fix=False)
    assert code == 1
    lines = out.splitlines()
    assert lines[0].split()[:2] == ["!", "Fixable"] and lines[0].endswith("missing")
    assert lines[1].split()[:2] == ["✗", "Bad"] and lines[1].endswith("no disk")
    assert closing(out) == "Run orchi to fix: Fixable. Needs you: Bad."


def test_doctor_never_runs_a_fix(home):
    class Loud(engine.Step):
        name = "Loud"

        def check(self):
            return engine.needs_fix("missing")

        def fix(self, ctx):
            raise AssertionError("doctor ran a fix")

    code, _ = run([Loud()], fix=False)
    assert code == 1


# Ownership

def test_what_a_fix_creates_is_owned(home):
    run([FileStep("First file", home / "a", "A")], fix=True)
    records = store.Store().owned()
    assert [(r["path"], r["kind"], r["step"]) for r in records] == [(str(home / "a"), "file", "First file")]


def test_a_file_that_was_already_there_is_never_owned(home):
    (home / "a").write_text("yours")
    run([FileStep("First file", home / "a", "A")], fix=True)
    assert (home / "a").read_text() == "A"
    assert store.Store().owned() == []


def test_a_folder_and_a_link_a_fix_makes_are_owned(home):
    class Tree(engine.Step):
        name = "Tree"

        def check(self):
            return engine.ok() if (home / "x" / "y" / "link").is_symlink() else engine.needs_fix("missing")

        def fix(self, ctx):
            ctx.folder(home / "x" / "y")
            ctx.link(home / "target", home / "x" / "y" / "link")

    (home / "target").write_text("t")
    code, _ = run([Tree()], fix=True)
    assert code == 0
    kinds = {r["path"]: r["kind"] for r in store.Store().owned()}
    assert kinds == {str(home / "x"): "folder", str(home / "x" / "y"): "folder",
                     str(home / "x" / "y" / "link"): "link"}


def test_changing_a_file_orchi_made_takes_no_backup_and_keeps_it_owned(home):
    run([FileStep("First file", home / "a", "A")], fix=True)
    code, out = run([FileStep("First file", home / "a", "A2")], fix=True)
    assert code == 0
    assert "Backup" not in closing(out)
    assert store.Store().owns(home / "a")
    assert not (store.state_dir() / "backups").exists()


# Backups

def test_a_file_is_backed_up_before_it_changes_and_the_closing_line_names_the_backup(home):
    (home / "a").write_text("yours")
    code, out = run([FileStep("First file", home / "a", "A")], fix=True)
    assert code == 0
    backups = list((store.state_dir() / "backups").iterdir())
    assert len(backups) == 1
    assert (backups[0] / str(home / "a").lstrip("/")).read_text() == "yours"
    assert closing(out) == f"Changed: First file.\nBackup: {backups[0]}"


def test_backups_are_taken_before_the_fix_starts(home):
    seen = {}

    class Watching(FileStep):
        def fix(self, ctx):
            seen["backups"] = [str(p) for p in (store.state_dir() / "backups").rglob("*") if p.is_file()]
            super().fix(ctx)

    (home / "a").write_text("yours")
    run([Watching("First file", home / "a", "A")], fix=True)
    assert any(p.endswith(str(home / "a")) for p in seen["backups"])


def test_a_file_a_step_did_not_name_is_still_backed_up_before_it_changes(home):
    class Quiet(FileStep):
        def touches(self):
            return []

    (home / "a").write_text("yours")
    code, out = run([Quiet("First file", home / "a", "A")], fix=True)
    assert code == 0
    assert "Backup: " in closing(out)
    backup = closing(out).split("Backup: ")[1]
    assert (store.Store().root / "backups").exists()
    assert open(os.path.join(backup, str(home / "a").lstrip("/"))).read() == "yours"


def test_a_run_with_nothing_to_back_up_names_no_backup(home):
    code, out = run([FileStep("First file", home / "a", "A")], fix=True)
    assert closing(out) == "Changed: First file."


# The record of runs

def test_a_run_is_recorded(home):
    run([FileStep("First file", home / "a", "A"), Fixed("Bad", engine.broken("no disk"))], fix=True)
    last = store.Store().last_run()
    assert last["command"] == "orchi"
    assert last["finished"] and not last["stopped"]
    assert [(s["name"], s["status"]) for s in last["steps"]] == [("First file", "fixed"), ("Bad", "broken")]


def test_doctor_is_not_recorded(home):
    run([FileStep("First file", home / "a", "A")], fix=True)
    before = store.Store().last_run()
    run([FileStep("First file", home / "a", "A")], fix=False)
    assert store.Store().last_run() == before


# The lock

def test_a_run_while_another_holds_the_lock_changes_nothing_and_says_so(home):
    with store.Store().lock():
        code, out = run([FileStep("First file", home / "a", "A")], fix=True)
    assert code == 1
    assert out == f"Another orchi run is going (pid {os.getpid()}).\n"
    assert not (home / "a").exists()


def test_doctor_waits_for_no_one_but_says_when_a_run_is_going(home):
    with store.Store().lock():
        code, out = run([Fixed("Fine", engine.ok())], fix=False)
    assert code == 1
    assert out.startswith("Another orchi run is going")


def test_the_lock_is_free_after_every_kind_of_run(home):
    class Failing(FileStep):
        def fix(self, ctx):
            raise OSError("disk full")

    run([Failing("Failing", home / "a", "A")], fix=True)
    run([Fixed("Fine", engine.ok())], fix=False)
    with store.Store().lock():
        pass


# Ctrl-C

class StopsHalfWay(engine.Step):
    """Writes its first file, then Ctrl-C lands before the second, unless told to finish."""
    name = "Two files"

    def __init__(self, home, finish=False):
        self.home, self.finish = home, finish

    def check(self):
        done = (self.home / "one").exists() and (self.home / "two").exists()
        return engine.ok() if done else engine.needs_fix("missing")

    def touches(self):
        return [self.home / "yours"]

    def fix(self, ctx):
        ctx.write(self.home / "one", "1")
        ctx.write(self.home / "yours", "changed")
        if not self.finish:
            raise KeyboardInterrupt
        ctx.write(self.home / "two", "2")


def test_ctrl_c_mid_fix_stops_the_run_and_a_rerun_finishes_it(home):
    (home / "yours").write_text("original")
    code, out = run([StopsHalfWay(home), FileStep("Later", home / "later", "L")], fix=True)
    assert code == 130
    assert closing(out).startswith("Stopped.")
    first_backup = closing(out).split("Backup: ")[1]
    assert not (home / "later").exists()
    assert (home / "one").read_text() == "1"
    last = store.Store().last_run()
    assert last["stopped"] and not last["finished"]
    assert [s["status"] for s in last["steps"]] == ["stopped"]

    code, out = run([StopsHalfWay(home, finish=True), FileStep("Later", home / "later", "L")], fix=True)
    assert code == 0
    assert (home / "two").read_text() == "2" and (home / "later").read_text() == "L"
    owned = [r["path"] for r in store.Store().owned()]
    assert sorted(owned) == sorted({str(home / "one"), str(home / "two"), str(home / "later")})
    assert len(owned) == len(set(owned))
    assert open(os.path.join(first_backup, str(home / "yours").lstrip("/"))).read() == "original"
    assert store.Store().last_run()["finished"]


def test_ctrl_c_during_a_check_in_doctor_stops_and_changes_nothing(home):
    class Interrupted(engine.Step):
        name = "Interrupted"

        def check(self):
            raise KeyboardInterrupt

    before = snapshot(home)
    code, out = run([Interrupted(), Fixed("Never", engine.ok())], fix=False)
    assert code == 130
    assert "Never" not in out
    assert closing(out) == "Stopped."
    assert snapshot(home) == before


def test_ctrl_c_leaves_the_lock_free(home):
    run([StopsHalfWay(home)], fix=True)
    with store.Store().lock():
        pass


# A killed run

def test_a_run_killed_mid_fix_leaves_the_lock_free_and_a_rerun_finishes_it(home, tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    (work / "b").write_text("yours")
    killed = subprocess.run([sys.executable, str(DRIVER), "kill"], env=child_env(DRIVE_DIR=str(work), DRIVE_KILL="1"),
                            capture_output=True, text=True, timeout=30)
    assert killed.returncode == -9
    assert (work / "a").read_text() == "A"
    assert (work / "b").read_text() == "yours"
    assert not store.Store().last_run()["finished"]

    rerun = subprocess.run([sys.executable, str(DRIVER), "kill"], env=child_env(DRIVE_DIR=str(work)),
                           capture_output=True, text=True, timeout=30)
    assert rerun.returncode == 0, rerun.stdout + rerun.stderr
    assert (work / "b").read_text() == "B"
    assert store.Store().last_run()["finished"]
    owned = [r["path"] for r in store.Store().owned()]
    assert len(owned) == len(set(owned))
    assert str(work / "b") not in owned
    backups = list((store.state_dir() / "backups").rglob("b"))
    assert backups and all(p.read_text() == "yours" for p in backups)


# Questions

def test_a_question_with_no_terminal_breaks_the_step_with_a_plain_line(home, monkeypatch):
    def no_terminal():
        raise OSError("Device not configured")

    monkeypatch.setattr(screen, "open_tty", no_terminal)

    class Asking(engine.Step):
        name = "Theme"

        def check(self):
            return engine.ok() if (home / "theme").exists() else engine.needs_fix("not chosen")

        def fix(self, ctx):
            ctx.write(home / "theme", ctx.ask("Which theme", ["Dark", "Light"]))

    code, out = run([Asking()], fix=True)
    assert code == 1
    first = out.splitlines()[0]
    assert first.split()[:2] == ["✗", "Theme"]
    assert first.endswith("needs a terminal to answer: Which theme")
    assert not (home / "theme").exists()


def test_a_question_reads_its_answer_from_the_terminal(home, monkeypatch):
    class Tty(io.StringIO):
        def __init__(self):
            super().__init__("9\n2\n")
            self.shown = ""

        def write(self, text):
            self.shown += text

    tty = Tty()
    monkeypatch.setattr(screen, "open_tty", lambda: tty)

    class Asking(engine.Step):
        name = "Theme"

        def check(self):
            return engine.ok() if (home / "theme").exists() else engine.needs_fix("not chosen")

        def fix(self, ctx):
            ctx.write(home / "theme", ctx.ask("Which theme", ["Dark", "Light"]))

    code, out = run([Asking()], fix=True)
    assert code == 0
    assert (home / "theme").read_text() == "Light"
    assert "Which theme" in tty.shown and "1  Dark" in tty.shown and "2  Light" in tty.shown
    assert "Which theme" not in out


def test_no_answer_breaks_the_step(home, monkeypatch):
    monkeypatch.setattr(screen, "open_tty", lambda: io.StringIO(""))

    class Asking(engine.Step):
        name = "Theme"

        def check(self):
            return engine.needs_fix("not chosen")

        def fix(self, ctx):
            ctx.ask("Which theme", ["Dark", "Light"])

    code, out = run([Asking()], fix=True)
    assert code == 1
    assert out.splitlines()[0].endswith("no answer: Which theme")


# --json

def test_json_gives_the_same_facts_as_the_lines(home):
    (home / "c").write_text("yours")
    code, out = run([FileStep("First file", home / "a", "A"), FileStep("Third file", home / "c", "C"),
                     Fixed("Bad", engine.broken("no disk"))], fix=True, as_json=True)
    assert code == 1
    data = json.loads(out)
    assert data["command"] == "orchi"
    assert data["ok"] is False
    assert [(s["name"], s["status"], s["detail"]) for s in data["steps"]] == [
        ("First file", "fixed", "fixed"), ("Third file", "fixed", "fixed"), ("Bad", "broken", "no disk")]
    assert data["changed"] == ["First file", "Third file"]
    assert data["needs_you"] == ["Bad"]
    assert data["to_fix"] == []
    assert data["backup"] and os.path.isdir(data["backup"])
    assert data["summary"] == f"Changed: First file, Third file. Needs you: Bad.\nBackup: {data['backup']}"


def test_json_for_doctor(home):
    code, out = run([Fixable("Fixable", engine.needs_fix("missing"))], fix=False, as_json=True)
    data = json.loads(out)
    assert code == 1
    assert data["command"] == "doctor"
    assert data["steps"] == [{"name": "Fixable", "status": "needs-fix", "detail": "missing"}]
    assert data["to_fix"] == ["Fixable"]
    assert data["backup"] is None


def test_json_when_another_run_holds_the_lock(home):
    with store.Store().lock():
        code, out = run([Fixed("Fine", engine.ok())], fix=True, as_json=True)
    data = json.loads(out)
    assert code == 1
    assert data["ok"] is False and data["steps"] == []
    assert data["summary"].startswith("Another orchi run is going")


# Review findings

def test_a_file_that_appears_while_orchi_writes_is_backed_up_and_not_claimed(home, monkeypatch):
    real = store.tempfile.mkstemp

    def appearing(*args, **kwargs):
        made = real(*args, **kwargs)
        if str(kwargs.get("dir")) == str(home) and not (home / "a").exists():
            (home / "a").write_text("theirs")
        return made

    monkeypatch.setattr(store.tempfile, "mkstemp", appearing)
    code, out = run([FileStep("First file", home / "a", "A")], fix=True)
    assert code == 0
    assert (home / "a").read_text() == "A"
    assert not store.Store().owns(home / "a")
    backup = closing(out).split("Backup: ")[1]
    assert open(os.path.join(backup, str(home / "a").lstrip("/"))).read() == "theirs"


@pytest.mark.parametrize("already", [False, True])
def test_making_a_link_leaves_a_file_named_like_a_temporary_alone(home, already):
    (home / ".foo.orchi-link").write_text("precious")
    (home / "target").write_text("t")
    if already:
        (home / "foo").write_text("old")

    class Link(engine.Step):
        name = "Link"

        def check(self):
            return engine.ok() if (home / "foo").is_symlink() else engine.needs_fix("missing")

        def fix(self, ctx):
            ctx.link(home / "target", home / "foo")

    code, _ = run([Link()], fix=True)
    assert code == 0
    assert (home / ".foo.orchi-link").read_text() == "precious"
    assert sorted(p.name for p in home.iterdir() if p.name != ".local") == [".foo.orchi-link", "foo", "target"]


def test_a_file_orchi_made_that_someone_replaced_is_no_longer_orchis(home):
    run([FileStep("First file", home / "a", "A")], fix=True)
    (home / "a").unlink()
    (home / "a").write_text("theirs")
    assert not store.Store().owns(home / "a")
    code, out = run([FileStep("First file", home / "a", "A2")], fix=True)
    assert code == 0
    backup = closing(out).split("Backup: ")[1]
    assert open(os.path.join(backup, str(home / "a").lstrip("/"))).read() == "theirs"
    assert not store.Store().owns(home / "a")


def test_a_record_for_something_no_longer_there_owns_nothing(home):
    run([FileStep("First file", home / "a", "A")], fix=True)
    (home / "a").unlink()
    assert not store.Store().owns(home / "a")


def test_a_file_orchi_made_and_changed_again_is_still_orchis(home):
    run([FileStep("First file", home / "a", "A")], fix=True)
    run([FileStep("First file", home / "a", "A2")], fix=True)
    run([FileStep("First file", home / "a", "A3")], fix=True)
    assert store.Store().owns(home / "a")
    assert not (store.state_dir() / "backups").exists()


def test_a_state_folder_that_cannot_be_made_is_one_plain_report(home, tmp_path, monkeypatch):
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    monkeypatch.setenv("ORCHI_STATE", str(locked / "state"))
    try:
        code, out = run([FileStep("First file", home / "a", "A")], fix=True, as_json=True)
    finally:
        locked.chmod(0o700)
    assert code == 1
    data = json.loads(out)
    assert data["ok"] is False and data["steps"] == []
    assert "Permission denied" in data["summary"]
    assert not (home / "a").exists()


def test_ctrl_c_while_a_line_is_shown_still_ends_with_the_record_and_closing_line(home):
    class Interrupting(screen.Screen):
        def result(self, name, status, detail=""):
            if not getattr(self, "interrupted", False):
                self.interrupted = True
                raise KeyboardInterrupt
            super().result(name, status, detail)

    (home / "a").write_text("yours")
    out = io.StringIO()
    code = engine.run([FileStep("First file", home / "a", "A"), FileStep("Later", home / "later", "L")], fix=True,
                      screen=Interrupting(out), store=store.Store())
    assert code == 130
    last = store.Store().last_run()
    assert last["stopped"] and not last["finished"]
    assert [(s["name"], s["status"]) for s in last["steps"]] == [("First file", "fixed")]
    assert closing(out.getvalue()) == f"Stopped. Changed: First file.\nBackup: {last['backup']}"
    assert not (home / "later").exists()


def drive(work, **env):
    return subprocess.run([sys.executable, str(DRIVER), "files"], env=child_env(DRIVE_DIR=str(work), **env),
                          capture_output=True, text=True, timeout=30)


def test_a_run_killed_between_making_a_file_and_recording_it_never_claims_it(home, tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    assert drive(work, DRIVE_KILL_AT="own").returncode == -9
    assert (work / "a").read_text() == "A"
    assert store.Store().owned() == []

    rerun = drive(work)
    assert rerun.returncode == 0, rerun.stdout + rerun.stderr
    assert not store.Store().owns(work / "a")
    assert store.Store().owns(work / "b")


def test_a_run_killed_after_a_backup_keeps_the_original_and_its_copy(home, tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    (work / "a").write_text("yours")
    assert drive(work, DRIVE_KILL_AT="backup").returncode == -9
    assert (work / "a").read_text() == "yours"
    copies = list((store.state_dir() / "backups").rglob("a"))
    assert [p.read_text() for p in copies] == ["yours"]

    rerun = drive(work)
    assert rerun.returncode == 0, rerun.stdout + rerun.stderr
    assert (work / "a").read_text() == "A"
    assert not store.Store().owns(work / "a")
    assert all(p.read_text() == "yours" for p in (store.state_dir() / "backups").rglob("a"))


# Review round 1

def test_output_that_breaks_off_does_not_stop_the_run(home):
    class Closed(io.StringIO):
        def write(self, text):
            raise BrokenPipeError(32, "Broken pipe")

    code = engine.run([FileStep("First file", home / "a", "A"), FileStep("Second file", home / "b", "B")], fix=True,
                      screen=screen.Screen(Closed()), store=store.Store())
    assert code == 0
    assert (home / "b").read_text() == "B"
    assert store.Store().last_run()["finished"]


@pytest.mark.parametrize("given", [None, "fine", engine.Check("sort of", "")])
def test_a_check_that_gives_no_result_is_broken_and_the_rest_still_run(home, given):
    class Odd(engine.Step):
        name = "Odd"

        def check(self):
            return given

    code, out = run([Odd(), FileStep("Second file", home / "b", "B")], fix=True)
    assert code == 1
    assert out.splitlines()[0].split()[:2] == ["✗", "Odd"]
    assert (home / "b").read_text() == "B"


def test_a_run_whose_record_cannot_be_saved_at_the_end_still_reports_what_changed(home, monkeypatch):
    (home / "a").write_text("yours")
    calls = []
    real = store.Store.save_run

    def failing(self, record):
        calls.append(1)
        if len(calls) > 1:
            raise OSError(28, "No space left on device")
        real(self, record)

    monkeypatch.setattr(store.Store, "save_run", failing)
    code, out = run([FileStep("First file", home / "a", "A")], fix=True, as_json=True)
    data = json.loads(out)
    assert code == 0
    assert data["changed"] == ["First file"]
    assert data["backup"] and os.path.isdir(data["backup"])


def test_a_file_orchi_owns_that_a_fix_changes_by_other_means_stays_orchis(home):
    run([FileStep("First file", home / "a", "A")], fix=True)

    class Direct(FileStep):
        def fix(self, ctx):
            self.path.write_text(self.text)

    code, _ = run([Direct("First file", home / "a", "A2"), Direct("Made", home / "made", "M")], fix=True)
    assert code == 0
    assert store.Store().owns(home / "a")
    assert store.Store().owns(home / "made")
    assert not (store.state_dir() / "backups").exists()


def test_writing_where_a_folder_is_fails_without_copying_the_folder(home):
    (home / "a").mkdir()
    (home / "a" / "big").write_text("x" * 1000)

    class Writing(engine.Step):
        name = "First file"

        def check(self):
            return engine.ok() if (home / "a").is_file() else engine.needs_fix("missing")

        def fix(self, ctx):
            ctx.write(home / "a", "A")

    code, out = run([Writing()], fix=True)
    assert code == 1
    assert "is a folder" in out.splitlines()[0]
    assert not (store.state_dir() / "backups").exists()


def test_no_steps_is_ok_in_the_report_and_the_exit_code(home):
    code, out = run([], fix=False, as_json=True)
    assert code == 0
    assert json.loads(out)["ok"] is True


# Review round 2

def test_a_file_orchi_made_stays_orchis_when_only_its_mode_or_attributes_change(home):
    class Script(engine.Step):
        name = "Script"

        def check(self):
            return engine.ok() if (home / "run").exists() else engine.needs_fix("missing")

        def fix(self, ctx):
            ctx.write(home / "run", "#!/bin/sh\n", mode=0o755)
            os.chmod(home / "run", 0o700)

    code, _ = run([Script()], fix=True)
    assert code == 0
    assert (home / "run").stat().st_mode & 0o777 == 0o700
    assert store.Store().owns(home / "run")
    os.chmod(home / "run", 0o755)
    os.link(home / "run", home / "run-too")
    assert store.Store().owns(home / "run")


def test_a_second_ctrl_c_while_the_run_closes_still_ends_with_130(home):
    class Interrupting(screen.Screen):
        def finish(self, report):
            super().finish(report)
            os.kill(os.getpid(), signal.SIGINT)

    class Stopping(engine.Step):
        name = "Stopping"

        def check(self):
            raise KeyboardInterrupt

    out = io.StringIO()
    code = engine.run([Stopping()], fix=True, screen=Interrupting(out), store=store.Store())
    assert code == 130
    assert closing(out.getvalue()) == "Stopped."


def test_ctrl_c_while_a_link_is_put_in_place_leaves_no_temporary_link(home, monkeypatch):
    (home / "target").write_text("t")
    (home / "foo").write_text("old")
    asked = []
    real = store.Store.owns

    def owns(self, path):
        asked.append(path)
        if len(asked) == 2:
            raise KeyboardInterrupt
        return real(self, path)

    class Link(engine.Step):
        name = "Link"

        def check(self):
            return engine.ok() if (home / "foo").is_symlink() else engine.needs_fix("missing")

        def fix(self, ctx):
            ctx.link(home / "target", home / "foo")

    monkeypatch.setattr(store.Store, "owns", owns)
    code, _ = run([Link()], fix=True)
    assert code == 130
    assert sorted(p.name for p in home.iterdir() if p.name != ".local") == ["foo", "target"]


# Review round 3

def test_doctor_calls_a_step_orchi_cannot_fix_broken(home):
    code, out = run([Fixed("Manual", engine.needs_fix("set it by hand"))], fix=False)
    assert code == 1
    assert out.splitlines()[0].split()[:2] == ["✗", "Manual"]
    assert closing(out) == "Needs you: Manual."


def test_what_a_failing_fix_made_at_a_named_path_is_still_orchis(home):
    class Half(FileStep):
        def fix(self, ctx):
            self.path.write_text(self.text)
            raise RuntimeError("then it failed")

    code, _ = run([Half("Half", home / "a", "A")], fix=True)
    assert code == 1
    assert store.Store().owns(home / "a")


def test_a_new_file_where_hard_links_are_refused_is_still_made_and_owned(home, monkeypatch):
    def refused(*args):
        raise PermissionError(1, "Operation not permitted")

    monkeypatch.setattr(store.os, "link", refused)
    code, _ = run([FileStep("First file", home / "a", "A")], fix=True)
    assert code == 0
    assert (home / "a").read_text() == "A"
    assert store.Store().owns(home / "a")


def test_ctrl_c_while_the_run_starts_is_a_plain_stop(home, monkeypatch):
    def stopped(self, record):
        raise KeyboardInterrupt

    monkeypatch.setattr(store.Store, "save_run", stopped)
    code, out = run([Fixed("Fine", engine.ok())], fix=True)
    assert code == 130
    assert out == "Stopped.\n"
