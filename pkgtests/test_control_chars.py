"""Text that comes from outside (Linear and GitHub, legwork and Markdown files, a server's reply) is shown at a terminal
without its control characters, at every place orchi writes it. One test class per kind of site; each uses a name such
as "\\x1b]0;evil\\x07Team" that would retitle the terminal window if it were written as it came.

--json is exact JSON: the control characters are escaped, and the text reads back the same.
"""
import io
import json
import os
import re
from pathlib import Path

import pytest

from engine_help import home  # noqa: F401
from mac_help import mac  # noqa: F401
from test_update import computer, site  # noqa: F401
from orchi import cli, engine, screen, sources, steps, store
from orchi.tickets import github, linear

EVIL = "\x1b]0;evil\x07Team"
C1 = "a\x9b31mb\x7fc\x85d"
BAD = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
KEY = "not-a-real-key"


def clean(text):
    assert not BAD.search(text), repr(text)


def settings(**values):
    Path(os.environ["ORCHI_SETTINGS"]).parent.mkdir(parents=True, exist_ok=True)
    Path(os.environ["ORCHI_SETTINGS"]).write_text(json.dumps(values))


def run(capsys, *argv):
    code = cli.main(["tickets", *argv])
    out = capsys.readouterr()
    return code, out.out, out.err


@pytest.fixture
def box(tmp_path, monkeypatch):
    """A home with a legwork folder and a notes folder, in made-up data."""
    base = tmp_path / "home"
    (base / "legwork" / "projects").mkdir(parents=True)
    (base / "notes").mkdir()
    monkeypatch.setenv("HOME", str(base))
    monkeypatch.setenv("LINEAR_API_KEY", KEY)
    return base


def linear_node(**over):
    node = {"identifier": "ENG-12", "title": EVIL, "url": "https://linear.app/acme/issue/ENG-12",
            "updatedAt": "2026-10-30T09:15:00.000Z", "description": "line one\x1b[2J\nline two\x9b",
            "state": {"name": f"In {EVIL}", "type": "started"}, "project": {"name": EVIL},
            "labels": {"nodes": [{"name": EVIL}]}}
    node.update(over)
    return node


def fake_linear(monkeypatch, node=None, error=None):
    def post(query, variables, key):
        if error:
            raise linear.SourceError(error)
        if "issue(id:" in query:
            return {"data": {"issue": node or linear_node()}}
        return {"data": {"issues": {"nodes": [node or linear_node()], "pageInfo": {"hasNextPage": False}}}}

    monkeypatch.setattr(linear, "post", post)


def fake_gh(monkeypatch, stderr=None):
    issue = {"number": 7, "title": EVIL, "state": "OPEN", "url": "https://github.com/acme/app/issues/7",
             "updatedAt": "2026-10-28T12:00:00Z", "labels": [{"name": EVIL}], "body": "body\x1b[31m\nmore\x9b"}

    def gh(argv):
        if stderr:
            raise github.SourceError(stderr)
        return json.dumps([issue] if argv[1:3] == ["issue", "list"] else issue)

    monkeypatch.setattr(github, "run", gh)


def legwork_file(box, **fields):
    lines = "\n".join(f"{k}: {v}" for k, v in fields.items())
    (box / "legwork" / "projects" / "birch.md").write_text(f"---\n{lines}\n---\n\nbody \x1b[2J here\x9b\n")


def notes_file(box):
    (box / "notes" / "todo.md").write_text(f"- [ ] {EVIL}\n  body \x1b[2J line\n")


def all_sources():
    settings(sources=["legwork", "github", "linear", "markdown"], legwork_dir="~/legwork",
             github={"repos": ["acme/app"], "command": "gh"}, linear={"teams": ["ENG"]},
             markdown={"paths": ["~/notes"]})


# The helper

def test_plain_drops_c0_del_and_c1_but_keeps_newline_and_tab_when_it_may():
    from orchi import plain
    every = "".join(chr(n) for n in range(0x20)) + "\x7f" + "".join(chr(n) for n in range(0x80, 0xa0))
    clean(plain.plain(every))
    assert plain.plain("a\tb\nc") == "a b c"
    assert plain.plain("a\tb\nc", lines=True) == "a\tb\nc"
    clean(plain.plain(EVIL, lines=True))
    assert "Team" in plain.plain(EVIL) and "\x1b" not in plain.plain(EVIL)
    assert plain.plain(None) == "" and plain.plain("bad\udcff") == "bad\\udcff"


