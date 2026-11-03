"""Tests for bin/herdr-adapter, the app side of the herdr wrapper.

hc and herdr-app are replaced by stubs on PATH that read their terminals from a
JSON file and record every call. Their replies are copied from real output, read
on 2026-10-30. Calls go through bin/herdr, so the choice of path is exercised too.
"""
import importlib.machinery
import importlib.util
import json
import os
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
BIN = HERE.parent
WRAPPER = BIN / "herdr"

STUB_HC = r"""#!/usr/bin/env python3
import json, os, sys
state_file = os.environ["STUB_STATE"]
state = json.load(open(state_file))
args = sys.argv[1:]
with open(os.environ["STUB_CALLS"], "a") as f:
    f.write(json.dumps(["hc"] + args) + "\n")
if state.get("hc_broken"):
    print(json.dumps({"error": {"kind": "connection", "message": "no server"}}), file=sys.stderr)
    sys.exit(1)
if state.get("hc_garbled"):
    print("not json")
    sys.exit(0)
command, rest = args[0], [a for a in args[1:] if a != "--json"]
terminals = state["terminals"]

def save():
    with open(state_file, "w") as f:
        json.dump(state, f)

def find(target):
    for t in terminals:
        if target in (t["address"], t.get("name")):
            return t
    print(json.dumps({"error": {"hint": "see `hc ls --all`", "kind": "not_found",
                                "message": f'no terminal "{target}"'}}), file=sys.stderr)
    sys.exit(3)

def advance(t):
    # A queue of later states, one taken on each get, stands in for time passing.
    queue = t.get("queue")
    if queue:
        t.update(queue.pop(0))
        save()

if command == "ls":
    rows = []
    for t in terminals:
        status = t.get("status") or {}
        row = {"address": t["address"], "agent": status.get("app", "sh"), "cwd": t.get("cwd"),
               "state": t.get("state", "live"), "turn": t.get("turn", 0)}
        if status.get("state"):
            row["status"] = status["state"]
        if t.get("name"):
            row["name"] = t["name"]
        rows.append(row)
    print(json.dumps({"hidden_finished": 0, "machines": [], "terminals": rows}))
elif command == "get":
    t = find(rest[0])
    advance(t)
    print(json.dumps({k: v for k, v in t.items() if k not in ("text", "history", "queue")}))
elif command == "read":
    if state.get("read_broken"):
        print(json.dumps({"error": {"kind": "io", "message": "cannot read"}}), file=sys.stderr)
        sys.exit(1)
    lines = rest[rest.index("--lines") + 1] if "--lines" in rest else None
    t = find(rest[-1] if lines is None or rest[0] == "--lines" else rest[0])
    text = t.get("text", "")
    if lines:
        text = t.get("history", "") + text
    print(json.dumps({"complete": True, "how": "screen", "text": text}))
elif command == "send":
    t = find(rest[0])
    if state.get("send_broken"):
        print(json.dumps({"error": {"kind": "blocked", "message": "cannot send"}}), file=sys.stderr)
        sys.exit(1)
    text = rest[rest.index("--") + 1]
    # Real hc tags text from a terminal, and Claude Code then won't run a slash command.
    caller = os.environ.get("HC_TERMINAL_ID")
    t.setdefault("sent", []).append(f'<hc from="{caller}">{text}</hc>' if caller else text)
    if t.get("after_send"):
        t.update(t["after_send"])
    save()
    print(json.dumps({"address": t["address"]}))
elif command == "keys":
    t = find(rest[0])
    t.setdefault("keys", []).extend(rest[1:])
    save()
    print(json.dumps({"address": t["address"]}))
elif command == "run":
    split = rest.index("--")
    flags, argv = rest[:split], rest[split + 1:]
    if state.get("run_broken"):
        print(json.dumps({"error": {"kind": "spawn_failed", "message": "cannot start"}}), file=sys.stderr)
        sys.exit(1)
    cwd = flags[flags.index("--cwd") + 1]
    labels = dict(flags[i + 1].split("=", 1) for i, flag in enumerate(flags) if flag == "--label")
    terminals.append({"address": "t90", "argv": argv, "cwd": cwd, "flags": flags, "labels": labels,
                      "state": "live", "after_send": state.get("started_with")})
    save()
    print(json.dumps({"address": "t90", "agent": "env", "cwd": cwd, "state": "live", "turn": 0}))
elif command == "label":
    t = find(rest[0])
    for pair in rest[1:]:
        k, _, v = pair.partition("=")
        t.setdefault("labels", {})[k] = v
    save()
    print(json.dumps({"address": t["address"], "labels": t["labels"]}))
else:
    print(json.dumps({"error": {"kind": "usage", "message": command}}), file=sys.stderr)
    sys.exit(2)
"""

STUB_APP = r"""#!/usr/bin/env python3
import json, os, sys
state_file = os.environ["STUB_STATE"]
state = json.load(open(state_file))
args = sys.argv[1:]
with open(os.environ["STUB_CALLS"], "a") as f:
    f.write(json.dumps(["herdr-app"] + args) + "\n")
if state.get("app_broken"):
    print(json.dumps({"error": "unknown command"}))
    sys.exit(1)
if args == ["ls"]:
    print(json.dumps({"spaces": state.get("spaces", [{"id": "spc1", "machine": None, "tabs": []}])}))
    sys.exit(0)
command, body = args[1], json.loads(args[2])
if command == "tab.rename":
    # A labelled terminal's tab appears a moment after the terminal does.
    if state.get("tab_late", 0) > 0:
        state["tab_late"] -= 1
        with open(state_file, "w") as f:
            json.dump(state, f)
        print(json.dumps({"error": f'no tab "{body["id"]}"'}))
        sys.exit(1)
    state.setdefault("tab_names", {})[body["id"]] = body["name"]
    with open(state_file, "w") as f:
        json.dump(state, f)
    print(json.dumps({"ok": True}))
elif command == "terminal.kill":
    # The real one returns before the terminal has ended. "lingers" keeps it for its queue.
    state["terminals"] = [t for t in state["terminals"]
                          if t["address"] != body["terminal"] or t.get("lingers")]
    with open(state_file, "w") as f:
        json.dump(state, f)
    print("{}")
"""

STUB_REAL = """#!/bin/sh
echo real "$@"
printf '%s\\n' "$*" >> "$STUB_REAL_CALLS"
"""


def term(address, status="idle", **extra):
    """A terminal as `hc get` shows one, with a Claude Code session in it."""
    t = {"address": address, "argv": ["/bin/zsh"], "cwd": "/Users/x/Projects", "keep": True,
         "foreground": {"argv": ["claude"], "cwd": "/Users/x/Projects/repo", "name": "claude.exe"},
         "labels": {"herdr.space": "spc1", "herdr.tab": "tb1", "where": "Repo / 1"},
         "name": None, "state": "live", "title": "", "turn": 7, "status_ms": 100}
    if status is not None:
        t["status"] = {"app": "claude-code", "msg": "", "state": status}
    else:
        t["status"] = None
        t["foreground"] = None
    t.update(extra)
    return t


