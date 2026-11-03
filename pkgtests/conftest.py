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
