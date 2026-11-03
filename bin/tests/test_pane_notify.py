"""Tests for bin/pane-notify.

herdr is a stub on PATH that records every call, answers `pane get` with
the pane each test sets, and exits with codes each test sets. terminal-notifier
and afplay are stubs on PATH that record their calls in the same file, so
a banner is a ["terminal-notifier", ...] call and a sound an ["afplay", ...]
call; terminal-notifier's stdin is recorded after "STDIN". HOME is a temporary directory holding Herdr's two sound files. The
hook input is the JSON Claude Code sends on stdin.
"""
import time
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "pane-notify"

HERDR = """#!{python}
import json, sys
args = sys.argv[1:]
with open({calls!r}, "a") as f:
    f.write(json.dumps(args) + "\\n")
cfg = json.load(open({cfg!r}))
if args[:2] == ["pane", "get"]:
    if cfg.get("get_rc"):
        print("pane not found", file=sys.stderr)
        sys.exit(cfg["get_rc"])
    pane = dict(cfg.get("pane", {{}}), pane_id=args[2])
    print(json.dumps({{"id": "cli:pane:get", "result": {{"pane": pane, "type": "pane_info"}}}}))
    sys.exit(0)
sys.exit(cfg.get("show_rc", 0))
"""

RECORDER = """#!{python}
import json, sys
call = [{name!r}] + sys.argv[1:]
if {name!r} == "terminal-notifier":
    call += ["STDIN", sys.stdin.read()]
with open({calls!r}, "a") as f:
    f.write(json.dumps(call) + "\\n")
cfg = json.load(open({cfg!r}))
sys.exit(cfg.get({rc!r}, 0))
"""


class Env:
    def __init__(self, tmp_path):
        self.bin = tmp_path / "bin"
        self.bin.mkdir()
        self.calls_file = tmp_path / "calls.jsonl"
        self.cfg_file = tmp_path / "cfg.json"
        self.configure(pane={"cwd": "/Users/me/Projects/orchi"})
        stub = self.bin / "herdr"
        stub.write_text(HERDR.format(python=sys.executable, calls=str(self.calls_file),
                                     cfg=str(self.cfg_file)))
        stub.chmod(0o755)
        for name, rc in (("terminal-notifier", "notify_rc"), ("afplay", "play_rc")):
            rec = self.bin / name
            rec.write_text(RECORDER.format(python=sys.executable, calls=str(self.calls_file),
                                           cfg=str(self.cfg_file), name=name, rc=rc))
            rec.chmod(0o755)
        self.home = tmp_path / "home"
        self.sounds = self.home / ".config" / "herdr" / "sounds"
        self.sounds.mkdir(parents=True)
        for name in ("done.mp3", "request.mp3"):
            (self.sounds / name).write_bytes(b"ID3")

    def configure(self, **cfg):
        self.cfg_file.write_text(json.dumps(cfg))

    def pane(self, **pane):
        pane.setdefault("cwd", "/Users/me/Projects/orchi")
        self.configure(pane=pane)

    def run(self, hook_input, herdr=True, **env_extra):
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("HERDR_", "CLAUDE_CODE_ENTRYPOINT"))}
        env["PATH"] = f"{self.bin}:{env['PATH']}"
        env["HOME"] = str(self.home)
        if herdr:
            env.update(HERDR_ENV="1", HERDR_PANE_ID="wAX:p2",
                       HERDR_SOCKET_PATH="/tmp/herdr.sock")
        env["CLAUDE_CODE_ENTRYPOINT"] = "cli"
        env.update(env_extra)
        env = {k: v for k, v in env.items() if v is not None}
        return subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(hook_input),
                              capture_output=True, text=True, env=env, timeout=30)

    def calls(self):
        if not self.calls_file.exists():
            return []
        return [json.loads(line) for line in self.calls_file.read_text().splitlines()]

    def shows(self):
        """Banners: the terminal-notifier calls, with no herdr notification show."""
        assert not [c for c in self.calls() if c[:2] == ["notification", "show"]]
        return [c for c in self.calls() if c[0] == "terminal-notifier"]

    def sounds_played(self, wait=True):
        # afplay is started detached, so give it a moment to record itself.
        deadline = time.monotonic() + (3 if wait else 0)
        while True:
            played = [c for c in self.calls() if c[0] == "afplay"]
            if played or time.monotonic() >= deadline:
                return played
            time.sleep(0.05)