class Bed:
    def __init__(self, tmp_path):
        self.tmp = tmp_path
        self.state = tmp_path / "state.json"
        self.calls = tmp_path / "calls.jsonl"
        self.real_calls = tmp_path / "real.txt"
        stubs = tmp_path / "stubs"
        stubs.mkdir()
        for name, text in (("hc", STUB_HC), ("herdr-app", STUB_APP), ("real-herdr", STUB_REAL)):
            path = stubs / name
            path.write_text(text)
            path.chmod(0o755)
        self.real = stubs / "real-herdr"
        self.path = f"{stubs}{os.pathsep}{os.environ['PATH']}"
        self.app_bin = tmp_path / "app-bin"
        self.app_bin.mkdir()
        launcher = self.app_bin / "herdr"
        launcher.write_text("#!/bin/sh\n")
        launcher.chmod(0o755)
        self.write({"terminals": [term("t4")]})

    def write(self, state):
        self.state.write_text(json.dumps(state))

    def settings(self, value):
        (self.tmp / "settings.json").write_text(json.dumps(value))

    def terminals(self, *terminals):
        self.write({"terminals": list(terminals)})

    def read(self):
        return json.loads(self.state.read_text())

    def terminal(self, address):
        return next(t for t in self.read()["terminals"] if t["address"] == address)

    def env(self, **extra):
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("HC_", "HERDR_", "ORCHI_"))}
        env.update({"PATH": self.path, "HC_TERMINAL_ID": "t4", "ORCHI_HERDR_REAL": str(self.real),
                    "ORCHI_APP_BIN": str(self.app_bin),
                    "STUB_STATE": str(self.state), "STUB_CALLS": str(self.calls),
                    "STUB_REAL_CALLS": str(self.real_calls),
                    "ORCHI_SETTINGS": str(self.tmp / "settings.json"),
                    "HERDR_APP_HOME": str(self.tmp / "herdr-app")})
        env.update(extra)
        return env

    def run(self, *args, cwd=None, env=None):
        return subprocess.run([str(WRAPPER), *args], capture_output=True, text=True,
                              timeout=30, cwd=cwd, env=self.env(**(env or {})))

    def ok(self, *args, **kw):
        done = self.run(*args, **kw)
        assert done.returncode == 0, done.stderr
        return done

    def result(self, *args, **kw):
        return json.loads(self.ok(*args, **kw).stdout)["result"]

    def error(self, *args, **kw):
        done = self.run(*args, **kw)
        assert done.returncode == 1, (done.stdout, done.stderr)
        assert done.stdout == ""
        return json.loads(done.stderr)

    def seen(self):
        if not self.calls.exists():
            return []
        return [json.loads(l) for l in self.calls.read_text().splitlines()]

    def real_ran(self):
        return self.real_calls.exists()


@pytest.fixture
def bed(tmp_path):
    return Bed(tmp_path)


def load(path, name):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


# agent list and agent get


def test_agent_list_keeps_live_local_agents(bed):
    bed.terminals(term("t4"), term("t7", "working"), term("win/t1"),
                  term("t8", None), term("t9", "done", state="exited"))
    agents = bed.result("agent", "list")["agents"]
    assert [a["pane_id"] for a in agents] == ["t4", "t7"]
    assert not bed.real_ran()


def test_agent_reply_has_herdr_shape(bed):
    bed.terminals(term("t7", "working", title="Some work", turn=12))
    done = bed.ok("agent", "get", "t7")
    reply = json.loads(done.stdout)
    assert reply["id"] == "cli:agent:get"
    agent = reply["result"]["agent"]
    assert agent["agent"] == "claude"
    assert agent["agent_status"] == "working"
    assert agent["pane_id"] == agent["terminal_id"] == "t7"
    assert agent["workspace_id"] == "spc1"
    assert agent["tab_id"] == "tb1"
    assert agent["state_change_seq"] == 12
    assert agent["cwd"] == "/Users/x/Projects"
    assert agent["foreground_cwd"] == "/Users/x/Projects/repo"
    assert agent["title"] == agent["terminal_title_stripped"] == "Some work"
    assert "name" not in agent


@pytest.mark.parametrize("state", ["idle", "working", "blocked", "done"])
def test_agent_status_passes_through(bed, state):
    bed.terminals(term("t7", state))
    assert bed.result("agent", "get", "t7")["agent"]["agent_status"] == state


def test_an_unknown_status_reads_unknown(bed):
    bed.terminals(term("t7", "thinking hard"))
    assert bed.result("agent", "get", "t7")["agent"]["agent_status"] == "unknown"


def test_a_name_comes_from_orchi_name(bed):
    labels = {"herdr.space": "s", "orchi.name": "orch-birch"}
    bed.terminals(term("t7", labels=labels, title="Claude Code"))
    agent = bed.result("agent", "list")["agents"][0]
    assert agent["name"] == agent["title"] == "orch-birch"
    assert agent["terminal_title"] == "Claude Code"


def test_a_name_comes_from_hc_when_there_is_no_label(bed):
    bed.terminals(term("t7", name="fw-one"))
    assert bed.result("agent", "list")["agents"][0]["name"] == "fw-one"


def test_agent_get_finds_an_hc_name(bed):
    bed.terminals(term("t7", name="fw-one"))
    assert bed.result("agent", "get", "fw-one")["agent"]["pane_id"] == "t7"


def test_agent_get_finds_a_label(bed):
    bed.terminals(term("t4"), term("t7", labels={"orchi.name": "orch-birch"}))
    assert bed.result("agent", "get", "orch-birch")["agent"]["pane_id"] == "t7"


def test_agent_get_finds_a_title(bed):
    bed.terminals(term("t7", title="orch-birch"))
    assert bed.result("agent", "get", "orch-birch")["agent"]["pane_id"] == "t7"


def test_a_name_beats_a_title(bed):
    bed.terminals(term("t7", title="orch-birch"), term("t8", labels={"orchi.name": "orch-birch"}))
    assert bed.result("agent", "get", "orch-birch")["agent"]["pane_id"] == "t8"


def test_an_unknown_agent_is_agent_not_found(bed):
    assert bed.error("agent", "get", "nobody") == {
        "error": {"code": "agent_not_found", "message": "agent target nobody not found"},
        "id": "cli:agent:get"}


def test_a_finished_terminal_is_agent_not_found(bed):
    bed.terminals(term("t7", state="exited"))
    assert bed.error("agent", "get", "t7")["error"]["code"] == "agent_not_found"


def test_a_shell_is_not_an_agent(bed):
    bed.terminals(term("t7", None))
    assert bed.error("agent", "get", "t7")["error"]["code"] == "agent_not_found"


def test_a_machine_address_is_not_found(bed):
    bed.terminals(term("win/t1"))
    assert bed.error("agent", "get", "win/t1")["error"]["code"] == "agent_not_found"
    assert bed.seen() == []


@pytest.mark.parametrize("target", ["-x", "--json", "a b", "", "a\nb"])
def test_a_bad_target_never_reaches_hc(bed, target):
    assert bed.run("agent", "read", "--lines", "1", "--", target).returncode == 1
    assert bed.seen() == []


