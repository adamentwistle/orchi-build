"""scripts/herdr-dev, the private test window, with a fake Herdr app and a fake orchi. HOME is a scratch folder, so
nothing reaches the real app, its homes or the real Orchi settings."""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import ROOT

SCRIPT = ROOT / "scripts" / "herdr-dev"

pytestmark = pytest.mark.skipif(shutil.which("zsh") is None, reason="herdr-dev is a zsh script")

# Logs every call with the Orchi variables it was given, and answers status as a running window does.
FAKE_APP = """#!/bin/sh
echo "app $* | settings=$ORCHI_SETTINGS | appbin=$ORCHI_APP_BIN" >> "$MARKS/app.log"
case "$1" in
  status) echo '{"layout": "orchi", "errors": []}'; exit "${FAKE_STATUS_RC:-0}" ;;
  do) echo '{"ok": true}' ;;
esac
exit 0
"""

# Orchi when a step needs a terminal to answer: it says so and exits 1.
FAKE_ORCHI = """import os, sys
open(os.path.join(os.environ["MARKS"], "orchi.log"), "a").write("settings=" + os.environ.get("ORCHI_SETTINGS", "") + "\\n")
print("Needs you: Ticket sources.")
sys.exit(int(os.environ.get("FAKE_ORCHI_RC", "1")))
"""


@pytest.fixture
def world(tmp_path):
    home, marks, repo, tools = (tmp_path / n for n in ("home", "marks", "repo", "tools"))
    for d in (home / ".local" / "bin", marks, repo / "src" / "orchi", repo / "bin", tools):
        d.mkdir(parents=True)
    app = home / ".local" / "bin" / "herdr-app"
    app.write_text(FAKE_APP)
    app.chmod(0o755)
    (repo / "src" / "orchi" / "__init__.py").write_text("")
    (repo / "src" / "orchi" / "__main__.py").write_text(FAKE_ORCHI)
    herdr = repo / "bin" / "herdr"
    herdr.write_text('#!/bin/sh\necho "checkout herdr $*"\n')
    herdr.chmod(0o755)
    # No front app to hand focus back to, so the test never brings a real app forward.
    lsappinfo = tools / "lsappinfo"
    lsappinfo.write_text("#!/bin/sh\nexit 0\n")
    lsappinfo.chmod(0o755)
    env = {
        "HOME": str(home), "MARKS": str(marks), "PATH": f"{tools}:{home}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
        "ORCHI_SETTINGS": str(tmp_path / "callers-settings.json"), "ORCHI_APP_BIN": str(tmp_path / "callers-app-bin"),
        "CLAUDE_CONFIG_DIR": str(tmp_path / "callers-profile"),
    }
    return {"home": home, "marks": marks, "repo": repo, "env": env}


def run(world, *args):
    return subprocess.run(["zsh", str(SCRIPT), *args], env=world["env"], capture_output=True, text=True, timeout=60)


def window(world, slug="t"):
    return world["home"] / ".config" / "hd" / slug


def test_up_dresses_the_window_when_a_step_needs_a_terminal(world):
    r = run(world, "up", "t", str(world["repo"]))
    assert "Needs you: Ticket sources." in r.stdout + r.stderr
    log = (world["marks"] / "app.log").read_text()
    assert 'do layout.switch {"name":"orchi"}' in log
    assert r.returncode == 1


def test_run_uses_the_windows_own_settings_and_launcher(world):
    run(world, "up", "t", str(world["repo"]))
    r = run(world, "run", "t", "env")
    lines = r.stdout.splitlines()
    assert f"ORCHI_SETTINGS={window(world)}/orchi-settings.json" in lines
    assert f"ORCHI_APP_BIN={window(world)}/orchi-app" in lines


def test_the_window_and_the_install_get_the_windows_settings(world):
    run(world, "up", "t", str(world["repo"]))
    opened = [l for l in (world["marks"] / "app.log").read_text().splitlines() if l.startswith("app  |")]
    assert opened == [f"app  | settings={window(world)}/orchi-settings.json | appbin={window(world)}/orchi-app"]
    assert (world["marks"] / "orchi.log").read_text() == f"settings={window(world)}/orchi-settings.json\n"


def test_the_launcher_runs_the_checkout_under_test(world):
    run(world, "up", "t", str(world["repo"]))
    r = subprocess.run([str(window(world) / "orchi-app" / "herdr"), "agent", "list"], capture_output=True, text=True)
    assert r.stdout == "checkout herdr agent list\n"


def test_the_launcher_follows_install_to_another_checkout(world, tmp_path):
    run(world, "up", "t", str(world["repo"]))
    other = tmp_path / "other checkout"
    shutil.copytree(world["repo"], other)
    (other / "bin" / "herdr").write_text('#!/bin/sh\necho "other herdr $*"\n')
    run(world, "install", "t", str(other))
    r = subprocess.run([str(window(world) / "orchi-app" / "herdr"), "x"], capture_output=True, text=True)
    assert r.stdout == "other herdr x\n"


def test_up_fails_when_the_launcher_cannot_be_written(world):
    window(world).mkdir(parents=True)
    (window(world) / "orchi-app").write_text("in the way")
    world["env"]["FAKE_ORCHI_RC"] = "0"
    assert run(world, "up", "t", str(world["repo"])).returncode != 0
    assert run(world, "install", "t", str(world["repo"])).returncode != 0

