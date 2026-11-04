"""orchi tickets writes: comment, move, create and sync, on Linear and GitHub only, each a plan until a yes.

Linear and gh are fakes that keep their own made-up issues, put in place of linear.post and github.run, so no test
writes to any real system. The conftests fail any test that reaches the network, gh or the keychain past them.
"""
import io
import json
import os
import re
import shutil
from pathlib import Path

import pytest

from orchi import cli
from orchi.tickets import cli as tickets_cli, github, linear

KEY = "not-a-real-key"
DOCS = Path(__file__).resolve().parent.parent / "docs"

STATES = [("Triage", "triage"), ("Backlog", "backlog"), ("Todo", "unstarted"), ("In Progress", "started"),
          ("In Review", "started"), ("Done", "completed"), ("Canceled", "canceled"), ("Duplicate", "canceled")]


def _team(key, projects):
    return {"id": f"team-{key}", "key": key,
            "states": {"nodes": [{"id": f"{key}-{name}", "name": name, "type": kind, "position": n}
                                 for n, (name, kind) in enumerate(STATES)]},
            "projects": {"nodes": [{"id": f"project-{name.lower()}", "name": name} for name in projects]}}


class FakeLinear:
    """Linear with a few made-up issues. Reads see the writes made before them."""

    def __init__(self):
        self.teams = {"ENG": _team("ENG", ["Birch", "Login"]), "OPS": _team("OPS", ["Birch"])}
        self.issues = {}
        for key, state, project in (("ENG-12", "In Progress", None), ("ENG-13", "Todo", None),
                                    ("ENG-14", "Done", None), ("ENG-15", "In Review", "Login"),
                                    ("OPS-3", "Todo", None)):
            self.issues[key] = {"state": state, "project": project}
        self.calls, self.writes, self.fail = [], [], set()
        self.created = 40

    def node(self, key):
        issue, team = self.issues[key], self.teams[key.split("-")[0]]
        state = next(s for s in team["states"]["nodes"] if s["name"] == issue["state"])
        project = next((p for p in team["projects"]["nodes"] if p["name"] == issue["project"]), None)
        return {"id": f"id-{key}", "identifier": key, "title": f"Issue {key}", "description": "",
                "url": f"https://linear.app/acme/issue/{key}", "updatedAt": "2026-11-01T00:00:00.000Z",
                "state": dict(state), "project": project, "labels": {"nodes": []}, "team": team}

    def __call__(self, query, variables, key):
        self.calls.append((query, variables, key))
        for name in ("commentCreate", "issueUpdate", "issueCreate"):
            if name in query:
                self.writes.append((name, variables))
                if name in self.fail:
                    return {"errors": [{"message": f"Linear refused the {name}"}], "data": None}
                return {"data": {name: self._write(name, variables)}}
        if "teams(" in query:
            team = self.teams.get(variables["key"])
            return {"data": {"teams": {"nodes": [team] if team else []}}}
        if "issue(id:" in query:
            if variables["id"] not in self.issues or variables["id"] in self.fail:
                return {"errors": [{"message": "Entity not found: Issue"}], "data": None}
            return {"data": {"issue": self.node(variables["id"])}}
        raise AssertionError(f"a query the fake doesn't know: {query}")

    def _write(self, name, variables):
        if name == "commentCreate":
            return {"success": True}
        if name == "issueCreate":
            self.created += 1
            team = next(t for t in self.teams.values() if t["id"] == variables["input"]["teamId"])
            key = f"{team['key']}-{self.created}"
            return {"success": True, "issue": {"identifier": key, "url": f"https://linear.app/acme/issue/{key}"}}
        key = variables["id"].removeprefix("id-")
        team = self.teams[key.split("-")[0]]
        if "stateId" in variables["input"]:
            self.issues[key]["state"] = next(s["name"] for s in team["states"]["nodes"]
                                             if s["id"] == variables["input"]["stateId"])
        if "projectId" in variables["input"]:
            self.issues[key]["project"] = next(p["name"] for p in team["projects"]["nodes"]
                                               if p["id"] == variables["input"]["projectId"])
        return {"success": True}

    def names(self):
        return [name for name, _ in self.writes]