@pytest.mark.parametrize("fault", ["hc_broken", "hc_garbled"])
def test_an_hc_failure_is_not_a_gone_agent(bed, fault):
    # switchboard-wait reads agent_not_found as a pane that has gone.
    bed.write({"terminals": [], fault: True})
    assert bed.error("agent", "get", "t7")["error"]["code"] == "hc_failed"
    assert bed.error("agent", "list")["error"]["code"] == "hc_failed"


def test_a_missing_hc_is_not_a_gone_agent(bed):
    done = bed.run("agent", "get", "t7", env={"PATH": "/usr/bin:/bin"})
    assert done.returncode == 1
    assert json.loads(done.stderr)["error"]["code"] == "hc_failed"


# pane current


def test_pane_current_is_this_terminal(bed):
    bed.terminals(term("t4", title="Here"), term("t7"))
    reply = json.loads(bed.ok("pane", "current").stdout)
    assert reply["id"] == "cli:pane:current"
    assert reply["result"]["type"] == "pane_current"
    pane = reply["result"]["pane"]
    assert pane["pane_id"] == "t4"
    assert pane["workspace_id"] == "spc1"
    assert pane["terminal_title"] == "Here"


def test_pane_current_takes_current_and_pane(bed):
    bed.terminals(term("t4"), term("t7"))
    assert bed.result("pane", "current", "--current")["pane"]["pane_id"] == "t4"
    assert bed.result("pane", "current", "--pane", "t7")["pane"]["pane_id"] == "t7"


def test_pane_current_shows_a_shell(bed):
    bed.terminals(term("t4", None))
    assert bed.result("pane", "current")["pane"]["agent_status"] == "unknown"


def test_pane_current_shows_the_name_a_session_checks(bed):
    bed.terminals(term("t4", labels={"orchi.name": "orch-birch"}))
    assert bed.result("pane", "current")["pane"]["title"] == "orch-birch"


def test_pane_current_with_no_terminal(bed):
    env = {"HC_TERMINAL_ID": "", "ORCHI_HERDR": "app"}
    assert bed.error("pane", "current", env=env)["error"]["code"] == "pane_not_found"


# agent read and pane read

SCREEN = "row one\nrow two\nrow three\n\n"
HISTORY = "old one\nold two\n"


def test_read_visible_takes_the_last_lines(bed):
    bed.terminals(term("t7", text=SCREEN, history=HISTORY))
    assert bed.ok("agent", "read", "t7", "--source", "visible", "--lines", "2").stdout == \
        "row two\nrow three\n"
    assert ["hc", "read", "--json", "t7"] in bed.seen()


def test_read_visible_with_no_limit_is_the_whole_screen(bed):
    bed.terminals(term("t7", text=SCREEN, history=HISTORY))
    assert bed.ok("agent", "read", "t7", "--source", "visible").stdout == \
        "row one\nrow two\nrow three\n"


@pytest.mark.parametrize("source", ["recent", "recent-unwrapped"])
def test_read_recent_reaches_into_history(bed, source):
    bed.terminals(term("t7", text=SCREEN, history=HISTORY))
    assert bed.ok("agent", "read", "t7", "--source", source, "--lines", "4").stdout == \
        "old two\nrow one\nrow two\nrow three\n"


def test_read_defaults_to_recent(bed):
    bed.terminals(term("t7", text=SCREEN, history=HISTORY))
    assert bed.ok("agent", "read", "t7", "--lines", "4").stdout.startswith("old two\n")


def test_read_an_empty_screen(bed):
    bed.terminals(term("t7", text=""))
    assert bed.ok("agent", "read", "t7").stdout == ""


def test_pane_read_works_on_a_shell(bed):
    bed.terminals(term("t7", None, text="$ \n"))
    assert bed.ok("pane", "read", "t7", "--lines", "5").stdout == "$ \n"


def test_agent_read_refuses_a_shell(bed):
    bed.terminals(term("t7", None, text="$ \n"))
    assert bed.error("agent", "read", "t7")["error"]["code"] == "agent_not_found"


def test_pane_read_of_nothing_is_pane_not_found(bed):
    assert bed.error("pane", "read", "t99")["error"]["code"] == "pane_not_found"


@pytest.mark.parametrize("args", [
    ["agent", "read", "t4", "--ansi"],
    ["agent", "read", "t4", "--format", "ansi"],
    ["agent", "read", "t4", "--source", "detection"],
    ["agent", "read", "t4", "--lines", "many"],
    ["agent", "read", "t4", "--lines"],
    ["agent", "read"],
    ["agent", "get"],
    ["agent", "get", "t4", "t7"],
])
def test_usage_errors(bed, args):
    assert bed.error(*args)["error"]["code"] == "usage"


# Anything else


@pytest.mark.parametrize("args", [
    ["workspace", "list"],
    ["agent", "focus", "t4"],
    ["pane", "split", "t4"],
    ["server", "stop"],
    ["agent"],
    ["--machine", "box", "agent", "list"],
])
def test_an_unmapped_call_never_reaches_terminal_herdr(bed, args):
    assert bed.error(*args)["error"]["code"] == "not_mapped"
    assert not bed.real_ran()


@pytest.mark.parametrize("args", [[], ["--help"], ["-h"], ["--version"], ["-V"], ["--skill"]])
def test_questions_about_herdr_itself_reach_it(bed, args):
    assert bed.ok(*args).stdout == " ".join(["real", *args]) + "\n"
    assert bed.seen() == []


# Sending


def test_prompt_sends_text_and_returns_the_agent(bed):
    bed.terminals(term("t7"))
    reply = json.loads(bed.ok("agent", "prompt", "t7", "SWITCHBOARD ANSWER birch-1: a").stdout)
    assert reply["id"] == "cli:agent:prompt"
    assert reply["result"]["agent"]["pane_id"] == "t7"
    assert bed.terminal("t7")["sent"] == ["SWITCHBOARD ANSWER birch-1: a"]


def test_prompt_is_sent_without_an_hc_tag(bed):
    # A tagged /rename is answered as text, not run (seen in a real session),
    # and hc's manual says to read a tagged message as a child's report.
    bed.terminals(term("t7"))
    bed.ok("agent", "prompt", "t7", "/rename orch-birch")
    assert bed.terminal("t7")["sent"] == ["/rename orch-birch"]


def test_prompt_finds_a_named_agent(bed):
    bed.terminals(term("t7", labels={"orchi.name": "fw-one"}))
    bed.ok("agent", "prompt", "fw-one", "/clear")
    assert bed.terminal("t7")["sent"] == ["/clear"]


def test_prompt_text_after_a_separator_stays_text(bed):
    bed.terminals(term("t7"))
    bed.ok("agent", "prompt", "t7", "--", "--wait for it")
    assert bed.terminal("t7")["sent"] == ["--wait for it"]


def test_prompt_to_nobody_sends_nothing(bed):
    assert bed.error("agent", "prompt", "t99", "hello")["error"]["code"] == "agent_not_found"
    assert not [c for c in bed.seen() if c[1] == "send"]


