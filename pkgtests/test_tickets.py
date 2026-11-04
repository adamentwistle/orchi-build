"""orchi tickets: one list of tickets from every chosen source, and one ticket by its reference.

Every source here is made-up data. Linear's API and gh are faked at their seams (linear.post and github.run), and the
keychain at keychain.find_password, so no test reaches the network, gh or the real keychain; the conftests make
sure of that for every test.
"""
import json
import os
import shutil
import subprocess
import sys
import urllib.error
from pathlib import Path

import pytest

from conftest import ROOT, SRC, scratch_env
import conftest as seams
from orchi import cli
from orchi.tickets import github, keychain, linear

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "tickets"
KEY = "not-a-real-key"
TICKET_KEYS = {"ref", "source", "id", "title", "state", "open", "url", "updated", "project", "labels", "body"}


def fixture(name):
    return json.loads((FIXTURES / name).read_text())


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    shutil.copytree(FIXTURES / "legwork", home / "legwork")
    shutil.copytree(FIXTURES / "notes", home / "notes")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    return home


def settings(**values):
    Path(os.environ["ORCHI_SETTINGS"]).parent.mkdir(parents=True, exist_ok=True)
    Path(os.environ["ORCHI_SETTINGS"]).write_text(json.dumps(values))


def every_source():
    settings(sources=["legwork", "github", "linear", "markdown"], legwork_dir="~/legwork",
             github={"repos": ["acme/app"], "command": "gh-personal"},
             linear={"teams": ["ENG", "OPS"]}, markdown={"paths": ["~/notes"]})


class FakeGh:
    def __init__(self):
        self.calls = []

    def __call__(self, argv):
        self.calls.append(argv)
        if argv[1:3] == ["issue", "list"]:
            return json.dumps(fixture("gh-list-acme-app.json"))
        if argv[1:4] == ["issue", "view", "7"]:
            return json.dumps(fixture("gh-view-acme-app-7.json"))
        raise github.SourceError("Could not resolve to an issue")


class FakeLinear:
    def __init__(self):
        self.calls = []

    def __call__(self, query, variables, key):
        self.calls.append((query, variables, key))
        if "issue(id:" in query:
            if variables["id"] == "ENG-12":
                return fixture("linear-issue.json")
            return {"errors": [{"message": "Entity not found: Issue"}], "data": None}
        return fixture("linear-page-2.json" if variables.get("after") else "linear-page-1.json")


@pytest.fixture
def fakes(monkeypatch):
    gh, ln = FakeGh(), FakeLinear()
    monkeypatch.setattr(github, "run", gh)
    monkeypatch.setattr(linear, "post", ln)
    return gh, ln


def run(capsys, *argv):
    code = cli.main(["tickets", *argv])
    out = capsys.readouterr()
    return code, out.out, out.err


ALL_REFS = [
    "legwork:birch",
    "gh:acme/app#7", "gh:acme/app#5",
    "linear:ENG-12", "linear:OPS-3",
    "md:~/notes/todo.md#fix-the-login-page", "md:~/notes/todo.md#fix-the-login-page-1", "md:~/notes/todo.md#ship-v240",
]


