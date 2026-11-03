"""The bundled pieces run from the installed package's own copy, not from the checkout.

One real `uv tool install` of the checkout goes into scratch directories. Then pr-drafter's sweep, ux-test's doctor,
usage-guard and pane-notify run from `orchi/data` inside the installed tool, each with HOME and the settings pointing
at a temporary folder, so nothing reads the real settings, usage cache or Herdr.
"""
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from bundled_names import NAMES
from conftest import ROOT, scratch_env

NOW = 1_800_000_000.0


@pytest.fixture(scope="module")
def installed(uv, tmp_path_factory):
    base = tmp_path_factory.mktemp("bundled")
    env = scratch_env(base)
    done = subprocess.run([uv, "tool", "install", "--force", str(ROOT)], env=env, capture_output=True, text=True,
                          cwd=str(base))
    assert done.returncode == 0, done.stdout + done.stderr
    python = Path(env["UV_TOOL_DIR"]) / "orchi" / "bin" / "python"
    where = subprocess.run([str(python), "-c", "from orchi.paths import data_dir; print(data_dir())"], env=env,
                           capture_output=True, text=True, cwd=str(base))
    assert where.returncode == 0, where.stderr
    data = Path(where.stdout.strip())
    assert str(ROOT) not in str(data), "the pieces must come from the installed copy"
    return data


@pytest.fixture
def home(tmp_path):
    folder = tmp_path / "home"
    folder.mkdir()
    return folder


def clean_env(home, **extra):
    env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "ORCHI_SETTINGS": str(home / "settings.json"),
           "HERDR_APP_HOME": str(home / "app"), "CLAUDE_CONFIG_DIR": str(home / "claude")}
    env.update(extra)
    return env


def test_the_installed_skills_name_nobody(installed):
    hits = []
    for piece in ("pr-drafter", "ux-test"):
        for path in (installed / "skills" / piece).rglob("*"):
            if path.is_file() and NAMES.search(path.read_text(errors="replace")):
                hits.append(str(path.relative_to(installed)))
    assert hits == []


def test_the_installed_pr_drafter_keeps_its_marks_and_sweeps_text(installed, home):
    skill = installed / "skills" / "pr-drafter"
    text = (skill / "SKILL.md").read_text()
    assert "**TL;DR.**" in text and all(f"**{m}**" in text for m in ("OBSERVED", "STALE", "NOT RUN"))
    ran = subprocess.run(["sh", str(skill / "voice-sweep.sh"), "--self-test"], cwd=home, env=clean_env(home),
                         capture_output=True, text=True, timeout=60)
    assert ran.returncode == 0, ran.stdout + ran.stderr
    draft = home / "draft.md"
    draft.write_text("A dash \u2014 here\n", encoding="utf-8")
    dirty = subprocess.run(["sh", str(skill / "voice-sweep.sh"), str(draft)], cwd=home, env=clean_env(home),
                           capture_output=True, text=True, timeout=60)
    assert dirty.returncode == 1 and "BLOCK" in dirty.stdout


def test_the_installed_ux_test_doctor_runs(installed, home):
    node = shutil.which("node")
    if node is None:
        if os.environ.get("CI"):
            pytest.fail("node is not installed, so ux-test cannot run", pytrace=False)
        pytest.skip("node is not installed")
    target = home / "app"
    target.mkdir()
    (target / "package.json").write_text(json.dumps({"dependencies": {"next": "15.0.0"}}))
    (target / "package-lock.json").write_text("{}")
    # Node alone on the PATH, so a global agent-browser beside the real node cannot change the report.
    tools = home / "tools"
    tools.mkdir()
    (tools / "node").symlink_to(node)
    env = clean_env(home, PATH=f"{tools}:/usr/bin:/bin")
    ran = subprocess.run(["bash", str(installed / "skills" / "ux-test" / "scripts" / "doctor.sh"), "--json",
                          str(target)], cwd=home, env=env, capture_output=True, text=True, timeout=120)
    report = json.loads(ran.stdout)
    assert report["kind"] == "next"
    assert ran.returncode == report["exit"] == 1
    pin = json.loads((installed / "skills" / "ux-test" / "versions.json").read_text())["global"]["agent-browser"]
    ab = next(c for c in report["checks"] if c["check"] == "agent-browser")
    assert ab["status"] != "OK" and pin in ab["fix"]


