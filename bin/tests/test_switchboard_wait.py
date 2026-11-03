"""Tests for bin/switchboard-wait.

The switchboard entries in fixtures/ are two made-up runs with the shape of
real ones: atlas-145 and atlas-146 (two decisions open at once), atlas-150 to
atlas-152 and atlas-163 to atlas-165 from the atlas repo, and
birch-17 to birch-20 (birch-20 says "Replaces birch-17") from the birch repo. herdr is
replaced by a stub on PATH whose answer each test sets.
"""
import importlib.machinery
import importlib.util
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "switchboard-wait"
FIXTURES = HERE / "fixtures"


def load_script():
    loader = importlib.machinery.SourceFileLoader("switchboard_wait", str(SCRIPT))
    spec = importlib.util.spec_from_loader("switchboard_wait", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def blocks(name):
    """Entry id -> its text, header to the next header, ANSWERED lines kept."""
    text = (FIXTURES / name).read_text()
    heads = list(re.finditer(r"^## (\S+) ", text, re.M))
    out = {}
    for i, m in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        out[m.group(1)] = text[m.start():end].rstrip("\n") + "\n\n"
    return out


def unanswered(text):
    return "".join(l for l in text.splitlines(True) if not l.startswith("ANSWERED "))


ATLAS = blocks("atlas-switchboard.md")
BIRCH = blocks("birch-switchboard.md")

STUB = """#!{python}
import json, sys, time
cfg = json.load(open({cfg!r}))
time.sleep(cfg.get("sleep", 0))
# Real herdr prints errors as JSON on stderr and exits 1.
if cfg["status"] == "gone" or cfg["status"].startswith("error:"):
    code = "agent_not_found" if cfg["status"] == "gone" else cfg["status"][6:]
    print(json.dumps({{"error": {{"code": code}}, "id": "cli:agent:get"}}), file=sys.stderr)
    sys.exit(1)
else:
    print(json.dumps({{"id": "cli:agent:get", "result": {{"agent": {{
        "agent_status": cfg["status"], "state_change_seq": cfg.get("seq", 1),
        "pane_id": sys.argv[3]}}, "type": "agent_info"}}}}))
"""


@pytest.fixture
def sw(tmp_path, monkeypatch):
    mod = load_script()
    monkeypatch.setattr(mod, "USAGE_CACHE", str(tmp_path / "no-usage.json"))
    monkeypatch.setattr(mod, "POLL", 0.2)
    state_file = tmp_path / "state.md"
    monkeypatch.setattr(mod, "STATE_FILE", str(state_file))
    bindir = tmp_path / "bin"
    bindir.mkdir()
    cfg = tmp_path / "herdr.json"
    stub = bindir / "herdr"
    stub.write_text(STUB.format(python=sys.executable, cfg=str(cfg)))
    stub.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bindir}:/usr/bin:/bin")

    class Env:
        repo = tmp_path / "atlas"
        board = repo / ".legwork" / "switchboard.md"
        cursor = repo / ".legwork" / "switchboard-wait.cursor"
        state = state_file
        script = mod

        def herdr(self, status="working", seq=1, sleep=0):
            # Atomic: a timer changes it while the fake herdr may be reading it.
            tmp = cfg.with_name(cfg.name + ".tmp")
            tmp.write_text(json.dumps({"status": status, "seq": seq, "sleep": sleep}))
            os.replace(tmp, cfg)

        def write(self, *texts):
            self.board.parent.mkdir(parents=True, exist_ok=True)
            self.board.write_text("".join(texts))

        def append(self, text):
            with open(self.board, "a") as f:
                f.write(text)

        def started(self, when, project="atlas", repo=None):
            """The switchboard's state file, watching this repo since `when`."""
            repo = repo or self.repo
            state_file.write_text(
                "# switchboard state\nupdated: 2026-10-10 23:56\n## watching\n"
                f"{project} {repo} w1:p2\n## started\n{project} {when}\n"
                f"## check-ins\n{project} 2026-10-10 23:56\n")

        def pause(self, project="atlas", repo=None, also=""):
            """The state file with this repo watched and paused."""
            state_file.write_text(
                "# switchboard state\nupdated: 2026-10-10 23:56\n## watching\n"
                f"{project} {repo or self.repo} w1:p2\n{also}## check-ins\n"
                f"{project} 2026-10-10 23:56\n## paused\n{project} 2026-10-10 23:57\n")

        def request(self, name="1793000000000-ab12.req", text="start s1\n"):
            folder = state_file.parent / "requests"
            folder.mkdir(exist_ok=True)
            path = folder / name
            path.write_text(text)
            return path

        def run(self, timeout=1, capsys=None):
            start = time.time()
            rc = mod.main(["--timeout", str(timeout), f"{self.repo}:w1:p2"])
            took = time.time() - start
            lines = capsys.readouterr().out.splitlines()
            return rc, lines, took

    env = Env()
    env.herdr("working")
    return env


# (a) atlas-151: a DECISION written while no wait was running.
def test_cold_start_reports_open_decision(sw, capsys):
    sw.write(ATLAS["atlas-150"], ATLAS["atlas-151"])
    rc, lines, took = sw.run(timeout=30, capsys=capsys)
    assert (rc, lines) == (0, ["atlas atlas-151 DECISION"])
    assert took < 5, "an open decision on start must return at once"


# (b) atlas-152: the CYCLE is the latest entry, atlas-151 still open.
def test_cold_start_reports_latest_cycle_152(sw, capsys):
    sw.write(ATLAS["atlas-150"], ATLAS["atlas-151"], unanswered(ATLAS["atlas-152"]))
    rc, lines, _ = sw.run(capsys=capsys)
    assert rc == 0
    assert lines == ["atlas atlas-151 DECISION", "atlas atlas-152 CYCLE"]


# (c) atlas-165: the CYCLE is the latest entry, atlas-164 still open.
def test_cold_start_reports_latest_cycle_165(sw, capsys):
    sw.write(ATLAS["atlas-163"], ATLAS["atlas-164"], unanswered(ATLAS["atlas-165"]))
    rc, lines, _ = sw.run(capsys=capsys)
    assert rc == 0
    assert lines == ["atlas atlas-164 DECISION", "atlas atlas-165 CYCLE"]


# (d) The real file: "ANSWERED atlas-151: B" sits under the atlas-152 CYCLE.
def test_answered_decision_is_not_reported(sw, capsys):
    sw.write(ATLAS["atlas-150"], ATLAS["atlas-151"], ATLAS["atlas-152"])
    rc, lines, _ = sw.run(capsys=capsys)
    assert rc == 0
    assert lines == ["atlas atlas-152 CYCLE"]


def test_cycle_that_is_not_latest_is_not_reported_on_start(sw, capsys):
    sw.write(ATLAS["atlas-163"], ATLAS["atlas-164"], ATLAS["atlas-165"],
             "## atlas-166 UPDATE 2026-03-15 07:00\nPublished v2.4.0.\n")
    rc, lines, _ = sw.run(capsys=capsys)
    assert (rc, lines) == (124, ["timeout"])


