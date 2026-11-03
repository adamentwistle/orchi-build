"""Tests for bin/switchboard-health.

herdr is replaced by a stub on PATH that answers `agent list` and
`agent get` from one list of agents each test sets, records every call,
and fails a subcommand with a herdr error code when a test asks it to.
terminal-notifier is a stub that records its arguments and exits with a
code each test sets. switchboard-health-ctl is a stub that records its
arguments, so switching the watcher off never reaches launchctl. `switchboard-wait --status` is the real script,
talking to the same herdr stub, except where a test needs a wait to show
as running. Every run passes --state-dir, so nothing touches the real
switchboard folder.
"""
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "switchboard-health"
T0 = 1791650000.0  # 2026-10-10, any fixed time will do
MIN = 60

HERDR = """#!{python}
import json, sys
args = sys.argv[1:]
with open({calls!r}, "a") as f:
    f.write(json.dumps(args) + "\\n")
cfg = json.load(open({cfg!r}))
key = " ".join(args[:2])
if key in cfg.get("fail", {{}}):
    # Real herdr prints errors as JSON on stderr and exits 1.
    print(json.dumps({{"error": {{"code": cfg["fail"][key]}}}}), file=sys.stderr)
    sys.exit(1)
if key == "agent list":
    print(json.dumps({{"id": "cli:agent:list",
                      "result": {{"type": "agent_list", "agents": cfg["agents"]}}}}))
elif key == "agent get":
    for a in cfg["agents"]:
        if args[2] in (a.get("pane_id"), a.get("name")):
            agent = {{"agent_status": a["agent_status"],
                     "state_change_seq": a.get("state_change_seq", 1),
                     "agent_session": {{"kind": "id", "value": a.get("session", "s0")}},
                     "pane_id": a["pane_id"]}}
            if cfg.get("no_sessions"):  # as the Herdr app reports an agent
                del agent["agent_session"]
            print(json.dumps({{"id": "cli:agent:get", "result": {{"type": "agent_info",
                "agent": agent}}}}))
            break
    else:
        print(json.dumps({{"error": {{"code": "agent_not_found"}}}}), file=sys.stderr)
        sys.exit(1)
elif key == "agent read":
    # Plain text, unlike every other reply.
    print(cfg.get("screen", ""))
elif key == "agent prompt" and args[3] == "/clear" and cfg.get("clear_takes", True):
    # /clear starts a new Claude Code session, so herdr reports a new session id
    # and the status line goes back to nothing used.
    for a in cfg["agents"]:
        if args[2] in (a.get("pane_id"), a.get("name")):
            a["session"] = a.get("session", "s0") + "+"
    cfg["screen"] = cfg.get("cleared_screen", "")
    json.dump(cfg, open({cfg!r}, "w"))
    print(json.dumps({{"id": "cli", "result": {{}}}}))
elif key == "workspace create":
    print(json.dumps({{"id": "cli:workspace:create", "result": {{"type": "workspace_created",
        "workspace": {{"workspace_id": "wS"}}, "tab": {{"tab_id": "wS:t1"}},
        "root_pane": {{"pane_id": cfg.get("root_pane", "wS:p1")}}}}}}))
else:
    print(json.dumps({{"id": "cli", "result": {{}}}}))
"""

NOTIFIER = """#!{python}
import json, sys
with open({calls!r}, "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
code = int(open({cfg!r}).read())
if code:
    print("Could not request notification permission", file=sys.stderr)
sys.exit(code)
"""

CTL = """#!{python}
import json, sys
with open({calls!r}, "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
"""

# A switchboard-wait stand-in for the one state the real script cannot be
# put in cheaply: a live wait listed in the pids file.
WAIT_RUNNING = """#!{python}
import sys
repo, pane = sys.argv[-1].split(":", 1)
name = repo.rstrip("/").split("/")[-1]
print(f"{{name}} pane working")
print(f"{{name}} wait running since 18:00 (pid 4242)")
"""

# The same, but with the real script's entry lines, so the open DECISIONs
# --status prints are there to read.
WAIT_RUNNING_ENTRIES = """#!{python}
import subprocess, sys
out = subprocess.run([sys.executable, {wait!r}] + sys.argv[1:],
                     capture_output=True, text=True).stdout
for line in out.splitlines():
    words = line.split()
    if words[1:2] not in (["pane"], ["wait"]):
        print(line)
repo, pane = sys.argv[-1].split(":", 1)
name = repo.rstrip("/").split("/")[-1]
print(f"{{name}} pane working")
print(f"{{name}} wait running since 18:00 (pid 4242)")
"""


