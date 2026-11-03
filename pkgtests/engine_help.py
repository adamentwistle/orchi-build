"""Helpers for the engine tests: a scratch home, a snapshot of a folder tree, and running `orchi` in a real terminal.

Every test that uses them runs with HOME, ORCHI_SETTINGS, ORCHI_STATE and HERDR_APP_HOME inside its own temporary
folder, so nothing reads or writes the real ones.
"""
import os
import pty
import select
import signal
import sys
import time
from pathlib import Path

import pytest

from conftest import SRC

DRIVER = Path(__file__).resolve().parent / "engine_driver.py"


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A scratch home with the settings, the state folder and Herdr's app home all inside it."""
    folder = tmp_path / "home"
    folder.mkdir()
    monkeypatch.setenv("HOME", str(folder))
    monkeypatch.setenv("ORCHI_SETTINGS", str(folder / ".config" / "orchi" / "settings.json"))
    monkeypatch.setenv("ORCHI_STATE", str(folder / ".local" / "state" / "orchi"))
    monkeypatch.setenv("HERDR_APP_HOME", str(folder / ".config" / "herdr-app"))
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.delenv("NO_COLOR", raising=False)
    return folder


def snapshot(root):
    """Every path under root with what is there: a file's bytes, a link's target, or that it is a folder, and its
    modification time, so any write, even of the same bytes, shows."""
    seen = {}
    root = Path(root)
    for here, folders, files in os.walk(root):
        for name in folders + files:
            path = Path(here) / name
            info = path.lstat()
            if path.is_symlink():
                what = ("link", os.readlink(path))
            elif path.is_dir():
                what = ("folder",)
            else:
                what = ("file", path.read_bytes())
            seen[str(path.relative_to(root))] = (what, info.st_mtime_ns, info.st_mode)
    return seen


def child_env(**extra):
    """This test's environment for a child process, with the package on its path."""
    env = dict(os.environ)
    env["PYTHONPATH"] = str(SRC)
    env.setdefault("TERM", "xterm-256color")
    env.pop("NO_COLOR", None)
    env.update(extra)
    return env


def in_terminal(argv, env, answers=(), pipe_stdin=False, timeout=30):
    """Run `python <argv>` with a real terminal as its controlling terminal, stdout and stderr, and its stdin a pipe
    when pipe_stdin is set, as under `curl | sh`. Each (text, reply) in answers types reply once text has shown.
    Returns the exit code and everything the terminal showed, with its line ends made plain."""
    pid, fd = pty.fork()
    if pid == 0:
        try:
            if pipe_stdin:
                read_end, write_end = os.pipe()
                os.close(write_end)
                os.dup2(read_end, 0)
            os.execve(sys.executable, [sys.executable, *argv], env)
        finally:
            os._exit(127)
    shown, pending, deadline = b"", list(answers), time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            shown += chunk
        if pending and pending[0][0].encode() in shown:
            os.write(fd, pending.pop(0)[1].encode())
    else:
        os.kill(pid, signal.SIGKILL)
    _, status = os.waitpid(pid, 0)
    os.close(fd)
    return os.waitstatus_to_exitcode(status), shown.decode("utf-8", "replace").replace("\r\n", "\n")