# (e) birch-20 says "Replaces birch-17 (no need to answer birch-17)."
def test_replaced_decision_is_not_reported(sw, capsys):
    sw.write(BIRCH["birch-17"], BIRCH["birch-18"], BIRCH["birch-19"], BIRCH["birch-20"])
    rc, lines, _ = sw.run(capsys=capsys)
    assert rc == 0
    assert lines == ["atlas birch-20 DECISION"]


# (f) A herdr call that hangs cannot hold the wait past its deadline.
def test_hung_herdr_does_not_outlast_deadline(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    sw.herdr("working", sleep=60)
    rc, lines, took = sw.run(timeout=2, capsys=capsys)
    assert (rc, lines) == (124, ["timeout"])
    assert took < 4


def test_herdr_timeout_is_reported_once_as_unreachable(sw, capsys, monkeypatch):
    monkeypatch.setattr(sw.script, "HERDR_TIMEOUT", 1)
    sw.write(ATLAS["atlas-150"])
    sw.herdr("working", sleep=60)
    rc, lines, took = sw.run(timeout=20, capsys=capsys)
    assert (rc, lines) == (0, ["atlas pane unreachable"])
    assert took < 3
    rc, lines, took = sw.run(timeout=3, capsys=capsys)
    assert (rc, lines) == (124, ["timeout"])
    assert took < 5


def test_herdr_call_is_made_with_a_30s_timeout(sw, capsys, monkeypatch):
    real_run = sw.script.subprocess.run
    timeouts = []

    def run(*args, **kwargs):
        timeouts.append(kwargs.get("timeout"))
        return real_run(*args, **kwargs)

    monkeypatch.setattr(sw.script.subprocess, "run", run)
    sw.write(ATLAS["atlas-150"])
    sw.herdr("idle", seq=2)
    assert sw.run(timeout=600, capsys=capsys)[:2] == (0, ["atlas pane idle"])
    assert timeouts == [30]


# (g) The cursor advances, a second start reports nothing new, and an
# entry written between waits is reported on the next start.
def test_cursor_advances_and_second_start_is_quiet(sw, capsys):
    sw.write(ATLAS["atlas-150"], ATLAS["atlas-151"])
    rc, lines, _ = sw.run(capsys=capsys)
    assert (rc, lines) == (0, ["atlas atlas-151 DECISION"])
    assert json.loads(sw.cursor.read_text())[str(sw.board)] == "atlas-151"

    rc, lines, _ = sw.run(capsys=capsys)
    assert (rc, lines) == (124, ["timeout"])
    assert json.loads(sw.cursor.read_text())[str(sw.board)] == "atlas-151"

    sw.append(unanswered(ATLAS["atlas-152"]))
    rc, lines, _ = sw.run(capsys=capsys)
    assert (rc, lines) == (0, ["atlas atlas-152 CYCLE"])
    assert json.loads(sw.cursor.read_text())[str(sw.board)] == "atlas-152"


def test_cursor_does_not_move_when_nothing_is_printed(sw, capsys):
    sw.write(ATLAS["atlas-150"], ATLAS["atlas-151"], ATLAS["atlas-152"])
    sw.cursor.write_text(json.dumps({str(sw.board): "atlas-150"}))
    sw.append("## atlas-153 DECIDED 2026-03-14 20:31\nResumed.\n")
    rc, lines, _ = sw.run(capsys=capsys)
    assert (rc, lines) == (124, ["timeout"])
    assert json.loads(sw.cursor.read_text())[str(sw.board)] == "atlas-150"


def test_new_decision_during_wait_is_reported(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    t = threading.Timer(0.5, sw.append, [ATLAS["atlas-151"]])
    t.start()
    try:
        rc, lines, took = sw.run(timeout=10, capsys=capsys)
    finally:
        t.cancel()
    assert (rc, lines) == (0, ["atlas atlas-151 DECISION"])
    assert took < 3


def test_idle_pane_is_reported_once_per_state_change(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    sw.herdr("idle", seq=5)
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas pane idle"])
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])
    sw.herdr("idle", seq=9)
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas pane idle"])


def test_pane_going_idle_during_wait_is_reported(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    t = threading.Timer(0.5, sw.herdr, ["done"], {"seq": 2})
    t.start()
    try:
        rc, lines, _ = sw.run(timeout=10, capsys=capsys)
    finally:
        t.cancel()
    assert (rc, lines) == (0, ["atlas pane done"])


def test_gone_pane_is_reported_on_start(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    sw.herdr("gone")
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas pane gone"])


def test_usage_floor_is_reported(sw, capsys, monkeypatch, tmp_path):
    usage = tmp_path / "usage.json"
    usage.write_text(json.dumps({"weeklyUsage": 50, "fableUsage": 10}))
    monkeypatch.setattr(sw.script, "USAGE_CACHE", str(usage))
    sw.write(ATLAS["atlas-150"])
    t = threading.Timer(0.5, usage.write_text,
                        [json.dumps({"weeklyUsage": 50, "fableUsage": 99})])
    t.start()
    try:
        rc, lines, _ = sw.run(timeout=10, capsys=capsys)
    finally:
        t.cancel()
    assert (rc, lines) == (0, ["usage weekly Fable at 99%"])


def test_bad_arguments_exit_2(sw, capsys):
    assert sw.script.main([]) == 2
    assert sw.script.main(["--timeout", "x", "repo:pane"]) == 2
    assert sw.script.main(["no-pane"]) == 2
    assert sw.script.main(["--status"]) == 2
    assert sw.script.main(["--state"]) == 2


# --status: full state for check-ins, never touches the cursor.
def test_status_reports_decision_the_cursor_already_reported(sw, capsys):
    sw.write(ATLAS["atlas-150"], ATLAS["atlas-151"])
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas atlas-151 DECISION"])
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])
    rc = sw.script.main(["--status", f"{sw.repo}:w1:p2"])
    lines = capsys.readouterr().out.splitlines()
    assert rc == 0
    first = ATLAS["atlas-151"].splitlines()[1]
    assert first.startswith("Attempted: ENG-52 option B is built as 240")
    assert lines == [f"atlas atlas-151 DECISION {first}", "atlas pane working",
                     "atlas wait none"]


def test_status_leaves_cursor_file_byte_identical(sw, capsys):
    sw.write(ATLAS["atlas-163"], ATLAS["atlas-164"], unanswered(ATLAS["atlas-165"]))
    sw.herdr("idle", seq=3)
    before = b'{"not": "rewritten",   "keep": "these bytes"}\n'
    sw.cursor.write_bytes(before)
    start = time.time()
    rc = sw.script.main(["--timeout", "20", "--status", f"{sw.repo}:w1:p2"])
    lines = capsys.readouterr().out.splitlines()
    assert rc == 0 and time.time() - start < 3
    assert [l.split(" ", 3)[:3] for l in lines[:2]] == [
        ["atlas", "atlas-164", "DECISION"], ["atlas", "atlas-165", "CYCLE"]]
    assert lines[2] == "atlas pane idle"
    assert sw.cursor.read_bytes() == before


def test_status_without_cursor_creates_none(sw, capsys):
    sw.write(ATLAS["atlas-150"], ATLAS["atlas-151"])
    assert sw.script.main(["--status", f"{sw.repo}:w1:p2"]) == 0
    capsys.readouterr()
    assert not sw.cursor.exists()


# A multibyte character cut mid-write.
def test_non_utf8_bytes_do_not_crash_the_wait(sw, capsys):
    sw.write(ATLAS["atlas-150"], ATLAS["atlas-151"])
    with open(sw.board, "ab") as f:
        f.write(b"## atlas-152 UPDATE 2026-03-14 20:01\nHalf a euro sign \xe2\x82")
    rc, lines, _ = sw.run(capsys=capsys)
    assert (rc, lines) == (0, ["atlas atlas-151 DECISION"])


# Finding 2: a trailing CYCLE or DONE needs the switchboard while the pane is stopped,
# so it is reported on every start, not once.
def test_trailing_cycle_is_reported_every_start_while_pane_idle(sw, capsys):
    sw.write(ATLAS["atlas-163"], ATLAS["atlas-164"], ATLAS["atlas-165"])
    sw.herdr("idle", seq=4)
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas atlas-165 CYCLE", "atlas pane idle"])
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas atlas-165 CYCLE"])
    sw.herdr("working", seq=5)
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])