def test_prompt_to_a_blocked_agent_sends_nothing(bed):
    # Enter would land on the approval or question it is waiting at.
    bed.terminals(term("t7", "blocked"))
    assert bed.error("agent", "prompt", "t7", "hello")["error"]["code"] == "agent_blocked"
    assert "sent" not in bed.terminal("t7")


# A half-typed line in the prompt. Put in terminal leaves one to be read first, and a send
# would run it with the text joined on (seen in a real session).


def test_prompt_sets_a_half_typed_line_aside_first(bed):
    bed.terminals(term("t7", text="\u276f half typed\n"))
    bed.ok("agent", "prompt", "t7", "SWITCHBOARD PAUSE")
    t = bed.terminal("t7")
    assert t["keys"] == ["ctrl+s"]
    assert t["sent"] == ["SWITCHBOARD PAUSE"]
    assert [c[1] for c in bed.seen() if c[1] in ("read", "keys", "send")] == ["read", "keys", "send"]


def test_prompt_leaves_a_held_stash_alone(bed):
    # Ctrl+S would bring it back to be joined on, or a line typed over it would replace it.
    screen = "output\n                       \u203a stashed\n\u276f half typed\n"
    bed.terminals(term("t7", text=screen))
    bed.ok("agent", "prompt", "t7", "SWITCHBOARD PAUSE")
    assert "keys" not in bed.terminal("t7")
    assert bed.terminal("t7")["sent"] == ["SWITCHBOARD PAUSE"]


def test_prompt_is_not_fooled_by_the_word_stashed_in_the_transcript(bed):
    bed.terminals(term("t7", text="I stashed the change\n> stashed\n\u276f \n"))
    bed.ok("agent", "prompt", "t7", "hello")
    assert bed.terminal("t7")["keys"] == ["ctrl+s"]


def test_prompt_presses_nothing_in_a_shell_that_keeps_a_stale_status(bed):
    # A shell freezes on Ctrl+S.
    bed.terminals(term("t7", foreground={"argv": ["/bin/zsh"], "cwd": "/", "name": "zsh"}))
    bed.ok("agent", "prompt", "t7", "hello")
    assert "keys" not in bed.terminal("t7")
    assert bed.terminal("t7")["sent"] == ["hello"]


def test_prompt_to_a_blocked_agent_presses_nothing(bed):
    bed.terminals(term("t7", "blocked"))
    bed.error("agent", "prompt", "t7", "hello")
    assert "keys" not in bed.terminal("t7")


def test_prompt_still_sends_when_the_screen_cannot_be_read(bed):
    bed.write({"terminals": [term("t7")], "read_broken": True})
    bed.ok("agent", "prompt", "t7", "hello")
    assert "keys" not in bed.terminal("t7")
    assert bed.terminal("t7")["sent"] == ["hello"]


def test_a_failed_prompt_puts_the_line_back(bed):
    bed.write({"terminals": [term("t7")], "send_broken": True})
    assert bed.error("agent", "prompt", "t7", "hello")["error"]["code"] == "hc_failed"
    assert bed.terminal("t7")["keys"] == ["ctrl+s", "ctrl+s"]


def test_a_failed_prompt_with_nothing_set_aside_presses_nothing(bed):
    screen = "\u203a stashed\n"
    bed.write({"terminals": [term("t7", text=screen)], "send_broken": True})
    bed.error("agent", "prompt", "t7", "hello")
    assert "keys" not in bed.terminal("t7")


def test_a_start_types_into_the_shell_with_no_ctrl_s(bed):
    bed.write({"terminals": [term("t7", None)], "started_with": None})
    bed.run("agent", "start", "orch-birch", "--kind", "claude", "--pane", "t7", "--timeout", "100")
    assert "keys" not in bed.terminal("t7")


def test_prompt_needs_a_target_and_text(bed):
    assert bed.error("agent", "prompt", "t4")["error"]["code"] == "usage"


def test_prompt_wait_ignores_the_state_from_before_the_send(bed):
    bed.terminals(term("t7", "idle", turn=7, status_ms=100, queue=[
        {},
        {"status": {"app": "claude-code", "state": "working"}, "status_ms": 200},
        {"status": {"app": "claude-code", "state": "idle"}, "status_ms": 300, "turn": 8},
    ]))
    result = bed.result("agent", "prompt", "t7", "go", "--wait", "--until", "idle",
                        "--timeout", "20000")
    assert result["agent"]["state_change_seq"] == 8


def test_prompt_wait_settles_on_a_command_that_starts_no_turn(bed):
    # /low-priority changes nothing hc reports, so the wait has to end anyway.
    bed.terminals(term("t7", "idle"))
    assert bed.result("agent", "prompt", "t7", "/low-priority", "--wait", "--until", "idle",
                      "--timeout", "20000")["agent"]["agent_status"] == "idle"


def test_prompt_wait_times_out(bed):
    bed.terminals(term("t7", "working"))
    err = bed.error("agent", "prompt", "t7", "go", "--wait", "--until", "idle",
                    "--timeout", "300")
    assert err["error"]["code"] == "timeout"


def test_wait_returns_on_a_stopped_agent(bed):
    bed.terminals(term("t7", "done"))
    reply = json.loads(bed.ok("agent", "wait", "t7", "--timeout", "1000").stdout)
    assert reply["id"] == "cli:agent:wait"
    assert reply["result"]["agent"]["agent_status"] == "done"


def test_wait_waits_for_a_change(bed):
    bed.terminals(term("t7", "working", queue=[
        {}, {"status": {"app": "claude-code", "state": "blocked"}}]))
    result = bed.result("agent", "wait", "t7", "--timeout", "20000")
    assert result["agent"]["agent_status"] == "blocked"


def test_wait_until_working(bed):
    bed.terminals(term("t7", "done", queue=[
        {}, {"status": {"app": "claude-code", "state": "working"}}]))
    result = bed.result("agent", "wait", "t7", "--until", "working", "--timeout", "20000")
    assert result["agent"]["agent_status"] == "working"


def test_wait_takes_several_states(bed):
    bed.terminals(term("t7", "blocked"))
    result = bed.result("agent", "wait", "t7", "--until", "idle", "--until", "blocked",
                        "--timeout", "1000")
    assert result["agent"]["agent_status"] == "blocked"


def test_wait_timeout_matches_herdr(bed):
    bed.terminals(term("t7", "working"))
    assert bed.error("agent", "wait", "t7", "--timeout", "100") == {
        "error": {"code": "timeout", "message": "timed out waiting for agent status"},
        "id": "cli:agent:wait"}


def test_wait_notices_a_terminal_that_goes(bed):
    bed.terminals(term("t7", "working", queue=[{}, {"state": "exited"}]))
    err = bed.error("agent", "wait", "t7", "--timeout", "20000")
    assert err["error"]["code"] == "agent_not_found"


def test_wait_refuses_an_unknown_state(bed):
    bed.terminals(term("t7"))
    err = bed.error("agent", "wait", "t7", "--until", "asleep", "--timeout", "100")
    assert err["error"]["code"] == "usage"


