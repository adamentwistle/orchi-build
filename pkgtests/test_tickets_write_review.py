"""Regression tests for the review findings on ticket writes and sync. Same fakes as test_tickets_write.py."""
import json

import pytest

from test_tickets_write import fakes, home, project, run, settings, sync  # noqa: F401  (fixtures and helpers)
from orchi.tickets import linear


def test_an_issue_past_in_review_in_a_later_state_stays(home, fakes, capsys):
    gh, ln = fakes
    settings()
    states = ln.teams["ENG"]["states"]["nodes"]
    review = next(s for s in states if s["name"] == "In Review")
    states.insert(states.index(review) + 1, {"id": "ENG-Ready", "name": "Ready to deploy", "type": "started",
                                             "position": review["position"] + 0.5})
    ln.issues["ENG-13"]["state"] = "Ready to deploy"
    url = gh.pr(9)
    project(home, entry=f"ENG-13 in {url}.")
    code, out, _ = sync(capsys, "--yes")
    assert code == 0 and ln.names() == ["issueUpdate"]
    assert ln.issues["ENG-13"]["state"] == "Ready to deploy"
    assert "linear:ENG-13  skip     already Ready to deploy" in out


@pytest.mark.parametrize("text", ["Worked on ENG-12A.", "Worked on ENG-120.", "See ENG-12B and xENG-12."])
def test_a_longer_word_does_not_name_an_issue(home, fakes, capsys, text):
    gh, ln = fakes
    settings()
    project(home, entry=text)
    assert sync(capsys, "--dry-run") == (0, "Nothing to change.\n", "")


def test_a_branch_name_after_the_key_still_names_it(home, fakes, capsys):
    gh, ln = fakes
    settings()
    url = gh.pr(9, branch="eng-13-fix-export")
    project(home, entry=f"Opened {url}.")
    assert "linear:ENG-13  state    Todo to In Review" in sync(capsys, "--dry-run")[1]


@pytest.fixture
def moved_team(fakes, monkeypatch):
    """Linear answers ENG-12 with an issue that now lives in team OPS, as it does for an issue moved between teams."""
    gh, ln = fakes

    def post(query, variables, key):
        if "issue(id:" in query and variables.get("id") == "ENG-12":
            variables = {**variables, "id": "OPS-3"}
        return ln(query, variables, key)

    monkeypatch.setattr(linear, "post", post)
    return gh, ln


def test_a_write_to_an_issue_now_in_another_team_is_refused(home, moved_team, capsys):
    gh, ln = moved_team
    settings(linear={"teams": ["ENG"]})
    code, out, err = run(capsys, "move", "ENG-12", "Done", "--comment", "x", "--yes")
    assert code == 1 and ln.writes == []
    assert err == "linear:ENG-12: OPS is not one of linear.teams\n"


def test_sync_refuses_an_issue_now_in_another_team(home, moved_team, capsys):
    gh, ln = moved_team
    settings(linear={"teams": ["ENG"]})
    project(home, line="ENG-12", entry="ENG-12.")
    code, out, err = sync(capsys, "--yes")
    assert code == 1 and ln.writes == []
    assert err == "linear:ENG-12: OPS is not one of linear.teams\n"


@pytest.mark.parametrize("field,value", [("isDraft", "false"), ("state", "open-ish"), ("title", ["x"]),
                                         ("url", 5)])
def test_a_pull_request_of_the_wrong_shape_stops_the_sync(home, fakes, capsys, field, value):
    gh, ln = fakes
    settings()
    url = gh.pr(9)
    gh.prs[url][field] = value
    project(home, entry=f"ENG-13 in {url}.")
    code, out, err = sync(capsys, "--yes")
    assert (code, out) == (1, "")
    assert err == f"{url}: gh-personal gave a pull request Orchi can't read\n"
    assert ln.writes == []


@pytest.mark.parametrize("state", [None, "", "merged"])
def test_a_github_issue_whose_state_cannot_be_read_is_not_moved(home, fakes, capsys, state, monkeypatch):
    gh, ln = fakes
    settings()
    real = gh.__call__

    def view(argv):
        said = real(argv)
        if argv[1:3] == ["issue", "view"]:
            issue = json.loads(said)
            issue["state"] = state
            return json.dumps(issue)
        return said

    monkeypatch.setattr("orchi.tickets.github.run", view)
    code, out, err = run(capsys, "move", "gh:acme/app#7", "closed", "--yes")
    assert code == 1 and gh.writes() == []
    assert err == "gh:acme/app#7: gh-personal gave an issue Orchi can't read\n"