def test_json_lists_made_up_tickets_from_all_four_sources(home, fakes, capsys, monkeypatch):
    every_source()
    monkeypatch.setenv("LINEAR_API_KEY", KEY)
    code, out, err = run(capsys, "--json")
    assert (code, err) == (0, "")
    got = json.loads(out)
    assert got["problems"] == []
    assert [t["ref"] for t in got["tickets"]] == ALL_REFS
    assert all(set(t) == TICKET_KEYS for t in got["tickets"])
    by_ref = {t["ref"]: t for t in got["tickets"]}
    assert by_ref["legwork:birch"] == {
        "ref": "legwork:birch", "source": "legwork", "id": "birch", "title": "Birch", "state": "queued", "open": True,
        "url": (home / "legwork" / "projects" / "birch.md").as_uri(), "updated": "2026-10-31", "project": None,
        "labels": ["work"], "body": None,
    }
    assert by_ref["gh:acme/app#7"] == {
        "ref": "gh:acme/app#7", "source": "github", "id": "acme/app#7", "title": "Export loses folder order",
        "state": "open", "open": True, "url": "https://github.com/acme/app/issues/7", "updated": "2026-10-28T12:00:00Z",
        "project": "acme/app", "labels": ["bug"], "body": None,
    }
    assert by_ref["linear:ENG-12"] == {
        "ref": "linear:ENG-12", "source": "linear", "id": "ENG-12", "title": "Fix the login page", "state": "In Progress",
        "open": True, "url": "https://linear.app/acme/issue/ENG-12/fix-the-login-page", "updated": "2026-10-30T09:15:00.000Z",
        "project": "Login", "labels": ["Bug"], "body": None,
    }
    md = by_ref["md:~/notes/todo.md#fix-the-login-page"]
    assert md["source"] == "markdown" and md["title"] == "Fix the login page" and md["state"] == "open" and md["open"]
    assert md["url"] == (home / "notes" / "todo.md").as_uri() + "#fix-the-login-page"
    assert md["project"] == "~/notes/todo.md" and md["labels"] == [] and md["body"] is None
    assert by_ref["md:~/notes/todo.md#ship-v240"]["title"] == "Ship v2.4.0!"


def test_each_source_is_asked_the_way_its_settings_say(home, fakes, capsys, monkeypatch):
    gh, ln = fakes
    every_source()
    monkeypatch.setenv("LINEAR_API_KEY", KEY)
    run(capsys, "--json")
    assert [c[0] for c in gh.calls] == ["gh-personal"]
    assert gh.calls[0][1:5] == ["issue", "list", "--repo", "acme/app"]
    assert "--state" in gh.calls[0] and gh.calls[0][gh.calls[0].index("--state") + 1] == "open"
    assert len(ln.calls) == 2
    assert all(key == KEY for _q, _v, key in ln.calls)
    assert ln.calls[0][1]["after"] is None and ln.calls[1][1]["after"] == "cursor-1"
    assert ln.calls[0][1]["filter"] == linear.issues_filter(["ENG", "OPS"], [])


def test_plain_output_is_one_aligned_line_per_ticket(home, fakes, capsys, monkeypatch):
    every_source()
    monkeypatch.setenv("LINEAR_API_KEY", KEY)
    code, out, err = run(capsys)
    assert (code, err) == (0, "")
    lines = out.splitlines()
    assert [line.split()[0] for line in lines] == ALL_REFS
    assert len({line.index(line.split()[1], len(line.split()[0])) for line in lines}) == 1, "the state column is aligned"
    assert lines[0].endswith("Birch")
    assert not any("—" in line or "\x1b" in line for line in lines)


def test_settings_alone_read_legwork_only(home, fakes, capsys):
    settings(legwork_dir="~/legwork")
    code, out, _ = run(capsys, "--json")
    assert code == 0
    assert [t["ref"] for t in json.loads(out)["tickets"]] == ["legwork:birch"]
    assert fakes[0].calls == [] and fakes[1].calls == []


def test_source_narrows_the_sources_for_one_call(home, fakes, capsys):
    every_source()
    code, out, _ = run(capsys, "--json", "--source", "markdown")
    assert code == 0
    assert [t["source"] for t in json.loads(out)["tickets"]] == ["markdown"] * 3
    assert fakes[0].calls == [] and fakes[1].calls == []


def test_source_adds_a_source_settings_left_out(home, fakes, capsys):
    settings(legwork_dir="~/legwork", github={"repos": ["acme/app"]})
    code, out, _ = run(capsys, "--json", "--source", "legwork", "--source", "github")
    assert code == 0
    assert [t["ref"] for t in json.loads(out)["tickets"]] == ["legwork:birch", "gh:acme/app#7", "gh:acme/app#5"]
    assert fakes[0].calls[0][0] == "gh"


def test_an_unknown_source_is_a_usage_error(home, fakes, capsys):
    with pytest.raises(SystemExit) as stop:
        cli.main(["tickets", "--source", "jira"])
    assert stop.value.code == 2