def test_send_keys(bed):
    bed.terminals(term("t7", labels={"orchi.name": "fw-one"}))
    bed.ok("agent", "send-keys", "fw-one", "enter", "ctrl+c")
    assert bed.terminal("t7")["keys"] == ["enter", "ctrl+c"]


@pytest.mark.parametrize("key", ["a b", "!", "$(x)"])
def test_send_keys_refuses_an_odd_key(bed, key):
    bed.terminals(term("t7"))
    assert bed.error("agent", "send-keys", "t7", key)["error"]["code"] == "usage"
    assert not [c for c in bed.seen() if c[1] == "keys"]


@pytest.mark.parametrize("group", ["agent", "pane"])
def test_rename_sets_the_label(bed, group):
    bed.terminals(term("t7"))
    bed.ok(group, "rename", "t7", "orch-birch")
    assert bed.terminal("t7")["labels"]["orchi.name"] == "orch-birch"
    assert bed.result("agent", "get", "orch-birch")["agent"]["pane_id"] == "t7"


@pytest.mark.parametrize("name", ["two words", "a=b", "-x", ""])
def test_rename_refuses_an_odd_name(bed, name):
    bed.terminals(term("t7"))
    assert bed.error("pane", "rename", "t7", "--", name)["error"]["code"] == "usage"
    assert not [c for c in bed.seen() if c[1] == "label"]


def test_pane_rename_of_nothing(bed):
    assert bed.error("pane", "rename", "t99", "x")["error"]["code"] == "pane_not_found"


READY = {"status": {"app": "claude-code", "state": "idle"}}


def test_start_names_the_terminal_and_types_the_command(bed):
    bed.terminals(term("t7", None, after_send=READY))
    result = bed.result("agent", "start", "fw-one", "--kind", "claude", "--pane", "t7",
                        "--timeout", "20000", "--", "--model", "sonnet", "--effort", "low")
    assert result["agent"]["name"] == "fw-one"
    assert result["agent"]["agent_status"] == "idle"
    t = bed.terminal("t7")
    assert t["sent"] == [f'HERDR_ENV=1 PATH={bed.app_bin}:"$PATH" claude --model sonnet --effort low']
    assert t["labels"]["orchi.name"] == "fw-one"
    kinds = [c[1] for c in bed.seen() if c[1] in ("label", "send")]
    assert kinds == ["label", "send"]


def test_start_quotes_its_arguments(bed):
    bed.terminals(term("t7", None, after_send=READY))
    bed.ok("agent", "start", "fw-one", "--kind", "claude", "--pane", "t7", "--",
           "--append", "a b; rm -rf x", "$(id)")
    assert bed.terminal("t7")["sent"] == [
        f"""HERDR_ENV=1 PATH={bed.app_bin}:"$PATH" claude --append 'a b; rm -rf x' '$(id)'"""]


def test_start_quotes_the_launcher_folder(bed):
    folder = bed.tmp / "a b"
    folder.mkdir()
    launcher = folder / "herdr"
    launcher.write_text("#!/bin/sh\n")
    launcher.chmod(0o755)
    bed.terminals(term("t7", None, after_send=READY))
    bed.ok("agent", "start", "fw-one", "--kind", "claude", "--pane", "t7",
           env={"ORCHI_APP_BIN": str(folder)})
    assert bed.terminal("t7")["sent"] == [f"""HERDR_ENV=1 PATH='{folder}':"$PATH" claude"""]


def test_start_runs_the_agent_under_the_profile_the_settings_set(bed):
    bed.settings({"claude_dir": "~/.claude-alt/"})
    bed.terminals(term("t7", None, after_send=READY))
    bed.ok("agent", "start", "fw-one", "--kind", "claude", "--pane", "t7", "--", "--model", "sonnet",
           env={"HOME": str(bed.tmp)})
    assert bed.terminal("t7")["sent"] == [
        f'HERDR_ENV=1 PATH={bed.app_bin}:"$PATH" CLAUDE_CONFIG_DIR={bed.tmp}/.claude-alt claude --model sonnet']


def test_start_quotes_the_profile_folder(bed):
    bed.settings({"claude_dir": "/p q/it's"})
    bed.terminals(term("t7", None, after_send=READY))
    bed.ok("agent", "start", "fw-one", "--kind", "claude", "--pane", "t7")
    assert bed.terminal("t7")["sent"] == [
        f"""HERDR_ENV=1 PATH={bed.app_bin}:"$PATH" CLAUDE_CONFIG_DIR='/p q/it'"'"'s' claude"""]


def test_start_with_no_profile_set_leaves_the_shells_own(bed):
    bed.settings({"claude_dir": "  ", "worker_limit": 3})
    bed.terminals(term("t7", None, after_send=READY))
    bed.ok("agent", "start", "fw-one", "--kind", "claude", "--pane", "t7", env={"CLAUDE_CONFIG_DIR": "/env"})
    assert bed.terminal("t7")["sent"] == [f'HERDR_ENV=1 PATH={bed.app_bin}:"$PATH" claude']


def test_start_refuses_when_the_launcher_is_missing(bed):
    # The agent would reach real herdr from an app terminal, which is the wrong one.
    (bed.app_bin / "herdr").unlink()
    bed.terminals(term("t7", None, after_send=READY))
    err = bed.error("agent", "start", "fw-one", "--kind", "claude", "--pane", "t7")
    assert err["error"]["code"] == "no_launcher"
    assert "sent" not in bed.terminal("t7")


def test_start_waits_for_claude_to_report(bed):
    bed.terminals(term("t7", None, queue=[{}, {}, READY]))
    result = bed.result("agent", "start", "fw-one", "--kind", "claude", "--pane", "t7",
                        "--timeout", "20000")
    assert result["agent"]["agent"] == "claude"


def test_start_times_out(bed):
    bed.terminals(term("t7", None))
    err = bed.error("agent", "start", "fw-one", "--kind", "claude", "--pane", "t7",
                    "--timeout", "200")
    assert err["error"]["code"] == "timeout"


def test_start_fails_on_a_blocked_agent(bed):
    # A trust dialog, which herdr also reports as a failed start.
    bed.terminals(term("t7", None, after_send={
        "status": {"app": "claude-code", "state": "blocked"}}))
    err = bed.error("agent", "start", "fw-one", "--kind", "claude", "--pane", "t7",
                    "--timeout", "20000")
    assert err["error"]["code"] == "agent_blocked"


def test_start_never_types_into_a_running_agent(bed):
    bed.terminals(term("t7", "idle"))
    err = bed.error("agent", "start", "fw-one", "--kind", "claude", "--pane", "t7")
    assert err["error"]["code"] == "pane_busy"
    assert not [c for c in bed.seen() if c[1] in ("send", "label")]


def test_start_refuses_another_kind(bed):
    bed.terminals(term("t7", None))
    err = bed.error("agent", "start", "x", "--kind", "codex", "--pane", "t7")
    assert err["error"]["code"] == "usage"
    assert not [c for c in bed.seen() if c[1] == "send"]