def stop(**extra):
    return dict({"session_id": "s1", "hook_event_name": "Stop",
                 "cwd": "/Users/me/Projects/orchi", "stop_hook_active": False}, **extra)


def notification(kind="permission_prompt", message="Claude needs your permission to use Bash"):
    return {"session_id": "s1", "hook_event_name": "Notification",
            "cwd": "/Users/me/Projects/orchi", "message": message,
            "notification_type": kind}


def opt(call, name):
    return call[call.index(name) + 1] if name in call else None


@pytest.fixture
def env(tmp_path):
    return Env(tmp_path)


# Who notifies

def test_orchestrator_pane_by_title_notifies_done(env):
    env.pane(title="orch-birch")
    done = env.run(stop())
    assert done.returncode == 0
    [show] = env.shows()
    assert opt(show, "-title") == "orch-birch: done"
    [played] = env.sounds_played()
    assert played == ["afplay", str(env.sounds / "done.mp3")]
    assert ["pane", "get", "wAX:p2"] in env.calls()


def test_orchestrator_pane_by_label_notifies(env):
    env.pane(label="orch-cedar", title="Tidy the settings page")
    env.run(stop())
    [show] = env.shows()
    assert opt(show, "-title") == "orch-cedar: done"


def test_normal_session_notifies_under_its_title(env):
    env.pane(title="Overnight run")
    env.run(stop())
    [show] = env.shows()
    assert opt(show, "-title") == "Overnight run: done"


def test_normal_session_without_title_uses_directory_name(env):
    env.pane(cwd="/Users/me/Projects/cedar")
    env.run(stop())
    [show] = env.shows()
    assert opt(show, "-title") == "cedar: done"


@pytest.mark.parametrize("pane", [
    {"label": "switchboard", "title": "switchboard"},
    {"label": "switchboard"},
    {"title": "switchboard"},
])
def test_switchboard_pane_is_quiet(env, pane):
    env.pane(**pane)
    done = env.run(stop())
    assert done.returncode == 0
    assert env.shows() == []


@pytest.mark.parametrize("pane", [
    {"label": "fw-wait-script", "title": "Rewrite the wait script"},
    {"label": "fw-x"},
])
def test_fanout_worker_pane_is_quiet(env, pane):
    env.pane(**pane)
    env.run(stop())
    env.run(notification())
    assert env.shows() == []


def test_label_beats_title(env):
    # A worker whose session got renamed still counts as a worker.
    env.pane(label="fw-x", title="orch-birch")
    env.run(stop())
    assert env.shows() == []


def test_subagent_is_quiet_and_asks_herdr_nothing(env):
    env.pane(title="orch-birch")
    env.run(stop(agent_id="a1", agent_type="general-purpose"))
    env.run(notification() | {"agent_id": "a1"})
    assert env.calls() == []


def test_subagent_stop_is_quiet(env):
    env.pane(title="orch-birch")
    env.run({"session_id": "s1", "hook_event_name": "SubagentStop"})
    assert env.calls() == []


@pytest.mark.parametrize("entrypoint", ["sdk-cli", "sdk-py", "sdk-ts"])
def test_headless_claude_is_quiet(env, entrypoint):
    # claude -p run from a script inside an orchestrator's pane inherits its pane id.
    env.pane(title="orch-birch")
    env.run(stop(), CLAUDE_CODE_ENTRYPOINT=entrypoint)
    assert env.calls() == []


def test_outside_herdr_does_nothing(env):
    done = env.run(stop(), herdr=False)
    assert done.returncode == 0
    assert env.calls() == []


# What it says

def test_permission_prompt_asks_with_request_sound(env):
    env.pane(title="orch-birch")
    env.run(notification())
    [show] = env.shows()
    assert opt(show, "-title") == "orch-birch: needs you"
    assert opt(show, "STDIN") == "Claude needs your permission to use Bash"
    [played] = env.sounds_played()
    assert played == ["afplay", str(env.sounds / "request.mp3")]


def test_elicitation_dialog_asks(env):
    env.pane(title="orch-birch")
    env.run(notification("elicitation_dialog", "Claude has a question"))
    [show] = env.shows()
    assert opt(show, "-title") == "orch-birch: needs you"
    [played] = env.sounds_played()
    assert played == ["afplay", str(env.sounds / "request.mp3")]


