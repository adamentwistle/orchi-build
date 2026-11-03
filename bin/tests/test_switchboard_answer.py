"""Tests for bin/switchboard-answer.

herdr is replaced by a stub on PATH that records its arguments and exits
with a code each test sets. Switchboard entries come from the same made-up
runs as the switchboard-wait fixtures.
"""
import importlib.machinery
import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "switchboard-answer"
WAIT = HERE.parent / "switchboard-wait"
FIXTURES = HERE / "fixtures"


def load(path, name):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def blocks(name):
    text = (FIXTURES / name).read_text()
    heads = list(re.finditer(r"^## (\S+) ", text, re.M))
    out = {}
    for i, m in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        out[m.group(1)] = text[m.start():end].rstrip("\n") + "\n\n"
    return out


ATLAS = blocks("atlas-switchboard.md")
BIRCH = blocks("birch-switchboard.md")

STUB = """#!{python}
import json, sys
with open({calls!r}, "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
cfg = json.load(open({cfg!r}))
if cfg["code"]:
    print(json.dumps({{"error": {{"code": "agent_not_found"}}}}), file=sys.stderr)
sys.exit(cfg["code"])
"""

STAMP = re.compile(r"\(\d{4}-\d\d-\d\d \d\d:\d\d\)$")


@pytest.fixture
def sa(tmp_path, monkeypatch):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    cfg = tmp_path / "herdr.json"
    calls = tmp_path / "calls.jsonl"
    stub = bindir / "herdr"
    stub.write_text(STUB.format(python=sys.executable, cfg=str(cfg), calls=str(calls)))
    stub.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bindir}:/usr/bin:/bin")
    cfg.write_text(json.dumps({"code": 0}))

    class Env:
        repo = tmp_path / "atlas"
        board = repo / ".legwork" / "switchboard.md"
        planning = tmp_path / "planning" / "s20261030.md"
        script = load(SCRIPT, "switchboard_answer")

        def herdr_fails(self):
            cfg.write_text(json.dumps({"code": 1}))

        def write(self, *texts):
            self.board.parent.mkdir(parents=True, exist_ok=True)
            self.board.write_text("".join(texts))

        def text(self):
            return self.board.read_text()

        def sent(self):
            if not calls.exists():
                return []
            return [json.loads(l) for l in calls.read_text().splitlines()]

        def answer(self, ident, answer, pane="w1:p2"):
            return self.script.main([str(self.repo), pane, ident, answer])

        def on_board(self, ident, answer, pane="t8"):
            return self.script.main(["--board", str(self.planning), pane, ident, answer])

        def grant(self, words, scope, pane="w1:p2"):
            return self.script.main(["--grant", str(self.repo), pane, words,
                                     "--scope", scope])

    return Env()


def test_answer_sends_and_appends(sa):
    sa.write(ATLAS["atlas-150"], ATLAS["atlas-151"].rstrip("\n") + "\n")
    before = sa.text()
    assert sa.answer("atlas-151", "B") == 0
    assert sa.sent() == [["agent", "prompt", "w1:p2", "SWITCHBOARD ANSWER atlas-151: B"]]
    assert sa.text().startswith(before)
    added = sa.text()[len(before):]
    assert added.startswith("ANSWERED atlas-151: B (") and added.endswith(")\n")
    assert STAMP.search(added.strip())


def test_answer_appends_on_own_line_when_file_has_no_final_newline(sa):
    sa.write(ATLAS["atlas-151"].rstrip("\n"))
    assert sa.answer("atlas-151", "A") == 0
    assert "\nANSWERED atlas-151: A (" in sa.text()


def test_answer_passes_quotes_and_colons_byte_for_byte(sa):
    sa.write(ATLAS["atlas-151"])
    words = '''B: "no cache", it's 'fine' $HOME `x` \\n  spaced  '''
    assert sa.answer("atlas-151", words) == 0
    assert sa.sent()[0][3] == f"SWITCHBOARD ANSWER atlas-151: {words}"
    assert f"ANSWERED atlas-151: {words} (" in sa.text()


