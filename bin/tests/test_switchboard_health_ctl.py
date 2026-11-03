"""Tests for bin/switchboard-health-ctl.

launchctl is a stub on PATH that records every call and answers `print`,
`bootstrap` and `bootout` with exit codes each test sets. claude is a stub
file the script only has to find. HOME is a temp directory, so nothing
touches the real ~/Library/LaunchAgents or switchboard folder. The dry run is
the real switchboard-health on /usr/bin/python3, pointed at the temp state
directory, where it finds no state file and does nothing.
"""
import json
import os
import plistlib
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "switchboard-health-ctl"
ORCHI = HERE.parent.parent
LABEL = "orchi.switchboard-health"
DOMAIN = f"gui/{os.getuid()}"

LAUNCHCTL = """#!{python}
import json, sys
args = sys.argv[1:]
with open({calls!r}, "a") as f:
    f.write(json.dumps(args) + "\\n")
cfg = json.load(open({cfg!r}))
rc = cfg.get(args[0], 0)
if rc:
    print(cfg.get("error", "launchctl failed"), file=sys.stderr)
elif args[0] == "print":
    print("gui/501/orchi.switchboard-health = {{\\n\\tstate = waiting\\n}}")
sys.exit(rc)
"""


class Env:
    def __init__(self, tmp_path):
        self.home = tmp_path / "home"
        self.home.mkdir()
        self.bin = tmp_path / "bin"
        self.bin.mkdir()
        self.state_dir = self.home / ".claude" / "switchboard"
        self.calls_file = tmp_path / "calls.jsonl"
        self.cfg_file = tmp_path / "cfg.json"
        self.cfg_file.write_text("{}")
        stub = self.bin / "launchctl"
        stub.write_text(LAUNCHCTL.format(python=sys.executable, calls=str(self.calls_file),
                                         cfg=str(self.cfg_file)))
        stub.chmod(0o755)
        self.launcher = self.home / ".local" / "libexec" / "orchi-app" / "herdr"
        self.launcher.parent.mkdir(parents=True)
        self.launcher.write_text("#!/bin/sh\n")
        self.launcher.chmod(0o755)

    def configure(self, **cfg):
        self.cfg_file.write_text(json.dumps(cfg))

    def add_claude(self, where=None):
        d = where or self.bin
        d.mkdir(parents=True, exist_ok=True)
        c = d / "claude"
        c.write_text("#!/bin/sh\n")
        c.chmod(0o755)
        return d

    def run(self, *args, settings=None):
        env = {"PATH": f"{self.bin}:/usr/bin:/bin", "HOME": str(self.home)}
        if settings is not None:
            env["ORCHI_SETTINGS"] = str(settings)
        done = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True,
                              text=True, env=env, timeout=60)
        return done.returncode, done.stdout, done.stderr

    def calls(self):
        if not self.calls_file.exists():
            return []
        return [json.loads(l) for l in self.calls_file.read_text().splitlines() if l.strip()]

    @property
    def plist(self):
        return self.state_dir / f"{LABEL}.plist"

    @property
    def old_plist(self):
        return self.home / "Library" / "LaunchAgents" / f"{LABEL}.plist"


@pytest.fixture
def ctl(tmp_path):
    return Env(tmp_path)


# on

def test_on_renders_the_plist_into_the_state_dir_and_bootstraps_it(ctl):
    ctl.configure(**{"print": 113})  # not loaded
    claude_dir = ctl.add_claude()
    rc, out, err = ctl.run("on")
    assert rc == 0, err
    assert ctl.plist.exists()
    plist = plistlib.loads(ctl.plist.read_bytes())
    assert plist["Label"] == LABEL
    assert plist["ProgramArguments"] == ["/usr/bin/python3", str(ORCHI / "bin" / "switchboard-health"),
                                         "--once"]
    assert plist["EnvironmentVariables"]["PATH"].split(":")[:4] == [
        str(ctl.home / ".local" / "libexec" / "orchi-app"), str(ctl.home / ".local" / "bin"),
        "/opt/homebrew/bin", str(claude_dir)]
    assert "ORCHI_HERDR" not in plist["EnvironmentVariables"]
    assert "ORCHI_HERDR" not in ctl.plist.read_text()
    assert plist["StandardOutPath"] == str(ctl.state_dir / "health.out.log")
    assert plist["StandardErrorPath"] == str(ctl.state_dir / "health.err.log")
    assert "@" not in ctl.plist.read_text().split("-->", 1)[1]
    assert ["bootstrap", DOMAIN, str(ctl.plist)] in ctl.calls()