class FakeGh:
    """gh with one made-up repo's issues and pull requests."""

    def __init__(self):
        self.issues = {7: "OPEN", 5: "CLOSED"}
        self.prs = {}
        self.calls, self.fail = [], set()

    def pr(self, number, state="OPEN", draft=False, title="Stop the login loop", body="", branch="fix-login"):
        url = f"https://github.com/acme/app/pull/{number}"
        self.prs[url] = {"url": url, "number": number, "state": state, "isDraft": draft, "title": title, "body": body,
                         "headRefName": branch}
        return url

    def writes(self):
        return [c for c in self.calls if c[1:3] in (["issue", "comment"], ["issue", "close"], ["issue", "reopen"],
                                                    ["issue", "create"])]

    def __call__(self, argv):
        self.calls.append(argv)
        verb = tuple(argv[1:3])
        if verb in self.fail:
            raise github.SourceError(f"gh refused {' '.join(verb)}")
        if verb == ("pr", "view"):
            if argv[3] not in self.prs:
                raise github.SourceError("no pull requests found")
            return json.dumps(self.prs[argv[3]])
        if verb == ("issue", "view"):
            number = int(argv[3])
            if number not in self.issues:
                raise github.SourceError("Could not resolve to an issue")
            return json.dumps({"number": number, "title": f"Issue {number}", "state": self.issues[number],
                               "url": f"https://github.com/acme/app/issues/{number}",
                               "updatedAt": "2026-11-01T00:00:00Z", "labels": [], "body": ""})
        if verb == ("issue", "close"):
            self.issues[int(argv[3])] = "CLOSED"
            return ""
        if verb == ("issue", "reopen"):
            self.issues[int(argv[3])] = "OPEN"
            return ""
        if verb == ("issue", "comment"):
            return f"https://github.com/acme/app/issues/{argv[3]}#issuecomment-1\n"
        if verb == ("issue", "create"):
            return "https://github.com/acme/app/issues/41\n"
        raise AssertionError(f"a gh call the fake doesn't know: {argv}")


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / "legwork" / "projects").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("LINEAR_API_KEY", KEY)
    return home


@pytest.fixture
def fakes(monkeypatch):
    gh, ln = FakeGh(), FakeLinear()
    monkeypatch.setattr(github, "run", gh)
    monkeypatch.setattr(linear, "post", ln)
    return gh, ln


def settings(**values):
    base = dict(sources=["legwork", "github", "linear"], legwork_dir="~/legwork",
                github={"repos": ["acme/app"], "command": "gh-personal"}, linear={"teams": ["ENG", "OPS"]})
    base.update(values)
    Path(os.environ["ORCHI_SETTINGS"]).parent.mkdir(parents=True, exist_ok=True)
    Path(os.environ["ORCHI_SETTINGS"]).write_text(json.dumps(base))


def run(capsys, *argv):
    code = cli.main(["tickets", *argv])
    out = capsys.readouterr()
    return code, out.out, out.err


class Terminal(io.StringIO):
    def isatty(self):
        return True


def at_a_terminal(monkeypatch, answer):
    """stdin and stdout both a terminal. stdout stays capsys's, so the output can still be read."""
    monkeypatch.setattr(tickets_cli.sys, "stdin", Terminal(answer))
    monkeypatch.setattr(tickets_cli.sys.stdout, "isatty", lambda: True)


# Comment, move and create

def test_a_linear_comment_with_yes_is_written(home, fakes, capsys):
    gh, ln = fakes
    settings()
    code, out, err = run(capsys, "comment", "linear:ENG-12", "Landed in acme/app#9", "--yes")
    assert (code, err) == (0, "")
    assert ln.writes == [("commentCreate", {"input": {"issueId": "id-ENG-12", "body": "Landed in acme/app#9"}})]
    assert all(key == KEY for _q, _v, key in ln.calls)
    assert out == "linear:ENG-12  comment  Landed in acme/app#9  done\n"


