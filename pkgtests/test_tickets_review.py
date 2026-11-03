"""Regression tests for review findings on orchi tickets, one per finding."""
import http.server
import json
import threading

import pytest

import conftest as seams
from orchi.tickets import linear

KEY = "not-a-real-key"


def serve(handler):
    server = http.server.HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def test_linear_never_follows_a_redirect_with_the_key(monkeypatch):
    seen = []

    class Elsewhere(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(self.headers.get("Authorization"))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"data": {}}')

        do_POST = do_GET

        def log_message(self, *a):
            pass

    other = serve(Elsewhere)

    class Moved(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{other.server_port}/steal")
            self.end_headers()

        def log_message(self, *a):
            pass

    first = serve(Moved)
    try:
        monkeypatch.setattr(linear, "API_URL", f"http://127.0.0.1:{first.server_port}/graphql")
        with pytest.raises(linear.SourceError) as caught:
            seams.REAL["linear.post"]("query { viewer { id } }", {}, KEY)
        assert seen == []
        assert KEY not in str(caught.value)
    finally:
        first.shutdown()
        other.shutdown()


@pytest.mark.parametrize("answer", [[], "x", None, 5, {"data": {"issues": []}}, {"data": {"issues": {"nodes": 3}}},
                                    {"data": []}])
def test_a_linear_answer_of_the_wrong_shape_is_a_problem_not_a_crash(monkeypatch, answer):
    from orchi.tickets import list_tickets, show
    monkeypatch.setenv("LINEAR_API_KEY", KEY)
    monkeypatch.setattr(linear, "post", lambda q, v, k: answer)
    s = {"sources": ["legwork", "linear"], "legwork_dir": None, "linear": {"teams": [], "projects": []}}
    tickets, problems = list_tickets(s)
    assert tickets == []
    assert problems == [{"source": "linear", "message": "Linear gave an answer Orchi can't read"}]
    with pytest.raises(linear.SourceError, match="^Linear gave an answer Orchi can't read$"):
        show({"source": "linear", "key": "ENG-1"}, s)


def test_a_list_cut_short_says_so(monkeypatch):
    from orchi.tickets import github, list_tickets
    issue = lambda n: {"number": n, "title": f"t{n}", "state": "OPEN", "url": "u", "updatedAt": "d", "labels": []}  # noqa: E731
    monkeypatch.setattr(github, "run", lambda argv: json.dumps([issue(n) for n in range(1, int(github.LIMIT) + 2)]))
    page = {"data": {"issues": {"nodes": [{"identifier": "ENG-1", "title": "t", "state": {"name": "Todo", "type": "unstarted"}}],
                                "pageInfo": {"hasNextPage": True, "endCursor": "c"}}}}
    monkeypatch.setattr(linear, "post", lambda q, v, k: page)
    monkeypatch.setenv("LINEAR_API_KEY", KEY)
    s = {"sources": ["github", "linear"], "github": {"repos": ["acme/app"], "command": "gh"},
         "linear": {"teams": [], "projects": []}}
    tickets, problems = list_tickets(s)
    assert len(tickets) == int(github.LIMIT) + linear.MAX_PAGES
    assert problems == [
        {"source": "github", "message": f"acme/app: showing the first {github.LIMIT} open issues"},
        {"source": "linear", "message": f"showing the first {linear.MAX_PAGES * 250} open issues"},
    ]


def test_a_full_list_that_is_not_cut_short_says_nothing(monkeypatch):
    from orchi.tickets import github, list_tickets
    monkeypatch.setattr(github, "run", lambda argv: json.dumps([]))
    s = {"sources": ["github"], "github": {"repos": ["acme/app"], "command": "gh"}}
    assert list_tickets(s) == ([], [])


def test_every_markdown_task_gets_its_own_anchor():
    from orchi.tickets import markdown
    got = [t["anchor"] for t in markdown.tasks("- [ ] Foo\n- [ ] Foo\n- [ ] Foo-1\n- [ ] Foo 1\n")]
    assert got == ["foo", "foo-1", "foo-1-1", "foo-1-2"]
    assert len(set(got)) == len(got)


@pytest.mark.parametrize("text,titles", [
    ("```\n~~~\n- [ ] in code\n```\n- [ ] real\n", ["real"]),
    ("````\n```\n- [ ] in code\n````\n- [ ] real\n", ["real"]),
    ("```\n- [ ] in code\n    ```\n- [ ] also in code\n```\n- [ ] real\n", ["real"]),
    ("```python\n- [ ] in code\n``` not a close\n- [ ] still code\n```\n- [ ] real\n", ["real"]),
    ("    ```\n- [ ] real\n", ["real"]),
    ("- [ ] parent\n  ```\n  - [ ] in its body\n  ```\n- [ ] real\n", ["parent", "real"]),
])
def test_markdown_code_blocks_open_and_close_as_commonmark_says(text, titles):
    from orchi.tickets import markdown
    assert [t["title"] for t in markdown.tasks(text)] == titles


def test_a_symlink_in_a_markdown_folder_cannot_reach_outside_it(tmp_path, monkeypatch):
    from orchi.tickets import markdown
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "notes").mkdir()
    (tmp_path / "outside").mkdir()
    (tmp_path / "outside" / "secret.md").write_text("- [ ] secret\n")
    (tmp_path / "notes" / "link.md").symlink_to(tmp_path / "outside" / "secret.md")
    (tmp_path / "notes" / "todo.md").write_text("- [ ] mine\n")
    s = {"markdown": {"paths": [str(tmp_path / "notes")]}}
    tickets, problems = markdown.list_open(s)
    assert [t["title"] for t in tickets] == ["mine"]
    for ref in ({"file": "~/outside/secret.md", "anchor": "secret"}, {"file": "~/notes/link.md", "anchor": "secret"}):
        with pytest.raises(markdown.SourceError, match="is not in markdown.paths"):
            markdown.show(ref, s)