def test_on_creates_the_state_dir(ctl):
    ctl.configure(**{"print": 113})
    ctl.add_claude()
    assert not ctl.state_dir.exists()
    rc, _, err = ctl.run("on")
    assert rc == 0, err
    assert ctl.state_dir.is_dir()


def test_on_shows_the_dry_run_before_it_bootstraps(ctl):
    ctl.configure(**{"print": 113})
    ctl.add_claude()
    rc, out, err = ctl.run("on")
    assert rc == 0, err
    # The dry run is the real script; with no state file it notes that and sends nothing.
    assert "no state file" in out
    assert not (ctl.state_dir / "health.jsonl").exists()
    assert out.index("no state file") < out.index("switched on")


def test_on_with_state_dir_flag_uses_it_everywhere(ctl, tmp_path):
    ctl.configure(**{"print": 113})
    ctl.add_claude()
    other = tmp_path / "elsewhere"
    rc, _, err = ctl.run("on", "--state-dir", str(other))
    assert rc == 0, err
    plist = other / f"{LABEL}.plist"
    assert plist.exists()
    assert not ctl.plist.exists()
    assert plistlib.loads(plist.read_bytes())["StandardOutPath"] == str(other / "health.out.log")
    assert ["bootstrap", DOMAIN, str(plist)] in ctl.calls()


def test_on_never_writes_to_library_launchagents(ctl):
    ctl.configure(**{"print": 113})
    ctl.add_claude()
    rc, _, err = ctl.run("on")
    assert rc == 0, err
    assert not (ctl.home / "Library" / "LaunchAgents").exists()


def test_on_when_already_loaded_says_so_and_changes_nothing(ctl):
    ctl.configure(**{"print": 0})
    ctl.add_claude()
    rc, out, _ = ctl.run("on")
    assert rc == 0
    assert "already on" in out
    assert [c[0] for c in ctl.calls()] == ["print"]
    assert not ctl.plist.exists()


def test_on_finds_claude_under_nvm_when_it_is_not_on_path(ctl):
    ctl.configure(**{"print": 113})
    nvm = ctl.add_claude(ctl.home / ".nvm" / "versions" / "node" / "v20.20.0" / "bin")
    rc, _, err = ctl.run("on")
    assert rc == 0, err
    path = plistlib.loads(ctl.plist.read_bytes())["EnvironmentVariables"]["PATH"]
    assert path.split(":")[3] == str(nvm)


def test_on_prefers_the_newest_nvm_node(ctl):
    ctl.configure(**{"print": 113})
    ctl.add_claude(ctl.home / ".nvm" / "versions" / "node" / "v18.2.0" / "bin")
    new = ctl.add_claude(ctl.home / ".nvm" / "versions" / "node" / "v20.20.0" / "bin")
    rc, _, err = ctl.run("on")
    assert rc == 0, err
    path = plistlib.loads(ctl.plist.read_bytes())["EnvironmentVariables"]["PATH"]
    assert path.split(":")[3] == str(new)


def test_on_without_claude_is_an_error_and_loads_nothing(ctl):
    ctl.configure(**{"print": 113})
    rc, out, err = ctl.run("on")
    assert rc == 1
    assert "claude" in err
    assert not any(c[0] == "bootstrap" for c in ctl.calls())
    assert not ctl.plist.exists()


