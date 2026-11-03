"""Tests for bin/herdr, the wrapper every call to herdr goes through.

The app is the only Herdr, so the wrapper has one job: hand the call to bin/herdr-adapter, whole and
unchanged, and never to the real herdr, which is the wrong Herdr in an app terminal. A stub adapter beside the
copied wrapper records what it was given, so these prove bytes, exit codes and the process itself. A stub real
herdr, reached through ORCHI_HERDR_REAL, proves it is never run.
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "herdr"

# Set by the shell or macOS, not by the wrapper.
SHELL_VARS = {"_", "PWD", "OLDPWD", "SHLVL", "__CF_USER_TEXT_ENCODING"}

STUB = """#!/usr/bin/env python3
import json, os, sys
record = {{"argv": [os.fsencode(a).hex() for a in sys.argv[1:]],
           "pid": os.getpid(),
           "env": dict(os.environ),
           "stdin": sys.stdin.buffer.read().hex()}}
with open({record!r}, "w") as f:
    json.dump(record, f)
sys.stdout.buffer.write(b"out\\n\\x00\\xff")
sys.stderr.buffer.write(b"err\\n\\xfe")
sys.exit({code})
"""


class Bed:
    def __init__(self, tmp_path):
        self.tmp = tmp_path
        self.record = tmp_path / "record.json"
        self.real_record = tmp_path / "real-record.json"
        self.real = tmp_path / "real-herdr"
        self.real.write_text(STUB.format(record=str(self.real_record), code=0))
        self.real.chmod(0o755)
        # The wrapper's own folder is the stand-in for bin/, so a stub adapter
        # sits beside it and the real bin/herdr-adapter is never run.
        self.bin = tmp_path / "bin"
        self.bin.mkdir()
        self.wrapper = self.bin / "herdr"
        shutil.copy(SCRIPT, self.wrapper)
        self.stub(0)

    def stub(self, code):
        adapter = self.bin / "herdr-adapter"
        adapter.write_text(STUB.format(record=str(self.record), code=code))
        adapter.chmod(0o755)

    def env(self, **extra):
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("HC_", "HERDR_", "ORCHI_"))}
        env["ORCHI_HERDR_REAL"] = str(self.real)
        env.update(ORCHI_SETTINGS=os.environ["ORCHI_SETTINGS"], HERDR_APP_HOME=os.environ["HERDR_APP_HOME"])
        env.update(extra)
        return env

    def popen(self, *args, **env):
        return subprocess.Popen([str(self.wrapper), *args], env=self.env(**env),
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE)

    def run(self, *args, stdin=b"", **env):
        p = self.popen(*args, **env)
        out, err = p.communicate(stdin, timeout=30)
        return p, out, err

    def seen(self):
        return json.loads(self.record.read_text())


@pytest.fixture
def bed(tmp_path):
    return Bed(tmp_path)


@pytest.mark.parametrize("args", [
    ["agent", "list"],
    ["agent", "prompt", "w9J:p4", "SWITCHBOARD ANSWER birch-1: a"],
    [""],
    ["a", "", "b"],
    ["two  spaces", " edges "],
    ["it's", 'a "quote"', "back\\slash"],
    ["line one\nline two\n"],
    ["--", "--timeout", "-x", "-"],
    ["$(touch pwned)", "`id`", "$HOME", "*", "?", "~", "a;b", "a|b", "a&b"],
    ["caf\u00e9", "\u2192", "\U0001f600"],
    ["x" * 100_000],
])
def test_arguments_reach_herdr_byte_for_byte(bed, args):
    p, _, _ = bed.run(*args)
    assert p.returncode == 0
    assert bed.seen()["argv"] == [os.fsencode(a).hex() for a in args]
    assert not (bed.tmp / "pwned").exists()


def test_no_arguments_stays_no_arguments(bed):
    bed.run()
    assert bed.seen()["argv"] == []


def test_stdin_reaches_herdr(bed):
    bed.run("agent", "list", stdin=b"piped\n\x00\xff")
    assert bed.seen()["stdin"] == b"piped\n\x00\xff".hex()


def test_stdout_and_stderr_come_back_untouched(bed):
    _, out, err = bed.run("agent", "list")
    assert out == b"out\n\x00\xff"
    assert err == b"err\n\xfe"


@pytest.mark.parametrize("code", [0, 1, 3, 127])
def test_exit_code_comes_back(bed, code):
    bed.stub(code)
    p, _, _ = bed.run("agent", "get", "x")
    assert p.returncode == code


def test_the_adapter_replaces_the_wrapper_process(bed):
    # Same pid, so a timeout or signal from a caller lands on herdr itself.
    p, _, _ = bed.run("agent", "list")
    assert bed.seen()["pid"] == p.pid


def test_environment_is_unchanged(bed):
    extra = {"HERDR_ENV": "1", "HERDR_PANE_ID": "w9J:p4", "CLAUDE_CONFIG_DIR": "/x y",
             "ODD": "a\nb"}
    bed.run("agent", "list", **extra)
    seen = bed.seen()["env"]
    want = bed.env(**extra)
    assert {k: v for k, v in seen.items() if k not in SHELL_VARS} == \
           {k: v for k, v in want.items() if k not in SHELL_VARS}


def test_the_wrapper_has_no_path_to_the_real_herdr():
    text = SCRIPT.read_text()
    assert "ORCHI_HERDR" not in text
    assert "HERDR_PANE_ID" not in text
    assert "/opt/homebrew" not in text


@pytest.mark.parametrize("setting,env", [
    ("an app terminal", {"HC_TERMINAL_ID": "t4"}),
    ("an app terminal with HERDR_ENV", {"HC_TERMINAL_ID": "t4", "HERDR_ENV": "1"}),
    ("no terminal at all, as the launchd watcher has", {}),
    ("HERDR_ENV alone", {"HERDR_ENV": "1"}),
    ("an empty HC_TERMINAL_ID", {"HC_TERMINAL_ID": ""}),
    ("the old ORCHI_HERDR=terminal", {"ORCHI_HERDR": "terminal"}),
    ("the old ORCHI_HERDR=terminal in an app terminal", {"ORCHI_HERDR": "terminal", "HC_TERMINAL_ID": "t4"}),
    ("the old ORCHI_HERDR=app", {"ORCHI_HERDR": "app"}),
    ("a terminal Herdr pane", {"HERDR_ENV": "1", "HERDR_PANE_ID": "w9J:p4"}),
    ("a pane that also has HC_TERMINAL_ID", {"HERDR_ENV": "1", "HERDR_PANE_ID": "w9J:p4", "HC_TERMINAL_ID": "t4"}),
    ("an unknown ORCHI_HERDR", {"ORCHI_HERDR": "ap", "HERDR_PANE_ID": "w9J:p4"}),
])
def test_every_call_goes_to_the_adapter_and_never_the_real_herdr(bed, setting, env):
    p, out, _ = bed.run("agent", "list", **env)
    assert p.returncode == 0, setting
    assert bed.seen()["argv"] == [b"agent".hex(), b"list".hex()], setting
    assert out == b"out\n\x00\xff", setting
    assert not bed.real_record.exists(), setting


def test_adapter_is_found_through_a_symlink(bed):
    other = bed.tmp / "elsewhere"
    other.mkdir()
    (other / "herdr").symlink_to(bed.wrapper)
    p = subprocess.run([str(other / "herdr"), "agent", "list"], capture_output=True, env=bed.env())
    assert p.returncode == 0
    assert bed.seen()["argv"] == [b"agent".hex(), b"list".hex()]


def test_a_missing_adapter_never_reaches_the_real_herdr(bed):
    # In an app terminal the real herdr is the wrong Herdr, so this must fail.
    (bed.bin / "herdr-adapter").unlink()
    p, _, _ = bed.run("agent", "list", HC_TERMINAL_ID="t4")
    assert p.returncode != 0
    assert not bed.real_record.exists()
    assert not bed.record.exists()