def test_trailing_done_is_reported_every_start_while_pane_done(sw, capsys):
    sw.write(ATLAS["atlas-150"],
             "## atlas-174 DONE 2026-03-15 09:57\nRoadmap 3 row 17.\n")
    sw.herdr("done", seq=7)
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas atlas-174 DONE", "atlas pane done"])
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas atlas-174 DONE"])


def test_open_decision_stays_report_once_while_pane_idle(sw, capsys):
    sw.write(ATLAS["atlas-150"], ATLAS["atlas-151"])
    sw.herdr("idle", seq=4)
    # The pane resting is not news while the DECISION printed on start is open.
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas atlas-151 DECISION"])
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])


# Finding 3: only agent_not_found means the pane is gone.
def test_herdr_server_not_running_is_not_gone(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    sw.herdr("error:server_not_running")
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas pane unreachable"])
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])


# Finding 4: a file rewritten shorter during a wait.
def test_file_rewritten_shorter_during_wait(sw, capsys):
    sw.write(ATLAS["atlas-150"], ATLAS["atlas-163"])
    t = threading.Timer(0.5, sw.write, [ATLAS["atlas-151"]])
    t.start()
    try:
        rc, lines, took = sw.run(timeout=6, capsys=capsys)
    finally:
        t.cancel()
    assert (rc, lines) == (0, ["atlas atlas-151 DECISION"])
    assert took < 3


# Finding 5: a repo with no .legwork directory yet.
def test_missing_legwork_dir_still_keeps_pane_state(sw, capsys):
    sw.repo.mkdir()
    sw.herdr("idle", seq=4)
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas pane idle"])
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])
    assert sw.cursor.exists()


def test_missing_repo_is_not_created(sw, capsys):
    sw.herdr("idle", seq=4)
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas pane idle"])
    assert not sw.repo.exists()


# Finding 6: two waits on the same repo share one cursor file.
def test_concurrent_wait_keeps_the_other_waits_cursor(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    other = {"panes": {"p9": {"status": "idle", "seq": 3}}, str(sw.board): "atlas-150"}
    t1 = threading.Timer(0.3, sw.cursor.write_text, [json.dumps(other)])
    t2 = threading.Timer(0.6, sw.append, [ATLAS["atlas-151"]])
    t1.start()
    t2.start()
    try:
        rc, lines, _ = sw.run(timeout=6, capsys=capsys)
    finally:
        t1.cancel()
        t2.cancel()
    assert (rc, lines) == (0, ["atlas atlas-151 DECISION"])
    saved = json.loads(sw.cursor.read_text())
    assert saved["panes"]["p9"] == {"status": "idle", "seq": 3}
    assert "w1:p2" in saved["panes"]
    assert saved[str(sw.board)] == "atlas-151"


def test_save_never_moves_a_cursor_backwards(sw):
    sw.write(ATLAS["atlas-150"], ATLAS["atlas-151"], unanswered(ATLAS["atlas-152"]))
    sw.cursor.write_text(json.dumps({str(sw.board): "atlas-152"}))
    sw.script.save_states({str(sw.cursor): {str(sw.board): "atlas-151"}},
                          {str(sw.cursor): {}})
    assert json.loads(sw.cursor.read_text())[str(sw.board)] == "atlas-152"


# Finding 7: "Replaces" only counts at the start of a line.
def test_replaces_in_prose_does_not_close_a_decision(sw, capsys):
    sw.write(BIRCH["birch-17"], "## birch-18 UPDATE 2026-03-14 19:30\n"
             "The new loader Replaces birch-17 style parsing.\n\n")
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas birch-17 DECISION"])


# Finding 8: a repeated header id must not move the cursor past a later entry.
def test_repeated_header_id_uses_the_first_match(sw, capsys):
    sw.write(ATLAS["atlas-150"], ATLAS["atlas-151"],
             "## atlas-150 DECIDED 2026-03-14 20:00\nA repeated id.\n\n")
    sw.cursor.write_text(json.dumps({str(sw.board): "atlas-150"}))
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas atlas-151 DECISION"])


# Finding 9: ANSWERED with whitespace, not a colon, after the id.
@pytest.mark.parametrize("line", ["ANSWERED atlas-151 B\n", "ANSWERED atlas-151"])
def test_answered_without_colon_is_recognised(sw, capsys, line):
    sw.write(ATLAS["atlas-150"], ATLAS["atlas-151"], line)
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])


# Finding 10: herdr's own "unknown" state is a pane state, not a failed call.
def test_herdr_unknown_state_is_kept_as_herdr_reports_it(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    sw.herdr("unknown", seq=4)
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])
    assert sw.script.main(["--status", f"{sw.repo}:w1:p2"]) == 0
    assert capsys.readouterr().out.splitlines() == ["atlas pane unknown", "atlas wait none"]
    sw.herdr("error:server_not_running")
    assert sw.script.main(["--status", f"{sw.repo}:w1:p2"]) == 0
    assert capsys.readouterr().out.splitlines() == ["atlas pane unreachable", "atlas wait none"]