def test_start_needs_a_pane(bed):
    err = bed.error("agent", "start", "x", "--kind", "claude")
    assert err["error"]["code"] == "usage"


def test_send_text_presses_keys_without_enter(bed):
    # hc send always presses Enter, which is wrong for answering a y/n question.
    bed.terminals(term("t7", None))
    bed.ok("pane", "send-text", "t7", "n")
    t = bed.terminal("t7")
    assert t["keys"] == ["n"]
    assert "sent" not in t


def test_send_text_refuses_what_keys_cannot_type(bed):
    bed.terminals(term("t7", None))
    err = bed.error("pane", "send-text", "t7", "two words")
    assert err["error"]["code"] == "not_mapped"
    assert not [c for c in bed.seen() if c[1] == "keys"]


def test_pane_close_ends_the_terminal_through_the_app(bed):
    bed.terminals(term("t4"), term("t7", labels={"orchi.name": "fw-one"}))
    bed.ok("pane", "close", "fw-one")
    assert ["herdr-app", "do", "terminal.kill", json.dumps({"terminal": "t7"})] in bed.seen()
    assert [t["address"] for t in bed.read()["terminals"]] == ["t4"]


def test_pane_close_of_nothing_kills_nothing(bed):
    assert bed.error("pane", "close", "t99")["error"]["code"] == "pane_not_found"
    assert not [c for c in bed.seen() if c[0] == "herdr-app"]


def test_an_app_failure_is_reported(bed):
    bed.write({"terminals": [term("t7")], "app_broken": True})
    assert bed.error("pane", "close", "t7")["error"]["code"] == "app_failed"


def test_pane_close_waits_for_the_terminal_to_end(bed):
    # terminal.kill returns first: a list right after still showed the terminal.
    bed.terminals(term("t7", lingers=True, queue=[{}, {}, {}, {"state": "finished"}]))
    bed.ok("pane", "close", "t7")
    assert bed.terminal("t7")["state"] == "finished"


def test_pane_close_says_so_when_a_terminal_will_not_end(bed):
    bed.terminals(term("t7", lingers=True))
    assert bed.error("pane", "close", "t7")["error"]["code"] == "timeout"


def test_wait_until_idle_does_not_accept_done(bed):
    # Real herdr times out the same way on a done pane.
    bed.terminals(term("t7", "done"))
    err = bed.error("agent", "wait", "t7", "--until", "idle", "--timeout", "100")
    assert err["error"]["code"] == "timeout"


# Tabs


def open_tab(bed, *extra, **kw):
    return bed.run("tab", "create", "--cwd", "/Users/x/Projects/repo", "--label", "orch-one",
                   *extra, **kw)


def runs(bed):
    return [c for c in bed.seen() if c[:2] == ["hc", "run"]]


def test_tab_create_opens_a_tab_in_the_callers_space(bed):
    done = open_tab(bed, "--no-focus")
    assert done.returncode == 0, done.stderr
    result = json.loads(done.stdout)["result"]
    tab = result["tab"]["tab_id"]
    assert tab.startswith("tb")
    assert result["tab"]["workspace_id"] == "spc1"
    assert result["root_pane"] == {"pane_id": "t90", "terminal_id": "t90"}
    opened = bed.terminal("t90")
    assert opened["cwd"] == "/Users/x/Projects/repo"
    assert opened["labels"] == {"herdr.space": "spc1", "herdr.tab": tab}
    assert bed.read()["tab_names"] == {tab: "orch-one"}


def test_tab_create_leaves_the_window_alone(bed):
    assert open_tab(bed).returncode == 0
    assert [c[2] for c in bed.seen() if c[0] == "herdr-app"] == ["tab.rename"]


def test_tab_create_outlives_the_session_that_opened_it(bed):
    assert open_tab(bed).returncode == 0
    flags = bed.terminal("t90")["flags"]
    for flag in ("--bg", "--keep", "--no-parent", "--outlive-parent"):
        assert flag in flags


def test_each_tab_gets_its_own_id(bed):
    first = json.loads(open_tab(bed).stdout)["result"]["tab"]["tab_id"]
    second = json.loads(open_tab(bed).stdout)["result"]["tab"]["tab_id"]
    assert first != second


def test_tab_create_runs_the_shell_with_its_environment(bed):
    assert open_tab(bed, "--env", "A=1", "--env", "B=two words", env={"SHELL": "/bin/zsh"}) \
        .returncode == 0
    assert bed.terminal("t90")["argv"] == ["/usr/bin/env", "A=1", "B=two words", "/bin/zsh"]


def test_tab_create_with_no_environment_runs_the_shell_alone(bed):
    assert open_tab(bed, env={"SHELL": "/bin/fish"}).returncode == 0
    assert bed.terminal("t90")["argv"] == ["/bin/fish"]


def test_tab_create_with_no_label_keeps_the_tab_number(bed):
    assert bed.run("tab", "create", "--cwd", "/x").returncode == 0
    assert "tab_names" not in bed.read()


def test_tab_create_waits_for_the_tab_to_appear(bed):
    bed.write({"terminals": [term("t4")], "tab_late": 2})
    assert open_tab(bed).returncode == 0
    assert list(bed.read()["tab_names"].values()) == ["orch-one"]


def test_tab_create_ends_the_terminal_when_the_tab_never_appears(bed):
    bed.write({"terminals": [term("t4")], "tab_late": 10000})
    done = open_tab(bed)
    assert json.loads(done.stderr)["error"]["code"] == "app_failed"
    assert ["herdr-app", "do", "terminal.kill", json.dumps({"terminal": "t90"})] in bed.seen()


def test_tab_create_reports_a_terminal_that_will_not_start(bed):
    bed.write({"terminals": [term("t4")], "run_broken": True})
    assert json.loads(open_tab(bed).stderr)["error"]["code"] == "hc_failed"


def test_tab_create_with_no_space_starts_nothing(bed):
    bed.terminals(term("t4", labels={}))
    assert json.loads(open_tab(bed).stderr)["error"]["code"] == "no_space"
    assert runs(bed) == []


@pytest.mark.parametrize("pair", ["NOVALUE", "=x", "-i=1", "A B=1", "A=one\ntwo"])
def test_tab_create_refuses_an_odd_environment_setting(bed, pair):
    assert json.loads(open_tab(bed, "--env", pair).stderr)["error"]["code"] == "usage"
    assert runs(bed) == []


@pytest.mark.parametrize("extra", [["--focus"], ["--workspace", "spc1"]])
def test_tab_create_refuses_what_could_move_the_window(bed, extra):
    assert json.loads(open_tab(bed, *extra).stderr)["error"]["code"] == "usage"
    assert runs(bed) == []


def test_tab_create_needs_a_folder(bed):
    assert bed.error("tab", "create", "--label", "x")["error"]["code"] == "usage"


# workspace create, what the health watcher restarts a switchboard with


def watcher(**extra):
    """The launch agent's environment: no terminal, and ORCHI_HERDR says which Herdr."""
    return {"HC_TERMINAL_ID": "", "ORCHI_HERDR": "app", **extra}