def load_script():
    loader = importlib.machinery.SourceFileLoader("switchboard_health", str(SCRIPT))
    spec = importlib.util.spec_from_loader("switchboard_health", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def read_lines(path):
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


@pytest.fixture
def sh(tmp_path, monkeypatch):
    mod = load_script()
    bindir = tmp_path / "bin"
    bindir.mkdir()
    herdr_cfg = tmp_path / "herdr.json"
    herdr_calls = tmp_path / "herdr-calls.jsonl"
    stub = bindir / "herdr"
    stub.write_text(HERDR.format(python=sys.executable, cfg=str(herdr_cfg),
                                 calls=str(herdr_calls)))
    stub.chmod(0o755)
    note_cfg = tmp_path / "notifier-code"
    note_calls = tmp_path / "notifier-calls.jsonl"
    note = bindir / "terminal-notifier"
    note.write_text(NOTIFIER.format(python=sys.executable, cfg=str(note_cfg),
                                    calls=str(note_calls)))
    note.chmod(0o755)
    note_cfg.write_text("0")
    ctl_calls = tmp_path / "ctl-calls.jsonl"
    ctl = bindir / "switchboard-health-ctl"
    ctl.write_text(CTL.format(python=sys.executable, calls=str(ctl_calls)))
    ctl.chmod(0o755)
    waiter = bindir / "wait-running"
    waiter.write_text(WAIT_RUNNING.format(python=sys.executable))
    waiter.chmod(0o755)
    waiter_entries = bindir / "wait-running-entries"
    waiter_entries.write_text(WAIT_RUNNING_ENTRIES.format(python=sys.executable,
                                                          wait=str(SCRIPT.parent / "switchboard-wait")))
    waiter_entries.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bindir}:/usr/bin:/bin")
    # A lock is checked through bin/herdr, so its real herdr is this stub too.
    monkeypatch.setenv("ORCHI_HERDR_REAL", str(stub))
    monkeypatch.delenv("ORCHI_HERDR", raising=False)
    monkeypatch.setattr(mod, "NOTIFIER", str(note))
    monkeypatch.setattr(mod, "CTL", str(ctl))
    monkeypatch.setattr(mod, "ORCHI", "/orchi")
    monkeypatch.setattr(mod, "CLAUDE_CONFIG_DIR", "/profile")
    monkeypatch.setattr(mod, "CLEAR_TIMEOUT", 1)
    monkeypatch.setattr(mod, "CLEAR_POLL", 0.1)
    state_dir = tmp_path / "sb"
    state_dir.mkdir()

    class Env:
        script = mod
        dir = state_dir
        log_path = state_dir / "health.jsonl"
        state_path = state_dir / "health-state.json"
        repo = tmp_path / "atlas"
        repo2 = tmp_path / "birch"
        cfg = {"agents": [], "fail": {}}

        def __init__(self):
            for r in (self.repo, self.repo2):
                (r / ".legwork").mkdir(parents=True)
                self.board(r, "## {}-1 UPDATE 2026-10-10 18:00\nStarted.\n\n".format(r.name))

        def board(self, repo, text):
            (repo / ".legwork" / "switchboard.md").write_text(text)

        def agents(self, *agents):
            self.cfg["agents"] = list(agents)
            herdr_cfg.write_text(json.dumps(self.cfg))

        def fail(self, key, code):
            self.cfg["fail"][key] = code
            herdr_cfg.write_text(json.dumps(self.cfg))

        def root_pane(self, value):
            self.cfg["root_pane"] = value
            herdr_cfg.write_text(json.dumps(self.cfg))

        def clear_never_takes(self):
            self.cfg["clear_takes"] = False
            herdr_cfg.write_text(json.dumps(self.cfg))

        def app_screen(self, screen, cleared=""):
            """Report agents as the Herdr app does, with no session id, and this status line."""
            self.cfg.update(no_sessions=True, screen=screen, cleared_screen=cleared)
            herdr_cfg.write_text(json.dumps(self.cfg))

        def lock(self, terminal="wZ:p1", herdr="terminal"):
            (state_dir / "lock").write_text(json.dumps(
                {"terminal": terminal, "herdr": herdr, "started": "2026-10-10 18:00"}))

        def read_lock(self):
            return json.loads((state_dir / "lock").read_text())

        def heal(self):
            self.cfg["fail"] = {}
            herdr_cfg.write_text(json.dumps(self.cfg))

        def notifier(self, code):
            note_cfg.write_text(str(code))

        def wait_running(self, entries=False):
            monkeypatch.setattr(mod, "WAIT", str(waiter_entries if entries else waiter))

        def state(self, watching=(), cycle=False, when="2026-10-10 18:40", paused=()):
            lines = ["# switchboard state", "updated: 2026-10-10 18:40", "## watching"]
            lines += [f"{p} {r} {pane}" for p, r, pane in watching]
            lines += ["## check-ins"] + [f"{p} 2026-10-10 18:40" for p, _, _ in watching]
            if paused:
                lines += ["## paused"] + [f"{p} 2026-10-10 18:41" for p in paused]
            if cycle:
                lines.append(f"CYCLE {when}")
            (state_dir / "state.md").write_text("\n".join(lines) + "\n")

        def run(self, *extra, at=T0, capsys=None):
            monkeypatch.setattr(mod, "now", lambda: at)
            herdr_calls.write_text("")
            note_calls.write_text("")
            ctl_calls.write_text("")
            rc = mod.main(["--once", "--state-dir", str(state_dir)] + list(extra))
            out = capsys.readouterr().out if capsys else ""
            return rc, out

        def herdr_calls(self):
            return read_lines(herdr_calls)

        def prompts(self):
            return [(c[2], c[3]) for c in self.herdr_calls() if c[:2] == ["agent", "prompt"]]

        def prompt_texts(self, prefix=""):
            return [t for _, t in self.prompts() if t.startswith(prefix)]

        def ctl_calls(self):
            return read_lines(ctl_calls)

        def banners(self):
            return [c[c.index("-message") + 1] for c in read_lines(note_calls)]

        def log(self):
            return read_lines(self.log_path)

    env = Env()
    yield env
    # Never Esc, never keys of any kind: the switchboard's wait must live.
    for c in read_lines(herdr_calls):
        assert "send-keys" not in c, c


def sw(status="idle", seq=1, pane="wB:p1", name="switchboard", title=None):
    a = {"agent": "claude", "agent_status": status, "state_change_seq": seq,
         "pane_id": pane, "title": title}
    if name:
        a["name"] = name
    return a


def orch(status="working", seq=1, pane="w1:p2", name="atlas"):
    return {"agent": "claude", "agent_status": status, "state_change_seq": seq,
            "pane_id": pane, "name": name, "title": None}


def watch(sh, *repos, **kw):
    rows = {"atlas": (sh.repo, "w1:p2"), "birch": (sh.repo2, "w2:p2")}
    sh.state([(r, str(rows[r][0]), rows[r][1]) for r in repos], **kw)


# Command line.

def test_help_runs_on_this_python():
    done = subprocess.run([sys.executable, str(SCRIPT), "--help"],
                          capture_output=True, text=True, timeout=30)
    assert done.returncode == 0
    assert "--once" in done.stdout and "--dry-run" in done.stdout


def test_without_once_is_a_usage_error(sh, capsys):
    assert sh.script.main(["--state-dir", str(sh.dir)]) == 2


def test_default_state_dir_is_the_switchboard_folder_from_settings(tmp_path, monkeypatch):
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"claude_dir": str(tmp_path / "profile")}))
    monkeypatch.setenv("ORCHI_SETTINGS", str(settings))
    mod = load_script()
    assert mod.DEFAULT_STATE_DIR == str(tmp_path / "profile" / "switchboard")
    assert mod.CLAUDE_CONFIG_DIR == str(tmp_path / "profile")


def test_restart_opens_the_orchi_checkout_beside_bin():
    assert load_script().ORCHI == str(SCRIPT.resolve().parent.parent)


def test_script_is_executable():
    assert os.access(SCRIPT, os.X_OK)


# The pass record.

def test_quiet_pass_logs_one_line_and_sends_nothing(sh):
    watch(sh, "atlas")
    sh.agents(sw("working"), orch("working"))
    assert sh.run()[0] == 0
    assert sh.prompts() == [] and sh.banners() == []
    (line,) = sh.log()
    assert line["switchboard"] == {"pane": "wB:p1", "status": "working"}
    assert line["actions"] == []
    assert "time" in line


def test_one_json_line_per_pass(sh):
    watch(sh, "atlas")
    sh.agents(sw("working"), orch("working"))
    for i in range(3):
        sh.run(at=T0 + i * 5 * MIN)
    assert len(sh.log()) == 3


def test_no_state_file_does_nothing_but_log(sh):
    sh.agents(orch("working"))
    assert sh.run()[0] == 0
    assert sh.herdr_calls() == [] or all(c[:2] == ["agent", "list"] for c in sh.herdr_calls())
    assert sh.banners() == []
    (line,) = sh.log()
    assert "no state file" in " ".join(line["notes"])


def test_herdr_unreachable_banners_once(sh):
    watch(sh, "atlas")
    sh.agents(sw("idle"))
    sh.fail("agent list", "server_unavailable")
    sh.run()
    assert len(sh.banners()) == 1
    assert sh.log()[-1]["errors"]
    sh.run(at=T0 + 5 * MIN)
    assert sh.banners() == []


# Check 1: the switchboard pane.

def test_switchboard_found_by_name_before_title(sh):
    watch(sh, "atlas")
    sh.agents(sw("working", pane="wX:p9", name=None, title="switchboard"),
              sw("blocked", pane="wB:p1"), orch("working"))
    sh.run()
    assert sh.log()[-1]["switchboard"] == {"pane": "wB:p1", "status": "blocked"}


def test_switchboard_found_by_title_when_no_name(sh):
    watch(sh, "atlas")
    sh.agents(sw("working", pane="wX:p9", name=None, title="switchboard"), orch("working"))
    sh.run()
    assert sh.log()[-1]["switchboard"] == {"pane": "wX:p9", "status": "working"}
    assert not any(c[:2] == ["workspace", "create"] for c in sh.herdr_calls())