# Finding 11: a usage cache with strings in it.
def test_string_usage_values_are_coerced_or_skipped(sw, capsys, monkeypatch, tmp_path):
    usage = tmp_path / "usage.json"
    usage.write_text(json.dumps({"weeklyUsage": "50", "fableUsage": "n/a"}))
    monkeypatch.setattr(sw.script, "USAGE_CACHE", str(usage))
    sw.write(ATLAS["atlas-150"])
    t = threading.Timer(0.5, usage.write_text,
                        [json.dumps({"weeklyUsage": "99", "fableUsage": None})])
    t.start()
    try:
        rc, lines, _ = sw.run(timeout=10, capsys=capsys)
    finally:
        t.cancel()
    assert (rc, lines) == (0, ["usage weekly all-models at 99%"])


# Coverage the review asked for.
def test_two_open_decisions_are_both_reported(sw, capsys):
    sw.write(ATLAS["atlas-145"], unanswered(ATLAS["atlas-146"]))
    rc, lines, _ = sw.run(capsys=capsys)
    assert (rc, lines) == (0, ["atlas atlas-145 DECISION", "atlas atlas-146 DECISION"])
    assert json.loads(sw.cursor.read_text())[str(sw.board)] == "atlas-146"
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])


def test_second_open_decision_after_cursor_on_first(sw, capsys):
    sw.write(ATLAS["atlas-145"], unanswered(ATLAS["atlas-146"]))
    sw.cursor.write_text(json.dumps({str(sw.board): "atlas-145"}))
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas atlas-146 DECISION"])


def test_cursor_is_written_by_temp_file_and_replace(sw, capsys, monkeypatch):
    real_replace = sw.script.os.replace
    calls = []

    def replace(src, dst):
        if dst == str(sw.cursor):
            calls.append((src, dst, json.loads(Path(src).read_text())))
            assert not Path(dst).exists()
        return real_replace(src, dst)

    monkeypatch.setattr(sw.script.os, "replace", replace)
    sw.write(ATLAS["atlas-150"], ATLAS["atlas-151"])
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas atlas-151 DECISION"])
    assert len(calls) == 1
    src, dst, content = calls[0]
    assert dst == str(sw.cursor) and src != dst
    assert content[str(sw.board)] == "atlas-151"
    assert not list(sw.cursor.parent.glob("*.tmp"))


def test_missing_herdr_binary_is_unreachable_once(sw, capsys, monkeypatch, tmp_path):
    empty = tmp_path / "empty-bin"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))
    sw.write(ATLAS["atlas-150"])
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas pane unreachable"])
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])


@pytest.mark.parametrize("junk", [b"not json{", b"[1, 2]", b"\xff\xfe", b""])
def test_corrupt_cursor_re_reports_and_is_rewritten(sw, capsys, junk):
    sw.write(ATLAS["atlas-150"], ATLAS["atlas-151"])
    sw.cursor.write_bytes(junk)
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas atlas-151 DECISION"])
    assert json.loads(sw.cursor.read_text())[str(sw.board)] == "atlas-151"


# A GRANT written by an older switchboard can take the same number as an
# orchestrator entry: cedar-2 below is a GRANT, a DECISION and two DONEs. With the cursor on the last DONE
# the next start matched the DECISION and reported the DONE again, three
# times in three minutes.
DUP = ("## cedar-1 DONE 2026-03-15 16:52\nRoadmap 1 wrapped.\n\n"
       "## cedar-2 GRANT 2026-03-15 17:07\nAdam: \"b\"\nScope: item 8.\n\n"
       "## cedar-2 DECISION 2026-03-15 17:10\nAttempted: x\n\n"
       "ANSWERED cedar-2: b (2026-03-15 17:10)\n\n"
       "## cedar-2 DONE 2026-03-15 17:10\nRoadmap 2 wrapped.\n\n")


def test_cursor_on_a_repeated_id_does_not_re_report_the_later_entry(sw, capsys):
    sw.write(DUP)
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas cedar-2 DONE"])
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])


def test_cursor_on_a_repeated_id_still_reports_what_follows(sw, capsys):
    sw.write(DUP)
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas cedar-2 DONE"])
    sw.append("## cedar-3 DECISION 2026-03-15 17:20\nAttempted: y\n\n")
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas cedar-3 DECISION"])


def test_merge_compares_repeated_ids_by_position(sw):
    sw.write(DUP)
    sw.cursor.write_text(json.dumps({str(sw.board): "cedar-2#2"}))
    sw.script.save_states({str(sw.cursor): {str(sw.board): "cedar-2"}},
                          {str(sw.cursor): {}})
    assert json.loads(sw.cursor.read_text())[str(sw.board)] == "cedar-2#2"


# An entry can put "Replaces <id>" on its heading line.
def test_replaces_on_the_heading_line_closes_a_decision(sw, capsys):
    sw.write("## birch-6 DECISION 2026-10-01 20:10\nAttempted: x\n\n"
             "## birch-9 DECISION 2026-10-01 21:21 Replaces birch-6\nAttempted: y\n\n")
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas birch-9 DECISION"])


# A DECISION answered in the pane gets a DECIDED entry, which carries
# "Replaces <id>" so the wait doesn't keep the DECISION open.
def test_decided_with_replaces_closes_a_decision(sw, capsys):
    sw.write("## cedar-80 DECISION 2026-10-01 16:54\nAttempted: x\n\n"
             "## cedar-82 DECIDED 2026-10-01 16:57\nReplaces cedar-80\n"
             "Adam said in the pane: \"after the tests\".\n\n")
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])


# A pgrep for a wait can find another repo's wait and miss that this repo has
# none, so a CYCLE sits unread. --status says whether a wait is watching each repo.
def spawn_wait(sw, timeout=20):
    return subprocess.Popen([sys.executable, str(SCRIPT), "--timeout", str(timeout),
                             f"{sw.repo}:w1:p2"], stdout=subprocess.DEVNULL)


def status_lines(sw, capsys):
    assert sw.script.main(["--status", f"{sw.repo}:w1:p2"]) == 0
    return capsys.readouterr().out.splitlines()


def until(cond, limit=5):
    end = time.time() + limit
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.1)
    return False


