"""The state folder: the lock, the record of runs, ownership records and backups."""
import json
import os
import stat
import subprocess
import sys

import pytest

from engine_help import DRIVER, child_env, home, snapshot  # noqa: F401
from orchi import store


# The folder

def test_the_state_folder_is_under_home_by_default(tmp_path, monkeypatch):
    monkeypatch.delenv("ORCHI_STATE")
    monkeypatch.setenv("HOME", str(tmp_path))
    assert store.state_dir() == tmp_path / ".local" / "state" / "orchi"


def test_orchi_state_moves_it(tmp_path, monkeypatch):
    monkeypatch.setenv("ORCHI_STATE", str(tmp_path / "elsewhere"))
    assert store.state_dir() == tmp_path / "elsewhere"
    assert store.Store().root == tmp_path / "elsewhere"


def test_making_a_store_writes_nothing(home):
    store.Store()
    assert not store.state_dir().exists()


# The lock

def test_a_second_run_cannot_take_the_lock_while_the_first_holds_it(home):
    with store.Store().lock():
        with pytest.raises(store.Busy) as busy:
            with store.Store().lock():
                pass
    assert busy.value.pid == os.getpid()


def test_the_lock_is_free_again_once_a_run_ends(home):
    with store.Store().lock():
        pass
    with store.Store().lock():
        pass


def test_the_lock_is_let_go_when_the_run_fails(home):
    with pytest.raises(RuntimeError):
        with store.Store().lock():
            raise RuntimeError("boom")
    with store.Store().lock():
        pass


def test_a_lock_left_by_a_killed_run_is_taken_over(home, tmp_path):
    holder = subprocess.Popen([sys.executable, str(DRIVER), "hold"], env=child_env(DRIVE_DIR=str(tmp_path)),
                              stdout=subprocess.PIPE, text=True)
    try:
        assert holder.stdout.readline().strip() == "held"
        with pytest.raises(store.Busy) as busy:
            with store.Store().lock():
                pass
        assert busy.value.pid == holder.pid
    finally:
        holder.kill()
        holder.wait()
        holder.stdout.close()
    assert (store.state_dir() / "lock").exists()
    with store.Store().lock():
        pass


def test_a_lock_file_with_rubbish_in_it_is_taken(home):
    store.state_dir().mkdir(parents=True)
    (store.state_dir() / "lock").write_text("not a pid\n")
    with store.Store().lock():
        pass


def test_a_busy_lock_with_no_pid_says_so_plainly(home):
    store.state_dir().mkdir(parents=True)
    with store.Store().lock():
        (store.state_dir() / "lock").write_text("")
        with pytest.raises(store.Busy) as busy:
            with store.Store().lock():
                pass
    assert busy.value.pid is None
    assert str(busy.value) == "Another orchi run is going."


def test_a_busy_lock_names_the_run_holding_it(home):
    with store.Store().lock():
        with pytest.raises(store.Busy) as busy:
            with store.Store().peek():
                pass
    assert str(busy.value) == f"Another orchi run is going (pid {os.getpid()})."


def test_peeking_creates_nothing(home):
    with store.Store().peek():
        pass
    assert not store.state_dir().exists()


def test_peeking_at_an_existing_lock_changes_nothing(home):
    with store.Store().lock():
        pass
    before = snapshot(home)
    with store.Store().peek():
        pass
    assert snapshot(home) == before


def test_two_peeks_share(home):
    with store.Store().lock():
        pass
    with store.Store().peek():
        with store.Store().peek():
            pass


def test_a_run_cannot_start_while_a_peek_holds_the_lock(home):
    with store.Store().lock():
        pass
    with store.Store().peek():
        with pytest.raises(store.Busy):
            with store.Store().lock():
                pass


# The record of runs

def test_no_run_yet_reads_as_none(home):
    assert store.Store().last_run() is None


def test_a_run_is_saved_and_read_back(home):
    store.Store().save_run({"command": "orchi", "finished": True})
    assert store.Store().last_run() == {"command": "orchi", "finished": True}


def test_a_state_file_that_is_rubbish_reads_as_none(home):
    store.state_dir().mkdir(parents=True)
    (store.state_dir() / "state.json").write_text("{half")
    assert store.Store().last_run() is None