def test_blocked_switchboard_banners_once_until_it_clears(sh):
    watch(sh, "atlas")
    sh.agents(sw("blocked"), orch("working"))
    sh.run()
    (msg,) = sh.banners()
    assert "blocked" in msg
    assert sh.prompts() == []
    sh.run(at=T0 + 5 * MIN)
    assert sh.banners() == []
    sh.agents(sw("working"), orch("working"))
    sh.run(at=T0 + 10 * MIN)
    assert sh.banners() == []
    sh.agents(sw("blocked"), orch("working"))
    sh.run(at=T0 + 15 * MIN)
    assert len(sh.banners()) == 1


def test_failed_banner_is_logged_and_retried(sh):
    watch(sh, "atlas")
    sh.agents(sw("blocked"), orch("working"))
    sh.notifier(3)
    sh.run()
    assert len(sh.banners()) == 1
    (action,) = [a for a in sh.log()[-1]["actions"] if a["kind"] == "banner"]
    assert action["ok"] is False and "3" in action["error"]
    sh.run(at=T0 + 5 * MIN)
    assert len(sh.banners()) == 1, "a failed banner leaves the fingerprint open"
    sh.notifier(0)
    sh.run(at=T0 + 10 * MIN)
    assert len(sh.banners()) == 1
    assert [a["ok"] for a in sh.log()[-1]["actions"]] == [True]
    sh.run(at=T0 + 15 * MIN)
    assert sh.banners() == []


def test_missing_notifier_is_a_failed_banner(sh):
    watch(sh, "atlas")
    sh.agents(sw("blocked"), orch("working"))
    sh.script.NOTIFIER = str(sh.dir / "no-such-notifier")
    sh.run()
    (action,) = sh.log()[-1]["actions"]
    assert action["kind"] == "banner" and action["ok"] is False


# Check 2: the switchboard's own cycle.

def test_cycle_marker_with_idle_switchboard_sends_three_prompts(sh):
    sh.state([("atlas", str(sh.repo), "w1:p2")], cycle=True)
    sh.agents(sw("idle"), orch("working"))
    sh.run()
    assert sh.prompts() == [("wB:p1", "/clear"), ("wB:p1", "/rename switchboard"),
                            ("wB:p1", "/switchboard resume")]


def test_cycle_rename_waits_for_clear_to_take(sh):
    sh.state([("atlas", str(sh.repo), "w1:p2")], cycle=True)
    sh.agents(sw("idle"), orch("working"))
    sh.run()
    calls = sh.herdr_calls()
    clear = calls.index(["agent", "prompt", "wB:p1", "/clear"])
    rename = calls.index(["agent", "prompt", "wB:p1", "/rename switchboard"])
    between = calls[clear + 1:rename]
    assert ["agent", "get", "wB:p1"] in between, "the new session is confirmed first"
    assert ["agent", "rename", "wB:p1", "switchboard"] in between


def test_cycle_stops_when_clear_does_not_take(sh):
    sh.state([("atlas", str(sh.repo), "w1:p2")], cycle=True)
    sh.agents(sw("idle"), orch("working"))
    sh.clear_never_takes()
    sh.run()
    assert sh.prompts() == [("wB:p1", "/clear")]
    (action,) = [a for a in sh.log()[-1]["actions"] if a["kind"] == "cycle"]
    assert action["ok"] is False and "/clear" in action["error"]


def test_cycle_that_does_not_take_is_resent_once_then_banners(sh):
    sh.state([("atlas", str(sh.repo), "w1:p2")], cycle=True)
    sh.agents(sw("idle"), orch("working"))
    sh.run()
    assert len(sh.prompts()) == 3
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompt_texts("/") == list(sh.script.CYCLE_PROMPTS), "resent once"
    assert sh.banners() == []
    sh.run(at=T0 + 10 * MIN)
    assert sh.prompts() == []
    (msg,) = sh.banners()
    assert "CYCLE 2026-10-10 18:40" in msg and "/switchboard resume" in msg
    sh.run(at=T0 + 15 * MIN)
    assert sh.prompts() == [] and sh.banners() == []


def test_cycle_resend_waits_for_idle(sh):
    sh.state([("atlas", str(sh.repo), "w1:p2")], cycle=True)
    sh.agents(sw("idle"), orch("working"))
    sh.run()
    sh.agents(sw("working"), orch("working"))
    sh.run(at=T0 + 5 * MIN)
    sh.run(at=T0 + 10 * MIN)
    assert sh.prompts() == [] and sh.banners() == []


def test_new_cycle_date_is_a_new_fingerprint(sh):
    sh.state([("atlas", str(sh.repo), "w1:p2")], cycle=True)
    sh.agents(sw("idle"), orch("working"))
    for i in range(3):
        sh.run(at=T0 + i * 5 * MIN)
    assert len(sh.banners()) == 1
    sh.state([("atlas", str(sh.repo), "w1:p2")], cycle=True, when="2026-10-10 21:15")
    sh.run(at=T0 + 15 * MIN)
    assert len(sh.prompts()) == 3


def test_cycle_marker_counts_done_as_idle(sh):
    sh.state([("atlas", str(sh.repo), "w1:p2")], cycle=True)
    sh.agents(sw("done"), orch("working"))
    sh.run()
    assert sh.prompt_texts("/") == ["/clear", "/rename switchboard", "/switchboard resume"]


def test_cycle_marker_waits_for_idle(sh):
    sh.state([("atlas", str(sh.repo), "w1:p2")], cycle=True)
    sh.agents(sw("working"), orch("working"))
    sh.run()
    assert sh.prompts() == []
    sh.agents(sw("idle"), orch("working"))
    sh.run(at=T0 + 5 * MIN)
    assert len(sh.prompts()) == 3


def held_back(sh, kind):
    return [a for line in sh.log() for a in line["actions"]
            if a["kind"] == kind and a["ok"] is None]


def test_held_back_cycle_is_logged_once(sh):
    # The switchboard is busy for hours inside its waits; one line says the
    # cycle is held back, not one line every 5 minutes.
    sh.state([("atlas", str(sh.repo), "w1:p2")], cycle=True)
    sh.agents(sw("working"), orch("working"))
    for i in range(3):
        sh.run(at=T0 + i * 5 * MIN)
    assert len(held_back(sh, "cycle")) == 1
    sh.agents(sw("idle"), orch("working"))
    sh.run(at=T0 + 15 * MIN)
    assert len(sh.prompts()) == 3


def test_held_back_check_in_is_logged_once(sh):
    watch(sh, "atlas")
    sh.wait_running()
    sh.agents(sw("blocked"), orch("idle"))
    for i in range(4):
        sh.run(at=T0 + i * 5 * MIN)
    assert len(held_back(sh, "prompt")) == 1
    sh.agents(sw("idle"), orch("idle"))
    sh.run(at=T0 + 20 * MIN)
    assert sh.prompt_texts("SWITCHBOARD HEALTH check-in") == [
        "SWITCHBOARD HEALTH check-in atlas: pane idle with no CYCLE or DONE"]
    assert sh.log()[-1]["actions"][-1]["ok"] is True


def test_check_in_held_back_again_after_it_clears_is_logged_again(sh):
    watch(sh, "atlas")
    sh.wait_running()
    sh.agents(sw("blocked"), orch("idle"))
    for i in range(3):
        sh.run(at=T0 + i * 5 * MIN)
    sh.agents(sw("blocked"), orch("working"))
    sh.run(at=T0 + 15 * MIN)
    sh.agents(sw("blocked"), orch("idle"))
    for i in range(4, 7):
        sh.run(at=T0 + i * 5 * MIN)
    assert len(held_back(sh, "prompt")) == 2