def test_a_file_named_directly_may_be_a_symlink(tmp_path, monkeypatch):
    from orchi.tickets import markdown
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "real.md").write_text("- [ ] mine\n")
    (tmp_path / "todo.md").symlink_to(tmp_path / "real.md")
    s = {"markdown": {"paths": [str(tmp_path / "todo.md")]}}
    assert [t["ref"] for t in markdown.list_open(s)[0]] == ["md:~/todo.md#mine"]


def test_a_markdown_path_that_cannot_be_named_says_why(tmp_path, monkeypatch):
    from orchi.tickets import markdown
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "release#1.md").write_text("- [ ] ship\n")
    tickets, problems = markdown.list_open({"markdown": {"paths": [str(tmp_path / "release#1.md")]}})
    assert tickets == []
    assert problems == ["~/release#1.md can't be named in a reference: its path has a space, comma, # or control character"]


def write_settings(values):
    import os
    from pathlib import Path
    Path(os.environ["ORCHI_SETTINGS"]).parent.mkdir(parents=True, exist_ok=True)
    Path(os.environ["ORCHI_SETTINGS"]).write_text(json.dumps(values))


def test_json_output_carries_no_raw_control_characters(tmp_path, monkeypatch, capsys):
    from orchi import cli
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "todo.md").write_text("- [ ] a\u009b31mred\u009dx\n", encoding="utf-8")
    write_settings({"sources": ["markdown"], "markdown": {"paths": ["~/todo.md"]}})
    assert cli.main(["tickets", "--json"]) == 0
    out = capsys.readouterr().out
    assert not any(0x80 <= ord(c) <= 0x9f or c in "\u2028\u2029" for c in out)
    assert json.loads(out)["tickets"][0]["title"] == "a\u009b31mred\u009dx"


def test_only_a_newline_ends_a_markdown_line():
    from orchi.tickets import markdown
    got = markdown.tasks("- [ ] a\u2028b\x85c\x0cd\r\n- [ ] e\r\n")
    assert [t["title"] for t in got] == ["a\u2028b\x85c\x0cd", "e"]


def test_source_is_for_the_list_and_show_refuses_it(capsys):
    from orchi import cli
    write_settings({})
    assert cli.main(["tickets", "--source", "github", "show", "legwork:birch"]) == 2
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == "orchi tickets: --source is for the list, not show\n"


# Each command here does nothing if the guard lets it through: `:` and `true` ignore their words. A guard test must
# never start the real binary when the guard is broken, which is exactly when it runs.
@pytest.mark.parametrize("argv", [["sh", "-c", ": /usr/bin/security find-generic-password"],
                                  ["/usr/bin/true", "security", "help"]])