@pytest.mark.parametrize("kind", ["idle_prompt", "auth_success", ""])
def test_other_notifications_are_quiet(env, kind):
    # Herdr's own toasts covered done and blocked; idle_prompt repeats a done.
    env.pane(title="orch-birch")
    env.run(notification(kind, "Claude is waiting for your input"))
    assert env.shows() == []


def test_done_body_is_first_line_of_last_message(env):
    env.pane(title="orch-birch")
    env.run(stop(last_assistant_message="PR 29 is open with the hook.\n\nDetails follow."))
    [show] = env.shows()
    assert opt(show, "STDIN") == "PR 29 is open with the hook."


def test_long_body_is_cut(env):
    env.pane(title="orch-birch")
    env.run(stop(last_assistant_message="x" * 500))
    [show] = env.shows()
    body = opt(show, "STDIN")
    assert len(body) <= 120
    assert body.endswith("...")


def test_done_without_message_says_claude_finished(env):
    env.pane(title="orch-birch")
    env.run(stop())
    [show] = env.shows()
    assert opt(show, "STDIN") == "Claude finished"


def test_title_is_cut(env):
    env.pane(title="t" * 300)
    env.run(stop())
    [show] = env.shows()
    assert len(opt(show, "-title")) <= 80


# Never in the way

def test_unknown_pane_is_quiet(env):
    # Can't tell a worker from an orchestrator: say nothing.
    env.configure(get_rc=1)
    done = env.run(stop())
    assert done.returncode == 0
    assert env.shows() == []


def test_failed_show_still_exits_zero_and_prints_nothing(env):
    env.configure(pane={"title": "orch-birch", "cwd": "/x"}, show_rc=1)
    done = env.run(stop())
    assert done.returncode == 0
    assert done.stdout == ""


def test_bad_input_exits_zero(env):
    env.pane(title="orch-birch")
    done = subprocess.run([sys.executable, str(SCRIPT)], input="not json",
                          capture_output=True, text=True, timeout=30,
                          env=dict(os.environ, PATH=f"{env.bin}:{os.environ['PATH']}",
                                   HERDR_ENV="1", HERDR_PANE_ID="wAX:p2"))
    assert done.returncode == 0
    assert env.shows() == []


def test_missing_herdr_exits_zero(env):
    (env.bin / "herdr").unlink()
    done = env.run(stop(), PATH=str(env.bin))
    assert done.returncode == 0


def test_banner_carries_no_sound_of_its_own(env):
    # The sound is Herdr's chime through afplay; a -sound would play twice.
    env.pane(title="orch-birch")
    env.run(stop())
    [show] = env.shows()
    assert "-sound" not in show


def test_quiet_pane_plays_no_sound(env):
    env.pane(label="switchboard")
    env.run(stop())
    env.run(notification())
    assert env.shows() == []
    assert env.sounds_played(wait=False) == []


def test_missing_sound_file_still_shows_banner(env):
    (env.sounds / "done.mp3").unlink()
    env.pane(title="orch-birch")
    done = env.run(stop())
    assert done.returncode == 0
    [show] = env.shows()
    assert opt(show, "-title") == "orch-birch: done"
    assert env.sounds_played(wait=False) == []


def test_failed_banner_still_exits_zero(env):
    env.configure(pane={"title": "orch-birch", "cwd": "/x"}, notify_rc=1)
    done = env.run(stop())
    assert done.returncode == 0
    assert done.stdout == ""


def test_missing_terminal_notifier_exits_zero(env):
    (env.bin / "terminal-notifier").unlink()
    env.pane(title="orch-birch")
    done = env.run(stop(), PATH=str(env.bin), PANE_NOTIFY_NOTIFIER=str(env.bin / "terminal-notifier"))
    assert done.returncode == 0
    assert done.stdout == ""


@pytest.mark.parametrize("first", ["- PR 30 is open.", "[x] done", "(see below)", '"quoted"'])
def test_body_goes_on_stdin_so_a_leading_dash_or_bracket_survives(env, first):
    # terminal-notifier refuses a -message value starting with -, [, (, { or a quote.
    env.pane(title="orch-birch")
    env.run(stop(last_assistant_message=first + "\nmore"))
    [show] = env.shows()
    assert "-message" not in show
    assert opt(show, "STDIN") == first