def test_cycle_marker_must_be_the_last_line(sh):
    watch(sh, "atlas")
    text = (sh.dir / "state.md").read_text()
    (sh.dir / "state.md").write_text(text.replace("## check-ins", "CYCLE 2026-10-10 18:00\n## check-ins"))
    sh.agents(sw("working"), orch("working"))
    sh.run()
    assert sh.prompts() == []
    assert not any(o["condition"].startswith("cycle") for o in sh.log()[-1]["observed"])


def test_cycle_failure_is_retried(sh):
    sh.state([("atlas", str(sh.repo), "w1:p2")], cycle=True)
    sh.agents(sw("idle"), orch("working"))
    sh.fail("agent prompt", "agent_blocked")
    sh.run()
    assert [a["ok"] for a in sh.log()[-1]["actions"]] == [False]
    sh.heal()
    sh.run(at=T0 + 5 * MIN)
    assert len(sh.prompts()) == 3


# Check 3: the waits.

def test_wait_none_with_idle_switchboard_prompts_on_the_second_pass(sh):
    watch(sh, "atlas")
    sh.agents(sw("idle"), orch("working"))
    sh.run()
    assert sh.prompts() == []
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompts() == [("wB:p1", f"SWITCHBOARD HEALTH wait-none: {sh.repo}")]
    sh.run(at=T0 + 10 * MIN)
    assert sh.prompts() == []


def test_wait_none_two_pass_count_resets_when_switchboard_works(sh):
    watch(sh, "atlas")
    sh.agents(sw("idle"), orch("working"))
    sh.run()
    sh.agents(sw("working"), orch("working"))
    sh.run(at=T0 + 5 * MIN)
    sh.agents(sw("idle"), orch("working"))
    sh.run(at=T0 + 10 * MIN)
    assert sh.prompts() == []
    sh.run(at=T0 + 15 * MIN)
    assert sh.prompt_texts("SWITCHBOARD HEALTH wait-none") == [
        f"SWITCHBOARD HEALTH wait-none: {sh.repo}"]