def test_a_failing_source_is_named_and_the_others_still_list(home, fakes, capsys, monkeypatch):
    every_source()
    monkeypatch.setattr(keychain, "find_password", lambda service: None)
    code, out, err = run(capsys, "--json")
    assert code == 1
    got = json.loads(out)
    assert [t["source"] for t in got["tickets"]] == ["legwork", "github", "github", "markdown", "markdown", "markdown"]
    assert got["problems"] == [{"source": "linear", "message": "no Linear API key in the keychain or LINEAR_API_KEY"}]
    code, out, err = run(capsys)
    assert code == 1
    assert err == "linear: no Linear API key in the keychain or LINEAR_API_KEY\n"


def test_a_missing_markdown_path_is_a_problem(home, fakes, capsys):
    settings(sources=["markdown"], markdown={"paths": ["~/notes", "~/gone.md"]})
    code, out, _ = run(capsys, "--json")
    assert code == 1
    got = json.loads(out)
    assert len(got["tickets"]) == 3
    assert got["problems"] == [{"source": "markdown", "message": "~/gone.md is not there"}]


def test_no_legwork_folder_means_no_legwork_tickets(home, fakes, capsys):
    settings()
    assert run(capsys, "--json")[:2] == (0, json.dumps({"tickets": [], "problems": [], "sources": ["legwork"]}, indent=2) + "\n")


# show

@pytest.mark.parametrize("ref,title,body", [
    ("ENG-12", "Fix the login page", "The login page loops after a wrong password."),
    ("linear:ENG-12", "Fix the login page", "The login page loops after a wrong password."),
    ("gh:acme/app#7", "Export loses folder order", "Sibling folders come back by date added."),
    ("legwork:birch", "Birch", "## Vision\n\nBookmarks that keep their folders."),
    ("md:~/notes/todo.md#fix-the-login-page", "Fix the login page",
     "It loops after a wrong password.\n- [ ] a sub-task stays in the body"),
    ("md:~/notes/todo.md#write-the-release-notes", "Write the release notes", ""),
])
def test_show_reads_one_ticket_from_its_source(home, fakes, capsys, monkeypatch, ref, title, body):
    every_source()
    monkeypatch.setenv("LINEAR_API_KEY", KEY)
    code, out, err = run(capsys, "show", ref, "--json")
    assert (code, err) == (0, "")
    got = json.loads(out)
    assert set(got) == TICKET_KEYS
    assert (got["title"], got["body"]) == (title, body)


def test_show_finds_a_done_ticket_too(home, fakes, capsys):
    settings(legwork_dir="~/legwork")
    code, out, _ = run(capsys, "--json", "show", "legwork:cedar")
    assert code == 0
    got = json.loads(out)
    assert (got["state"], got["open"]) == ("done", False)


def test_show_prints_plain_lines(home, fakes, capsys):
    settings(legwork_dir="~/legwork")
    code, out, err = run(capsys, "show", "legwork:birch")
    assert (code, err) == (0, "")
    lines = out.splitlines()
    assert lines[0] == "Birch"
    assert lines[1].split() == ["legwork:birch", "queued", "2026-10-31"]
    assert lines[2] == (home / "legwork" / "projects" / "birch.md").as_uri()
    assert lines[3] == ""
    assert "Bookmarks that keep their folders." in out


def test_gh_show_uses_the_gh_command_from_settings(home, fakes, capsys):
    every_source()
    run(capsys, "show", "gh:Acme/App#7")
    assert fakes[0].calls == [["gh-personal", "issue", "view", "7", "--repo", "acme/app", "--json",
                               github.VIEW_FIELDS]]


@pytest.mark.parametrize("ref,message", [
    ("eng-12", "a reference with no source is a Linear key, such as ENG-12"),
    ("jira:ENG-1", "jira is not a ticket source: use linear, gh, legwork or md"),
    ("md:todo.md#x", "a Markdown task is written md:<file from / or ~/>#<anchor>"),
])
def test_show_names_a_bad_reference_in_one_plain_line(home, fakes, capsys, ref, message):
    settings()
    code, out, err = run(capsys, "show", ref)
    assert (code, out) == (2, "")
    assert err == f"{json.dumps(ref)} is not a ticket reference: {message}\n"


