"""Tests for bin/switchboard-lock.

The real herdr is a stub reached through ORCHI_HERDR_REAL, and hc a stub on PATH,
each answering from one file and recording its calls. An app lock goes through the
real bin/herdr and bin/herdr-adapter, so which Herdr gets asked is exercised too.
Every run names a temp lock file, so nothing touches the real switchboard folder.
"""
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
import threading
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "switchboard-lock"

REAL = """#!{python}
import json, sys
with open({calls!r}, "a") as f:
    f.write(json.dumps(["herdr"] + sys.argv[1:]) + "\\n")
cfg = json.load(open({cfg!r}))
pane = sys.argv[3]
if cfg.get("garbled"):
    print("not json", file=sys.stderr)
    sys.exit(1)
if cfg.get("error"):
    print(json.dumps({{"error": {{"code": cfg["error"]}}}}), file=sys.stderr)
    sys.exit(1)
if pane not in cfg.get("panes", []):
    print(json.dumps({{"error": {{"code": "agent_not_found"}}}}), file=sys.stderr)
    sys.exit(1)
print(json.dumps({{"id": "cli:agent:get", "result": {{"agent": {{"agent_status": "idle"}}}}}}))
"""

HC = """#!{python}
import json, sys
with open({calls!r}, "a") as f:
    f.write(json.dumps(["hc"] + sys.argv[1:]) + "\\n")
cfg = json.load(open({cfg!r}))
args = [a for a in sys.argv[1:] if a != "--json"]
if cfg.get("hc_broken"):
    print(json.dumps({{"error": {{"kind": "connection", "message": "no server"}}}}), file=sys.stderr)
    sys.exit(1)
terminals = cfg.get("terminals", {{}})
if args[0] == "get" and args[1] in terminals:
    print(json.dumps({{"address": args[1], "state": "live", "status": terminals[args[1]],
                      "labels": {{}}, "turn": 1}}))
elif args[0] == "ls":
    print(json.dumps({{"terminals": []}}))
else:
    print(json.dumps({{"error": {{"kind": "not_found", "message": "no terminal"}}}}), file=sys.stderr)
    sys.exit(3)
"""


def load():
    loader = importlib.machinery.SourceFileLoader("switchboard_lock", str(SCRIPT))
    spec = importlib.util.spec_from_loader("switchboard_lock", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class Bed:
    def __init__(self, tmp_path):
        self.file = tmp_path / "sb" / "lock"
        self.cfg = tmp_path / "cfg.json"
        self.calls_file = tmp_path / "calls.jsonl"
        self.bin = tmp_path / "bin"
        self.bin.mkdir()
        self.real = self.bin / "real-herdr"
        self.real.write_text(REAL.format(python=sys.executable, cfg=str(self.cfg),
                                         calls=str(self.calls_file)))
        self.real.chmod(0o755)
        hc = self.bin / "hc"
        hc.write_text(HC.format(python=sys.executable, cfg=str(self.cfg), calls=str(self.calls_file)))
        hc.chmod(0o755)
        self.set()

    def set(self, **cfg):
        self.cfg.write_text(json.dumps(cfg))

    def env(self, **extra):
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("HC_", "HERDR_", "ORCHI_", "SWITCHBOARD_"))}
        env.update({"PATH": f"{self.bin}{os.pathsep}/usr/bin:/bin", "ORCHI_HERDR_REAL": str(self.real),
                    "SWITCHBOARD_NOW": "2026-10-30 22:40",
                    "ORCHI_SETTINGS": os.environ["ORCHI_SETTINGS"], "HERDR_APP_HOME": os.environ["HERDR_APP_HOME"]})
        env.update(extra)
        return env

    def run(self, *args, env=None):
        done = subprocess.run([sys.executable, str(SCRIPT), "--file", str(self.file), *args],
                              capture_output=True, text=True, timeout=30,
                              env=self.env(**(env or {})))
        return done.returncode, done.stdout, done.stderr

    def lock(self, terminal="t7", herdr="app", started="2026-10-30 21:00"):
        self.file.parent.mkdir(exist_ok=True)
        self.file.write_text(json.dumps({"terminal": terminal, "herdr": herdr, "started": started}))

    def owner(self):
        return json.loads(self.file.read_text())

    def calls(self):
        if not self.calls_file.exists():
            return []
        return [json.loads(l) for l in self.calls_file.read_text().splitlines()]