def test_the_state_file_is_replaced_whole(home, monkeypatch):
    store.Store().save_run({"run": 1})

    def stop(*args):
        raise KeyboardInterrupt

    with monkeypatch.context() as patch:
        patch.setattr(os, "replace", stop)
        with pytest.raises(KeyboardInterrupt):
            store.Store().save_run({"run": 2})
    assert store.Store().last_run() == {"run": 1}
    assert [p.name for p in store.state_dir().iterdir()] == ["state.json"]


# Ownership records

def test_nothing_is_owned_at_first(home):
    assert store.Store().owned() == []


def test_a_recorded_path_is_owned_with_its_kind_and_step(home):
    path = home / "made.txt"
    path.write_text("made")
    store.Store().own(path, "file", "First file")
    records = store.Store().owned()
    assert [(r["path"], r["kind"], r["step"]) for r in records] == [(str(path), "file", "First file")]
    assert store.Store().owns(path)
    assert not store.Store().owns(home / "other.txt")


def test_a_path_is_recorded_once(home):
    s = store.Store()
    s.own(home / "made.txt", "file", "First file")
    s.own(home / "made.txt", "file", "First file")
    assert len(store.Store().owned()) == 1


def test_a_path_is_recorded_by_its_full_path(home, monkeypatch):
    monkeypatch.chdir(home)
    (home / "made.txt").write_text("made")
    store.Store().own("made.txt", "file", "First file")
    assert store.Store().owns(home / "made.txt")


def test_disowning_removes_the_record(home):
    s = store.Store()
    s.own(home / "a", "file", "A")
    s.own(home / "b", "link", "B")
    s.disown(home / "a")
    assert [r["path"] for r in store.Store().owned()] == [str(home / "b")]


def test_an_unreadable_ownership_file_is_never_written_over(home):
    store.state_dir().mkdir(parents=True)
    (store.state_dir() / "owned.json").write_text("{half")
    with pytest.raises(store.StoreError):
        store.Store().owned()
    with pytest.raises(store.StoreError):
        store.Store().own(home / "made.txt", "file", "First file")
    assert (store.state_dir() / "owned.json").read_text() == "{half"


def test_ownership_records_are_json_a_later_uninstall_can_read(home):
    store.Store().own(home / "made.txt", "file", "First file")
    data = json.loads((store.state_dir() / "owned.json").read_text())
    assert data["owned"][0]["path"] == str(home / "made.txt")


# Backups

def test_a_backup_copies_a_file_under_its_full_path(home):
    original = home / "notes" / "a.txt"
    original.parent.mkdir()
    original.write_text("mine")
    s = store.Store()
    copy = s.backup(original)
    assert copy == s.backup_dir / str(original).lstrip("/")
    assert copy.read_text() == "mine"
    assert s.backup_dir.parent == store.state_dir() / "backups"


def test_a_backup_is_taken_once_per_run(home):
    original = home / "a.txt"
    original.write_text("mine")
    s = store.Store()
    s.backup(original)
    original.write_text("changed")
    copy = s.backup(original)
    assert copy.read_text() == "mine"


def test_a_backup_keeps_a_link_as_a_link(home):
    (home / "target").write_text("t")
    (home / "link").symlink_to(home / "target")
    copy = store.Store().backup(home / "link")
    assert copy.is_symlink()
    assert os.readlink(copy) == str(home / "target")


def test_a_backup_copies_a_folder(home):
    (home / "dir" / "inner").mkdir(parents=True)
    (home / "dir" / "inner" / "f").write_text("f")
    copy = store.Store().backup(home / "dir")
    assert (copy / "inner" / "f").read_text() == "f"


def test_nothing_there_is_nothing_to_back_up(home):
    s = store.Store()
    assert s.backup(home / "missing") is None
    assert s.backup_dir is None
    assert not store.state_dir().exists()


def test_two_runs_back_up_into_different_folders(home):
    original = home / "a.txt"
    original.write_text("one")
    first = store.Store().backup(original)
    original.write_text("two")
    second = store.Store().backup(original)
    assert first != second
    assert first.read_text() == "one"
    assert second.read_text() == "two"


# Writing files

def test_a_file_is_replaced_whole(home, monkeypatch):
    target = home / "a.txt"
    target.write_text("old")

    def stop(*args):
        raise KeyboardInterrupt

    with monkeypatch.context() as patch:
        patch.setattr(os, "replace", stop)
        with pytest.raises(KeyboardInterrupt):
            store.replace_file(target, "new")
    assert target.read_text() == "old"
    assert [p.name for p in home.iterdir()] == ["a.txt"]


# Review findings