def stamp(seconds):
    return (datetime.fromtimestamp(NOW, timezone.utc) + timedelta(seconds=seconds)).isoformat()


def usage_guard(installed, home, *args):
    env = clean_env(home, USAGE_GUARD_NOW=str(NOW), USAGE_GUARD_STAMPS=str(home / "stamps"))
    return subprocess.run([sys.executable, str(installed / "bin" / "usage-guard"), *args], input="{}", cwd=home,
                          env=env, capture_output=True, text=True, timeout=30)


def test_the_installed_usage_guard_reads_the_usage_cache_and_the_setting(installed, home):
    cache = home / ".cache" / "orchi" / "usage.json"
    cache.parent.mkdir(parents=True)
    cache.write_text(json.dumps({"sessionUsage": 10, "sessionResetAt": stamp(3 * 3600), "weeklyUsage": 85,
                                 "weeklyResetAt": stamp(2 * 86400), "fableUsage": 10,
                                 "fableResetAt": stamp(2 * 86400)}))
    os.utime(cache, (NOW, NOW))
    assert "weekly all-models limit" in usage_guard(installed, home, "--check").stdout
    assert "-> ok" in usage_guard(installed, home, "--check").stdout.splitlines()[1]
    (home / "settings.json").write_text(json.dumps({"usage_guard_percent": 80}))
    ran = usage_guard(installed, home, "--check")
    assert ran.returncode == 0, ran.stderr
    assert "weekly all-models limit" in ran.stdout and "-> PAUSE" in ran.stdout.splitlines()[1]


STUB_HC = """#!{python}
import json, sys
if sys.argv[1] == "get":
    print(json.dumps({{"address": "t7", "state": "live", "title": {title!r}, "cwd": "/work/app",
                       "labels": {labels!r}}}))
else:
    print(json.dumps({{"error": {{"kind": "not_found", "message": "no"}}}}), file=sys.stderr)
    sys.exit(3)
"""

STUB_NOTIFIER = """#!{python}
import json, sys
open({calls!r}, "a").write(json.dumps([sys.argv[1:], sys.stdin.read()]) + "\\n")
"""


def pane_notify(installed, home, title, labels):
    bin_dir = home / "stubs"
    bin_dir.mkdir()
    calls = home / "banners.jsonl"
    (bin_dir / "hc").write_text(STUB_HC.format(python=sys.executable, title=title, labels=labels))
    (bin_dir / "terminal-notifier").write_text(STUB_NOTIFIER.format(python=sys.executable, calls=str(calls)))
    for stub in bin_dir.iterdir():
        stub.chmod(0o755)
    env = clean_env(home, PATH=f"{bin_dir}:/usr/bin:/bin", HC_TERMINAL_ID="t7", CLAUDE_CODE_ENTRYPOINT="cli")
    hook = {"hook_event_name": "Stop", "session_id": "s1", "last_assistant_message": "All done.\nmore"}
    ran = subprocess.run([sys.executable, str(installed / "bin" / "pane-notify")], input=json.dumps(hook), cwd=home,
                         env=env, capture_output=True, text=True, timeout=30)
    assert ran.returncode == 0 and ran.stdout == ""
    return [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []


def test_the_installed_pane_notify_banners_a_normal_pane(installed, home):
    [(args, body)] = pane_notify(installed, home, "Overnight run", {})
    assert args == ["-title", "Overnight run: done"] and body == "All done."


def test_the_installed_pane_notify_is_quiet_for_a_worker_pane(installed, home):
    assert pane_notify(installed, home, "Make the pieces", {"orchi.name": "fw-bundled"}) == []