def test_plain_dumps_escapes_what_json_leaves_raw_and_reads_back_exact():
    from orchi import plain
    value = {"text": C1 + EVIL, "list": [EVIL]}
    shown = plain.dumps(value)
    clean(shown)
    assert json.loads(shown) == value


def test_plain_keeps_a_zero_and_json_keeps_a_name_that_is_not_utf8_printable():
    from orchi import plain
    assert plain.plain(0) == "0" and plain.plain(False) == "False" and plain.plain("") == ""
    shown = plain.dumps({"file": "bad\udcff.md"})
    shown.encode("utf-8")
    assert json.loads(shown) == {"file": "bad\udcff.md"}


# Tickets listed, one site per source

def test_a_linear_title_state_and_reference_list_without_control_characters(box, monkeypatch, capsys):
    settings(sources=["legwork", "linear"], linear={"teams": ["ENG"]})
    fake_linear(monkeypatch)
    code, out, err = run(capsys)
    clean(out + err)
    assert "Team" in out and code == 0


def test_a_github_title_and_state_list_without_control_characters(box, monkeypatch, capsys):
    settings(sources=["legwork", "github"], github={"repos": ["acme/app"], "command": "gh"})
    fake_gh(monkeypatch)
    code, out, err = run(capsys)
    clean(out + err)
    assert "Team" in out and code == 0


def test_legwork_file_text_lists_without_control_characters(box, capsys):
    settings(sources=["legwork"], legwork_dir="~/legwork")
    legwork_file(box, name=EVIL, status="queued\x1b[2J", category="work")
    code, out, err = run(capsys)
    clean(out + err)
    assert "Team" in out and code == 0


def test_markdown_task_text_lists_without_control_characters(box, capsys):
    settings(sources=["legwork", "markdown"], markdown={"paths": ["~/notes"]})
    notes_file(box)
    code, out, err = run(capsys)
    clean(out + err)
    assert "Team" in out and code == 0


def test_the_columns_line_up_when_a_reference_shows_escapes(box, monkeypatch, capsys):
    from orchi.tickets import cli as tickets_cli
    settings(sources=["legwork"])
    rows = [{"ref": "md:~/bad\udcff.md#x", "state": "open", "title": "one"},
            {"ref": "legwork:birch", "state": "open", "title": "two"}]
    monkeypatch.setattr(tickets_cli, "list_tickets", lambda s, sources: (rows, []))
    code, out, _ = run(capsys)
    first, second = out.splitlines()
    assert code == 0 and first.index("open") == second.index("open")


# One ticket read on its own

@pytest.mark.parametrize("ref", ["linear:ENG-12", "gh:acme/app#7", "legwork:birch", "md:~/notes/todo.md#team"])
def test_show_prints_title_state_and_body_without_control_characters(box, monkeypatch, capsys, ref):
    all_sources()
    fake_linear(monkeypatch)
    fake_gh(monkeypatch)
    legwork_file(box, name=EVIL, status="queued\x1b[2J", updated="2026\x9b")
    notes_file(box)
    (box / "notes" / "todo.md").write_text("- [ ] Team\n  body \x1b[2J line\x9b\n")
    code, out, err = run(capsys, "show", ref)
    clean(out + err)
    assert code == 0 and "team" in out.lower() and out.count("\n") >= 4


# A server's reply quoted in an error

def test_a_linear_error_message_is_shown_without_control_characters(box, monkeypatch, capsys):
    settings(sources=["legwork", "linear"], linear={"teams": ["ENG"]})
    fake_linear(monkeypatch, error=f"Linear said {EVIL}")
    code, out, err = run(capsys)
    clean(out + err)
    assert code == 1 and "Linear said" in err
    code, out, err = run(capsys, "show", "linear:ENG-12")
    clean(out + err)
    assert code == 1 and "Linear said" in err


def test_a_gh_error_line_is_shown_without_control_characters(box, monkeypatch, capsys):
    settings(sources=["legwork", "github"], github={"repos": ["acme/app"], "command": "gh"})
    fake_gh(monkeypatch, stderr=f"gh said {EVIL}")
    code, out, err = run(capsys)
    clean(out + err)
    assert code == 1 and "gh said" in err
    code, out, err = run(capsys, "show", "gh:acme/app#7")
    clean(out + err)
    assert code == 1 and "gh said" in err