def test_without_a_yes_and_no_terminal_nothing_is_written(home, fakes, capsys):
    gh, ln = fakes
    settings()
    code, out, err = run(capsys, "move", "ENG-12", "In Review", "--comment", "Ready")
    assert code == 1
    assert ln.writes == []
    assert out == ("linear:ENG-12  comment  Ready\n"
                   "linear:ENG-12  state    In Progress to In Review\n")
    assert err == "Nothing changed. Add --yes to make these changes.\n"


def test_dry_run_prints_the_plan_and_exits_0(home, fakes, capsys):
    gh, ln = fakes
    settings()
    code, out, err = run(capsys, "move", "gh:acme/app#7", "closed", "--dry-run")
    assert (code, err) == (0, "")
    assert gh.writes() == []
    assert out == "gh:acme/app#7  state  open to closed\n"


def test_dry_run_and_yes_together_are_a_usage_error(home, fakes, capsys):
    settings()
    with pytest.raises(SystemExit) as stop:
        cli.main(["tickets", "comment", "ENG-12", "x", "--yes", "--dry-run"])
    assert stop.value.code == 2
    assert fakes[1].writes == []


@pytest.mark.parametrize("answer,written", [("y\n", True), ("yes\n", True), ("Y\n", True), ("n\n", False),
                                            ("\n", False), ("", False), ("sure\n", False)])
def test_at_a_terminal_it_asks_and_only_a_yes_writes(home, fakes, capsys, monkeypatch, answer, written):
    gh, ln = fakes
    settings()
    at_a_terminal(monkeypatch, answer)
    code, out, err = run(capsys, "comment", "ENG-12", "Ready")
    assert out.startswith("linear:ENG-12  comment  Ready\nMake these changes? (y/N) ")
    assert ln.names() == (["commentCreate"] if written else [])
    assert code == (0 if written else 1)
    if not written:
        assert err == "Nothing changed.\n"


def test_json_never_asks_even_at_a_terminal(home, fakes, capsys, monkeypatch):
    gh, ln = fakes
    settings()
    at_a_terminal(monkeypatch, "y\n")
    code, out, _ = run(capsys, "comment", "ENG-12", "Ready", "--json")
    assert code == 1 and ln.writes == []
    got = json.loads(out)
    assert got == {"changes": [{"ref": "linear:ENG-12", "do": "comment", "text": "Ready", "status": "planned"}],
                   "skipped": [], "problems": [], "written": False}


def test_json_with_yes_says_what_was_done(home, fakes, capsys):
    settings()
    code, out, _ = run(capsys, "move", "ENG-13", "in progress", "--yes", "--json")
    assert code == 0
    assert json.loads(out) == {
        "changes": [{"ref": "linear:ENG-13", "do": "state", "from": "Todo", "to": "In Progress", "status": "done"}],
        "skipped": [], "problems": [], "written": True}


def test_a_linear_move_comments_first_then_sets_the_state_and_project(home, fakes, capsys):
    gh, ln = fakes
    settings()
    code, out, err = run(capsys, "move", "ENG-12", "Done", "--comment", "Merged acme/app#9", "--project", "login",
                         "--yes")
    assert (code, err) == (0, "")
    assert ln.writes == [
        ("commentCreate", {"input": {"issueId": "id-ENG-12", "body": "Merged acme/app#9"}}),
        ("issueUpdate", {"id": "id-ENG-12", "input": {"stateId": "ENG-Done"}}),
        ("issueUpdate", {"id": "id-ENG-12", "input": {"projectId": "project-login"}}),
    ]
    assert ln.issues["ENG-12"] == {"state": "Done", "project": "Login"}


def test_a_state_the_team_does_not_have_is_a_problem_naming_its_states(home, fakes, capsys):
    gh, ln = fakes
    settings()
    code, out, err = run(capsys, "move", "ENG-12", "Shipped", "--yes")
    assert code == 1 and ln.writes == []
    assert err == ("linear:ENG-12: Shipped is not a state of ENG: Triage, Backlog, Todo, In Progress, In Review, "
                   "Done, Canceled, Duplicate\n")