def test_on_without_the_launcher_is_an_error_and_loads_nothing(ctl):
    # herdr would be the wrong Herdr, which shows no switchboard, so the job would start one.
    ctl.configure(**{"print": 113})
    ctl.add_claude()
    ctl.launcher.unlink()
    rc, _, err = ctl.run("on")
    assert rc == 1
    assert "launcher" in err
    assert "run scripts/install.sh in your Orchi checkout" in err
    assert "herdr-build" not in err
    assert not [c for c in ctl.calls() if c[0] == "bootstrap"]


def test_on_gives_the_dry_run_the_same_herdr_as_the_job(ctl):
    # A state file gives the dry run something to ask herdr, and the launcher records it.
    ctl.configure(**{"print": 113})
    ctl.add_claude()
    seen = ctl.home / "seen"
    ctl.launcher.write_text(f"""#!/bin/sh
echo "$*" >> {seen}
echo '{{"result": {{"agents": []}}}}'
""")
    ctl.state_dir.mkdir(parents=True)
    (ctl.state_dir / "state.md").write_text("# switchboard state\n## watching\n")
    assert ctl.run("on")[0] == 0
    assert seen.read_text().splitlines()[0] == "agent list"


def test_on_without_orchi_settings_renders_no_settings_entry(ctl):
    ctl.configure(**{"print": 113})
    ctl.add_claude()
    assert ctl.run("on")[0] == 0
    plist = plistlib.loads(ctl.plist.read_bytes())
    assert "ORCHI_SETTINGS" not in plist["EnvironmentVariables"]
    assert "ORCHI_SETTINGS" not in ctl.plist.read_text().split("-->", 1)[1]


def test_on_gives_the_job_the_same_orchi_settings_as_the_dry_run(ctl, tmp_path):
    # The settings move the switchboard folder; the job must watch the one the dry run checked.
    ctl.configure(**{"print": 113})
    ctl.add_claude()
    profile = tmp_path / "profile"
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"claude_dir": str(profile)}))
    ctl.state_dir = profile / "switchboard"
    rc, out, err = ctl.run("on", settings=settings)
    assert rc == 0, err
    assert "no state file" in out
    plist = plistlib.loads(ctl.plist.read_bytes())
    assert plist["EnvironmentVariables"]["ORCHI_SETTINGS"] == str(settings)
    assert "ORCHI_HERDR" not in plist["EnvironmentVariables"]
    assert plist["StandardOutPath"] == str(profile / "switchboard" / "health.out.log")
    assert "@" not in ctl.plist.read_text().split("-->", 1)[1]


def test_on_reports_a_failed_bootstrap(ctl):
    ctl.configure(**{"print": 113, "bootstrap": 5, "error": "Bootstrap failed: 5: Input/output error"})
    ctl.add_claude()
    rc, out, err = ctl.run("on")
    assert rc == 1
    assert "Input/output error" in err
    assert "switched on" not in out


# off

def test_off_boots_out_the_job_when_loaded(ctl):
    ctl.configure(**{"print": 0})
    rc, out, err = ctl.run("off")
    assert rc == 0, err
    assert ["bootout", f"{DOMAIN}/{LABEL}"] in ctl.calls()
    assert "switched off" in out


def test_off_when_not_loaded_says_so_and_exits_0(ctl):
    ctl.configure(**{"print": 113})
    rc, out, _ = ctl.run("off")
    assert rc == 0
    assert "already off" in out
    assert not any(c[0] == "bootout" for c in ctl.calls())


def test_off_reports_a_failed_bootout(ctl):
    ctl.configure(**{"print": 0, "bootout": 36, "error": "Boot-out failed: 36"})
    rc, out, err = ctl.run("off")
    assert rc == 1
    assert "Boot-out failed" in err


# status

def log_line(**over):
    rec = {"time": "2026-10-10T19:20:05+0100", "switchboard": {"pane": "w1:p1", "status": "idle"},
           "observed": [], "actions": [], "cleared": [], "notes": [], "errors": []}
    rec.update(over)
    return json.dumps(rec, sort_keys=True)