def test_the_security_guard_sees_past_the_first_word(argv):
    import subprocess
    with pytest.raises(AssertionError, match="security"):
        subprocess.run(argv, capture_output=True)


# The first /code-review round on the pull request.

def test_a_legwork_file_with_crlf_endings_reads_the_same(tmp_path):
    from orchi.tickets import legwork
    (tmp_path / "projects").mkdir()
    (tmp_path / "projects" / "x.md").write_bytes(b"---\r\nname: X\r\nstatus: done\r\n---\r\nbody\r\n")
    (tmp_path / "projects" / "y.md").write_bytes(b"---\r\nname: Y\r\nstatus: queued\r\n---\r\n")
    tickets, problems = legwork.list_open({"legwork_dir": str(tmp_path)})
    assert [(t["title"], t["state"]) for t in tickets] == [("Y", "queued")]


@pytest.mark.parametrize("status,message,shown", [
    (400, "Authentication required, not authenticated", "Invalid Linear API key"),
    (500, "Something broke", "Something broke"),
])
def test_linear_http_errors_read_like_its_answers(monkeypatch, status, message, shown):
    import io
    import urllib.error

    def urlopen(request, timeout=None):
        body = io.BytesIO(json.dumps({"errors": [{"message": message}]}).encode())
        raise urllib.error.HTTPError(request.full_url, status, "x", {}, body)

    monkeypatch.setattr(linear, "urlopen", urlopen)
    with pytest.raises(linear.SourceError) as caught:
        seams.REAL["linear.post"]("query { viewer { id } }", {}, KEY)
    assert str(caught.value) == shown


def test_linear_show_reads_a_not_found_http_error_as_not_found(monkeypatch):
    def post(query, variables, key):
        raise linear.SourceError("Entity not found: Issue")

    monkeypatch.setattr(linear, "post", post)
    monkeypatch.setenv("LINEAR_API_KEY", KEY)
    assert linear.show({"key": "ENG-99"}, {}) is None


@pytest.mark.parametrize("answer,problem", [
    ([None, "x", 5], None),
    ({"message": "odd"}, "acme/app: gh gave an answer Orchi can't read"),
])
def test_gh_answers_of_the_wrong_shape_never_crash(monkeypatch, answer, problem):
    from orchi.tickets import github, list_tickets
    monkeypatch.setattr(github, "run", lambda argv: json.dumps(answer))
    s = {"sources": ["github"], "github": {"repos": ["acme/app"], "command": "gh"}}
    assert list_tickets(s) == ([], [{"source": "github", "message": problem}] if problem else [])


def test_a_repo_a_reference_cannot_name_says_so(monkeypatch):
    from orchi.tickets import github, list_tickets
    monkeypatch.setattr(github, "run", lambda argv: json.dumps([{"number": 1, "title": "t", "state": "OPEN"}]))
    s = {"sources": ["github"], "github": {"repos": ["-x/y"], "command": "gh"}}
    assert list_tickets(s) == ([], [{"source": "github", "message": "-x/y can't be named in a reference"}])


def test_a_source_that_cannot_reach_its_files_is_a_problem_not_a_crash(monkeypatch):
    from orchi.tickets import list_tickets, markdown

    def denied(s):
        raise PermissionError(13, "Permission denied", "/locked")

    monkeypatch.setattr(markdown, "list_open", denied)
    assert list_tickets({"sources": ["markdown"]}) == (
        [], [{"source": "markdown", "message": "/locked can't be read: Permission denied"}])


def test_a_code_block_in_a_task_ends_with_the_task():
    from orchi.tickets import markdown
    got = markdown.tasks("- [ ] a\n  ```\n  code\nnot indented\n- [ ] b\n")
    assert [(t["title"], t["body"]) for t in got] == [("a", "```\ncode"), ("b", "")]


# The second /code-review round on the pull request.

@pytest.fixture
def locked(tmp_path):
    """A folder no one can read, opened up again after the test so it can be cleaned away."""
    import os
    folder = tmp_path / "locked"
    folder.mkdir()
    (folder / "todo.md").write_text("- [ ] hidden\n")
    os.chmod(folder, 0)
    yield folder
    os.chmod(folder, 0o755)