def test_a_move_to_the_state_it_has_changes_nothing(home, fakes, capsys):
    gh, ln = fakes
    settings()
    code, out, err = run(capsys, "move", "ENG-12", "In Progress", "--yes")
    assert (code, err) == (0, "")
    assert ln.writes == []
    assert out == "linear:ENG-12  skip  already In Progress\n"


def test_a_ticket_that_is_not_there_is_a_problem(home, fakes, capsys):
    gh, ln = fakes
    settings()
    assert run(capsys, "comment", "ENG-99", "x", "--yes")[0::2] == (1, "linear:ENG-99 was not found\n")
    assert run(capsys, "move", "gh:acme/app#99", "closed", "--yes")[0::2] == (1, "gh:acme/app#99 was not found\n")
    assert ln.writes == [] and gh.writes() == []


def test_github_writes_go_through_the_gh_command_from_settings(home, fakes, capsys):
    gh, ln = fakes
    settings()
    assert run(capsys, "comment", "gh:Acme/App#7", "-starts with a dash", "--yes")[0] == 0
    assert run(capsys, "move", "gh:acme/app#7", "closed", "--comment", "Fixed by #9", "--yes")[0] == 0
    assert run(capsys, "move", "gh:acme/app#5", "open", "--yes")[0] == 0
    assert gh.writes() == [
        ["gh-personal", "issue", "comment", "7", "--repo", "acme/app", "--body=-starts with a dash"],
        ["gh-personal", "issue", "comment", "7", "--repo", "acme/app", "--body=Fixed by #9"],
        ["gh-personal", "issue", "close", "7", "--repo", "acme/app"],
        ["gh-personal", "issue", "reopen", "5", "--repo", "acme/app"],
    ]


@pytest.mark.parametrize("argv,message", [
    (["move", "gh:acme/app#7", "merged"], "gh:acme/app#7: a GitHub issue is open or closed"),
    (["move", "gh:acme/app#7", "closed", "--project", "Birch"], "gh:acme/app#7: --project is for Linear"),
    (["create", "--repo", "acme/app", "A title", "--state", "Todo"], "--state is for Linear"),
])
def test_what_github_does_not_have_is_refused(home, fakes, capsys, argv, message):
    gh, ln = fakes
    settings()
    code, out, err = run(capsys, *argv, "--yes")
    assert code == 2 and err == message + "\n"
    assert gh.writes() == []


def test_create_makes_a_linear_issue_on_the_team(home, fakes, capsys):
    gh, ln = fakes
    settings()
    code, out, err = run(capsys, "create", "--team", "ENG", "Export loses order", "--body", "Why, and the PR link",
                         "--state", "Todo", "--yes")
    assert (code, err) == (0, "")
    assert ln.writes == [("issueCreate", {"input": {"teamId": "team-ENG", "title": "Export loses order",
                                                    "description": "Why, and the PR link", "stateId": "ENG-Todo"}})]
    assert out == "ENG  create  Export loses order  done linear:ENG-41\n"


def test_create_makes_a_github_issue_in_the_repo(home, fakes, capsys):
    gh, ln = fakes
    settings()
    code, out, err = run(capsys, "create", "--repo", "Acme/App", "Export loses order", "--yes", "--json")
    assert (code, err) == (0, "")
    assert gh.writes() == [["gh-personal", "issue", "create", "--repo", "acme/app", "--title=Export loses order",
                            "--body="]]
    assert json.loads(out)["changes"] == [{"ref": None, "do": "create", "where": "acme/app",
                                           "title": "Export loses order", "status": "done",
                                           "created": "gh:acme/app#41"}]


def test_create_needs_a_team_or_a_repo(home, fakes, capsys):
    settings()
    for argv in (["create", "x", "--yes"], ["create", "--team", "ENG", "--repo", "acme/app", "x", "--yes"]):
        with pytest.raises(SystemExit) as stop:
            cli.main(["tickets", *argv])
        assert stop.value.code == 2