def open_workspace(bed, *extra):
    return bed.run("workspace", "create", "--cwd", "/orchi", "--label", "switchboard",
                   "--env", "CLAUDE_CONFIG_DIR=/profile", "--env", "DISABLE_AUTO_UPDATE=true",
                   *extra, env=watcher())


LOCAL = {"id": "spc2", "machine": None, "active": False, "tabs": []}
REMOTE = {"id": "spc9", "machine": "win", "active": True, "tabs": []}


def test_workspace_create_opens_a_labelled_tab_in_the_first_space(bed):
    bed.write({"terminals": [], "spaces": [LOCAL, {**LOCAL, "id": "spc3", "active": True}]})
    done = open_workspace(bed, "--no-focus")
    assert done.returncode == 0, done.stderr
    result = json.loads(done.stdout)["result"]
    tab = result["tab"]["tab_id"]
    assert result["workspace"]["workspace_id"] == "spc2"
    assert result["root_pane"] == {"pane_id": "t90", "terminal_id": "t90"}
    opened = bed.terminal("t90")
    assert opened["cwd"] == "/orchi"
    assert opened["labels"] == {"herdr.space": "spc2", "herdr.tab": tab}
    assert bed.read()["tab_names"] == {tab: "switchboard"}


def test_workspace_create_skips_another_machines_space(bed):
    bed.write({"terminals": [], "spaces": [REMOTE, LOCAL]})
    assert open_workspace(bed).returncode == 0
    assert bed.terminal("t90")["labels"]["herdr.space"] == "spc2"


def test_workspace_create_runs_the_shell_with_its_environment(bed):
    open_workspace(bed)
    argv = bed.terminal("t90")["argv"]
    assert argv[:3] == ["/usr/bin/env", "CLAUDE_CONFIG_DIR=/profile", "DISABLE_AUTO_UPDATE=true"]


def test_workspace_create_leaves_the_window_alone(bed):
    open_workspace(bed)
    commands = [c[2] for c in bed.seen() if c[:2] == ["herdr-app", "do"]]
    assert commands == ["tab.rename"], "tab.new and space.new take focus"


def test_workspace_create_outlives_the_watcher(bed):
    open_workspace(bed)
    flags = bed.terminal("t90")["flags"]
    assert {"--bg", "--keep", "--no-parent", "--outlive-parent"} <= set(flags)


def test_workspace_create_with_no_local_space_starts_nothing(bed):
    bed.write({"terminals": [], "spaces": [REMOTE]})
    done = open_workspace(bed)
    assert done.returncode == 1
    assert json.loads(done.stderr)["error"]["code"] == "no_space"
    assert runs(bed) == []


def test_workspace_create_with_the_window_closed_starts_nothing(bed):
    bed.write({"terminals": [], "app_broken": True})
    done = open_workspace(bed)
    assert done.returncode == 1
    assert json.loads(done.stderr)["error"]["code"] == "app_failed"
    assert runs(bed) == []


def test_workspace_create_ends_the_terminal_when_the_tab_never_appears(bed):
    bed.write({"terminals": [], "tab_late": 999})
    assert open_workspace(bed).returncode == 1
    assert [t for t in bed.read()["terminals"] if t["address"] == "t90"] == []


@pytest.mark.parametrize("args", [["--focus"], ["--workspace", "spc9"], ["extra"]])
def test_workspace_create_refuses_what_it_does_not_map(bed, args):
    assert open_workspace(bed, *args).returncode == 1
    assert runs(bed) == []


def test_workspace_create_needs_a_folder(bed):
    assert bed.error("workspace", "create", "--label", "x")["error"]["code"] == "usage"


# Worktrees


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@t", *args],
                          capture_output=True, text=True, check=True).stdout


@pytest.fixture
def repo(tmp_path):
    path = tmp_path / "repo"
    path.mkdir()
    git(path, "init", "-q", "-b", "main")
    (path / "file").write_text("one\n")
    git(path, "add", "file")
    git(path, "commit", "-qm", "first")
    return path


def create(bed, repo, *extra, slug="one"):
    return bed.run("worktree", "create", "--cwd", str(repo), "--branch", f"fanout/{slug}",
                   "--base", "main", "--path", f"{repo}-wt/{slug}", "--label", f"fw-{slug}",
                   "--no-focus", "--trust-repository", *extra)


def branches(repo):
    return git(repo, "branch", "--format=%(refname:short)").split()


def test_worktree_create_opens_a_tab_in_the_callers_space(bed, repo):
    done = create(bed, repo)
    assert done.returncode == 0, done.stderr
    result = json.loads(done.stdout)["result"]
    path = f"{repo}-wt/one"
    assert result["root_pane"]["pane_id"] == "t90"
    assert result["workspace"]["workspace_id"] == path
    assert (Path(path) / "file").exists()
    assert "fanout/one" in branches(repo)
    opened = bed.terminal("t90")
    assert opened["cwd"] == path
    assert opened["labels"]["herdr.space"] == "spc1"
    assert opened["labels"]["herdr.tab"] == result["tab"]["tab_id"]
    assert bed.read()["tab_names"] == {result["tab"]["tab_id"]: "fw-one"}


def test_worktree_create_never_uses_tab_new(bed, repo):
    # tab.new selects the tab and takes focus, even in a space that isn't shown.
    assert create(bed, repo).returncode == 0
    assert "tab.new" not in [c[2] for c in bed.seen() if c[0] == "herdr-app"]


def test_worktree_create_refuses_focus(bed, repo):
    assert json.loads(create(bed, repo, "--focus").stderr)["error"]["code"] == "usage"
    assert not Path(f"{repo}-wt/one").exists()


def test_worktree_create_with_no_space_creates_nothing(bed, repo):
    # A guessed space would be whichever one the user is looking at.
    bed.terminals(term("t4", labels={}))
    assert json.loads(create(bed, repo).stderr)["error"]["code"] == "no_space"
    assert not Path(f"{repo}-wt/one").exists()
    assert branches(repo) == ["main"]


def test_worktree_create_cleans_up_when_the_tab_fails(bed, repo):
    bed.write({"terminals": [term("t4")], "app_broken": True})
    assert json.loads(create(bed, repo).stderr)["error"]["code"] == "app_failed"
    assert not Path(f"{repo}-wt/one").exists()
    assert branches(repo) == ["main"]
    assert "one" not in git(repo, "worktree", "list")


def test_worktree_create_cleans_up_when_the_tab_never_starts(bed, repo):
    bed.write({"terminals": [term("t4")], "run_broken": True})
    assert json.loads(create(bed, repo).stderr)["error"]["code"] == "hc_failed"
    assert not Path(f"{repo}-wt/one").exists()
    assert branches(repo) == ["main"]


def test_worktree_create_reports_a_git_failure_and_opens_no_tab(bed, repo):
    git(repo, "branch", "fanout/one")
    assert json.loads(create(bed, repo).stderr)["error"]["code"] == "git_failed"
    assert not [c for c in bed.seen() if c[:2] == ["hc", "run"]]
    assert "fanout/one" in branches(repo)