def test_running_wait_is_not_wait_none(sh):
    watch(sh, "atlas")
    sh.wait_running()
    sh.agents(sw("idle"), orch("working"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompts() == []


def test_wait_none_fingerprint_is_per_repo(sh):
    watch(sh, "atlas", "birch")
    sh.agents(sw("idle"), orch("working"), orch("working", pane="w2:p2", name="birch"))
    sh.run()
    sent = []
    for i in (1, 2, 3):
        sh.run(at=T0 + i * 5 * MIN)
        sent.append(sh.prompt_texts())
    assert sent == [[f"SWITCHBOARD HEALTH wait-none: {sh.repo}"],
                    [f"SWITCHBOARD HEALTH wait-none: {sh.repo2}"], []]


def test_one_prompt_per_pass_the_rest_deferred(sh):
    watch(sh, "atlas")
    sh.agents(sw("idle"), orch("idle"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompt_texts() == [f"SWITCHBOARD HEALTH wait-none: {sh.repo}"]
    (deferred,) = [a for a in sh.log()[-1]["actions"] if a["ok"] is None]
    assert deferred["text"].startswith("SWITCHBOARD HEALTH check-in atlas")
    sh.run(at=T0 + 10 * MIN)
    assert sh.prompt_texts() == ["SWITCHBOARD HEALTH check-in atlas: pane idle with no CYCLE or DONE"]


def test_failed_prompt_does_not_use_up_the_pass(sh):
    watch(sh, "atlas", "birch")
    sh.agents(sw("idle"), orch("working"), orch("working", pane="w2:p2", name="birch"))
    sh.run()
    sh.fail("agent prompt", "agent_blocked")
    sh.run(at=T0 + 5 * MIN)
    assert len(sh.prompts()) == 2, "both tried, neither landed"


# Check 4: the orchestrators.

def test_blocked_orchestrator_prompts_check_in_on_the_second_pass(sh):
    watch(sh, "atlas")
    sh.agents(sw("working"), orch("blocked"))
    sh.run()
    sh.agents(sw("idle"), orch("blocked"))
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompt_texts("SWITCHBOARD HEALTH check-in") == [
        "SWITCHBOARD HEALTH check-in atlas: pane blocked"]
    sh.run(at=T0 + 10 * MIN)
    assert sh.prompt_texts("SWITCHBOARD HEALTH check-in") == []


def test_idle_orchestrator_without_cycle_or_done_prompts_check_in(sh):
    watch(sh, "atlas")
    sh.wait_running()
    sh.agents(sw("idle"), orch("idle"))
    sh.run()
    assert sh.prompt_texts("SWITCHBOARD HEALTH check-in") == []
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompt_texts("SWITCHBOARD HEALTH check-in") == [
        "SWITCHBOARD HEALTH check-in atlas: pane idle with no CYCLE or DONE"]


OPEN_DECISION = ("## atlas-1 UPDATE 2026-10-10 18:00\nStarted.\n\n"
                 "## atlas-2 DECISION 2026-10-10 19:00\nAttempted: x\n\n")


def test_idle_orchestrator_behind_an_open_decision_is_waiting_not_stalled(sh):
    # The wait stays quiet here, so the watcher must not wake the switchboard
    # for it either: the orchestrator is waiting on Adam.
    watch(sh, "atlas")
    sh.wait_running(entries=True)
    sh.board(sh.repo, OPEN_DECISION)
    sh.agents(sw("idle"), orch("done"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompt_texts("SWITCHBOARD HEALTH check-in") == []
    observed = [o["condition"] for o in sh.log()[-1]["observed"]]
    assert not any(c.startswith("check-in:") for c in observed)


@pytest.mark.parametrize("after", [
    "ANSWERED atlas-2: b (2026-10-10 19:10)\n\n",
    "## atlas-3 UPDATE 2026-10-10 19:10\nCarrying on.\n\n",
    '## atlas-g1 GRANT 2026-10-10 19:10\nAdam: "go on"\nScope: x\n\n',
])
def test_idle_orchestrator_past_its_decision_still_prompts_check_in(sh, after):
    watch(sh, "atlas")
    sh.wait_running(entries=True)
    sh.board(sh.repo, OPEN_DECISION + after)
    sh.agents(sw("idle"), orch("idle"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompt_texts("SWITCHBOARD HEALTH check-in") == [
        "SWITCHBOARD HEALTH check-in atlas: pane idle with no CYCLE or DONE"]


def test_blocked_orchestrator_behind_an_open_decision_still_prompts(sh):
    watch(sh, "atlas")
    sh.wait_running(entries=True)
    sh.board(sh.repo, OPEN_DECISION)
    sh.agents(sw("idle"), orch("blocked"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompt_texts("SWITCHBOARD HEALTH check-in") == [
        "SWITCHBOARD HEALTH check-in atlas: pane blocked"]


@pytest.mark.parametrize("kind", ["CYCLE", "DONE"])
def test_idle_orchestrator_with_trailing_cycle_or_done_is_fine(sh, kind):
    watch(sh, "atlas")
    sh.board(sh.repo, "## atlas-1 UPDATE 2026-10-10 18:00\nStarted.\n\n"
                      f"## atlas-2 {kind} 2026-10-10 19:00\nStopping here.\n\n")
    sh.agents(sw("idle"), orch("done"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompt_texts("SWITCHBOARD HEALTH check-in") == []


def test_done_from_an_earlier_run_does_not_hide_an_idle_orchestrator(sh, tmp_path):
    # The latest entry is the DONE of the run before.
    watch(sh, "atlas")
    state = Path(sh.log_path).parent / "state.md"
    state.write_text(state.read_text().replace(
        "## check-ins", "## started\natlas 2026-10-10 23:49\n## check-ins"))
    sh.board(sh.repo, "## atlas-100 DONE 2026-10-05 19:31\nRoadmap 3 complete.\n\n")
    sh.agents(sw("idle"), orch("idle"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    observed = [o["condition"] for o in sh.log()[-1]["observed"]]
    assert "check-in:pane idle with no CYCLE or DONE" in observed


def test_check_in_waits_while_the_switchboard_is_blocked(sh):
    watch(sh, "atlas")
    sh.agents(sw("blocked"), orch("blocked"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompts() == [], "a prompt into a blocked pane would answer its prompt"
    deferred = [a for a in sh.log()[-1]["actions"] if a["kind"] == "prompt"]
    assert deferred and deferred[0]["ok"] is None
    sh.agents(sw("idle"), orch("blocked"))
    sh.run(at=T0 + 10 * MIN)
    assert sh.prompt_texts("SWITCHBOARD HEALTH check-in") == [
        "SWITCHBOARD HEALTH check-in atlas: pane blocked"]


def test_check_in_two_pass_count_resets_when_condition_clears(sh):
    watch(sh, "atlas")
    sh.wait_running()
    sh.agents(sw("idle"), orch("blocked"))
    sh.run()
    sh.agents(sw("idle"), orch("working"))
    sh.run(at=T0 + 5 * MIN)
    sh.agents(sw("idle"), orch("blocked"))
    sh.run(at=T0 + 10 * MIN)
    assert sh.prompts() == []


def test_check_in_fingerprint_reopens_after_clearing(sh):
    watch(sh, "atlas")
    sh.wait_running()
    sh.agents(sw("idle"), orch("blocked"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompt_texts("SWITCHBOARD HEALTH check-in") != []
    sh.agents(sw("idle"), orch("working"))
    sh.run(at=T0 + 10 * MIN)
    sh.agents(sw("idle"), orch("blocked"))
    sh.run(at=T0 + 15 * MIN)
    assert sh.prompt_texts("SWITCHBOARD HEALTH check-in") == []
    sh.run(at=T0 + 20 * MIN)
    assert sh.prompt_texts("SWITCHBOARD HEALTH check-in") == [
        "SWITCHBOARD HEALTH check-in atlas: pane blocked"]


def every_five(sh, first, last):
    """Passes every 5 minutes from minute `first` to `last`, both included.
    Returns the prompts and banners of each, as {minute: (prompts, banners)}."""
    seen = {}
    for m in range(first, last + 1, 5):
        sh.run(at=T0 + m * MIN)
        seen[m] = (sh.prompt_texts(), sh.banners())
    return seen


def test_stall_prompts_and_banners_after_sixty_minutes(sh):
    watch(sh, "atlas")
    sh.wait_running()
    sh.agents(sw("idle"), orch("working", seq=7))
    seen = every_five(sh, 0, 70)
    assert all(seen[m] == ([], []) for m in range(0, 60, 5))
    prompts, banners = seen[60]
    assert prompts == ["SWITCHBOARD HEALTH stall atlas: 60 min with no change"]
    (msg,) = banners
    assert "atlas" in msg
    assert seen[65] == seen[70] == ([], [])


def test_stall_clock_restarts_when_seq_moves(sh):
    watch(sh, "atlas")
    sh.wait_running()
    sh.agents(sw("idle"), orch("working", seq=7))
    every_five(sh, 0, 25)
    sh.agents(sw("idle"), orch("working", seq=8))
    seen = every_five(sh, 30, 90)
    assert all(seen[m][0] == [] for m in range(30, 90, 5))
    assert seen[90][0] == ["SWITCHBOARD HEALTH stall atlas: 60 min with no change"]


def test_stall_clock_restarts_when_switchboard_file_changes(sh):
    watch(sh, "atlas")
    sh.wait_running()
    sh.agents(sw("idle"), orch("working", seq=7))
    every_five(sh, 0, 25)
    board = sh.repo / ".legwork" / "switchboard.md"
    with open(board, "a") as f:
        f.write("## atlas-2 UPDATE 2026-10-10 19:00\nStill going.\n\n")
    os.utime(board, (T0 + 1000, T0 + 1000))
    seen = every_five(sh, 30, 90)
    assert all(seen[m][0] == [] for m in range(30, 90, 5))
    assert len(seen[90][0]) == 1


def test_stall_prompt_and_banner_go_to_a_busy_switchboard(sh):
    # The switchboard is "working" inside its wait nearly all the time; the
    # prompt queues and lands when the wait returns (probe d).
    watch(sh, "atlas")
    sh.agents(sw("working"), orch("working", seq=7))
    seen = every_five(sh, 0, 60)
    assert seen[60][0] == ["SWITCHBOARD HEALTH stall atlas: 60 min with no change"]
    assert len(seen[60][1]) == 1
    sh.run(at=T0 + 65 * MIN)
    assert sh.prompts() == [] and sh.banners() == []


def test_stall_prompt_waits_while_the_switchboard_is_blocked(sh):
    watch(sh, "atlas")
    sh.agents(sw("blocked"), orch("working", seq=7))
    seen = every_five(sh, 0, 60)
    assert seen[60][0] == []
    sh.agents(sw("idle"), orch("working", seq=7))
    sh.wait_running()
    sh.run(at=T0 + 65 * MIN)
    assert sh.prompt_texts() == ["SWITCHBOARD HEALTH stall atlas: 65 min with no change"]


def test_check_in_goes_to_a_busy_switchboard(sh):
    watch(sh, "atlas")
    sh.wait_running()
    sh.agents(sw("working"), orch("idle"))
    sh.run()
    assert sh.prompts() == []
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompts() == [
        ("wB:p1", "SWITCHBOARD HEALTH check-in atlas: pane idle with no CYCLE or DONE")]
    sh.run(at=T0 + 10 * MIN)
    assert sh.prompts() == []


def test_one_prompt_per_pass_to_a_busy_switchboard(sh):
    watch(sh, "atlas", "birch")
    sh.wait_running()
    sh.agents(sw("working"), orch("idle"), orch("idle", pane="w2:p2", name="birch"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert len(sh.prompts()) == 1
    sh.run(at=T0 + 10 * MIN)
    assert len(sh.prompts()) == 1


def test_no_check_in_to_a_busy_switchboard_with_a_cycle_marker(sh):
    # It is about to cycle; a queued check-in would land at the old context.
    sh.state([("atlas", str(sh.repo), "w1:p2")], cycle=True)
    sh.wait_running()
    sh.agents(sw("working"), orch("idle"))
    for i in range(3):
        sh.run(at=T0 + i * 5 * MIN)
        assert sh.prompts() == []


def test_wait_none_is_never_sent_to_a_busy_switchboard(sh):
    # A busy switchboard may be starting its wait; only an idle one has none.
    watch(sh, "atlas")
    sh.agents(sw("working"), orch("working"))
    for i in range(3):
        sh.run(at=T0 + i * 5 * MIN)
        assert sh.prompt_texts("SWITCHBOARD HEALTH wait-none") == []


# A long gap between passes: the Mac slept, or launchd did not run.

def test_stall_clock_restarts_after_a_long_gap(sh):
    watch(sh, "atlas")
    sh.wait_running()
    sh.agents(sw("idle"), orch("working", seq=7))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    sh.run(at=T0 + 65 * MIN)
    assert sh.prompts() == [] and sh.banners() == [], "asleep is not stalled"
    assert any("gap" in n for n in sh.log()[-1]["notes"])
    for m in range(75, 125, 10):
        sh.run(at=T0 + m * MIN)
        assert sh.prompts() == []
    sh.run(at=T0 + 125 * MIN)
    assert sh.prompt_texts() == ["SWITCHBOARD HEALTH stall atlas: 60 min with no change"]


def test_two_pass_count_restarts_after_a_long_gap(sh):
    watch(sh, "atlas")
    sh.wait_running()
    sh.agents(sw("idle"), orch("blocked"))
    sh.run()
    sh.run(at=T0 + 30 * MIN)
    assert sh.prompts() == []
    sh.run(at=T0 + 35 * MIN)
    assert sh.prompt_texts() == ["SWITCHBOARD HEALTH check-in atlas: pane blocked"]


def test_fifteen_minutes_is_not_a_gap(sh):
    watch(sh, "atlas")
    sh.wait_running()
    sh.agents(sw("idle"), orch("blocked"))
    sh.run()
    sh.run(at=T0 + 15 * MIN)
    assert sh.prompt_texts() == ["SWITCHBOARD HEALTH check-in atlas: pane blocked"]


def test_gap_keeps_sent_fingerprints(sh):
    watch(sh, "atlas")
    sh.agents(sw("blocked"), orch("working"))
    sh.run()
    sh.run(at=T0 + 60 * MIN)
    assert sh.banners() == [], "blocked banner already sent, and asleep is not stalled"


# Decision 10: restarting a dead switchboard.

def restart_calls(sh):
    """Every herdr call that is not a read."""
    return [c for c in sh.herdr_calls() if c[:2] not in (["agent", "list"], ["agent", "get"])]


def test_missing_switchboard_is_restarted(sh, capsys):
    watch(sh, "atlas")
    sh.agents(orch("working"))
    sh.run()
    calls = restart_calls(sh)
    assert calls[0] == ["workspace", "create", "--cwd", "/orchi", "--label", "switchboard",
                        "--env", "CLAUDE_CONFIG_DIR=/profile",
                        "--env", "DISABLE_AUTO_UPDATE=true", "--no-focus"]
    assert calls[1] == ["pane", "rename", "wS:p1", "switchboard"]
    start = calls[2]
    assert start[:6] == ["agent", "start", "switchboard", "--kind", "claude", "--pane"]
    assert start[6] == "wS:p1"
    assert start[-5:] == ["--", "--model", "opus", "--effort", "high"]
    assert sh.prompts() == [("wS:p1", "/rename switchboard"), ("wS:p1", "/switchboard resume")]
    (action,) = [a for a in sh.log()[-1]["actions"] if a["kind"] == "restart"]
    assert action["ok"] is True and action["pane"] == "wS:p1"
    assert sh.banners() == []


def test_no_restart_when_watching_nothing(sh):
    sh.state([])
    sh.agents(orch("working"))
    sh.run()
    assert restart_calls(sh) == [] and sh.banners() == []
    assert any("watches nothing" in n for n in sh.log()[-1]["notes"])
    assert not sh.log()[-1]["actions"]


def test_no_restart_without_a_state_file(sh):
    sh.agents(orch("working"))
    sh.run()
    assert restart_calls(sh) == []


def test_watching_nothing_still_banners_a_blocked_switchboard(sh):
    sh.state([])
    sh.agents(sw("blocked"))
    sh.run()
    assert len(sh.banners()) == 1


def test_restart_at_most_once_an_hour_then_banner(sh):
    watch(sh, "atlas")
    sh.agents(orch("working"))
    sh.run()
    sh.run(at=T0 + 10 * MIN)
    assert restart_calls(sh) == [], "no second restart inside the hour"
    (msg,) = sh.banners()
    assert "No restart before" in msg
    sh.run(at=T0 + 20 * MIN)
    assert restart_calls(sh) == [] and sh.banners() == []
    sh.run(at=T0 + 61 * MIN)
    assert restart_calls(sh)[0][:2] == ["workspace", "create"], "the next hour may try again"


def test_restart_agent_not_ready_banners_and_does_not_retry(sh):
    watch(sh, "atlas")
    sh.agents(orch("working"))
    sh.fail("agent start", "agent_not_ready")
    sh.run()
    (action,) = [a for a in sh.log()[-1]["actions"] if a["kind"] == "restart"]
    assert action["ok"] is False and "agent_not_ready" in action["error"]
    assert sh.prompts() == []
    (msg,) = sh.banners()
    assert "No retry this hour" in msg
    sh.run(at=T0 + 30 * MIN)
    assert restart_calls(sh) == [] and sh.banners() == []


def test_first_restart_failure_is_logged_without_banner(sh):
    watch(sh, "atlas")
    sh.agents(orch("working"))
    sh.fail("workspace create", "server_error")
    sh.run()
    (action,) = [a for a in sh.log()[-1]["actions"] if a["kind"] == "restart"]
    assert action["ok"] is False
    assert sh.banners() == []
    sh.run(at=T0 + 5 * MIN)
    assert restart_calls(sh) == []
    assert len(sh.banners()) == 1


def test_restart_banner_retried_when_notifier_fails(sh):
    watch(sh, "atlas")
    sh.agents(orch("working"))
    sh.fail("agent start", "agent_not_ready")
    sh.notifier(3)
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert len(sh.banners()) == 1
    assert restart_calls(sh) == []


def test_restart_window_clears_when_switchboard_returns(sh):
    watch(sh, "atlas")
    sh.agents(orch("working"))
    sh.fail("agent start", "agent_not_ready")
    sh.run()
    sh.heal()
    sh.agents(sw("working"), orch("working"))
    sh.run(at=T0 + 5 * MIN)
    sh.agents(orch("working"))
    sh.run(at=T0 + 10 * MIN)
    assert restart_calls(sh) == [], "still the same hour"
    assert len(sh.banners()) == 1, "a new outage, a new banner"


# Switching itself off when there is nothing to watch.

def test_watching_nothing_on_two_passes_switches_the_watcher_off(sh):
    sh.state([])
    sh.agents(sw("idle"))
    sh.run()
    assert sh.ctl_calls() == []
    sh.run(at=T0 + 5 * MIN)
    assert sh.ctl_calls() == [["off"]]
    assert {"kind": "self-off"} in sh.log()[-1]["actions"]
    assert len(sh.log()) == 2, "the pass is logged before the watcher goes"


def test_no_state_file_counts_as_watching_nothing(sh):
    sh.agents(orch("working"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.ctl_calls() == [["off"]]


def test_switchboard_missing_and_watching_nothing_switches_off(sh):
    sh.state([])
    sh.agents(orch("working"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.ctl_calls() == [["off"]]
    assert restart_calls(sh) == []


def test_herdr_unreachable_and_watching_nothing_still_switches_off(sh):
    sh.state([])
    sh.fail("agent list", "server_unavailable")
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.ctl_calls() == [["off"]]


def test_a_watched_project_restarts_the_count(sh):
    sh.state([])
    sh.agents(sw("working"), orch("working"))
    sh.run()
    watch(sh, "atlas")
    sh.run(at=T0 + 5 * MIN)
    sh.state([])
    sh.run(at=T0 + 10 * MIN)
    assert sh.ctl_calls() == []
    sh.run(at=T0 + 15 * MIN)
    assert sh.ctl_calls() == [["off"]]


def test_never_switches_off_while_watching(sh):
    watch(sh, "atlas")
    sh.agents(sw("working"), orch("working"))
    for i in range(4):
        sh.run(at=T0 + i * 5 * MIN)
        assert sh.ctl_calls() == []


def test_cycle_marker_is_not_watching_nothing(sh):
    sh.state([], cycle=True)
    sh.agents(sw("working"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.ctl_calls() == []


def test_long_gap_restarts_the_off_count(sh):
    sh.state([])
    sh.agents(sw("idle"))
    sh.run()
    sh.run(at=T0 + 60 * MIN)
    assert sh.ctl_calls() == []
    sh.run(at=T0 + 65 * MIN)
    assert sh.ctl_calls() == [["off"]]


def test_count_starts_again_after_switching_off(sh):
    sh.state([])
    sh.agents(sw("idle"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.ctl_calls() == [["off"]]
    sh.run(at=T0 + 10 * MIN)
    assert sh.ctl_calls() == [], "switched on again: one empty pass is not enough"


def test_dry_run_never_switches_off(sh, capsys):
    sh.state([])
    sh.agents(sw("idle"))
    sh.run()
    before = sh.state_path.read_text()
    rc, out = sh.run("--dry-run", at=T0 + 5 * MIN, capsys=capsys)
    assert "would switch the health watcher off" in out
    assert sh.ctl_calls() == []
    assert sh.state_path.read_text() == before


# --dry-run.

def test_dry_run_prints_and_sends_nothing(sh, capsys):
    sh.state([("atlas", str(sh.repo), "w1:p2")], cycle=True)
    sh.agents(sw("idle"), orch("blocked"))
    rc, out = sh.run("--dry-run", capsys=capsys)
    assert rc == 0
    assert "would prompt wB:p1: /clear" in out
    assert sh.prompts() == [] and sh.banners() == []
    assert not sh.log_path.exists() and not sh.state_path.exists()


def test_dry_run_restart_and_banner_send_nothing(sh, capsys):
    watch(sh, "atlas")
    sh.agents(orch("working"))
    rc, out = sh.run("--dry-run", capsys=capsys)
    assert "would restart the switchboard" in out
    assert restart_calls(sh) == [] and sh.banners() == []
    sh.agents(sw("blocked"), orch("working"))
    rc, out = sh.run("--dry-run", capsys=capsys)
    assert "would banner" in out
    assert sh.banners() == []


def test_dry_run_leaves_two_pass_state_alone(sh, capsys):
    watch(sh, "atlas")
    sh.agents(sw("idle"), orch("working"))
    sh.run()
    before = sh.state_path.read_text()
    sh.run("--dry-run", at=T0 + 5 * MIN, capsys=capsys)
    assert sh.state_path.read_text() == before
    assert len(sh.log()) == 1


# Robustness.

def test_last_restart_survives_a_crash(sh, monkeypatch):
    watch(sh, "atlas")
    sh.agents(orch("working"))
    real = sh.script.restart

    def boom():
        raise RuntimeError("herdr went away mid-restart")

    monkeypatch.setattr(sh.script, "restart", boom)
    with pytest.raises(RuntimeError):
        sh.run()
    monkeypatch.setattr(sh.script, "restart", real)
    sh.run(at=T0 + 5 * MIN)
    assert restart_calls(sh) == [], "the crash must not reset the hourly cap"
    assert "No restart before" in sh.banners()[0]


@pytest.mark.parametrize("bad", [12, None, "-rf", "--help", ""])
def test_bad_switchboard_pane_id_is_never_passed_to_herdr(sh, bad):
    sh.state([("atlas", str(sh.repo), "w1:p2")], cycle=True)
    sh.agents(sw("idle", pane=bad), orch("working"))
    assert sh.run()[0] == 0
    assert sh.prompts() == []
    assert any("pane id" in e for e in sh.log()[-1]["errors"])


def test_bad_orchestrator_pane_id_skips_that_repo_only(sh):
    sh.state([("atlas", str(sh.repo), "--help"), ("birch", str(sh.repo2), "w2:p2")])
    sh.wait_running()
    sh.agents(sw("idle"), orch("blocked", pane="w2:p2", name="birch"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompt_texts() == ["SWITCHBOARD HEALTH check-in birch: pane blocked"]
    assert not any("--help" in c for c in sh.herdr_calls())
    assert any("pane id" in e for e in sh.log()[-1]["errors"])


def test_bad_root_pane_from_workspace_create_stops_the_restart(sh):
    watch(sh, "atlas")
    sh.agents(orch("working"))
    sh.root_pane(["wS:p1"])
    sh.run()
    (action,) = [a for a in sh.log()[-1]["actions"] if a["kind"] == "restart"]
    assert action["ok"] is False
    assert not any(c[:2] == ["agent", "start"] for c in sh.herdr_calls())


def test_one_failing_repo_check_does_not_stop_the_pass(sh, monkeypatch):
    watch(sh, "atlas", "birch")
    sh.agents(sw("idle"), orch("working"), orch("blocked", pane="w2:p2", name="birch"))
    real = sh.script.wait_status

    def flaky(repo, pane):
        if repo == str(sh.repo):
            raise ValueError("unreadable board")
        return ["pane blocked", "wait running since 18:00 (pid 4242)"], None

    monkeypatch.setattr(sh.script, "wait_status", flaky)
    assert sh.run()[0] == 0
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompt_texts() == ["SWITCHBOARD HEALTH check-in birch: pane blocked"]
    (err,) = sh.log()[-1]["errors"]
    assert "unreadable board" in err and str(sh.repo) in err
    monkeypatch.setattr(sh.script, "wait_status", real)


# Paused projects: idle on purpose.

def test_a_paused_project_gets_no_check_in(sh):
    watch(sh, "atlas", paused=["atlas"])
    sh.agents(sw("working"), orch("idle"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompts() == []
    assert sh.log()[-1]["observed"] == []


def test_a_paused_project_blocked_gets_no_check_in(sh):
    watch(sh, "atlas", paused=["atlas"])
    sh.agents(sw("working"), orch("blocked"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompts() == []


def test_a_paused_project_is_not_wait_none(sh):
    watch(sh, "atlas", paused=["atlas"])
    sh.agents(sw("idle"), orch("idle"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompts() == []


def test_a_paused_project_gets_no_stall(sh):
    watch(sh, "atlas", paused=["atlas"])
    sh.agents(sw("working"), orch("working"))
    every_five(sh, 0, 70)
    assert sh.prompts() == [] and sh.banners() == []


def test_only_the_paused_project_is_left_out(sh):
    watch(sh, "atlas", "birch", paused=["atlas"])
    sh.agents(sw("working"), orch("idle"), orch("idle", pane="w2:p2", name="birch"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompt_texts() == ["SWITCHBOARD HEALTH check-in birch: pane idle with no CYCLE or DONE"]


def test_a_stall_clock_starts_fresh_after_a_pause(sh):
    watch(sh, "atlas")
    sh.agents(sw("working"), orch("working"))
    every_five(sh, 0, 30)
    watch(sh, "atlas", paused=["atlas"])
    sh.run(at=T0 + 35 * MIN)
    watch(sh, "atlas")
    every_five(sh, 40, 75)
    assert sh.prompts() == []


def test_a_paused_project_still_counts_as_watching(sh):
    watch(sh, "atlas", paused=["atlas"])
    sh.agents(sw("idle"), orch("idle"))
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.ctl_calls() == []


def test_a_paused_project_still_gets_its_switchboard_restarted(sh):
    watch(sh, "atlas", paused=["atlas"])
    sh.agents(orch("idle"))
    sh.run()
    assert [a for a in sh.log()[-1]["actions"] if a["kind"] == "restart"]


# The lock, before any restart.

def test_a_live_lock_stops_a_restart(sh):
    watch(sh, "atlas")
    sh.lock()
    sh.agents(orch("working"), orch("working", pane="wZ:p1", name="elsewhere"))
    sh.run()
    assert restart_calls(sh) == []
    assert sh.banners() == []
    assert not sh.state_path.read_text().count("last_restart")
    assert any("terminal wZ:p1" in n for n in sh.log()[-1]["notes"])


def test_a_lock_that_cannot_be_checked_stops_a_restart(sh):
    watch(sh, "atlas")
    sh.lock()
    sh.agents(orch("working"))
    sh.fail("agent get", "server_broken")
    sh.run()
    assert restart_calls(sh) == []
    assert any("server_broken" in n for n in sh.log()[-1]["notes"])


def test_a_dead_lock_is_replaced_by_the_restart(sh):
    watch(sh, "atlas")
    sh.lock("wGone:p1")
    sh.agents(orch("working"))
    sh.run()
    assert restart_calls(sh)[0][:2] == ["workspace", "create"]
    lock = sh.read_lock()
    assert (lock["terminal"], lock["herdr"]) == ("wS:p1", "terminal")


def test_a_restart_takes_the_lock_before_claude_starts(sh):
    watch(sh, "atlas")
    sh.agents(orch("working"))
    seen = {}
    real = sh.script.herdr

    def spy(*args, **kw):
        if args[:2] == ("agent", "start"):
            seen["lock"] = sh.read_lock()["terminal"]
        return real(*args, **kw)

    sh.script.herdr = spy
    sh.run()
    assert seen == {"lock": "wS:p1"}


def test_a_restart_in_the_app_says_so_in_the_lock(sh, monkeypatch):
    monkeypatch.setenv("ORCHI_HERDR", "app")
    watch(sh, "atlas")
    sh.agents(orch("working"))
    sh.run()
    assert sh.read_lock()["herdr"] == "app"


def test_a_lock_taken_during_the_restart_closes_the_new_pane(sh, monkeypatch):
    watch(sh, "atlas")
    sh.agents(orch("working"))
    taken = types.SimpleNamespace(holder=lambda path: None,
                                  take=lambda path, pane, herdr: "switchboard is running somewhere else")
    monkeypatch.setattr(sh.script, "load_lock", lambda: taken)
    sh.run()
    assert ["pane", "close", "wS:p1"] in sh.herdr_calls()
    assert not any(c[:2] == ["agent", "start"] for c in sh.herdr_calls())
    (action,) = [a for a in sh.log()[-1]["actions"] if a["kind"] == "restart"]
    assert action["ok"] is False and "somewhere else" in action["error"]


def test_no_lock_read_while_the_switchboard_is_there(sh):
    watch(sh, "atlas")
    sh.lock("wGone:p1")
    sh.agents(sw("working"), orch("working"))
    sh.run()
    assert not any(c == ["agent", "get", "wGone:p1"] for c in sh.herdr_calls())


def test_dry_run_with_a_live_lock_restarts_nothing(sh, capsys):
    watch(sh, "atlas")
    sh.lock()
    sh.agents(orch("working"), orch("working", pane="wZ:p1", name="elsewhere"))
    _, out = sh.run("--dry-run", capsys=capsys)
    assert "would restart" not in out


# /clear in the Herdr app, which reports no session id.

# The shape of a real status line, with the agent list that can sit below it.
LINE = "   model:  Opus 5.5  -  high  context:  {} {}%   0  cache hit:  turn:100.0%\n"
BELOW = "  \u23f5\u23f5 auto mode on\n\n  \u23fa main\n  \u25ef general-purpose  Running\n"
BUSY = "reply\n" + LINE.format("\u2593\u2593\u2593\u2591\u2591\u2591\u2591", "33.5") + BELOW
CLEARED = LINE.format("\u2591\u2591\u2591\u2591\u2591\u2591\u2591", "0.0") + BELOW


def test_cycle_in_the_app_is_confirmed_by_the_context_figure(sh):
    sh.state([("atlas", str(sh.repo), "w1:p2")], cycle=True)
    sh.agents(sw("idle"), orch("working"))
    sh.app_screen(BUSY, CLEARED)
    sh.run()
    assert sh.prompts() == [("wB:p1", "/clear"), ("wB:p1", "/rename switchboard"),
                            ("wB:p1", "/switchboard resume")]
    calls = sh.herdr_calls()
    clear = calls.index(["agent", "prompt", "wB:p1", "/clear"])
    assert ["agent", "read", "wB:p1", "--source", "visible"] in calls[clear + 1:]


def test_cycle_in_the_app_stops_when_the_figure_never_reaches_zero(sh):
    sh.state([("atlas", str(sh.repo), "w1:p2")], cycle=True)
    sh.agents(sw("idle"), orch("working"))
    sh.app_screen(BUSY, BUSY)
    sh.run()
    assert sh.prompts() == [("wB:p1", "/clear")]
    (action,) = [a for a in sh.log()[-1]["actions"] if a["kind"] == "cycle"]
    assert action["ok"] is False and "/clear" in action["error"]


def test_cycle_in_the_app_takes_the_last_figure_on_the_screen(sh):
    sh.state([("atlas", str(sh.repo), "w1:p2")], cycle=True)
    sh.agents(sw("idle"), orch("working"))
    sh.app_screen(BUSY, CLEARED + BUSY)
    sh.run()
    assert sh.prompts() == [("wB:p1", "/clear")]


def test_cycle_with_no_session_and_no_figure_sends_nothing(sh):
    sh.state([("atlas", str(sh.repo), "w1:p2")], cycle=True)
    sh.agents(sw("idle"), orch("working"))
    sh.app_screen("no status line here\n")
    sh.run()
    assert sh.prompts() == []
    (action,) = [a for a in sh.log()[-1]["actions"] if a["kind"] == "cycle"]
    assert action["ok"] is False and "cannot be confirmed" in action["error"]


def test_a_session_id_is_still_what_counts_where_there_is_one(sh):
    sh.state([("atlas", str(sh.repo), "w1:p2")], cycle=True)
    sh.agents(sw("idle"), orch("working"))
    sh.run()
    assert not any(c[:2] == ["agent", "read"] for c in sh.herdr_calls())


# ACTION entries wait on Adam, as DECISION entries do.

ACTION = "## atlas-2 ACTION 2026-10-10 18:10\nWhy: x\nDo: y\nWhere: z\n\n"


def test_idle_orchestrator_behind_an_open_action_is_waiting_not_stalled(sh):
    watch(sh, "atlas")
    sh.agents(sw("working"), orch("idle"))
    sh.board(sh.repo, ACTION)
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompts() == []


def test_idle_orchestrator_past_an_answered_action_still_prompts(sh):
    watch(sh, "atlas")
    sh.agents(sw("working"), orch("idle"))
    sh.board(sh.repo, ACTION + "ANSWERED atlas-2: completed: yes (2026-10-10 18:20)\n")
    sh.run()
    sh.run(at=T0 + 5 * MIN)
    assert sh.prompt_texts("SWITCHBOARD HEALTH check-in atlas")