def _without(ln, team, name, field):
    state = next(s for s in ln.teams[team]["states"]["nodes"] if s["name"] == name)
    del state[field]


def test_a_target_state_with_no_id_is_unreadable_before_any_write(home, fakes, capsys):
    gh, ln = fakes
    settings()
    _without(ln, "ENG", "In Review", "id")
    url = gh.pr(9)
    project(home, entry=f"ENG-12 in {url}.")
    code, out, err = sync(capsys, "--yes")
    assert code == 1 and ln.writes == []
    assert err == "linear:ENG-12: Linear gave an answer Orchi can't read\n"


def test_a_move_whose_state_has_no_id_writes_nothing(home, fakes, capsys):
    gh, ln = fakes
    settings()
    _without(ln, "ENG", "Done", "id")
    code, out, err = run(capsys, "move", "ENG-12", "Done", "--comment", "x", "--yes")
    assert code == 1 and ln.writes == []
    assert err == "linear:ENG-12: Linear gave an answer Orchi can't read\n"


def test_an_issue_state_with_no_name_is_unreadable_not_a_crash(home, fakes, capsys, monkeypatch):
    gh, ln = fakes
    settings()
    real = ln.node

    def node(key):
        got = real(key)
        del got["state"]["name"]
        return got

    monkeypatch.setattr(ln, "node", node)
    for status in ("review", "icebox"):
        project(home, status=status, line="ENG-12", entry="ENG-12.")
        code, out, err = sync(capsys, "--dry-run")
        assert (code, out) == (1, "")
        assert err == "linear:ENG-12: Linear gave an answer Orchi can't read\n"


def test_a_project_with_no_id_is_unreadable(home, fakes, capsys):
    gh, ln = fakes
    settings()
    del ln.teams["ENG"]["projects"]["nodes"][1]["id"]
    code, out, err = run(capsys, "move", "ENG-12", "Done", "--project", "Login", "--yes")
    assert code == 1 and ln.writes == []
    assert err == "linear:ENG-12: Linear gave an answer Orchi can't read\n"


@pytest.mark.parametrize("link,shown", [
    ("https://github.com/acme/app/releases/tag/release/v1.2", "https://github.com/acme/app/releases/tag/release/v1.2"),
    ("https://github.com/acme/app/releases/tag/v1.2.", "https://github.com/acme/app/releases/tag/v1.2"),
    ("(https://github.com/acme/app/releases/tag/v1.2)", "https://github.com/acme/app/releases/tag/v1.2"),
])
def test_a_release_link_is_taken_whole(home, fakes, capsys, link, shown):
    gh, ln = fakes
    settings()
    project(home, status="done", entry=f"ENG-13 shipped {link}")
    out = sync(capsys, "--dry-run")[1]
    assert out.splitlines()[0] == f"linear:ENG-13  comment  Legwork session 2026-11-02: moved to Done. {shown}"


@pytest.mark.parametrize("state", ["Canceled", "Duplicate", "Done"])
def test_sync_leaves_every_closed_state_alone(home, fakes, capsys, state):
    gh, ln = fakes
    settings()
    ln.issues["ENG-13"]["state"] = state
    url = gh.pr(9, state="MERGED")
    project(home, entry=f"ENG-13 in {url}.")
    code, out, _ = sync(capsys, "--yes")
    assert code == 0 and ln.writes == []
    assert out == f"linear:ENG-13  skip  already {state}\n"


# The first /code-review round

@pytest.mark.parametrize("key,now", [("ENG-15", "In Review"), ("ENG-14", "Done")])
def test_a_move_never_goes_backwards_without_back(home, fakes, capsys, key, now):
    gh, ln = fakes
    settings()
    code, out, err = run(capsys, "move", key, "In Progress", "--yes")
    assert (code, err) == (0, "") and ln.writes == []
    assert out == f"linear:{key}  skip  already {now}; --back moves it back\n"
    code, out, _ = run(capsys, "move", key, "In Progress", "--back", "--yes")
    assert code == 0 and ln.issues[key]["state"] == "In Progress"


def test_a_move_forward_or_level_is_made(home, fakes, capsys):
    gh, ln = fakes
    settings()
    ln.issues["ENG-13"]["state"] = "Backlog"
    assert run(capsys, "move", "ENG-13", "Todo", "--yes")[0] == 0
    assert run(capsys, "move", "ENG-13", "Duplicate", "--yes")[0] == 0
    assert ln.issues["ENG-13"]["state"] == "Duplicate"