# The states of a Linear issue, and the plans of writes

def writable(states=EVIL):
    team = {"id": "t1", "key": "ENG", "states": {"nodes": [
        {"id": "s1", "name": f"Todo {states}", "type": "unstarted", "position": 1},
        {"id": "s2", "name": f"In Progress {states}", "type": "started", "position": 2}]},
        "projects": {"nodes": [{"id": "p1", "name": f"Birch {states}"}]}}
    return {"id": "i1", "identifier": "ENG-12", "state": team["states"]["nodes"][1], "project": None, "team": team}


def fake_writable(monkeypatch, reply=None):
    def post(query, variables, key):
        if "query Writable" in query:
            return {"data": {"issue": writable()}}
        if reply:
            return reply
        raise AssertionError(query)

    monkeypatch.setattr(linear, "post", post)


def test_state_names_list_without_control_characters(box, monkeypatch, capsys):
    settings(sources=["legwork", "linear"], linear={"teams": ["ENG"]})
    fake_writable(monkeypatch)
    code, out, err = run(capsys, "states", "ENG-12")
    clean(out + err)
    assert code == 0 and "Todo" in out


def test_a_plan_names_what_linear_said_without_control_characters(box, monkeypatch, capsys):
    settings(sources=["legwork", "linear"], linear={"teams": ["ENG"]})
    fake_writable(monkeypatch)
    code, out, err = run(capsys, "move", "ENG-12", "Nowhere", "--dry-run")
    clean(out + err)
    assert code == 1 and "is not a state" in err
    code, out, err = run(capsys, "move", "ENG-12", "Todo \x1b]0;evil\x07Team", "--back", "--dry-run")
    clean(out + err)
    assert code == 0 and "Todo" in out


def test_a_failed_write_shows_the_servers_reason_without_control_characters(box, monkeypatch, capsys):
    settings(sources=["legwork", "linear"], linear={"teams": ["ENG"]})
    fake_writable(monkeypatch, reply={"errors": [{"message": f"refused {EVIL}"}], "data": None})
    code, out, err = run(capsys, "comment", "ENG-12", "hello", "--yes")
    clean(out + err)
    assert code == 1 and "refused" in out + err


# --json stays exact JSON

def test_json_lists_escape_control_characters_and_read_back_exact(box, monkeypatch, capsys):
    all_sources()
    fake_linear(monkeypatch)
    fake_gh(monkeypatch)
    legwork_file(box, name=EVIL, status="queued\x1b[2J")
    notes_file(box)
    code, out, _ = run(capsys, "--json")
    assert code == 0
    clean(out)
    got = json.loads(out)
    titles = {t["source"]: t["title"] for t in got["tickets"]}
    assert titles == {"legwork": EVIL, "github": EVIL, "linear": EVIL, "markdown": EVIL}
    states = {t["source"]: t["state"] for t in got["tickets"]}
    assert states["legwork"] == "queued\x1b[2J" and states["linear"] == f"In {EVIL}"


def test_json_show_and_errors_escape_control_characters(box, monkeypatch, capsys):
    all_sources()
    fake_linear(monkeypatch)
    code, out, _ = run(capsys, "show", "linear:ENG-12", "--json")
    clean(out)
    assert code == 0 and json.loads(out)["body"] == "line one\x1b[2J\nline two\x9b"
    settings(sources=["legwork", "linear"], linear={"teams": ["ENG"]})
    fake_linear(monkeypatch, error=f"Linear said {EVIL}")
    code, out, _ = run(capsys, "--json")
    clean(out)
    assert code == 1 and json.loads(out)["problems"][0]["message"] == f"Linear said {EVIL}"


def test_json_plans_escape_control_characters_and_read_back_exact(box, monkeypatch, capsys):
    settings(sources=["legwork", "linear"], linear={"teams": ["ENG"]})
    fake_writable(monkeypatch)
    code, out, _ = run(capsys, "comment", "ENG-12", f"hi {EVIL}", "--dry-run", "--json")
    clean(out)
    assert code == 0 and json.loads(out)["changes"][0]["text"] == f"hi {EVIL}"
    code, out, _ = run(capsys, "move", "ENG-12", "Nowhere", "--dry-run", "--json")
    clean(out)
    assert code == 1 and EVIL in json.loads(out)["problems"][0]