def test_a_markdown_folder_that_cannot_be_read_is_a_problem(tmp_path, monkeypatch, locked):
    from orchi.tickets import markdown
    monkeypatch.setenv("HOME", str(tmp_path))
    s = {"markdown": {"paths": [str(locked)]}}
    assert markdown.list_open(s) == ([], ["~/locked can't be read"])
    with pytest.raises(markdown.SourceError, match="^~/locked can't be read$"):
        markdown.show({"file": "~/locked/todo.md", "anchor": "hidden"}, s)


def test_a_legwork_folder_that_cannot_be_read_is_a_problem(tmp_path, monkeypatch, capsys):
    import os
    from orchi import cli
    from orchi.tickets import legwork
    monkeypatch.setenv("HOME", str(tmp_path))
    projects = tmp_path / "lw" / "projects"
    projects.mkdir(parents=True)
    (projects / "oak.md").write_text("---\nstatus: queued\n---\n")
    os.chmod(projects, 0)
    try:
        assert legwork.list_open({"legwork_dir": str(tmp_path / "lw")}) == ([], ["~/lw/projects can't be read"])
        write_settings({"legwork_dir": "~/lw"})
        assert cli.main(["tickets", "show", "legwork:oak"]) == 1
        assert capsys.readouterr().err == "legwork:oak: ~/lw/projects can't be read\n"
    finally:
        os.chmod(projects, 0o755)


def test_a_shelved_legwork_project_is_not_open(tmp_path):
    from orchi.tickets import legwork
    (tmp_path / "projects").mkdir()
    (tmp_path / "projects" / "oak.md").write_text("---\nstatus: icebox\n---\n")
    assert legwork.list_open({"legwork_dir": str(tmp_path)}) == ([], [])
    assert legwork.show({"project": "oak"}, {"legwork_dir": str(tmp_path)})["open"] is False


def test_a_legwork_link_out_of_projects_is_not_a_project(tmp_path):
    from orchi.tickets import legwork
    (tmp_path / "projects").mkdir()
    (tmp_path / "elsewhere.md").write_text("---\nstatus: queued\n---\nprivate\n")
    (tmp_path / "projects" / "oak.md").symlink_to(tmp_path / "elsewhere.md")
    s = {"legwork_dir": str(tmp_path)}
    assert legwork.list_open(s) == ([], [])
    assert legwork.show({"project": "oak"}, s) is None


def test_a_linear_page_with_more_to_come_but_no_cursor_says_it_is_cut_short(monkeypatch):
    page = {"data": {"issues": {"nodes": [{"identifier": "ENG-1", "title": "t", "state": {"name": "Todo", "type": "unstarted"}}],
                                "pageInfo": {"hasNextPage": True, "endCursor": None}}}}
    monkeypatch.setattr(linear, "post", lambda q, v, k: page)
    monkeypatch.setenv("LINEAR_API_KEY", KEY)
    tickets, problems = linear.list_open({"linear": {"teams": [], "projects": []}})
    assert len(tickets) == 1
    assert problems == [f"showing the first {linear.PAGE} open issues"]


@pytest.mark.parametrize("key", ["abc\ndef", "abc\u00e9", "abc def"])
def test_a_linear_key_a_request_cannot_carry_is_named_as_such(monkeypatch, key):
    monkeypatch.setenv("LINEAR_API_KEY", key)
    with pytest.raises(linear.SourceError) as caught:
        linear.api_key()
    assert str(caught.value) == "the Linear API key has a character a key can't have"
    assert key not in str(caught.value)


# The third /code-review round on the pull request.

def test_legwork_frontmatter_read_from_crlf_text_has_no_carriage_returns():
    from pathlib import Path
    from orchi.tickets import legwork
    got = legwork._ticket(Path("/x/birch.md"), "---\r\nname: Birch\r\nstatus: done\r\n---\r\nbody", False)
    assert (got["title"], got["state"], got["open"]) == ("Birch", "done", False)


@pytest.mark.parametrize("status", ['"done"', "Done", "'icebox'", "ICEBOX"])
def test_a_legwork_status_in_quotes_or_capitals_still_counts(status):
    from pathlib import Path
    from orchi.tickets import legwork
    assert legwork._ticket(Path("/x/oak.md"), f"---\nstatus: {status}\n---\n", False)["open"] is False