@pytest.mark.parametrize("ref", ["legwork:birch", "md:~/notes/todo.md#a-task"])
def test_legwork_and_markdown_are_not_written(home, fakes, capsys, ref):
    settings()
    code, out, err = run(capsys, "comment", ref, "x", "--yes")
    assert (code, out) == (2, "")
    assert err == f"{ref}: orchi tickets writes only Linear and GitHub tickets\n"


@pytest.mark.parametrize("values,argv,message", [
    ({"sources": ["legwork", "github"]}, ["comment", "ENG-12", "x"], "linear is not one of the sources in settings"),
    ({"linear": {"teams": ["OPS"]}}, ["comment", "ENG-12", "x"], "ENG is not one of linear.teams"),
    ({"linear": {"teams": ["OPS"]}}, ["create", "--team", "ENG", "x"], "ENG is not one of linear.teams"),
    ({"github": {"repos": ["acme/web"]}}, ["move", "gh:acme/app#7", "closed"], "acme/app is not one of github.repos"),
    ({"sources": ["legwork", "linear"]}, ["create", "--repo", "acme/app", "x"],
     "github is not one of the sources in settings"),
])
def test_a_write_reaches_only_what_settings_choose(home, fakes, capsys, values, argv, message):
    gh, ln = fakes
    settings(**values)
    code, out, err = run(capsys, *argv, "--yes")
    assert code == 1
    assert message in err
    assert ln.writes == [] and gh.writes() == []


def test_no_teams_in_settings_means_any_team(home, fakes, capsys):
    gh, ln = fakes
    settings(linear={})
    assert run(capsys, "comment", "OPS-3", "x", "--yes")[0] == 0
    assert ln.names() == ["commentCreate"]


def test_a_failed_comment_leaves_that_tickets_state_alone(home, fakes, capsys):
    gh, ln = fakes
    settings()
    ln.fail.add("commentCreate")
    code, out, err = run(capsys, "move", "ENG-12", "Done", "--comment", "Merged", "--yes")
    assert code == 1
    assert ln.names() == ["commentCreate"]
    assert ln.issues["ENG-12"]["state"] == "In Progress"
    assert out == ("linear:ENG-12  comment  Merged  failed: Linear refused the commentCreate\n"
                   "linear:ENG-12  state    In Progress to Done  not tried\n")


def test_a_write_with_no_fake_stops_at_the_guard(home, capsys):
    # Every write goes through linear.post or github.run, which the package conftest replaces for every test.
    settings()
    with pytest.raises(AssertionError, match="network through Linear"):
        cli.main(["tickets", "comment", "ENG-12", "x", "--yes"])
    with pytest.raises(AssertionError, match="ran gh"):
        cli.main(["tickets", "comment", "gh:acme/app#7", "x", "--yes"])


def test_source_is_refused_on_a_write(home, fakes, capsys):
    settings()
    code, out, err = run(capsys, "--source", "linear", "comment", "ENG-12", "x", "--yes")
    assert (code, out) == (2, "")
    assert err == "orchi tickets: --source is for the list, not comment\n"
    assert fakes[1].writes == []


def test_a_written_comment_shows_on_one_line(home, fakes, capsys):
    settings()
    code, out, _ = run(capsys, "comment", "ENG-12", "one\ntwo\x1b[31m", "--dry-run")
    assert code == 0
    assert out == "linear:ENG-12  comment  one two [31m\n"


# sync

def project(home, status="review", line="ENG-12, ENG-13, ENG-14, ENG-15", entry="Fixed the loop.", name="Birch"):
    linked = f"linear: {line}\n" if line is not None else ""
    (home / "legwork" / "projects" / "birch.md").write_text(
        f"---\nname: {name}\ncategory: work\nstatus: {status}\nupdated: 2026-11-02\n{linked}---\n\n"
        "## Next prompt\n\n```\nRead the log.\n## Log\n- 2026-01-01: a fenced line, not a log entry ENG-13\n```\n\n"
        f"## Log\n\n- 2026-11-02: {entry}\n  More of it.\n- 2026-10-30: Started ENG-13.\n")