# Setup's questions

def collect(mac, monkeypatch, **picks):
    """Run the Linear step, and give the lists it offered."""
    mac.settings(sources=["legwork", "linear"])
    mac.picks = picks
    seen = []
    ask_many = mac.ask_many

    def spy(self, question, choices):
        seen.append(list(choices))
        return ask_many(question, choices)

    monkeypatch.setattr(screen.Screen, "ask_many", spy)
    chosen = [s for s in steps.steps() if s.name == "Linear"]
    out = io.StringIO()
    code = engine.run(chosen, fix=True, screen=screen.Screen(out, as_json=True), store=store.Store())
    return code, json.loads(out.getvalue()), seen


def test_team_and_project_names_from_linear_are_offered_without_control_characters(mac, home, monkeypatch):
    mac.linear_teams = {"ENG": EVIL, "OPS": "Operations"}
    mac.linear_projects = {"p1": EVIL, "p2": "Beta"}
    code, report, seen = collect(mac, monkeypatch, teams=["ENG"], projects=["Beta"])
    assert code == 0, report
    assert len(seen) == 2
    for offered in seen:
        for choice in offered:
            clean(choice)
    assert any("Team" in c for c in seen[0]) and any("Team" in c for c in seen[1])
    saved = json.loads(Path(os.environ["ORCHI_SETTINGS"]).read_text())
    assert saved["linear"] == {"teams": ["ENG"], "projects": ["p2"]}


def test_two_projects_whose_names_differ_only_in_control_characters_are_still_two_choices(mac, home, monkeypatch):
    mac.linear_teams = {}
    mac.linear_projects = {"aaaaaaaa1": "Beta\x1b", "bbbbbbbb2": "Beta\x07"}
    code, report, seen = collect(mac, monkeypatch, projects=["bbbbbbbb"])
    assert code == 0, report
    assert len(set(seen[0])) == 2
    saved = json.loads(Path(os.environ["ORCHI_SETTINGS"]).read_text())
    assert saved["linear"]["projects"] == ["bbbbbbbb2"]


def test_a_team_key_or_project_id_with_control_characters_is_offered_clean_and_kept_exact(mac, home, monkeypatch):
    mac.linear_teams = {}
    # Two projects with one name, so the id is shown after it.
    mac.linear_projects = {"p\x1b[2J1": "Alpha", "p2": "Alpha"}
    code, report, seen = collect(mac, monkeypatch, projects=["(p"])
    assert code == 0, report
    clean("".join(seen[0]))
    assert any("p [2J1" in c for c in seen[0])
    saved = json.loads(Path(os.environ["ORCHI_SETTINGS"]).read_text())
    assert saved["linear"]["projects"] == ["p\x1b[2J1", "p2"]


def test_choices_that_look_alike_once_control_characters_are_gone_still_get_one_each():
    text, back = sources.listed({"aaaaaaaa\x1b1": "Beta\x1b", "aaaaaaaa\x071": "Beta\x07"}, False)
    clean("".join(text.values()))
    assert len(text) == 2 and len(back) == 2
    assert sorted(back.values()) == ["aaaaaaaa\x071", "aaaaaaaa\x1b1"]


def test_listed_choices_are_clean_for_teams_and_projects():
    text, back = sources.listed({"ENG": EVIL}, True)
    clean("".join(text.values()))
    assert list(back.values()) == ["ENG"]
    text, back = sources.listed({"p1": EVIL, "p2": EVIL}, False)
    clean("".join(text.values()))
    assert sorted(back.values()) == ["p1", "p2"]


def text_run(mac, monkeypatch):
    """The Linear step, shown as lines at a terminal-less stream."""
    chosen = [s for s in steps.steps() if s.name == "Linear"]
    out = io.StringIO()
    code = engine.run(chosen, fix=True, screen=screen.Screen(out, env={"NO_COLOR": "1"}), store=store.Store())
    return code, out.getvalue()


def test_linear_refusing_the_key_with_control_characters_in_its_reply_shows_clean_lines(mac, home, monkeypatch):
    mac.settings(sources=["legwork", "linear"])

    def post(query, variables, key):
        raise linear.SourceError(f"Linear said {EVIL}")

    monkeypatch.setattr(linear, "post", post)
    code, shown = text_run(mac, monkeypatch)
    clean(shown.replace("\n", ""))
    assert code == 1 and "Linear said" in shown