@pytest.mark.parametrize("words", ["a\nb", "a\r\nb", "a\rb"])
def test_answer_with_newline_is_refused(sa, words, capsys):
    sa.write(ATLAS["atlas-151"])
    before = sa.text()
    assert sa.answer("atlas-151", words) == 2
    assert sa.sent() == [] and sa.text() == before
    assert "newline" in capsys.readouterr().err


def test_answer_empty_is_refused(sa):
    sa.write(ATLAS["atlas-151"])
    assert sa.answer("atlas-151", "  ") == 2
    assert sa.sent() == []


def test_answer_unknown_id_is_refused(sa, capsys):
    sa.write(ATLAS["atlas-150"], ATLAS["atlas-151"])
    before = sa.text()
    assert sa.answer("atlas-999", "B") == 1
    assert sa.sent() == [] and sa.text() == before
    assert "atlas-999" in capsys.readouterr().err


def test_answer_to_update_entry_is_refused(sa):
    sa.write(ATLAS["atlas-150"], ATLAS["atlas-151"])
    assert sa.answer("atlas-150", "B") == 1
    assert sa.sent() == []


def test_answer_already_answered_is_refused(sa):
    sa.write(ATLAS["atlas-151"], "ANSWERED atlas-151: B (2026-03-14 20:10)\n")
    before = sa.text()
    assert sa.answer("atlas-151", "A") == 1
    assert sa.sent() == [] and sa.text() == before


def test_answer_replaced_decision_is_refused(sa):
    # birch-20 says "Replaces birch-17"
    sa.write(BIRCH["birch-17"], BIRCH["birch-20"])
    assert "Replaces birch-17" in sa.text()
    assert sa.answer("birch-17", "A") == 1
    assert sa.sent() == []


def test_answer_when_herdr_fails_writes_nothing(sa, capsys):
    sa.write(ATLAS["atlas-151"])
    before = sa.text()
    sa.herdr_fails()
    assert sa.answer("atlas-151", "B") != 0
    assert sa.text() == before
    assert capsys.readouterr().err


def test_answer_when_herdr_missing_writes_nothing(sa, monkeypatch):
    sa.write(ATLAS["atlas-151"])
    before = sa.text()
    monkeypatch.setenv("PATH", "/nonexistent")
    assert sa.answer("atlas-151", "B") != 0
    assert sa.text() == before


def test_answer_missing_file_is_refused(sa):
    assert sa.answer("atlas-151", "B") == 1
    assert sa.sent() == []
    assert not sa.board.exists()


def test_answer_closes_the_decision_for_a_second_answer(sa):
    sa.write(ATLAS["atlas-151"])
    assert sa.answer("atlas-151", "B") == 0
    assert sa.answer("atlas-151", "A") == 1
    assert len(sa.sent()) == 1


def test_bad_arguments(sa):
    assert sa.script.main([]) == 2
    assert sa.script.main(["only", "three", "args"]) == 2
    assert sa.script.main(["--grant", str(sa.repo), "w1:p2", "words"]) == 2
    assert sa.sent() == []


# GRANT

def test_grant_appends_entry_and_sends(sa):
    sa.write(ATLAS["atlas-150"], ATLAS["atlas-151"])
    assert sa.grant("answer the grill questions", "grill questions only") == 0
    entry = sa.text().split("\n## ")[-1]
    head, adam, scope = entry.splitlines()[:3]
    assert re.fullmatch(r"atlas-g1 GRANT \d{4}-\d\d-\d\d \d\d:\d\d", head)
    assert adam == 'Adam: "answer the grill questions"'
    assert scope == "Scope: grill questions only"
    assert sa.text().endswith("\n")
    call = sa.sent()
    assert len(call) == 1 and call[0][:3] == ["agent", "prompt", "w1:p2"]
    assert call[0][3] == ("SWITCHBOARD GRANT atlas-g1: answer the grill questions "
                          "(Scope: grill questions only)")