def test_status_says_when_no_wait_watches_the_repo(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    assert status_lines(sw, capsys)[-1] == "atlas wait none"


def test_status_shows_a_running_wait_and_drops_it_on_kill(sw, capsys, monkeypatch, tmp_path):
    monkeypatch.setenv("SWITCHBOARD_USAGE_CACHE", str(tmp_path / "no-usage.json"))
    sw.write(ATLAS["atlas-150"])
    proc = spawn_wait(sw)
    try:
        assert until(lambda: status_lines(sw, capsys)[-1].startswith("atlas wait running"))
        line = status_lines(sw, capsys)[-1]
        assert f"pid {proc.pid}" in line
    finally:
        proc.terminate()
        proc.wait(5)
    assert status_lines(sw, capsys)[-1] == "atlas wait none"
    assert str(proc.pid) not in (sw.repo / ".legwork" / "switchboard-wait.pids").read_text()


def test_status_ignores_a_dead_wait_left_in_the_list(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    dead = subprocess.Popen(["true"])
    dead.wait()
    (sw.repo / ".legwork" / "switchboard-wait.pids").write_text(
        json.dumps({str(dead.pid): time.time()}))
    assert status_lines(sw, capsys)[-1] == "atlas wait none"


def test_status_ignores_a_live_pid_that_is_not_a_wait(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    (sw.repo / ".legwork" / "switchboard-wait.pids").write_text(
        json.dumps({str(os.getpid()): time.time()}))
    assert status_lines(sw, capsys)[-1] == "atlas wait none"


def test_a_finished_wait_takes_itself_off_the_list(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])
    pids = sw.repo / ".legwork" / "switchboard-wait.pids"
    assert not pids.exists() or json.loads(pids.read_text()) == {}


# Review of this change, finding 1: a wait started with SIGHUP ignored
# (nohup) must keep ignoring it.
def test_inherited_sighup_ignore_is_kept(sw, capsys, monkeypatch, tmp_path):
    import signal
    monkeypatch.setenv("SWITCHBOARD_USAGE_CACHE", str(tmp_path / "no-usage.json"))
    sw.write(ATLAS["atlas-150"])
    proc = subprocess.Popen(
        [sys.executable, str(SCRIPT), "--timeout", "20", f"{sw.repo}:w1:p2"],
        stdout=subprocess.DEVNULL,
        preexec_fn=lambda: signal.signal(signal.SIGHUP, signal.SIG_IGN))
    try:
        assert until(lambda: status_lines(sw, capsys)[-1].startswith("atlas wait running"))
        proc.send_signal(signal.SIGHUP)
        time.sleep(0.5)
        assert proc.poll() is None
    finally:
        proc.terminate()
        proc.wait(5)


# Finding 3: a live process that only looks like a wait, or a wait that
# started at another time than the one listed, is not the listed wait.
def test_status_ignores_a_reused_pid_with_a_wait_like_name(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    fake = subprocess.Popen(["bash", "-c", "exec -a switchboard-wait-fake sleep 30"])
    try:
        until(lambda: "switchboard-wait-fake" in subprocess.run(
            ["ps", "-o", "command=", "-p", str(fake.pid)],
            capture_output=True, text=True).stdout)
        (sw.repo / ".legwork" / "switchboard-wait.pids").write_text(
            json.dumps({str(fake.pid): 1.0}))
        assert status_lines(sw, capsys)[-1] == "atlas wait none"
    finally:
        fake.kill()
        fake.wait(5)


# Finding 4: an id that itself ends in "#<digits>" is not a repeat count.
def test_id_ending_in_hash_digits_is_reported_once(sw, capsys):
    sw.write("## t#1 DECISION 2026-10-10 12:00\nAttempted: x\n\n")
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas t#1 DECISION"])
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])


# Finding 6: "Replaces" counts on a heading only as its last words.
def test_replaces_in_heading_prose_does_not_close_a_decision(sw, capsys):
    sw.write(BIRCH["birch-17"], "## birch-18 UPDATE 2026-03-14 19:30 new loader Replaces birch-17 style\n"
             "Prose.\n\n")
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas birch-17 DECISION"])


# A new run must not be dropped at once because the latest entry is the DONE
# of the run before, days older than the watch.
OLD_DONE = "## atlas-100 DONE 2026-10-05 19:31\nRoadmap 3 complete.\n\n"


def test_done_before_the_watch_started_is_not_reported_on_start(sw, capsys):
    sw.write(OLD_DONE)
    sw.started("2026-10-10 23:49")
    sw.herdr("done")
    rc, lines, _ = sw.run(capsys=capsys)
    assert "atlas atlas-100 DONE" not in lines


def test_done_before_the_watch_started_is_not_reported_while_working(sw, capsys):
    sw.write(OLD_DONE)
    sw.started("2026-10-10 23:49")
    rc, lines, _ = sw.run(capsys=capsys)
    assert (rc, lines) == (124, ["timeout"])


def test_cycle_before_the_watch_started_is_not_reported(sw, capsys):
    sw.write("## atlas-100 CYCLE 2026-10-05 19:31\nContext full.\n\n")
    sw.started("2026-10-10 23:49")
    sw.herdr("idle")
    rc, lines, _ = sw.run(capsys=capsys)
    assert "atlas atlas-100 CYCLE" not in lines


def test_done_after_the_watch_started_is_reported(sw, capsys):
    sw.write(OLD_DONE, "## atlas-101 DONE 2026-10-11 00:42\nENG-201 done.\n\n")
    sw.started("2026-10-10 23:49")
    rc, lines, _ = sw.run(capsys=capsys)
    assert (rc, lines) == (0, ["atlas atlas-101 DONE"])


# An ACTION left open by the run before, printed by a new run's first wait, has that run's
# DONE beside it, and the switchboard would stop watching a live run.
# An answer to an old question would also reach the new orchestrator.
OLD_ASK = "## atlas-99 {kind} 2026-10-05 19:30\nWhy: Merge pull request 2.\n\n"


@pytest.mark.parametrize("kind", ["ACTION", "DECISION"])
def test_open_entry_of_a_finished_run_is_not_reported(sw, capsys, kind):
    sw.write(OLD_ASK.format(kind=kind), OLD_DONE)
    sw.started("2026-10-10 23:49")
    rc, lines, _ = sw.run(capsys=capsys)
    assert (rc, lines) == (124, ["timeout"])


def test_open_entry_of_a_run_that_never_finished_is_reported(sw, capsys):
    # A resumed run may still need the answer.
    sw.write(OLD_ASK.format(kind="ACTION"))
    sw.started("2026-10-10 23:49")
    rc, lines, _ = sw.run(capsys=capsys)
    assert (rc, lines) == (0, ["atlas atlas-99 ACTION"])


def test_open_entry_after_the_watch_started_is_reported(sw, capsys):
    sw.write(OLD_ASK.format(kind="ACTION"), OLD_DONE, "## atlas-101 ACTION 2026-10-11 00:42\nWhy: Merge.\n\n")
    sw.started("2026-10-10 23:49")
    rc, lines, _ = sw.run(capsys=capsys)
    assert (rc, lines) == (0, ["atlas atlas-101 ACTION"])


def test_open_entry_with_no_started_line_is_still_reported(sw, capsys):
    sw.write(OLD_ASK.format(kind="DECISION"), OLD_DONE)
    rc, lines, _ = sw.run(capsys=capsys)
    assert "atlas atlas-99 DECISION" in lines


def test_status_leaves_out_an_open_entry_of_a_finished_run(sw, capsys):
    sw.write(OLD_ASK.format(kind="ACTION"), OLD_DONE)
    sw.started("2026-10-10 23:49")
    assert sw.script.main(["--status", f"{sw.repo}:w1:p2"]) == 0
    assert "atlas-99" not in capsys.readouterr().out


def test_done_at_the_same_minute_as_the_start_is_reported(sw, capsys):
    sw.write("## atlas-101 DONE 2026-10-10 23:49\nDone.\n\n")
    sw.started("2026-10-10 23:49")
    sw.herdr("done")
    rc, lines, _ = sw.run(capsys=capsys)
    assert lines == ["atlas atlas-101 DONE", "atlas pane done"]


def test_done_written_during_the_wait_is_reported(sw, capsys):
    sw.write(OLD_DONE)
    sw.started("2026-10-10 23:49")
    threading.Timer(0.5, sw.append,
                    ["## atlas-101 DONE 2026-10-11 00:42\nENG-201 done.\n\n"]).start()
    rc, lines, _ = sw.run(timeout=10, capsys=capsys)
    assert (rc, lines) == (0, ["atlas atlas-101 DONE"])


def test_old_done_is_reported_when_the_repo_has_no_started_line(sw, capsys):
    sw.write(OLD_DONE)
    sw.herdr("done")
    rc, lines, _ = sw.run(capsys=capsys)
    assert "atlas atlas-100 DONE" in lines


def test_started_line_for_another_repo_does_not_apply(sw, capsys, tmp_path):
    sw.write(OLD_DONE)
    sw.started("2026-10-10 23:49", project="birch", repo=tmp_path / "birch")
    sw.herdr("done")
    rc, lines, _ = sw.run(capsys=capsys)
    assert "atlas atlas-100 DONE" in lines


def test_open_decision_before_the_watch_started_is_still_reported(sw, capsys):
    sw.write(ATLAS["atlas-150"], ATLAS["atlas-151"])
    sw.started("2026-10-10 23:49")
    rc, lines, _ = sw.run(capsys=capsys)
    assert (rc, lines) == (0, ["atlas atlas-151 DECISION"])


def test_status_leaves_out_a_done_before_the_watch_started(sw, capsys):
    sw.write(OLD_DONE)
    sw.started("2026-10-10 23:49")
    sw.herdr("done")
    rc = sw.script.main(["--status", f"{sw.repo}:w1:p2"])
    out = capsys.readouterr().out.splitlines()
    assert rc == 0
    assert not any("DONE" in l for l in out)


def test_state_option_names_the_state_file(sw, capsys, tmp_path):
    sw.write(OLD_DONE)
    other = tmp_path / "elsewhere.md"
    other.write_text(f"## watching\natlas {sw.repo} w1:p2\n## started\natlas 2026-10-10 23:49\n")
    sw.herdr("done")
    rc = sw.script.main(["--status", "--state", str(other), f"{sw.repo}:w1:p2"])
    out = capsys.readouterr().out.splitlines()
    assert not any("DONE" in l for l in out)


def test_missing_state_file_keeps_the_old_behaviour(sw, capsys, tmp_path):
    sw.write(OLD_DONE)
    sw.herdr("done")
    rc = sw.script.main(["--status", "--state", str(tmp_path / "none.md"), f"{sw.repo}:w1:p2"])
    out = capsys.readouterr().out.splitlines()
    assert "atlas atlas-100 DONE Roadmap 3 complete." in out


# Idle and done flips must not wake the switchboard for nothing. herdr's done is
# idle not yet seen, and its state_change_seq is one counter for all panes
# that moves only when an agent's own state changes, so an idle and done
# flip keeps its seq. A pane that only flips did nothing new, and while the
# latest entry is an open DECISION already reported, the orchestrator is
# waiting on Adam.
DECISION = "## atlas-200 DECISION 2026-10-20 09:00\nAttempted: x\n\n"


def wait_with(sw, capsys, *changes, timeout=1):
    """One wait; each change is (delay, function, args) run while it waits."""
    timers = [threading.Timer(d, f, a) for d, f, a in changes]
    for t in timers:
        t.start()
    try:
        return sw.run(timeout=timeout, capsys=capsys)[:2]
    finally:
        for t in timers:
            t.cancel()


def test_idle_to_done_with_the_same_seq_is_not_an_event(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    sw.herdr("idle", seq=1)
    assert wait_with(sw, capsys) == (0, ["atlas pane idle"])
    sw.herdr("done", seq=1)
    assert wait_with(sw, capsys) == (124, ["timeout"])
    sw.herdr("idle", seq=1)
    assert wait_with(sw, capsys) == (124, ["timeout"])


def test_flips_during_a_wait_are_not_events(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    sw.herdr("done", seq=1)
    assert wait_with(sw, capsys) == (0, ["atlas pane done"])
    assert wait_with(sw, capsys, (0.3, sw.herdr, ["idle", 1]),
                     (0.6, sw.herdr, ["done", 1])) == (124, ["timeout"])


def test_a_turn_no_poll_saw_between_waits_is_an_event(sw, capsys):
    # The switchboard relays a prompt after a wake; the turn runs and ends
    # before the next wait starts, so only the new seq shows it.
    sw.write(ATLAS["atlas-150"])
    sw.herdr("idle", seq=1)
    assert wait_with(sw, capsys) == (0, ["atlas pane idle"])
    sw.herdr("done", seq=3)
    assert wait_with(sw, capsys) == (0, ["atlas pane done"])


def test_a_turn_inside_one_poll_is_an_event(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    sw.herdr("done", seq=1)
    assert wait_with(sw, capsys) == (0, ["atlas pane done"])
    assert wait_with(sw, capsys, (0.3, sw.herdr, ["idle", 7]),
                     timeout=10) == (0, ["atlas pane idle"])


def test_blocked_then_idle_is_an_event(sw, capsys):
    # The switchboard last heard blocked; it needs to know the block is gone.
    sw.write(ATLAS["atlas-150"])
    sw.herdr("blocked", seq=1)
    assert wait_with(sw, capsys) == (0, ["atlas pane blocked"])
    sw.herdr("idle", seq=2)
    assert wait_with(sw, capsys) == (0, ["atlas pane idle"])


def test_working_then_stopped_is_still_an_event(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    sw.herdr("idle", seq=1)
    assert wait_with(sw, capsys) == (0, ["atlas pane idle"])
    assert wait_with(sw, capsys, (0.3, sw.herdr, ["working", 2]),
                     (0.6, sw.herdr, ["done", 3]), timeout=10) == (0, ["atlas pane done"])


def test_unknown_then_idle_is_an_event(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    sw.herdr("unknown", seq=1)
    assert wait_with(sw, capsys) == (124, ["timeout"])
    sw.herdr("idle", seq=1)
    assert wait_with(sw, capsys) == (0, ["atlas pane idle"])


def test_blocked_and_gone_after_idle_are_still_events(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    sw.herdr("idle", seq=1)
    assert wait_with(sw, capsys) == (0, ["atlas pane idle"])
    sw.herdr("blocked", seq=2)
    assert wait_with(sw, capsys) == (0, ["atlas pane blocked"])
    sw.herdr("gone")
    assert wait_with(sw, capsys) == (0, ["atlas pane gone"])


def test_an_open_decision_already_reported_quiets_idle_and_done(sw, capsys):
    sw.write(ATLAS["atlas-150"], DECISION)
    assert wait_with(sw, capsys) == (0, ["atlas atlas-200 DECISION"])
    sw.herdr("idle", seq=2)
    assert wait_with(sw, capsys) == (124, ["timeout"])
    assert wait_with(sw, capsys, (0.3, sw.herdr, ["working", 3]),
                     (0.6, sw.herdr, ["done", 4])) == (124, ["timeout"])


def test_an_open_decision_does_not_quiet_blocked(sw, capsys):
    sw.write(ATLAS["atlas-150"], DECISION)
    assert wait_with(sw, capsys) == (0, ["atlas atlas-200 DECISION"])
    sw.herdr("blocked", seq=2)
    assert wait_with(sw, capsys) == (0, ["atlas pane blocked"])


def test_blocked_then_idle_behind_a_reported_decision_is_an_event(sw, capsys):
    # The switchboard last heard blocked, and the DECISION does not tell it
    # the block is gone; resting after that is quiet again.
    sw.write(ATLAS["atlas-150"], DECISION)
    assert wait_with(sw, capsys) == (0, ["atlas atlas-200 DECISION"])
    sw.herdr("blocked", seq=8)
    assert wait_with(sw, capsys) == (0, ["atlas pane blocked"])
    sw.herdr("idle", seq=9)
    assert wait_with(sw, capsys) == (0, ["atlas pane idle"])
    sw.herdr("done", seq=10)
    assert wait_with(sw, capsys) == (124, ["timeout"])


def test_an_answered_decision_brings_pane_reports_back(sw, capsys):
    sw.write(ATLAS["atlas-150"], DECISION)
    assert wait_with(sw, capsys) == (0, ["atlas atlas-200 DECISION"])
    sw.herdr("idle", seq=2)
    assert wait_with(sw, capsys) == (124, ["timeout"])
    sw.append("ANSWERED atlas-200: b (2026-10-20 09:30)\n\n")
    assert wait_with(sw, capsys, (0.3, sw.herdr, ["working", 3]),
                     (0.6, sw.herdr, ["idle", 4]), timeout=10) == (0, ["atlas pane idle"])


def test_a_decided_that_replaces_it_brings_pane_reports_back(sw, capsys):
    sw.write(ATLAS["atlas-150"], DECISION)
    assert wait_with(sw, capsys) == (0, ["atlas atlas-200 DECISION"])
    sw.append("## atlas-201 DECIDED 2026-10-20 09:40\nReplaces atlas-200\n"
              "Adam said in the pane: \"b\".\n\n")
    assert wait_with(sw, capsys, (0.3, sw.herdr, ["idle", 2]),
                     timeout=10) == (0, ["atlas pane idle"])


def test_a_new_decision_that_replaces_it_is_reported(sw, capsys):
    sw.write(ATLAS["atlas-150"], DECISION)
    sw.herdr("idle", seq=2)
    assert wait_with(sw, capsys) == (0, ["atlas atlas-200 DECISION"])
    sw.append("## atlas-202 DECISION 2026-10-20 10:00 Replaces atlas-200\n"
              "Attempted: y\n\n")
    assert wait_with(sw, capsys) == (0, ["atlas atlas-202 DECISION"])
    sw.herdr("done", seq=3)
    assert wait_with(sw, capsys) == (124, ["timeout"])


def test_a_decision_and_the_pane_stopping_in_one_poll_report_the_decision(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    assert wait_with(sw, capsys) == (124, ["timeout"])

    def ask():
        sw.append(DECISION)
        sw.herdr("idle", seq=2)

    assert wait_with(sw, capsys, (0.3, ask, []), timeout=10) == (0, ["atlas atlas-200 DECISION"])


def test_a_grant_after_the_decision_brings_pane_reports_back(sw, capsys):
    sw.write(ATLAS["atlas-150"], DECISION)
    assert wait_with(sw, capsys) == (0, ["atlas atlas-200 DECISION"])
    sw.herdr("idle", seq=2)
    assert wait_with(sw, capsys) == (124, ["timeout"])
    sw.append('## atlas-g1 GRANT 2026-10-20 09:30\nAdam: "go on"\nScope: x\n\n')
    assert wait_with(sw, capsys, (0.3, sw.herdr, ["working", 3]),
                     (0.6, sw.herdr, ["idle", 4]), timeout=10) == (0, ["atlas pane idle"])


def test_status_still_shows_the_pane_while_a_decision_is_open(sw, capsys):
    sw.write(ATLAS["atlas-150"], DECISION)
    sw.herdr("idle", seq=2)
    sw.run(capsys=capsys)
    assert sw.script.main(["--status", f"{sw.repo}:w1:p2"]) == 0
    assert capsys.readouterr().out.splitlines() == [
        "atlas atlas-200 DECISION Attempted: x", "atlas pane idle", "atlas wait none"]


# Requests from the Orchi panel.

def test_a_request_waiting_at_start_is_reported(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    sw.request()
    rc, lines, took = sw.run(timeout=5, capsys=capsys)
    assert (rc, lines) == (0, ["requests"])
    assert took < 2


def test_a_request_during_a_wait_is_reported(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    threading.Timer(0.3, sw.request).start()
    rc, lines, took = sw.run(timeout=10, capsys=capsys)
    assert (rc, lines) == (0, ["requests"])
    assert took < 5


def test_a_request_still_there_is_reported_on_every_start(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    sw.request()
    assert sw.run(capsys=capsys)[:2] == (0, ["requests"])
    assert sw.run(capsys=capsys)[:2] == (0, ["requests"])


def test_a_handled_request_is_not_reported(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    sw.request().unlink()
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])


def test_a_request_comes_with_the_other_events(sw, capsys):
    sw.write(ATLAS["atlas-151"])
    sw.request()
    assert sw.run(capsys=capsys)[1] == ["requests", "atlas atlas-151 DECISION"]


def test_hidden_files_are_not_requests(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    sw.request(name=".DS_Store")
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])


def test_a_folder_is_not_a_request(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    (sw.request().parent / "sub").mkdir()
    for f in sw.request().parent.glob("*.req"):
        f.unlink()
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])


def test_requests_sit_beside_the_state_file_given(sw, capsys, tmp_path):
    other = tmp_path / "other"
    (other / "requests").mkdir(parents=True)
    (other / "requests" / "1.req").write_text("start s1\n")
    assert sw.script.main(["--timeout", "1", "--state", str(other / "state.md")]) == 0
    assert capsys.readouterr().out.splitlines() == ["requests"]


def test_an_empty_watch_list_waits_for_a_request(sw, capsys):
    threading.Timer(0.3, sw.request).start()
    assert sw.script.main(["--timeout", "10"]) == 0
    assert capsys.readouterr().out.splitlines() == ["requests"]


def test_an_empty_watch_list_times_out(sw, capsys):
    assert sw.script.main(["--timeout", "1"]) == 124
    assert capsys.readouterr().out.splitlines() == ["timeout"]


# Paused projects.

def test_a_paused_project_reports_nothing(sw, capsys):
    sw.write(ATLAS["atlas-151"])
    sw.herdr("idle")
    sw.pause()
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])


def test_a_paused_project_keeps_its_news_for_after(sw, capsys):
    sw.write(ATLAS["atlas-151"])
    sw.pause()
    sw.run(capsys=capsys)
    sw.started("2026-01-01 00:00")
    assert sw.run(capsys=capsys)[1] == ["atlas atlas-151 DECISION"]


def test_only_the_paused_project_is_left_out(sw, capsys, tmp_path):
    other = tmp_path / "birch"
    (other / ".legwork").mkdir(parents=True)
    (other / ".legwork" / "switchboard.md").write_text(ATLAS["atlas-151"])
    sw.write(ATLAS["atlas-151"])
    sw.pause()
    assert sw.script.main(["--timeout", "1", f"{sw.repo}:w1:p2", f"{other}:w2:p2"]) == 0
    assert capsys.readouterr().out.splitlines() == ["birch atlas-151 DECISION"]


def test_a_paused_project_still_hears_a_request(sw, capsys):
    sw.pause()
    threading.Timer(0.3, sw.request).start()
    assert sw.run(timeout=10, capsys=capsys)[:2] == (0, ["requests"])


def test_a_paused_project_lists_no_wait(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    sw.pause()
    sw.run(capsys=capsys)
    assert not (sw.repo / ".legwork" / "switchboard-wait.pids").exists()


def test_a_cycle_line_after_the_paused_section_is_no_project(sw, capsys):
    sw.pause()
    with open(sw.state, "a") as f:
        f.write("CYCLE 2026-10-10 23:58\n")
    assert sw.script.paused_repos(str(sw.state)) == {str(sw.repo)}


def test_status_says_paused_and_still_shows_what_is_open(sw, capsys):
    sw.write(ATLAS["atlas-151"])
    sw.herdr("idle")
    sw.pause()
    assert sw.script.main(["--status", f"{sw.repo}:w1:p2"]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert lines[0].startswith("atlas atlas-151 DECISION")
    assert lines[1:] == ["atlas pane idle", "atlas paused"]


def test_status_of_a_project_not_paused_has_no_paused_line(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    assert sw.script.main(["--status", f"{sw.repo}:w1:p2"]) == 0
    assert "atlas paused" not in capsys.readouterr().out


# ACTION entries are reported as DECISION entries are.

ACTION = ("## atlas-200 ACTION 2026-10-30 22:40\n"
          "Why: the deploy needs Adam's login\n"
          "Do: run the deploy\n"
          "Where: this terminal\n"
          "Blocks: the release\n"
          "Meanwhile: the docs\n\n")


def test_an_open_action_is_reported_on_start(sw, capsys):
    sw.write(ACTION)
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas atlas-200 ACTION"])
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])


def test_a_new_action_during_a_wait_is_reported(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    threading.Timer(0.3, sw.append, [ACTION]).start()
    assert sw.run(timeout=5, capsys=capsys)[:2] == (0, ["atlas atlas-200 ACTION"])


def test_an_answered_action_is_not_reported(sw, capsys):
    sw.write(ACTION, "ANSWERED atlas-200: completed: done (2026-10-30 22:50)\n")
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])


def test_a_replaced_action_is_not_reported(sw, capsys):
    sw.write(ACTION, "## atlas-201 DECIDED 2026-10-30 22:50\nReplaces atlas-200\nDone by hand.\n\n")
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])


def test_an_open_action_already_reported_quiets_idle_and_done(sw, capsys):
    sw.write(ACTION)
    sw.herdr("working")
    sw.run(capsys=capsys)
    sw.herdr("idle", seq=2)
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])


def test_status_shows_an_open_action_with_its_first_line(sw, capsys):
    sw.write(ACTION)
    assert sw.script.main(["--status", f"{sw.repo}:w1:p2"]) == 0
    assert capsys.readouterr().out.splitlines()[0] == (
        "atlas atlas-200 ACTION Why: the deploy needs Adam's login")


# The switchboard wakes on an UPDATE, so Adam hears what a run is doing as it happens.
def test_new_update_wakes_a_running_wait(sw, capsys):
    sw.write(ATLAS["atlas-150"])
    t = threading.Timer(0.5, sw.append, ["## atlas-153 UPDATE 2026-03-14 20:31\nItem 1 landed.\n"])
    t.start()
    rc, lines, _ = sw.run(timeout=20, capsys=capsys)
    t.join()
    assert (rc, lines) == (0, ["atlas atlas-153 UPDATE"])


def test_update_written_between_waits_reaches_the_next_one(sw, capsys):
    sw.write(ATLAS["atlas-150"], ATLAS["atlas-151"])
    sw.cursor.write_text(json.dumps({str(sw.board): "atlas-151"}))
    sw.append("## atlas-153 UPDATE 2026-03-14 20:31\nItem 1 landed.\n")
    assert sw.run(capsys=capsys)[:2] == (0, ["atlas atlas-153 UPDATE"])


def test_old_update_is_not_reported_on_a_first_start(sw, capsys):
    sw.write("## atlas-153 UPDATE 2026-03-14 20:31\nItem 1 landed.\n")
    assert sw.run(capsys=capsys)[:2] == (124, ["timeout"])


# An ACTION can ask Adam to run /go, with a DONE a moment later. Removing the project
# at that DONE would lose the rest of the run, so the DONE doesn't end the watch.
HANDED_BACK = (ACTION + "## atlas-201 DONE 2026-10-30 22:41\nStopped for Adam's step.\n\n")


def test_done_with_an_open_action_is_reported_once(sw, capsys):
    sw.herdr("idle")
    sw.write(HANDED_BACK)
    rc, lines, _ = sw.run(capsys=capsys)
    assert rc == 0 and "atlas atlas-201 DONE" in lines
    rc, lines, _ = sw.run(capsys=capsys)
    assert "atlas atlas-201 DONE" not in lines


def test_done_comes_back_once_the_action_closes(sw, capsys):
    sw.herdr("idle")
    sw.write(HANDED_BACK)
    sw.run(capsys=capsys)
    sw.append("ANSWERED atlas-200: closed by the switchboard: atlas-202 shows it ran (2026-10-30 23:00)\n")
    rc, lines, _ = sw.run(capsys=capsys)
    assert rc == 0 and "atlas atlas-201 DONE" in lines


def test_an_action_from_an_earlier_run_does_not_hold_a_done(sw, capsys):
    sw.herdr("idle")
    sw.write(ACTION, "## atlas-201 DONE 2026-10-31 09:00\nFinished.\n\n")
    sw.started("2026-10-31 08:00")
    sw.run(capsys=capsys)
    rc, lines, _ = sw.run(capsys=capsys)
    assert rc == 0 and "atlas atlas-201 DONE" in lines