def test_at_a_terminal_the_problems_show_before_the_question(home, fakes, capsys, monkeypatch):
    import io
    import sys
    from orchi.tickets import cli as tickets_cli
    gh, ln = fakes
    settings()
    ln.fail.add("ENG-12")
    project(home, entry="ENG-12 and ENG-13.")
    seen = []

    class Asking(io.StringIO):
        def isatty(self):
            return True

        def readline(self):
            seen.append(sys.stderr.getvalue())
            return "n\n"

    monkeypatch.setattr(tickets_cli.sys, "stdin", Asking())
    monkeypatch.setattr(tickets_cli.sys.stdout, "isatty", lambda: True)
    code, out, err = sync(capsys)
    assert code == 1 and ln.writes == []
    assert seen == ["linear:ENG-12 was not found\n"]


def test_in_progress_falls_back_to_the_first_started_state_by_position(home, fakes, capsys):
    gh, ln = fakes
    settings()
    ln.teams["ENG"]["states"]["nodes"] = [
        {"id": "ENG-Todo", "name": "Todo", "type": "unstarted", "position": 0},
        {"id": "ENG-QA", "name": "QA", "type": "started", "position": 5},
        {"id": "ENG-In Review", "name": "In Review", "type": "started", "position": 3},
        {"id": "ENG-Doing", "name": "Doing", "type": "started", "position": 2},
    ]
    project(home, entry="ENG-13.")
    assert sync(capsys, "--dry-run")[1].splitlines()[0] == "linear:ENG-13  state    Todo to Doing"


def test_create_takes_a_team_key_in_any_case(home, fakes, capsys):
    gh, ln = fakes
    settings()
    code, out, err = run(capsys, "create", "--team", "eng", "A title", "--yes")
    assert (code, err) == (0, "")
    assert ln.writes[0][1]["input"]["teamId"] == "team-ENG"


def test_a_log_under_a_single_hash_heading_is_read(home, fakes, capsys):
    gh, ln = fakes
    settings()
    (home / "legwork" / "projects" / "birch.md").write_text(
        "---\nname: Birch\nstatus: review\nlinear: ENG-13\n---\n\n# Log\n\n- 2026-11-02: ENG-13.\n")
    assert sync(capsys, "--dry-run")[1].startswith("linear:ENG-13  state    Todo to In Progress\n")


def test_a_quoted_project_name_still_matches(home, fakes, capsys):
    gh, ln = fakes
    settings()
    project(home, name='"Birch"', entry="ENG-13.")
    assert "linear:ENG-13  project  Birch" in sync(capsys, "--dry-run")[1]


# The second /code-review round

@pytest.mark.parametrize("now,target", [("Todo", "Backlog"), ("Backlog", "Triage"), ("Ready to deploy", "In Review")])
def test_a_move_to_an_earlier_state_of_the_same_kind_needs_back(home, fakes, capsys, now, target):
    gh, ln = fakes
    settings()
    states = ln.teams["ENG"]["states"]["nodes"]
    states.append({"id": "ENG-Ready", "name": "Ready to deploy", "type": "started", "position": 4.5})
    ln.issues["ENG-13"]["state"] = now
    code, out, _ = run(capsys, "move", "ENG-13", target, "--yes")
    assert code == 0 and ln.writes == []
    assert out == f"linear:ENG-13  skip  already {now}; --back moves it back\n"


def test_a_bracketed_linear_line_is_read(home, fakes, capsys):
    gh, ln = fakes
    settings()
    project(home, line="[ENG-12, ENG-13]", entry="ENG-13.")
    assert sync(capsys, "--dry-run")[1].startswith("linear:ENG-13  state    Todo to In Progress\n")


@pytest.mark.parametrize("where", ["linear", "github"])
def test_a_ticket_made_but_not_named_in_the_answer_still_counts_as_made(home, fakes, capsys, monkeypatch, where):
    gh, ln = fakes
    settings()
    if where == "github":
        real = gh.__call__
        monkeypatch.setattr("orchi.tickets.github.run",
                            lambda argv: "" if argv[1:3] == ["issue", "create"] else real(argv))
        argv = ["create", "--repo", "acme/app", "A title", "--yes"]
    else:
        real = ln.__call__

        def post(query, variables, key):
            got = real(query, variables, key)
            if "issueCreate" in query:
                got["data"]["issueCreate"]["issue"] = None
            return got

        monkeypatch.setattr(linear, "post", post)
        argv = ["create", "--team", "ENG", "A title", "--yes"]
    code, out, err = run(capsys, *argv)
    assert (code, err) == (0, "")
    assert out.rstrip().endswith("A title  done")