def test_grant_number_is_one_more_than_existing_grants(sa):
    sa.write(ATLAS["atlas-150"],
             "## atlas-g1 GRANT 2026-03-15 10:00\nAdam: \"x\"\nScope: y\n\n",
             "## atlas-g2 GRANT 2026-03-15 11:00\nAdam: \"x\"\nScope: y\n\n")
    assert sa.grant("more", "scope") == 0
    assert "## atlas-g3 GRANT " in sa.text()
    assert "SWITCHBOARD GRANT atlas-g3:" in sa.sent()[0][3]


def test_grant_project_from_existing_entry_ids(sa):
    sa.write(BIRCH["birch-17"])
    assert sa.grant("go", "s") == 0
    assert "## birch-g1 GRANT " in sa.text()


def test_grant_project_falls_back_to_repo_dir_name(sa):
    sa.write("")
    assert sa.grant("go", "s") == 0
    assert "## atlas-g1 GRANT " in sa.text()


def test_grant_creates_missing_file(sa):
    sa.repo.mkdir()
    assert sa.grant("go", "s") == 0
    assert sa.text().startswith("## atlas-g1 GRANT ")


def test_grant_when_herdr_fails_writes_nothing(sa):
    sa.write(ATLAS["atlas-151"])
    before = sa.text()
    sa.herdr_fails()
    assert sa.grant("go", "s") != 0
    assert sa.text() == before


@pytest.mark.parametrize("words,scope", [("a\nb", "s"), ("a", "s\nt"), ("", "s"), ("a", " ")])
def test_grant_refuses_newlines_and_empty(sa, words, scope):
    sa.write(ATLAS["atlas-151"])
    before = sa.text()
    assert sa.grant(words, scope) == 2
    assert sa.sent() == [] and sa.text() == before


def test_grant_words_keep_quotes(sa):
    sa.write(ATLAS["atlas-151"])
    assert sa.grant('say "yes" to it', "s") == 0
    assert 'Adam: "say "yes" to it"' in sa.text()


# switchboard-wait still reads what this writes

@pytest.fixture
def wait(tmp_path, monkeypatch):
    mod = load(WAIT, "switchboard_wait_for_answer")
    monkeypatch.setattr(mod, "USAGE_CACHE", str(tmp_path / "no-usage.json"))
    monkeypatch.setattr(mod, "POLL", 0.2)
    return mod


def run_wait(wait, sa, capsys, *flags):
    capsys.readouterr()
    rc = wait.main([*flags, "--timeout", "1", f"{sa.repo}:w1:p2"]
                   if not flags else [*flags, f"{sa.repo}:w1:p2"])
    return rc, capsys.readouterr().out.splitlines()


def open_decisions(lines):
    return [l for l in lines if " DECISION" in l]


def test_wait_sees_written_answer_as_closing_the_decision(sa, wait, capsys):
    sa.write(ATLAS["atlas-150"], ATLAS["atlas-151"])
    assert len(open_decisions(run_wait(wait, sa, capsys, "--status")[1])) == 1
    assert sa.answer("atlas-151", "B") == 0
    assert open_decisions(run_wait(wait, sa, capsys, "--status")[1]) == []


def test_wait_ignores_a_written_grant(sa, wait, capsys):
    sa.write(ATLAS["atlas-150"], ATLAS["atlas-151"])
    before = open_decisions(run_wait(wait, sa, capsys, "--status")[1])
    assert sa.grant("answer the grill questions", "grill only") == 0
    entries = wait.parse(str(sa.board))[0]
    assert [e[0] for e in entries] == ["atlas-150", "atlas-151"]
    assert open_decisions(run_wait(wait, sa, capsys, "--status")[1]) == before


def test_wait_reports_next_decision_after_grant_and_answer(sa, wait, capsys):
    sa.write(ATLAS["atlas-151"])
    assert sa.grant("go", "s") == 0
    assert sa.answer("atlas-151", "B") == 0
    sa.board.write_text(sa.text() + "\n" + ATLAS["atlas-164"])
    rc, lines = run_wait(wait, sa, capsys)
    assert open_decisions(lines) == ["atlas atlas-164 DECISION"]


# ACTION entries close the same way.