@pytest.mark.parametrize("ref", ["legwork:nope", "md:~/notes/todo.md#no-such-task", "linear:ENG-99"])
def test_show_says_when_a_ticket_is_not_there(home, fakes, capsys, monkeypatch, ref):
    every_source()
    monkeypatch.setenv("LINEAR_API_KEY", KEY)
    code, out, err = run(capsys, "show", ref)
    assert (code, out) == (1, "")
    assert err == f"{ref} was not found\n"


def test_show_reads_markdown_only_from_the_paths_settings_name(home, fakes, capsys):
    (home / "secret.md").write_text("- [ ] a task\n")
    every_source()
    code, out, err = run(capsys, "show", "md:~/secret.md#a-task")
    assert (code, out) == (1, "")
    assert err == "md:~/secret.md#a-task: ~/secret.md is not in markdown.paths\n"


def test_show_without_a_legwork_folder_says_so(home, fakes, capsys):
    settings()
    code, _, err = run(capsys, "show", "legwork:birch")
    assert code == 1
    assert err == "legwork:birch: no legwork_dir in settings\n"


# The Linear key

def test_linear_api_key_in_the_environment_wins_over_the_keychain(home, fakes, capsys, monkeypatch):
    settings(sources=["linear"])
    monkeypatch.setenv("LINEAR_API_KEY", KEY)
    # The conftest keychain fake fails any test that reaches it.
    assert run(capsys, "--json")[0] == 0
    assert {key for _q, _v, key in fakes[1].calls} == {KEY}


def test_the_key_comes_from_the_keychain_under_orchis_service_name(home, fakes, capsys, monkeypatch):
    asked = []
    monkeypatch.setattr(keychain, "find_password", lambda service: asked.append(service) or "lin_api_from-keychain")
    settings(sources=["linear"])
    assert run(capsys, "--json")[0] == 0
    assert asked == [keychain.LINEAR_SERVICE] and keychain.LINEAR_SERVICE == "orchi-linear"
    assert {key for _q, _v, key in fakes[1].calls} == {"lin_api_from-keychain"}


def test_the_key_never_reaches_output_even_when_linear_refuses_it(home, capsys, monkeypatch):
    sent = []

    def urlopen(request, timeout=None):
        sent.append(request)
        raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, None)

    monkeypatch.setattr(linear, "post", seams.REAL["linear.post"])
    monkeypatch.setattr(linear, "urlopen", urlopen)
    monkeypatch.setenv("LINEAR_API_KEY", KEY)
    settings(sources=["linear"])
    for argv in (["--json"], [], ["show", "ENG-12"], ["show", "ENG-12", "--json"]):
        code, out, err = run(capsys, *argv)
        assert code == 1
        assert KEY not in out + err
        assert "Invalid Linear API key" in out + err
    assert sent[0].full_url == linear.API_URL
    assert sent[0].get_header("Authorization") == KEY


def test_linear_errors_read_as_plain_messages(monkeypatch):
    def urlopen(request, timeout=None):
        raise urllib.error.URLError("no route")

    monkeypatch.setattr(linear, "urlopen", urlopen)
    with pytest.raises(linear.SourceError) as caught:
        seams.REAL["linear.post"]("query { viewer { id } }", {}, KEY)
    assert str(caught.value) == "Linear can't be reached"


def test_issues_filter_follows_teams_and_projects():
    still_open = {"state": {"type": {"nin": ["completed", "canceled"]}}}
    assert linear.issues_filter([], []) == {**still_open, "assignee": {"isMe": {"eq": True}}}
    assert linear.issues_filter(["ENG"], []) == {**still_open, "team": {"key": {"in": ["ENG"]}}}
    assert linear.issues_filter([], ["p1"]) == {**still_open, "project": {"id": {"in": ["p1"]}}}
    assert linear.issues_filter(["ENG"], ["p1"]) == {
        **still_open, "or": [{"team": {"key": {"in": ["ENG"]}}}, {"project": {"id": {"in": ["p1"]}}}]}