def test_status_loaded_with_a_quiet_last_pass(ctl):
    ctl.configure(**{"print": 0})
    ctl.state_dir.mkdir(parents=True)
    (ctl.state_dir / "health.jsonl").write_text(log_line(time="2026-10-10T19:10:00+0100") + "\n"
                                                + log_line() + "\n")
    rc, out, err = ctl.run("status")
    assert rc == 0, err
    assert "on" in out.splitlines()[0]
    assert "2026-10-10 19:20" in out
    assert "no alerts" in out


def test_status_names_the_alerts_of_the_last_pass(ctl):
    ctl.configure(**{"print": 0})
    ctl.state_dir.mkdir(parents=True)
    (ctl.state_dir / "health.jsonl").write_text(log_line(
        observed=[{"repo": "/r/birch", "pane": "w1:p2", "condition": "stall", "count": 2}],
        actions=[{"kind": "prompt", "ok": True}],
        errors=["herdr agent list failed"]) + "\n")
    rc, out, _ = ctl.run("status")
    assert rc == 0
    assert "1 alert" in out
    assert "stall" in out
    assert "herdr agent list failed" in out


def test_status_not_loaded(ctl):
    ctl.configure(**{"print": 113})
    rc, out, _ = ctl.run("status")
    assert rc == 0
    assert "off" in out.splitlines()[0]


def test_status_without_a_log_says_no_pass_yet(ctl):
    ctl.configure(**{"print": 0})
    rc, out, _ = ctl.run("status")
    assert rc == 0
    assert "no pass" in out


def test_status_survives_a_torn_last_line(ctl):
    ctl.configure(**{"print": 0})
    ctl.state_dir.mkdir(parents=True)
    (ctl.state_dir / "health.jsonl").write_text(log_line() + "\n" + '{"time": "2026-10')
    rc, out, _ = ctl.run("status")
    assert rc == 0
    assert "unreadable" in out


# the old login-time plist

def test_on_warns_about_the_old_login_plist_and_never_deletes_it(ctl):
    ctl.configure(**{"print": 113})
    ctl.add_claude()
    ctl.old_plist.parent.mkdir(parents=True)
    ctl.old_plist.write_text("old")
    rc, out, err = ctl.run("on")
    assert rc == 0, err
    text = out + err
    assert "at login" in text
    assert f"rm {ctl.old_plist}" in text
    assert ctl.old_plist.read_text() == "old"


def test_status_warns_about_the_old_login_plist(ctl):
    ctl.configure(**{"print": 113})
    ctl.old_plist.parent.mkdir(parents=True)
    ctl.old_plist.write_text("old")
    rc, out, err = ctl.run("status")
    assert rc == 0
    assert "at login" in out + err
    assert f"rm {ctl.old_plist}" in out + err
    assert ctl.old_plist.exists()


def test_off_does_not_warn_or_delete(ctl):
    ctl.configure(**{"print": 113})
    ctl.old_plist.parent.mkdir(parents=True)
    ctl.old_plist.write_text("old")
    rc, out, err = ctl.run("off")
    assert rc == 0
    assert ctl.old_plist.exists()


def test_no_warning_without_an_old_plist(ctl):
    ctl.configure(**{"print": 113})
    rc, out, err = ctl.run("status")
    assert "at login" not in out + err


# usage

def test_help_runs_on_this_python():
    done = subprocess.run(["/usr/bin/python3", str(SCRIPT), "--help"], capture_output=True, text=True)
    assert done.returncode == 0
    assert "on" in done.stdout + done.stderr


def test_no_command_is_a_usage_error(ctl):
    rc, out, err = ctl.run()
    assert rc == 2
    assert "Usage" in err


def test_unknown_command_is_a_usage_error(ctl):
    rc, out, err = ctl.run("restart")
    assert rc == 2
    assert not ctl.calls()


def test_script_is_executable():
    assert os.access(SCRIPT, os.X_OK)