def test_one_markdown_path_that_cannot_be_checked_leaves_the_others(tmp_path, monkeypatch):
    import pathlib
    from orchi.tickets import markdown
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "todo.md").write_text("- [ ] mine\n")
    real_is_dir = pathlib.Path.is_dir

    def is_dir(self, *a, **kw):
        # What Python 3.10 to 3.12 do for a path under a folder that can't be searched.
        if "locked" in str(self):
            raise PermissionError(13, "Permission denied", str(self))
        return real_is_dir(self, *a, **kw)

    monkeypatch.setattr(pathlib.Path, "is_dir", is_dir)
    tickets, problems = markdown.list_open({"markdown": {"paths": [str(tmp_path / "todo.md"), str(tmp_path / "locked" / "x.md")]}})
    assert [t["title"] for t in tickets] == ["mine"]
    assert problems == ["~/locked/x.md can't be read"]


def test_a_dropped_linear_connection_is_a_problem_not_a_crash(monkeypatch):
    import http.client

    def urlopen(request, timeout=None):
        raise http.client.IncompleteRead(b"partial")

    monkeypatch.setattr(linear, "urlopen", urlopen)
    with pytest.raises(linear.SourceError, match="^Linear can't be reached$"):
        seams.REAL["linear.post"]("query { viewer { id } }", {}, KEY)


def test_a_legwork_file_a_reference_cannot_name_says_so(tmp_path, monkeypatch):
    from orchi.tickets import legwork
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "projects").mkdir()
    (tmp_path / "projects" / "Big Idea.md").write_text("---\nstatus: queued\n---\n")
    (tmp_path / "projects" / "_template.md").write_text("---\nstatus: queued\n---\n")
    assert legwork.list_open({"legwork_dir": str(tmp_path)}) == (
        [], [f"{tmp_path}/projects/Big Idea.md can't be named in a reference"])


def test_a_markdown_file_that_is_not_md_says_so(tmp_path, monkeypatch):
    from orchi.tickets import markdown
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "TODO.markdown").write_text("- [ ] a\n")
    assert markdown.list_open({"markdown": {"paths": [str(tmp_path / "TODO.markdown")]}}) == (
        [], ["~/TODO.markdown can't be named in a reference: its name doesn't end in .md"])


def test_a_linear_page_that_fails_after_the_first_keeps_what_was_read(monkeypatch):
    pages = []

    def post(query, variables, key):
        pages.append(variables["after"])
        if variables["after"]:
            raise linear.SourceError("Linear can't be reached")
        return {"data": {"issues": {"nodes": [{"identifier": "ENG-1", "title": "t", "state": {"name": "Todo", "type": "unstarted"}}],
                                    "pageInfo": {"hasNextPage": True, "endCursor": "c"}}}}

    monkeypatch.setattr(linear, "post", post)
    monkeypatch.setenv("LINEAR_API_KEY", KEY)
    tickets, problems = linear.list_open({"linear": {"teams": [], "projects": []}})
    assert [t["ref"] for t in tickets] == ["linear:ENG-1"]
    assert problems == [f"showing the first {linear.PAGE} open issues: Linear can't be reached"]


def test_a_file_name_that_is_not_utf8_is_named_as_a_problem_not_a_crash(tmp_path, monkeypatch, capsys):
    import os
    from orchi import cli
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "notes").mkdir()
    try:
        (tmp_path / "notes" / os.fsdecode(b"bad\xff.md")).write_text("- [ ] a\n")
    except (OSError, UnicodeEncodeError):
        pytest.skip("this file system takes only UTF-8 names")
    write_settings({"sources": ["markdown"], "markdown": {"paths": ["~/notes"]}})
    assert cli.main(["tickets"]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "can't be named in a reference" in captured.err


def test_a_path_that_is_not_utf8_cannot_be_named():
    from pathlib import Path
    from orchi.tickets import markdown
    assert markdown._named(Path("/x/bad\udcff.md")) == "its name isn't UTF-8"
    assert markdown._named(Path("/x/good.md")) is None


def test_plain_output_shows_a_name_that_is_not_utf8_with_escapes():
    from orchi.tickets import cli as tickets_cli
    shown = tickets_cli._plain("~/notes/bad\udcff.md can't be named")
    assert shown == "~/notes/bad\\udcff.md can't be named"
    shown.encode("utf-8")