# The screen

def tty(lines):
    class Tty:
        def __init__(self):
            self.lines, self.out = list(lines), []

        def readline(self):
            return self.lines.pop(0) if self.lines else ""

        def write(self, text):
            self.out.append(text)

        def flush(self):
            pass

        def fileno(self):
            return 0

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            pass

    return Tty()


def test_a_step_line_and_the_closing_line_show_outside_text_without_control_characters():
    out = io.StringIO()
    shown = screen.Screen(out, env={"NO_COLOR": "1"})
    shown.begin(["Linear"])
    shown.result("Linear", "broken", f"Linear said {EVIL} {C1}")
    shown.finish({"summary": f"Needs you: {EVIL}.\nKept:\n  {C1}"})
    text = out.getvalue()
    clean(text.replace("\n", ""))
    assert "Linear said" in text and text.endswith("\n") and "Kept:\n" in text


def test_the_json_report_escapes_what_json_leaves_raw_and_reads_back_exact():
    out = io.StringIO()
    shown = screen.Screen(out, as_json=True)
    report = {"steps": [{"name": "Linear", "status": "broken", "detail": C1 + EVIL}], "summary": C1}
    shown.finish(report)
    clean(out.getvalue().replace("\n", ""))
    assert json.loads(out.getvalue()) == report


def test_a_question_and_its_choices_show_without_control_characters_and_the_pick_is_the_original(monkeypatch):
    t = tty(["2\n"])
    monkeypatch.setattr(screen, "open_tty", lambda: t)
    choices = [f"ENG  {EVIL}", f"OPS  {C1}"]
    got = screen.Screen(io.StringIO(), env={"NO_COLOR": "1"}).ask(f"Pick {EVIL}", choices)
    clean("".join(t.out).replace("\n", ""))
    assert got == choices[1]
    t = tty(["1\n"])
    monkeypatch.setattr(screen, "open_tty", lambda: t)
    got = screen.Screen(io.StringIO(), env={"NO_COLOR": "1"}).ask_many(f"Pick {EVIL}", choices)
    clean("".join(t.out).replace("\n", ""))
    assert got == [choices[0]]


def test_a_typed_choice_matches_the_text_that_was_shown_even_when_it_ends_in_a_control_character(monkeypatch):
    t = tty(["Beta\n"])
    monkeypatch.setattr(screen, "open_tty", lambda: t)
    got = screen.Screen(io.StringIO(), env={"NO_COLOR": "1"}).ask("Pick", ["Alpha", "Beta\x1b"])
    assert got == "Beta\x1b"


def test_a_typed_choice_matches_the_text_that_was_shown(monkeypatch):
    from orchi import plain
    shown = plain.plain(f"ENG  {EVIL}")
    t = tty([shown + "\n"])
    monkeypatch.setattr(screen, "open_tty", lambda: t)
    got = screen.Screen(io.StringIO(), env={"NO_COLOR": "1"}).ask("Pick", [f"ENG  {EVIL}", "OPS"])
    assert got == f"ENG  {EVIL}"


# Update

def test_a_release_tag_with_control_characters_is_shown_without_them(computer, site, capsys):
    site.tag = EVIL
    assert cli.main(["update"]) == 1
    shown = capsys.readouterr().out
    clean(shown.replace("\n", ""))
    assert "is not a version number" in shown


def test_the_update_report_in_json_escapes_the_tag_and_reads_back_exact(computer, site, capsys):
    site.tag = C1 + EVIL
    assert cli.main(["update", "--json"]) == 1
    shown = capsys.readouterr().out
    clean(shown.replace("\n", ""))
    assert json.loads(shown)["summary"] == f"The newest release, {C1 + EVIL}, is not a version number. Nothing changed."


# A refusal from the system seam names what was refused, which can be a program or an address from outside

def test_a_refusal_naming_outside_text_is_one_clean_line(monkeypatch, capsys):
    from orchi import system

    def refuse(args):
        raise system.Refused(f"{EVIL} is refused while ORCHI_NO_SYSTEM is set")

    monkeypatch.setitem(cli.COMMANDS, "doctor", cli.Command("x", refuse))
    assert cli.main(["doctor"]) == 1
    err = capsys.readouterr().err
    clean(err.replace("\n", ""))
    assert "is refused" in err
