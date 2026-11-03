"""Tests for bin/switchboard-state.

The script is the switchboard's only way to change its state file. Each test
points it at a temp file with --file and fixes the clock with
SWITCHBOARD_NOW, so the times written are known.
"""
import importlib.machinery
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "switchboard-state"
HEALTH = HERE.parent / "switchboard-health"


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


@pytest.fixture
def st(tmp_path):
    state = tmp_path / "sb" / "state.md"

    class Env:
        file = state

        def run(self, *args, now="2026-10-10 23:49"):
            env = dict(os.environ, SWITCHBOARD_NOW=now)
            done = subprocess.run([sys.executable, str(SCRIPT), "--file", str(state)] + list(args),
                                  capture_output=True, text=True, env=env)
            return done.returncode, done.stdout, done.stderr

        def text(self):
            return state.read_text()

    return Env()


def test_run_adds_watching_started_and_check_in_lines(st):
    rc, _, err = st.run("add", "--run", "cedar", "/Users/me/Projects/cedar", "wAR:p5")
    assert rc == 0, err
    assert st.text() == (
        "# switchboard state\nupdated: 2026-10-10 23:49\n"
        "## watching\ncedar /Users/me/Projects/cedar wAR:p5\n"
        "## started\ncedar 2026-10-10 23:49\n"
        "## check-ins\ncedar 2026-10-10 23:49\n")


def test_watch_without_run_writes_no_started_line(st):
    st.run("add", "atlas", "/r/atlas", "w1:p2")
    assert "## started\n## check-ins" in st.text()


def test_adding_again_keeps_the_first_start_and_updates_the_pane(st):
    st.run("add", "--run", "atlas", "/r/atlas", "w1:p2")
    st.run("add", "atlas", "/r/atlas", "w9:p1", now="2026-10-11 02:00")
    text = st.text()
    assert "atlas /r/atlas w9:p1\n" in text
    assert "atlas /r/atlas w1:p2" not in text
    assert "## started\natlas 2026-10-10 23:49\n" in text
    assert "updated: 2026-10-11 02:00" in text


def test_a_second_run_moves_the_start(st):
    st.run("add", "--run", "atlas", "/r/atlas", "w1:p2")
    st.run("add", "--run", "atlas", "/r/atlas", "w1:p2", now="2026-10-12 09:00")
    assert "## started\natlas 2026-10-12 09:00\n" in st.text()


def test_remove_takes_out_every_line_for_the_project(st):
    st.run("add", "--run", "atlas", "/r/atlas", "w1:p2")
    st.run("add", "--run", "birch", "/r/birch", "w2:p2")
    rc, _, _ = st.run("remove", "atlas")
    assert rc == 0
    assert "atlas" not in st.text()
    assert "birch /r/birch w2:p2" in st.text()


def test_remove_of_the_last_project_leaves_an_empty_file(st):
    st.run("add", "--run", "atlas", "/r/atlas", "w1:p2")
    st.run("remove", "atlas", now="2026-10-11 00:43")
    assert st.text() == ("# switchboard state\nupdated: 2026-10-11 00:43\n"
                         "## watching\n## started\n## check-ins\n")


def test_checkin_updates_each_named_project(st):
    st.run("add", "--run", "atlas", "/r/atlas", "w1:p2")
    st.run("add", "--run", "birch", "/r/birch", "w2:p2")
    st.run("checkin", "atlas", "birch", now="2026-10-11 01:30")
    text = st.text()
    assert "## check-ins\natlas 2026-10-11 01:30\nbirch 2026-10-11 01:30\n" in text
    assert "## started\natlas 2026-10-10 23:49\n" in text


def test_pane_changes_only_the_pane(st):
    st.run("add", "--run", "atlas", "/r/atlas", "w1:p2")
    st.run("pane", "atlas", "w5:p1")
    assert "atlas /r/atlas w5:p1\n" in st.text()
    assert "atlas 2026-10-10 23:49\n## check-ins" in st.text()