def sync(capsys, *argv):
    return run(capsys, "sync", "legwork:birch", *argv)


def test_sync_dry_run_prints_the_plan_and_writes_nothing(home, fakes, capsys):
    gh, ln = fakes
    settings()
    url = gh.pr(9)
    project(home, entry=f"ENG-12: stopped the loop in {url}.")
    code, out, err = sync(capsys, "--dry-run")
    assert (code, err) == (0, "")
    assert ln.writes == [] and gh.writes() == []
    assert out == (f"linear:ENG-12  comment  Legwork session 2026-11-02: moved to In Review. {url}\n"
                   "linear:ENG-12  state    In Progress to In Review\n"
                   "linear:ENG-12  project  Birch\n")
    assert ["gh-personal", "pr", "view", url, "--json", github.PR_FIELDS] in gh.calls


def test_sync_with_yes_writes_the_plan_in_order(home, fakes, capsys):
    gh, ln = fakes
    settings()
    url = gh.pr(9)
    project(home, entry=f"ENG-12: stopped the loop in {url}.")
    code, out, err = sync(capsys, "--yes")
    assert (code, err) == (0, "")
    assert ln.writes == [
        ("commentCreate", {"input": {"issueId": "id-ENG-12",
                                     "body": f"Legwork session 2026-11-02: moved to In Review.\n{url}"}}),
        ("issueUpdate", {"id": "id-ENG-12", "input": {"stateId": "ENG-In Review"}}),
        ("issueUpdate", {"id": "id-ENG-12", "input": {"projectId": "project-birch"}}),
    ]
    assert gh.writes() == []


def test_sync_without_a_yes_writes_nothing(home, fakes, capsys):
    gh, ln = fakes
    settings()
    project(home, entry="Worked on ENG-13.")
    code, out, err = sync(capsys)
    assert code == 1 and ln.writes == []
    assert err == "Nothing changed. Add --yes to make these changes.\n"


def test_a_merged_pull_request_moves_to_done_with_its_link(home, fakes, capsys):
    gh, ln = fakes
    settings()
    url = gh.pr(9, state="MERGED")
    project(home, entry="Landed linear:ENG-12.")
    code, out, _ = sync(capsys, "--pr", url, "--yes")
    assert code == 0
    assert ln.issues["ENG-12"]["state"] == "Done"
    assert ln.writes[0][1]["input"]["body"] == f"Legwork session 2026-11-02: moved to Done.\n{url}"


def test_work_with_no_pull_request_is_in_progress_without_a_comment(home, fakes, capsys):
    gh, ln = fakes
    settings()
    project(home, entry="Started on ENG-13 and eng-14 is not a key.")
    code, out, _ = sync(capsys, "--dry-run")
    assert code == 0
    assert out == ("linear:ENG-13  state    Todo to In Progress\n"
                   "linear:ENG-13  project  Birch\n")


def test_a_done_project_with_a_commit_link_moves_to_done(home, fakes, capsys):
    gh, ln = fakes
    settings()
    commit = "https://github.com/acme/app/commit/0123abc"
    project(home, status="done", entry=f"ENG-13 shipped as {commit}.")
    code, out, _ = sync(capsys, "--dry-run")
    assert code == 0
    assert out.splitlines()[:2] == [f"linear:ENG-13  comment  Legwork session 2026-11-02: moved to Done. {commit}",
                                    "linear:ENG-13  state    Todo to Done"]


def test_a_done_project_with_no_evidence_link_is_in_progress_and_says_why(home, fakes, capsys):
    gh, ln = fakes
    settings()
    project(home, status="done", entry="ENG-13 finished.")
    code, out, _ = sync(capsys, "--dry-run")
    assert code == 0
    assert out == ("linear:ENG-13  state    Todo to In Progress\n"
                   "linear:ENG-13  project  Birch\n"
                   "linear:ENG-13  skip     not Done: no merged pull request or commit or release link\n")