@pytest.mark.parametrize("how", ["lock", "peek"])
def test_a_lock_that_is_a_link_is_never_followed(home, how):
    store.state_dir().mkdir(parents=True)
    precious = home / "precious.txt"
    precious.write_text("keep me")
    (store.state_dir() / "lock").symlink_to(precious)
    with pytest.raises(store.StoreError):
        with getattr(store.Store(), how)():
            pass
    assert precious.read_text() == "keep me"


# Review round 1

def test_a_run_blocked_by_doctor_names_no_pid(home):
    with store.Store().lock():
        pass
    with store.Store().peek():
        with pytest.raises(store.Busy) as busy:
            with store.Store().lock():
                pass
    assert busy.value.pid is None


def test_a_backup_never_follows_a_link_it_already_copied(home):
    real = home / "real"
    real.mkdir()
    (real / "x").write_text("x")
    (home / "cfg").symlink_to(real)
    s = store.Store()
    s.backup(home / "cfg")
    with pytest.raises(store.StoreError):
        s.backup(home / "cfg" / "x")
    assert sorted(p.name for p in real.iterdir()) == ["x"]
    assert (real / "x").read_text() == "x"


# Review round 2

def test_a_file_inside_a_folder_already_backed_up_keeps_its_first_copy(home):
    (home / "conf").mkdir()
    (home / "conf" / "f").write_text("original")
    s = store.Store()
    s.backup(home / "conf")
    (home / "conf" / "f").write_text("changed")
    copy = s.backup(home / "conf" / "f")
    assert copy.read_text() == "original"


# Review round 3

def test_a_folder_backed_up_after_a_file_inside_it_keeps_the_file_s_first_copy(home):
    (home / "conf").mkdir()
    (home / "conf" / "f").write_text("original")
    (home / "conf" / "g").write_text("g")
    s = store.Store()
    s.backup(home / "conf" / "f")
    (home / "conf" / "f").write_text("changed")
    copy = s.backup(home / "conf")
    assert (copy / "f").read_text() == "original"
    assert (copy / "g").read_text() == "g"


def test_something_else_where_an_owned_folder_was_is_not_owned(home):
    (home / "x").mkdir()
    s = store.Store()
    s.own(home / "x", "folder", "Step")
    records = json.loads((store.state_dir() / "owned.json").read_text())
    (home / "x").rmdir()
    (home / "x").write_text("theirs")
    records["owned"][0]["id"][1] = os.lstat(home / "x").st_ino
    (store.state_dir() / "owned.json").write_text(json.dumps(records))
    assert not store.Store().owns(home / "x")


def test_a_held_back_ctrl_c_is_not_lost_when_sigint_was_left_at_its_default(home):
    import signal
    old = signal.signal(signal.SIGINT, signal.SIG_DFL)
    try:
        done = subprocess.run([sys.executable, "-c", (
            "import os, signal\n"
            "from orchi import store\n"
            "signal.signal(signal.SIGINT, signal.SIG_DFL)\n"
            "with store.shielded():\n"
            "    os.kill(os.getpid(), signal.SIGINT)\n"
            "print('carried on')\n")], env=child_env(), capture_output=True, text=True, timeout=30)
    finally:
        signal.signal(signal.SIGINT, old)
    assert "carried on" not in done.stdout
    assert done.returncode == -signal.SIGINT


def test_a_backup_is_private_whatever_the_original_was(home):
    original = home / "cfg" / "deep" / "file.json"
    original.parent.mkdir(parents=True)
    original.write_text("{}")
    original.chmod(0o644)
    (home / "cfg").chmod(0o755)
    copy = store.Store().backup(original)
    assert stat.S_IMODE(copy.stat().st_mode) == 0o600
    here, base = copy.parent, store.state_dir() / "backups"
    while here != base.parent:
        assert stat.S_IMODE(here.stat().st_mode) == 0o700, here
        here = here.parent if here != base else base.parent


def test_a_backed_up_folder_is_private_all_through(home):
    folder = home / "dir"
    (folder / "sub").mkdir(parents=True)
    (folder / "sub" / "a").write_text("x")
    (folder / "b").write_text("y")
    (folder / "b").chmod(0o666)
    copy = store.Store().backup(folder)
    modes = {p.name: stat.S_IMODE(p.stat().st_mode) for p in [copy, copy / "sub", copy / "sub" / "a", copy / "b"]}
    assert modes == {"dir": 0o700, "sub": 0o700, "a": 0o600, "b": 0o600}