def test_unknown_project_is_refused_and_nothing_written(st):
    st.run("add", "--run", "atlas", "/r/atlas", "w1:p2")
    before = st.text()
    for args in (("remove", "nope"), ("checkin", "nope"), ("pane", "nope", "w1:p1")):
        rc, _, err = st.run(*args, now="2026-10-11 05:00")
        assert rc == 1 and "nope" in err
    assert st.text() == before


def test_cycle_marks_the_last_line_and_uncycle_clears_it(st):
    st.run("add", "--run", "atlas", "/r/atlas", "w1:p2")
    st.run("cycle", now="2026-10-11 03:00")
    assert st.text().endswith("CYCLE 2026-10-11 03:00\n")
    st.run("add", "birch", "/r/birch", "w2:p2", now="2026-10-11 03:05")
    assert st.text().endswith("CYCLE 2026-10-11 03:00\n")
    st.run("uncycle", now="2026-10-11 03:10")
    assert "CYCLE" not in st.text()


def test_repo_path_with_a_space_round_trips(st):
    st.run("add", "--run", "atlas", "/r/my atlas", "w1:p2")
    st.run("checkin", "atlas")
    assert "atlas /r/my atlas w1:p2\n" in st.text()


def test_show_prints_the_file(st):
    st.run("add", "--run", "atlas", "/r/atlas", "w1:p2")
    rc, out, _ = st.run("show")
    assert rc == 0 and out == st.text()


def test_bad_arguments_exit_2(st):
    for args in ((), ("add", "atlas"), ("frob",), ("pane", "atlas")):
        rc, _, _ = st.run(*args)
        assert rc == 2, args
    assert not st.file.exists()


def test_project_names_with_spaces_are_refused(st):
    rc, _, _ = st.run("add", "--run", "two words", "/r/birch", "w1:p2")
    assert rc == 2


def test_write_replaces_the_file_whole(st, monkeypatch):
    mod = load("switchboard_state", SCRIPT)
    calls = []
    real = os.replace
    monkeypatch.setattr(os, "replace", lambda a, b: (calls.append((a, b)), real(a, b)))
    monkeypatch.setenv("SWITCHBOARD_NOW", "2026-10-10 23:49")
    assert mod.main(["--file", str(st.file), "add", "--run", "atlas", "/r/atlas", "w1:p2"]) == 0
    assert calls and calls[0][1] == str(st.file)


def test_health_reads_what_the_script_writes(st):
    st.run("add", "--run", "atlas", "/r/my atlas", "w1:p2")
    st.run("cycle", now="2026-10-11 03:00")
    health = load("switchboard_health", HEALTH)
    got = health.read_state(str(st.file))
    assert got == {"watching": [("atlas", "/r/my atlas", "w1:p2")], "paused": set(),
                   "cycle": "CYCLE 2026-10-11 03:00"}


def test_wait_reads_the_started_line_the_script_writes(st):
    wait = load("switchboard_wait", HERE.parent / "switchboard-wait")
    st.run("add", "--run", "atlas", "/r/atlas", "w1:p2")
    assert wait.started_at("/r/atlas", str(st.file)) == "2026-10-10 23:49"


def test_default_file_is_in_the_switchboard_folder(tmp_path, monkeypatch):
    monkeypatch.delenv("SWITCHBOARD_STATE", raising=False)
    settings = tmp_path / "settings.json"
    settings.write_text('{"claude_dir": "%s"}' % (tmp_path / "profile"))
    monkeypatch.setenv("ORCHI_SETTINGS", str(settings))
    mod = load("switchboard_state", SCRIPT)
    assert mod.default_file() == str(tmp_path / "profile" / "switchboard" / "state.md")


def test_script_is_executable():
    assert os.access(SCRIPT, os.X_OK)


# Paused projects.

def test_paused_writes_a_section_after_the_check_ins(st):
    st.run("add", "--run", "atlas", "/r/atlas", "w1:p2")
    rc, _, err = st.run("paused", "atlas", now="2026-10-11 08:00")
    assert rc == 0, err
    assert st.text() == (
        "# switchboard state\nupdated: 2026-10-11 08:00\n"
        "## watching\natlas /r/atlas w1:p2\n"
        "## started\natlas 2026-10-10 23:49\n"
        "## check-ins\natlas 2026-10-10 23:49\n"
        "## paused\natlas 2026-10-11 08:00\n")