def test_sync_leaves_done_and_canceled_issues_alone(home, fakes, capsys):
    gh, ln = fakes
    settings()
    url = gh.pr(9, state="MERGED")
    project(home, entry=f"ENG-14 again, in {url}.")
    code, out, _ = sync(capsys, "--yes")
    assert code == 0 and ln.writes == []
    assert out == "linear:ENG-14  skip  already Done\n"


def test_sync_never_moves_an_issue_backwards(home, fakes, capsys):
    gh, ln = fakes
    settings()
    project(home, entry="Poked at ENG-15.")
    code, out, _ = sync(capsys, "--yes")
    assert code == 0 and ln.writes == []
    assert out == "linear:ENG-15  skip  already In Review\n"


def test_an_open_draft_does_not_count_as_in_review(home, fakes, capsys):
    gh, ln = fakes
    settings()
    url = gh.pr(9, draft=True)
    project(home, entry=f"ENG-13 in {url}.")
    code, out, _ = sync(capsys, "--dry-run")
    assert out.splitlines()[0] == "linear:ENG-13  state    Todo to In Progress"


def test_issues_this_session_did_not_name_are_left_out(home, fakes, capsys):
    gh, ln = fakes
    settings()
    project(home, entry="Tidied the docs.")
    code, out, err = sync(capsys, "--yes")
    assert (code, out, err) == (0, "Nothing to change.\n", "")
    assert ln.calls == []


def test_an_issue_named_after_the_project_counts_when_it_is_linked(home, fakes, capsys):
    gh, ln = fakes
    settings()
    project(home, entry="Tidied the docs.")
    code, out, _ = sync(capsys, "linear:ENG-13", "OPS-3", "--dry-run")
    assert code == 0
    assert out == ("linear:ENG-13  state    Todo to In Progress\n"
                   "linear:ENG-13  project  Birch\n"
                   "linear:OPS-3   skip     not on legwork:birch's linear: line\n")


def test_sync_takes_only_linear_references_after_the_project(home, fakes, capsys):
    settings()
    project(home)
    code, out, err = sync(capsys, "gh:acme/app#7", "--dry-run")
    assert (code, out) == (2, "")
    assert err == "orchi tickets sync: gh:acme/app#7 is not a Linear issue\n"
    code, out, err = run(capsys, "sync", "linear:ENG-12", "--dry-run")
    assert code == 2 and err == "orchi tickets sync: name a legwork project first, such as legwork:<project>\n"


def test_a_pull_request_that_names_an_issue_is_that_issues(home, fakes, capsys):
    gh, ln = fakes
    settings()
    merged = gh.pr(9, state="MERGED", branch="eng-12-stop-the-loop")
    other = gh.pr(10, title="ENG-13: export order")
    project(home, entry=f"Two pull requests: {merged} and {other}.")
    code, out, _ = sync(capsys, "--dry-run")
    assert code == 0
    assert out.splitlines() == [
        f"linear:ENG-12  comment  Legwork session 2026-11-02: moved to Done. {merged}",
        "linear:ENG-12  state    In Progress to Done",
        "linear:ENG-12  project  Birch",
        f"linear:ENG-13  comment  Legwork session 2026-11-02: moved to In Review. {other}",
        "linear:ENG-13  state    Todo to In Review",
        "linear:ENG-13  project  Birch",
    ]


def test_a_pull_request_that_cannot_be_read_stops_the_sync(home, fakes, capsys):
    gh, ln = fakes
    settings()
    project(home, entry="ENG-12 in https://github.com/acme/app/pull/404.")
    code, out, err = sync(capsys, "--yes")
    assert (code, out) == (1, "")
    assert err == "https://github.com/acme/app/pull/404: no pull requests found\n"
    assert ln.writes == []


def test_an_issue_that_cannot_be_read_is_named_and_the_others_carry_on(home, fakes, capsys):
    gh, ln = fakes
    settings()
    ln.fail.add("ENG-12")
    project(home, entry="ENG-12 and ENG-13.")
    code, out, err = sync(capsys, "--yes")
    assert code == 1
    assert err == "linear:ENG-12 was not found\n"
    assert ln.issues["ENG-13"]["state"] == "In Progress"