@pytest.mark.parametrize("flag,value", [("--branch", "--orphan"), ("--base", "--detach")])
def test_worktree_create_refuses_a_ref_that_looks_like_a_flag(bed, repo, flag, value):
    args = {"--branch": "fanout/one", "--base": "main", flag: value}
    done = bed.run("worktree", "create", "--cwd", str(repo), "--path", f"{repo}-wt/one",
                   "--label", "x", "--branch", args["--branch"], "--base", args["--base"])
    assert json.loads(done.stderr)["error"]["code"] == "usage"
    assert branches(repo) == ["main"]


def test_worktree_create_needs_its_options(bed, repo):
    err = bed.error("worktree", "create", "--cwd", str(repo), "--branch", "x")
    assert err["error"]["code"] == "usage"


def test_worktree_list_shows_linked_worktrees_only(bed, repo):
    create(bed, repo)
    result = bed.result("worktree", "list", "--cwd", str(repo))
    assert result["worktrees"] == [{"branch": "fanout/one", "path": f"{repo}-wt/one",
                                    "workspace_id": f"{repo}-wt/one"}]


def test_worktree_list_uses_the_callers_folder(bed, repo):
    assert bed.result("worktree", "list", cwd=repo)["worktrees"] == []


def test_worktree_list_outside_a_repository(bed, tmp_path):
    outside = tmp_path / "plain"
    outside.mkdir()
    err = bed.error("worktree", "list", "--cwd", str(outside))
    assert err["error"]["code"] == "not_git_worktree"


def test_worktree_remove_works_after_the_pane_has_gone(bed, repo):
    create(bed, repo)
    bed.ok("pane", "close", "t90")
    bed.ok("worktree", "remove", "--workspace", f"{repo}-wt/one", "--trust-repository")
    assert not Path(f"{repo}-wt/one").exists()
    assert bed.result("worktree", "list", "--cwd", str(repo))["worktrees"] == []


def test_worktree_remove_keeps_a_dirty_worktree_without_force(bed, repo):
    create(bed, repo)
    (Path(f"{repo}-wt/one") / "new").write_text("work\n")
    err = bed.error("worktree", "remove", "--workspace", f"{repo}-wt/one")
    assert err["error"]["code"] == "git_failed"
    assert (Path(f"{repo}-wt/one") / "new").exists()
    bed.ok("worktree", "remove", "--workspace", f"{repo}-wt/one", "--force")
    assert not Path(f"{repo}-wt/one").exists()


def test_worktree_remove_never_removes_a_main_checkout(bed, repo):
    err = bed.error("worktree", "remove", "--workspace", str(repo), "--force")
    assert err["error"]["code"] == "not_linked_worktree"
    assert (repo / "file").exists()


def test_worktree_remove_refuses_a_folder_inside_a_checkout(bed, repo):
    (repo / "sub").mkdir()
    err = bed.error("worktree", "remove", "--workspace", str(repo / "sub"), "--force")
    assert err["error"]["code"] == "not_linked_worktree"
    assert (repo / "sub").exists()


def test_worktree_remove_of_a_plain_folder(bed, tmp_path):
    plain = tmp_path / "plain"
    plain.mkdir()
    err = bed.error("worktree", "remove", "--workspace", str(plain), "--force")
    assert err["error"]["code"] == "worktree_not_found"
    assert plain.exists()


def test_worktree_remove_of_a_herdr_id(bed):
    err = bed.error("worktree", "remove", "--workspace", "wDQ")
    assert err["error"]["code"] == "worktree_not_found"


# orchi's own readers, on the adapter's output


def on_path(bed, monkeypatch):
    for k, v in bed.env(PATH=f"{BIN}{os.pathsep}{bed.path}").items():
        monkeypatch.setenv(k, v)


def test_switchboard_wait_reads_a_status(bed, monkeypatch):
    import time
    on_path(bed, monkeypatch)
    wait = load(BIN / "switchboard-wait", "switchboard_wait_a")
    bed.terminals(term("t7", "working", turn=5))
    assert wait.pane_status("t7", time.time() + 20) == ("working", 5)
    assert wait.pane_status("t99", time.time() + 20) == ("gone", None)


def test_switchboard_wait_does_not_call_a_broken_hc_gone(bed, monkeypatch):
    import time
    on_path(bed, monkeypatch)
    wait = load(BIN / "switchboard-wait", "switchboard_wait_b")
    bed.write({"terminals": [], "hc_broken": True})
    assert wait.pane_status("t7", time.time() + 20) == (wait.UNREACHABLE, None)


def test_switchboard_health_restarts_through_the_adapter(bed, monkeypatch, tmp_path):
    on_path(bed, monkeypatch)
    monkeypatch.delenv("HC_TERMINAL_ID")
    monkeypatch.setenv("ORCHI_HERDR", "app")
    bed.write({"terminals": [], "spaces": [LOCAL], "started_with": READY})
    health = load(BIN / "switchboard-health", "switchboard_health_c")
    health.LOCK_FILE = str(tmp_path / "lock")
    assert health.restart() == (True, "t90", None)
    t = bed.terminal("t90")
    assert t["labels"]["orchi.name"] == "switchboard"
    assert t["sent"][0].startswith("HERDR_ENV=1 PATH=")
    assert t["sent"][0].endswith("claude --model opus --effort high")
    assert t["sent"][1:] == ["/rename switchboard", "/switchboard resume"]
    lock = json.loads((tmp_path / "lock").read_text())
    assert (lock["terminal"], lock["herdr"]) == ("t90", "app")


def test_switchboard_health_confirms_clear_from_the_status_line(bed, monkeypatch):
    on_path(bed, monkeypatch)
    # launchd gives a job no locale, and the status line's bars aren't ASCII.
    for name in ("LANG", "LC_ALL", "LC_CTYPE"):
        monkeypatch.delenv(name, raising=False)
    health = load(BIN / "switchboard-health", "switchboard_health_d")
    bed.terminals(term("t7", text="working\ncontext: \u2593\u2591\u2591 31.2%\n"))
    assert health.session_of("t7") == (None, None), "hc reports no session id"
    assert health.context_of("t7") == 31.2


def test_switchboard_health_finds_a_pane(bed, monkeypatch):
    on_path(bed, monkeypatch)
    health = load(BIN / "switchboard-health", "switchboard_health_a")
    bed.terminals(term("t7", labels={"orchi.name": "orch-birch"}))
    result, err = health.herdr("agent", "list")
    assert err is None
    assert health.find_pane(result["agents"], "orch-birch")["pane_id"] == "t7"
    assert health.find_pane(result["agents"], "t7")["pane_id"] == "t7"


def test_switchboard_health_finds_the_switchboard_by_title(bed, monkeypatch):
    on_path(bed, monkeypatch)
    health = load(BIN / "switchboard-health", "switchboard_health_b")
    bed.terminals(term("t7", title="switchboard"))
    result, _ = health.herdr("agent", "list")
    assert health.find_switchboard(result["agents"])["pane_id"] == "t7"