CLAUDE = {"app": "claude-code", "state": "working"}


@pytest.fixture
def bed(tmp_path):
    return Bed(tmp_path)


def test_take_writes_the_contract_shape(bed):
    assert bed.run("take", "t7", "app")[0] == 0
    assert bed.owner() == {"terminal": "t7", "herdr": "app", "started": "2026-10-30 22:40"}


def test_take_makes_the_folder(bed):
    assert not bed.file.parent.exists()
    assert bed.run("take", "w1:p2", "terminal")[0] == 0
    assert bed.owner()["terminal"] == "w1:p2"


def test_a_live_owner_stops_take_with_one_line(bed):
    bed.lock()
    bed.set(terminals={"t7": CLAUDE})
    before = bed.file.read_text()
    rc, out, _ = bed.run("take", "t9", "app")
    assert rc == 1
    assert out == "switchboard is running in the Herdr app, terminal t7, since 2026-10-30 21:00\n"
    assert bed.file.read_text() == before


def test_a_live_terminal_owner_is_named_too(bed):
    bed.lock("w1:p2", "terminal")
    bed.set(panes=["w1:p2"])
    rc, out, _ = bed.run("take", "t9", "app")
    assert rc == 1
    assert out == "switchboard is running in terminal Herdr, terminal w1:p2, since 2026-10-30 21:00\n"


def test_a_dead_owner_is_replaced(bed):
    bed.lock()
    assert bed.run("take", "t9", "app")[0] == 0
    assert bed.owner() == {"terminal": "t9", "herdr": "app", "started": "2026-10-30 22:40"}


def test_a_terminal_with_only_a_shell_left_is_dead(bed):
    bed.lock()
    bed.set(terminals={"t7": None})
    assert bed.run("take", "t9", "app")[0] == 0


def test_a_lock_in_a_stopped_terminal_herdr_is_dead(bed):
    bed.lock("w1:p2", "terminal")
    bed.set(error="server_not_running")
    assert bed.run("take", "t9", "app")[0] == 0


def test_the_same_owner_keeps_its_start_and_asks_nobody(bed):
    bed.lock()
    assert bed.run("take", "t7", "app")[0] == 0
    assert bed.owner()["started"] == "2026-10-30 21:00"
    assert bed.calls() == []


def test_the_same_address_in_the_other_herdr_is_another_owner(bed):
    bed.lock("t7", "terminal")
    bed.set(panes=["t7"])
    assert bed.run("take", "t7", "app")[0] == 1


@pytest.mark.parametrize("cfg", [{"hc_broken": True}])
def test_an_app_lock_that_cannot_be_checked_holds(bed, cfg):
    bed.lock()
    bed.set(**cfg)
    rc, out, _ = bed.run("take", "t9", "app")
    assert rc == 1
    assert "could not check (hc_failed)" in out and "switchboard-lock release" in out
    assert len(out.splitlines()) == 1
    assert bed.owner()["terminal"] == "t7"


@pytest.mark.parametrize("cfg,word", [({"error": "server_broken"}, "server_broken"),
                                      ({"garbled": True}, "exit 1")])
def test_a_terminal_lock_that_cannot_be_checked_holds(bed, cfg, word):
    bed.lock("w1:p2", "terminal")
    bed.set(**cfg)
    rc, out, _ = bed.run("take", "t9", "app")
    assert rc == 1 and word in out


def test_a_hung_herdr_holds(bed, monkeypatch):
    mod = load()

    def hang(*a, **kw):
        raise subprocess.TimeoutExpired("herdr", 30)

    monkeypatch.setattr(mod.subprocess, "run", hang)
    bed.lock()
    assert "timed out" in mod.holder(str(bed.file))


@pytest.mark.parametrize("text", ["", "not json", "[]", '{"terminal": "t7"}',
                                  '{"terminal": "--help", "herdr": "app"}',
                                  '{"terminal": "t7", "herdr": "other"}'])
def test_a_lock_that_cannot_be_read_counts_as_none(bed, text):
    bed.file.parent.mkdir()
    bed.file.write_text(text)
    assert bed.run("show")[1] == "free: no lock\n"
    assert bed.run("take", "t9", "app")[0] == 0
    assert bed.owner()["terminal"] == "t9"
    assert bed.calls() == [], "a flag in the file never reaches herdr"