ACTION = ("## atlas-200 ACTION 2026-10-30 22:40\n"
          "Why: the deploy needs Adam's login\n"
          "Do: run the deploy\n"
          "Where: this terminal\n"
          "Run: ! gh pr merge 12 --squash\n"
          "Blocks: the release\n"
          "Meanwhile: the docs\n\n")


def test_an_action_can_be_marked_completed(sa):
    sa.write(ACTION)
    assert sa.answer("atlas-200", "completed: done, deployed at 22:50") == 0
    assert sa.sent() == [["agent", "prompt", "w1:p2",
                          "SWITCHBOARD ANSWER atlas-200: completed: done, deployed at 22:50"]]
    assert "\nANSWERED atlas-200: completed: done, deployed at 22:50 (" in sa.text()


def test_an_action_only_closes_once(sa):
    sa.write(ACTION)
    assert sa.answer("atlas-200", "completed: yes") == 0
    assert sa.answer("atlas-200", "completed: again") == 1
    assert len(sa.sent()) == 1


def test_an_action_that_was_replaced_is_refused(sa):
    sa.write(ACTION, "## atlas-201 ACTION 2026-10-30 22:41 Replaces atlas-200\nWhy: x\n\n")
    assert sa.answer("atlas-200", "completed: yes") == 1
    assert sa.answer("atlas-201", "completed: yes") == 0


def test_an_update_is_still_refused(sa):
    sa.write("## atlas-1 UPDATE 2026-10-30 22:40\nStarted.\n\n")
    assert sa.answer("atlas-1", "A") == 1
    assert sa.sent() == []


# Planner boards.

PLAN_ONE = ("## plan-1 DECISION 2026-10-30 22:40\n"
            "Attempted: read the tickets\n"
            "Uncertain: which first\n"
            "Options: A) one B) two\n"
            "Recommendation: A\n"
            "Blocks: the plan\n"
            "Meanwhile: nothing\n\n")


def board(sa, *texts):
    sa.planning.parent.mkdir(exist_ok=True)
    sa.planning.write_text("".join(texts))


def test_board_answer_sends_and_appends(sa):
    board(sa, PLAN_ONE)
    assert sa.on_board("plan-1", "A") == 0
    assert sa.sent() == [["agent", "prompt", "t8", "SWITCHBOARD ANSWER plan-1: A"]]
    text = sa.planning.read_text()
    assert text.startswith(PLAN_ONE)
    added = text[len(PLAN_ONE):]
    assert added.startswith("ANSWERED plan-1: A (") and STAMP.search(added.strip())


def test_board_answer_leaves_no_folder_beside_the_board(sa):
    board(sa, PLAN_ONE)
    assert sa.on_board("plan-1", "A") == 0
    assert [p.name for p in sa.planning.parent.iterdir()] == [sa.planning.name]


def test_board_takes_an_action_too(sa):
    board(sa, PLAN_ONE, ACTION)
    assert sa.on_board("atlas-200", "completed: yes") == 0
    assert "\nANSWERED atlas-200: completed: yes (" in sa.planning.read_text()


def test_board_refuses_what_is_not_open(sa):
    board(sa, PLAN_ONE, "ANSWERED plan-1: A (2026-10-30 22:41)\n")
    before = sa.planning.read_text()
    assert sa.on_board("plan-1", "B") == 1
    assert sa.on_board("plan-2", "B") == 1
    assert sa.sent() == []
    assert sa.planning.read_text() == before


def test_board_with_plan_entries_after_the_question(sa):
    board(sa, PLAN_ONE, "## s1-p1 PLAN 2026-10-30 22:42\nProject: birch\n"
                        "## s1-ready READY 2026-10-30 22:43\n")
    assert sa.on_board("plan-1", "A") == 0


def test_board_missing_sends_nothing_and_creates_nothing(sa):
    assert sa.on_board("plan-1", "A") == 1
    assert sa.sent() == []
    assert not sa.planning.exists()


def test_board_herdr_failure_writes_nothing(sa):
    board(sa, PLAN_ONE)
    sa.herdr_fails()
    assert sa.on_board("plan-1", "A") == 1
    assert sa.planning.read_text() == PLAN_ONE