def test_nothing_paused_leaves_the_file_as_it_always_was(st):
    st.run("add", "--run", "atlas", "/r/atlas", "w1:p2")
    before = st.text()
    st.run("paused", "atlas")
    st.run("unpaused", "atlas")
    assert st.text() == before


def test_unpaused_leaves_the_others_paused(st):
    st.run("add", "atlas", "/r/atlas", "w1:p2")
    st.run("add", "birch", "/r/birch", "w2:p2")
    st.run("paused", "atlas")
    st.run("paused", "birch")
    st.run("unpaused", "atlas")
    assert st.text().endswith("## paused\nbirch 2026-10-10 23:49\n")


def test_unpaused_on_a_project_that_is_not_paused_is_fine(st):
    st.run("add", "atlas", "/r/atlas", "w1:p2")
    before = st.text()
    assert st.run("unpaused", "atlas")[0] == 0
    assert st.text() == before


def test_paused_twice_keeps_one_line(st):
    st.run("add", "atlas", "/r/atlas", "w1:p2")
    st.run("paused", "atlas")
    st.run("paused", "atlas", now="2026-10-11 08:00")
    assert st.text().count("atlas 2026-10-11 08:00") == 1
    assert st.text().endswith("## paused\natlas 2026-10-11 08:00\n")


@pytest.mark.parametrize("cmd", ["paused", "unpaused"])
def test_pausing_a_project_not_watched_writes_nothing(st, cmd):
    st.run("add", "atlas", "/r/atlas", "w1:p2")
    before = st.text()
    rc, _, err = st.run(cmd, "nope")
    assert rc == 1 and "nope" in err
    assert st.text() == before


@pytest.mark.parametrize("args", [["paused"], ["unpaused"], ["paused", "a", "b"], ["paused", "a b"]])
def test_pause_bad_arguments(st, args):
    assert st.run(*args)[0] == 2


def test_cycle_stays_the_last_line_while_something_is_paused(st):
    st.run("add", "atlas", "/r/atlas", "w1:p2")
    st.run("paused", "atlas")
    st.run("cycle", now="2026-10-11 08:00")
    assert st.text().endswith("## paused\natlas 2026-10-10 23:49\nCYCLE 2026-10-11 08:00\n")
    st.run("uncycle")
    assert st.text().endswith("## paused\natlas 2026-10-10 23:49\n")


def test_remove_takes_the_paused_line_too(st):
    st.run("add", "atlas", "/r/atlas", "w1:p2")
    st.run("paused", "atlas")
    st.run("remove", "atlas")
    assert "paused" not in st.text()


def test_a_new_run_ends_a_pause(st):
    st.run("add", "atlas", "/r/atlas", "w1:p2")
    st.run("paused", "atlas")
    st.run("add", "atlas", "/r/atlas", "w1:p2")
    assert "## paused" in st.text(), "watching again changes nothing"
    st.run("add", "--run", "atlas", "/r/atlas", "w1:p2")
    assert "## paused" not in st.text()


def test_every_reader_gets_the_paused_file_right(st, tmp_path):
    st.run("add", "--run", "atlas", "/r/atlas", "w1:p2")
    st.run("paused", "atlas")
    st.run("cycle")
    health = load("switchboard_health_paused", HEALTH).read_state(str(st.file))
    assert health["watching"] == [("atlas", "/r/atlas", "w1:p2")]
    assert health["paused"] == {"atlas"}
    assert health["cycle"] == "CYCLE 2026-10-10 23:49"
    wait = load("switchboard_wait_paused", HERE.parent / "switchboard-wait")
    assert wait.started_at("/r/atlas", str(st.file)) == "2026-10-10 23:49"
    assert wait.paused_repos(str(st.file)) == {"/r/atlas"}
