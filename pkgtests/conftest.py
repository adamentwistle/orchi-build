"""Shared helpers for the package tests. Nothing here touches the real HOME or the real uv directories."""
import os
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

# The folders that ship inside the wheel, and the names that never do.
DATA_FOLDERS = (
    "mods", "themes", "sounds", "skills", "commands", "scripts",
    "bin", "config", "layouts", "keys", "browser", "launchd",
)
EXCLUDED_DIRS = {"tests", "__pycache__", ".pytest_cache"}
EXCLUDED_NAMES = {".DS_Store", "gpui-kit.d.ts", "jsconfig.json"}

sys.path.insert(0, str(SRC))


def is_excluded(relative_path):
    parts = Path(relative_path).parts
    return (
        any(part in EXCLUDED_DIRS for part in parts[:-1])
        or parts[-1] in EXCLUDED_NAMES
        or parts[-1].endswith(".pyc")
    )


def scratch_env(base):
    """An environment whose HOME, uv directories and caches all live under `base`."""
    base = Path(base)
    home = base / "home"
    home.mkdir(parents=True, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith("UV_")}
    env.update(
        HOME=str(home),
        XDG_CACHE_HOME=str(base / "xdg-cache"),
        XDG_CONFIG_HOME=str(base / "xdg-config"),
        XDG_DATA_HOME=str(base / "xdg-data"),
        UV_CACHE_DIR=str(base / "uv-cache"),
        UV_TOOL_DIR=str(base / "uv-tools"),
        UV_TOOL_BIN_DIR=str(base / "uv-bin"),
        UV_PYTHON_INSTALL_DIR=str(base / "uv-python"),
        UV_NO_CONFIG="1",
    )
    env.pop("ORCHI_SETTINGS", None)
    env.pop("CLAUDE_CONFIG_DIR", None)
    return env


def find_uv():
    """The path to uv. Missing uv skips on a laptop, but fails when CI is set."""
    path = shutil.which("uv")
    if path:
        return path
    reason = "uv is not installed, so the build and install tests cannot run"
    if os.environ.get("CI"):
        pytest.fail(reason, pytrace=False)
    pytest.skip(reason)


@pytest.fixture(scope="session")
def uv():
    return find_uv()


# The seams where orchi tickets meets the world, as they really are. Every test gets fakes in their place that fail
# the test if it reaches one, so no test runs gh, asks Linear or reads the keychain; a test that wants one installs
# its own fake. The top conftest also stops the security binary and any socket off this computer.
from orchi.tickets import github as _github, keychain as _keychain, linear as _linear  # noqa: E402

REAL = {"keychain.find_password": _keychain.find_password, "linear.post": _linear.post, "github.run": _github.run}


@pytest.fixture(autouse=True)
def no_real_seams(monkeypatch):
    def keychain(service):
        raise AssertionError("a test reached the keychain: fake orchi.tickets.keychain.find_password")

    def post(query, variables, key):
        raise AssertionError("a test reached the network through Linear: fake orchi.tickets.linear.post")

    def gh(argv):
        raise AssertionError("a test ran gh: fake orchi.tickets.github.run")

    monkeypatch.setattr(_keychain, "find_password", keychain)
    monkeypatch.setattr(_linear, "post", post)
    monkeypatch.setattr(_github, "run", gh)


# Setup starts programs and downloads pages through orchi.system only. Every test gets versions of them that fail the
# test, a Mac that is not Linux, and no extra folders to look for tools in, so a test that wants a program, a page or
# a platform installs its own (pkgtests/mac_help.py has a whole fake Mac). The top conftest also stops the programs
# that change a Mac (launchctl, brew, xcode-select, npm) if anything starts them another way.
from orchi import system as _system  # noqa: E402

REAL.update({"system.run": _system.run, "system.fetch": _system.fetch, "system.sleep": _system.sleep,
             "system.platform": _system.platform})


@pytest.fixture(autouse=True)
def no_real_system(monkeypatch):
    def run(argv, *a, **kw):
        raise AssertionError(f"a test started {list(argv)}: fake orchi.system.run")

    def fetch(url, *a, **kw):
        raise AssertionError(f"a test downloaded {url}: fake orchi.system.fetch")

    def sleep(seconds):
        raise AssertionError("a test slept: fake orchi.system.sleep")

    monkeypatch.setattr(_system, "run", run)
    monkeypatch.setattr(_system, "fetch", fetch)
    monkeypatch.setattr(_system, "sleep", sleep)
    monkeypatch.setattr(_system, "EXTRA_DIRS", ())
    monkeypatch.setattr(_system, "platform", lambda: "darwin")