def test_board_refuses_a_newline(sa):
    board(sa, PLAN_ONE)
    assert sa.on_board("plan-1", "A\nB") == 2
    assert sa.sent() == []


@pytest.mark.parametrize("args", [["--board"], ["--board", "f", "p", "i"],
                                  ["--board", "f", "p", "i", "a", "extra"]])
def test_board_bad_arguments(sa, args):
    assert sa.script.main(args) == 2


OPEN = "## birch-1 ACTION 2026-10-31 20:06\nWhy: x\nDo: run /go birch\n\n"


def close(sa, ident, why):
    return sa.script.main(["--close", str(sa.repo), ident, why])


def test_close_appends_and_sends_nothing(sa):
    sa.write(OPEN)
    assert close(sa, "birch-1", "birch-2 shows it ran") == 0
    assert sa.sent() == []
    assert re.search(r"^ANSWERED birch-1: closed by the switchboard: birch-2 shows it ran "
                     r"\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$", sa.text(), re.M)


def test_close_refuses_what_is_not_open(sa):
    sa.write("## birch-1 UPDATE 2026-10-31 20:06\nNot a question.\n\n")
    assert close(sa, "birch-1", "why") == 1
    assert close(sa, "birch-9", "why") == 1
    assert "ANSWERED" not in sa.text()


def test_close_needs_a_reason_on_one_line(sa):
    sa.write(OPEN)
    assert close(sa, "birch-1", "two\nlines") == 2
    assert close(sa, "birch-1", "  ") == 2
    assert "ANSWERED" not in sa.text()


def test_closed_entry_can_not_be_answered(sa):
    sa.write(OPEN)
    close(sa, "birch-1", "settled")
    assert sa.answer("birch-1", "completed: done") == 1
    assert sa.sent() == []


def test_close_works_on_a_planner_board(sa):
    sa.planning.parent.mkdir(parents=True, exist_ok=True)
    sa.planning.write_text(OPEN)
    assert sa.script.main(["--close", "--board", str(sa.planning), "birch-1", "settled"]) == 0
    assert "closed by the switchboard: settled" in sa.planning.read_text()
    assert sa.sent() == []


def finish(sa, why="Marked complete by Adam."):
    return sa.script.main(["--finish", str(sa.repo), why])


def test_finish_closes_what_is_open_and_writes_a_done(sa):
    sa.write(OPEN, "## birch-2 UPDATE 2026-10-31 21:00\nStill going.\n\n")
    assert finish(sa) == 0
    assert sa.sent() == []
    text = sa.text()
    assert re.search(r"^ANSWERED birch-1: closed by Adam: run finished \(", text, re.M)
    assert re.search(r"^## birch-3 DONE \d{4}-\d{2}-\d{2} \d{2}:\d{2}\nMarked complete by Adam\.$", text, re.M)


def test_finish_is_seen_as_the_end_of_the_run(sa, wait):
    sa.write(OPEN)
    finish(sa)
    entries, answered = wait.parse(str(sa.board))
    assert entries[-1][1] == "DONE"
    assert [entries[i][1] for i in wait.reportable(entries, answered, -1, False)] == ["DONE"]


def test_finish_twice_writes_one_done(sa):
    sa.write(OPEN)
    finish(sa)
    once = sa.text()
    assert finish(sa) == 0
    assert sa.text() == once


def test_finish_numbers_past_a_grant_and_a_repeated_id(sa):
    sa.write("## birch-7 UPDATE 2026-10-31 21:00\nA.\n\n## birch-g2 GRANT 2026-10-31 21:01\nAdam: \"x\"\nScope: y\n\n")
    finish(sa)
    assert "## birch-8 DONE " in sa.text()


def test_finish_on_an_empty_repo_uses_its_name(sa):
    assert finish(sa) == 0
    assert re.search(r"^## atlas-1 DONE ", sa.text(), re.M)


def test_finish_needs_a_reason_on_one_line(sa):
    sa.write(OPEN)
    assert finish(sa, "two\nlines") == 2
    assert finish(sa, "  ") == 2
    assert "DONE" not in sa.text()