def test_it_asks_only_when_both_ends_are_a_terminal(home, fakes, capsys, monkeypatch):
    import io
    from orchi.tickets import cli as tickets_cli
    gh, ln = fakes
    settings()

    class In(io.StringIO):
        def isatty(self):
            return True

    monkeypatch.setattr(tickets_cli.sys, "stdin", In("y\n"))
    code, out, err = run(capsys, "comment", "ENG-12", "x")  # capsys's stdout is not a terminal
    assert code == 1 and ln.writes == []
    assert "Make these changes" not in out
    assert err == "Nothing changed. Add --yes to make these changes.\n"


def test_a_github_issue_moved_to_another_repo_is_refused(home, fakes, capsys, monkeypatch):
    gh, ln = fakes
    settings()
    real = gh.__call__

    def view(argv):
        said = real(argv)
        if argv[1:3] == ["issue", "view"]:
            issue = json.loads(said)
            issue["url"] = "https://github.com/other/place/issues/3"
            return json.dumps(issue)
        return said

    monkeypatch.setattr("orchi.tickets.github.run", view)
    code, out, err = run(capsys, "comment", "gh:acme/app#7", "x", "--yes")
    assert code == 1 and gh.writes() == []
    assert err == "gh:acme/app#7: other/place is not one of github.repos\n"


# The third /code-review round

def test_an_open_pull_request_on_a_team_with_no_in_review_moves_to_in_progress(home, fakes, capsys):
    gh, ln = fakes
    settings()
    ln.teams["ENG"]["states"]["nodes"] = [s for s in ln.teams["ENG"]["states"]["nodes"] if s["name"] != "In Review"]
    url = gh.pr(9)
    project(home, entry=f"ENG-13 in {url}.")
    assert sync(capsys, "--dry-run")[1].splitlines()[:2] == [
        f"linear:ENG-13  comment  Legwork session 2026-11-02: moved to In Progress. {url}",
        "linear:ENG-13  state    Todo to In Progress"]


def test_a_move_refused_as_backwards_posts_no_comment(home, fakes, capsys):
    gh, ln = fakes
    settings()
    code, out, err = run(capsys, "move", "ENG-14", "In Progress", "--comment", "Landed", "--yes")
    assert (code, err) == (0, "") and ln.writes == []
    assert out == "linear:ENG-14  skip  already Done; --back moves it back\n"


def test_an_inline_triple_backtick_is_not_a_fence(home, fakes, capsys):
    gh, ln = fakes
    settings()
    (home / "legwork" / "projects" / "birch.md").write_text(
        "---\nname: Birch\nstatus: review\nlinear: ENG-12, ENG-13\n---\n\n## Next prompt\n\n```orchi``` is the command.\n\n"
        "```\n## Log\n- 2026-01-01: ENG-13\n```\n\n## Log\n\n- 2026-11-02: ENG-12.\n")
    out = sync(capsys, "--dry-run")[1]
    assert "linear:ENG-12" in out and "linear:ENG-13" not in out


def test_a_shelved_project_with_no_log_entry_uses_its_updated_date(home, fakes, capsys):
    gh, ln = fakes
    settings()
    (home / "legwork" / "projects" / "birch.md").write_text(
        "---\nname: Birch\nstatus: icebox\nupdated: 2026-11-03\nlinear: ENG-13\n---\n\n## Log\n")
    assert sync(capsys, "--dry-run")[1].splitlines()[0] == "linear:ENG-13  comment  Shelved in legwork on 2026-11-03."


@pytest.mark.parametrize("tail", ["12abc", "12_x", "12345678901"])
def test_a_pull_request_link_with_more_after_its_number_is_not_read(home, fakes, capsys, tail):
    gh, ln = fakes
    settings()
    gh.pr(12, state="MERGED", title="ENG-13")
    project(home, entry=f"See https://github.com/acme/app/pull/{tail} for ENG-12.")
    code, out, _ = sync(capsys, "--dry-run")
    assert code == 0 and "pull/12" not in out
    assert not any(c[1:3] == ["pr", "view"] for c in gh.calls)


@pytest.mark.parametrize("stop", [KeyboardInterrupt, EOFError])
def test_stopping_at_the_question_changes_nothing(home, fakes, capsys, monkeypatch, stop):
    import io
    from orchi.tickets import cli as tickets_cli
    gh, ln = fakes
    settings()

    class Stopped(io.StringIO):
        def isatty(self):
            return True

        def readline(self):
            raise stop()

    monkeypatch.setattr(tickets_cli.sys, "stdin", Stopped())
    monkeypatch.setattr(tickets_cli.sys.stdout, "isatty", lambda: True)
    code, out, err = run(capsys, "comment", "ENG-12", "x")
    assert code == 1 and ln.writes == []
    assert err == "Nothing changed.\n"