def test_a_shelved_project_cancels_every_open_linked_issue(home, fakes, capsys):
    gh, ln = fakes
    settings()
    project(home, status="icebox", entry="Shelved: waiting on the design.")
    code, out, _ = sync(capsys, "--dry-run")
    assert code == 0
    assert out.splitlines() == [
        "linear:ENG-12  comment  Shelved in legwork on 2026-11-02.",
        "linear:ENG-12  state    In Progress to Canceled",
        "linear:ENG-13  comment  Shelved in legwork on 2026-11-02.",
        "linear:ENG-13  state    Todo to Canceled",
        "linear:ENG-14  skip     already Done",
        "linear:ENG-15  comment  Shelved in legwork on 2026-11-02.",
        "linear:ENG-15  state    In Review to Canceled",
    ]


def test_a_project_with_no_linear_line_has_nothing_to_sync(home, fakes, capsys):
    gh, ln = fakes
    settings()
    project(home, line=None)
    assert sync(capsys, "--yes") == (0, "Nothing to change.\n", "")
    assert ln.calls == []


def test_sync_of_a_project_that_is_not_there_says_so(home, fakes, capsys):
    settings()
    code, out, err = run(capsys, "sync", "legwork:nope", "--dry-run")
    assert (code, out, err) == (1, "", "legwork:nope was not found\n")


def test_sync_puts_an_issue_in_a_project_only_on_one_exact_name(home, fakes, capsys):
    gh, ln = fakes
    settings()
    project(home, name="Bir", entry="ENG-13.")
    assert "project" not in sync(capsys, "--dry-run")[1]
    project(home, name="birch", entry="ENG-13.")
    assert "linear:ENG-13  project  Birch" in sync(capsys, "--dry-run")[1]


def test_sync_refuses_issues_outside_linear_teams(home, fakes, capsys):
    gh, ln = fakes
    settings(linear={"teams": ["OPS"]})
    project(home, line="ENG-13, OPS-3", entry="ENG-13 and OPS-3.")
    code, out, err = sync(capsys, "--yes")
    assert code == 1
    assert err == "linear:ENG-13: ENG is not one of linear.teams\n"
    assert ln.issues["OPS-3"]["state"] == "In Progress"
    assert all(v.get("id") != "id-ENG-13" for _n, v in ln.writes)


def test_sync_json_carries_the_plan(home, fakes, capsys):
    gh, ln = fakes
    settings()
    project(home, entry="ENG-15 and ENG-13.")
    code, out, _ = sync(capsys, "--dry-run", "--json")
    assert code == 0
    assert json.loads(out) == {
        "changes": [{"ref": "linear:ENG-13", "do": "state", "from": "Todo", "to": "In Progress", "status": "planned"},
                    {"ref": "linear:ENG-13", "do": "project", "to": "Birch", "status": "planned"}],
        "skipped": [{"ref": "linear:ENG-15", "reason": "already In Review"}],
        "problems": [], "written": False}


# The house-rules line legwork can take

def test_the_house_rules_snippet_is_a_command_orchi_takes():
    text = (DOCS / "legwork-sync.md").read_text()
    block = re.search(r"```\n(- .+?)\n```", text, re.S)
    assert block, "docs/legwork-sync.md holds the house-rules line in a fenced block"
    line = block.group(1)
    assert "\n" not in line.strip()
    commands = re.findall(r"`(orchi tickets sync [^`]+)`", line)
    assert commands
    for command in commands:
        argv = command.replace("<project>", "birch").replace("<url>", "https://github.com/acme/app/pull/9").split()
        args = cli.build_parser().parse_args(argv[1:])
        assert args.action == "sync"


# The session's sources

def test_the_list_names_the_sources_it_read(home, fakes, capsys):
    settings(sources=["legwork", "markdown"])
    code, out, _ = run(capsys, "--json")
    assert code == 0 and json.loads(out)["sources"] == ["legwork", "markdown"]
    code, out, _ = run(capsys, "--json", "--source", "markdown")
    assert json.loads(out)["sources"] == ["markdown"]