def test_find_password_asks_security_for_one_generic_password(monkeypatch):
    calls = []

    class Done:
        def __init__(self, code, out):
            self.returncode, self.stdout, self.stderr = code, out, ""

    def fake_run(argv, **kw):
        calls.append(argv)
        return Done(0, "lin_api_x\n")

    monkeypatch.setattr(keychain.subprocess, "run", fake_run)
    assert seams.REAL["keychain.find_password"]("orchi-linear") == "lin_api_x"
    assert calls == [["/usr/bin/security", "find-generic-password", "-s", "orchi-linear", "-w"]]
    monkeypatch.setattr(keychain.subprocess, "run", lambda argv, **kw: Done(44, ""))
    assert seams.REAL["keychain.find_password"]("orchi-linear") is None

    def missing(argv, **kw):
        raise FileNotFoundError(argv[0])

    monkeypatch.setattr(keychain.subprocess, "run", missing)
    assert seams.REAL["keychain.find_password"]("orchi-linear") is None


def test_only_keychain_py_names_the_security_binary():
    named = [p.relative_to(ROOT) for p in (ROOT / "src").rglob("*.py") if "/usr/bin/security" in p.read_text()]
    assert named == [Path("src/orchi/tickets/keychain.py")]


def test_gh_failures_read_as_plain_messages(monkeypatch):
    class Done:
        returncode, stdout, stderr = 1, "", "GraphQL: Could not resolve to a Repository\nmore\n"

    monkeypatch.setattr(github.subprocess, "run", lambda argv, **kw: Done())
    with pytest.raises(github.SourceError, match="^GraphQL: Could not resolve to a Repository$"):
        seams.REAL["github.run"](["gh-personal", "issue", "list"])

    def missing(argv, **kw):
        raise FileNotFoundError(argv[0])

    monkeypatch.setattr(github.subprocess, "run", missing)
    with pytest.raises(github.SourceError, match="^gh-personal is not installed$"):
        seams.REAL["github.run"](["gh-personal", "issue", "list"])


# The guards in the conftests

def test_no_test_reaches_the_real_security_binary(tmp_path):
    with pytest.raises(AssertionError, match="keychain"):
        keychain.find_password("orchi-linear")
    # Every command here is harmless if the guard is broken: a security that isn't there, and words `:` ignores.
    missing = str(tmp_path / "security")
    for argv, shell in (([missing, "list-keychains"], False), (f"{missing} help", True),
                        (": security find-generic-password", True)):
        with pytest.raises(AssertionError, match="security"):
            subprocess.run(argv, shell=shell, capture_output=True)


def test_no_test_reaches_the_network():
    with pytest.raises(AssertionError, match="network"):
        linear.post("query { viewer { id } }", {}, KEY)
    with pytest.raises(AssertionError, match="gh"):
        github.run(["gh", "issue", "list"])
    import socket
    with pytest.raises(AssertionError, match="network"):
        socket.create_connection(("api.linear.app", 443), timeout=1)


# The installed command

def test_the_command_lists_file_sources_end_to_end(tmp_path):
    env = scratch_env(tmp_path)
    env["PYTHONPATH"] = str(SRC)
    env.pop("LINEAR_API_KEY", None)
    home = Path(env["HOME"])
    shutil.copytree(FIXTURES / "legwork", home / "legwork")
    shutil.copytree(FIXTURES / "notes", home / "notes")
    env["ORCHI_SETTINGS"] = str(tmp_path / "settings.json")
    env["HERDR_APP_HOME"] = str(tmp_path / "herdr-app")
    # Only file sources, so the child process never runs gh or reaches Linear or the keychain.
    Path(env["ORCHI_SETTINGS"]).write_text(json.dumps(
        {"sources": ["legwork", "markdown"], "legwork_dir": "~/legwork", "markdown": {"paths": ["~/notes/todo.md"]}}))
    done = subprocess.run([sys.executable, "-m", "orchi", "tickets", "--json"], env=env, capture_output=True,
                          text=True, cwd=str(tmp_path), timeout=60)
    assert done.returncode == 0, done.stderr
    assert [t["ref"] for t in json.loads(done.stdout)["tickets"]] == [ALL_REFS[0], *ALL_REFS[5:]]