# Which Herdr gets asked.

def test_an_app_lock_is_read_through_the_adapter_even_from_terminal_herdr(bed):
    bed.lock()
    bed.set(terminals={"t7": CLAUDE})
    assert bed.run("show", env={"HERDR_PANE_ID": "w1:p2"})[0] == 0
    assert bed.calls()[0][:2] == ["hc", "get"]
    assert not any(c[0] == "herdr" for c in bed.calls())


def test_a_terminal_lock_reaches_the_real_herdr_even_from_the_app(bed):
    bed.lock("w1:p2", "terminal")
    bed.set(panes=["w1:p2"])
    assert bed.run("show", env={"HC_TERMINAL_ID": "t9"})[0] == 0
    assert bed.calls() == [["herdr", "agent", "get", "w1:p2"]]


# release and show.

def test_release_removes_the_lock(bed):
    bed.lock()
    assert bed.run("release")[0] == 0
    assert not bed.file.exists()
    assert bed.calls() == [], "release asks nobody"


def test_release_with_no_lock_is_fine(bed):
    bed.file.parent.mkdir()
    assert bed.run("release")[0] == 0


def test_show_with_no_lock(bed):
    assert bed.run("show") == (0, "free: no lock\n", "")


def test_show_a_live_owner(bed):
    bed.lock()
    bed.set(terminals={"t7": CLAUDE})
    assert bed.run("show")[:2] == (
        0, "switchboard is running in the Herdr app, terminal t7, since 2026-10-30 21:00\n")


def test_show_a_dead_owner(bed):
    bed.lock("w1:p2", "terminal")
    assert bed.run("show")[:2] == (0, "free: terminal w1:p2 in terminal Herdr has gone\n")


def test_show_writes_nothing(bed):
    bed.lock()
    before = bed.file.read_text()
    bed.run("show")
    assert bed.file.read_text() == before


# Odds and ends.

def test_two_takes_at_once_leave_one_owner(bed):
    results = {}

    def take(terminal):
        results[terminal] = bed.run("take", terminal, "app")[0]

    bed.set(terminals={"t1": CLAUDE, "t2": CLAUDE})
    threads = [threading.Thread(target=take, args=(t,)) for t in ("t1", "t2")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(results.values()) == [0, 1]
    assert results[bed.owner()["terminal"]] == 0


def test_the_default_file_is_in_the_switchboard_folder(tmp_path):
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"claude_dir": str(tmp_path / "profile")}))
    env = {k: v for k, v in os.environ.items() if k != "SWITCHBOARD_LOCK"}
    env["ORCHI_SETTINGS"] = str(settings)
    code = ("import importlib.machinery as m, importlib.util as u;"
            f"l = m.SourceFileLoader('l', {str(SCRIPT)!r});"
            "s = u.spec_from_loader('l', l); x = u.module_from_spec(s); l.exec_module(x);"
            "print(x.default_file())")
    done = subprocess.run(["/usr/bin/python3", "-c", code], capture_output=True, text=True, env=env)
    assert done.stdout.strip() == str(tmp_path / "profile" / "switchboard" / "lock")


def test_the_lock_file_can_be_set_for_tests(bed):
    assert subprocess.run([sys.executable, str(SCRIPT), "take", "t7", "app"], text=True,
                          capture_output=True, env=bed.env(SWITCHBOARD_LOCK=str(bed.file))).returncode == 0
    assert bed.owner()["terminal"] == "t7"


@pytest.mark.parametrize("args", [[], ["take"], ["take", "t7"], ["take", "t7", "other"],
                                  ["take", "--help", "app"], ["take", "", "app"],
                                  ["take", "t7", "app", "x"], ["release", "x"], ["show", "x"],
                                  ["steal"]])
def test_bad_arguments(bed, args):
    assert bed.run(*args)[0] == 2
    assert not bed.file.exists()


def test_help_runs_on_this_python():
    done = subprocess.run(["/usr/bin/python3", str(SCRIPT), "show", "extra"], capture_output=True,
                          text=True)
    assert done.returncode == 2 and "Usage" in done.stderr


def test_script_is_executable():
    assert os.access(SCRIPT, os.X_OK)
