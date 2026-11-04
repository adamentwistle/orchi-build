"""orchi update, against a local server that plays GitHub's releases and source archives, with a fake uv and a fake new
orchi. Nothing leaves this computer, and nothing touches a real uv, the real home or a real Herdr."""
import io
import json
import os
import tarfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

import orchi
from conftest import REAL
from engine_help import home  # noqa: F401
from orchi import cli, system

TOKEN = "ghp_secretTOKENvalue1234567890"


def archive(version):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:gz") as tar:
        data = f"[project]\nname = 'orchi'\nversion = '{version}'\n".encode()
        info = tarfile.TarInfo("o-r-abc123/pyproject.toml")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    return out.getvalue()


class Site:
    """GitHub, as far as update needs it: the latest release, and the archive of a tag."""

    def __init__(self):
        self.tag = "v0.2.0"
        self.token = None
        self.releases_status = 200
        self.redirect_to = None
        self.seen = []
        site = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, body=b"", headers=()):
                self.send_response(status)
                for k, v in headers:
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                site.seen.append((self.path, self.headers.get("Authorization")))
                if site.token and self.headers.get("Authorization") != f"Bearer {site.token}" and self.path.startswith("/repos"):
                    return self.reply(404)
                if self.path == "/repos/o/r/releases/latest":
                    if site.releases_status != 200:
                        return self.reply(site.releases_status)
                    return self.reply(200, json.dumps({"tag_name": site.tag}).encode())
                if self.path == f"/repos/o/r/tarball/{site.tag}":
                    if site.redirect_to:
                        return self.reply(302, headers=[("Location", site.redirect_to + "/archive.tar.gz")])
                    return self.reply(200, archive(site.tag.lstrip("v")))
                self.reply(404)

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def site():
    made = Site()
    yield made
    made.stop()


class Computer:
    """What update starts: uv and the new orchi. uv installs by reading the archive it is given."""

    def __init__(self, tmp_path, monkeypatch, site):
        self.bin = tmp_path / "uv-bin"
        self.bin.mkdir()
        self.path = tmp_path / "path"
        self.path.mkdir()
        (self.path / "uv").write_text("#!/bin/sh\nexit 0\n")
        (self.path / "uv").chmod(0o755)
        monkeypatch.setenv("PATH", str(self.path))
        monkeypatch.delenv("ORCHI_NO_SYSTEM")
        monkeypatch.setenv("ORCHI_API_URL", site.url)
        monkeypatch.setenv("ORCHI_REPO", "o/r")
        monkeypatch.delenv("ORCHI_GITHUB_TOKEN", raising=False)
        monkeypatch.setenv("TMPDIR", str(tmp_path))
        monkeypatch.setattr(orchi, "__version__", "0.1.0")
        monkeypatch.setattr(system, "get", REAL["system.get"])
        monkeypatch.setattr(system, "run", self.run)
        self.calls, self.installed, self.archives = [], [], []
        self.uv_fails = False
        self.dir_fails = False
        self.child_code = 0
        self.child_interactive = None

    def run(self, argv, input=None, timeout=None, env=None, interactive=False):
        argv = [os.fspath(a) for a in argv]
        self.calls.append(argv)
        if os.path.basename(argv[0]) == "uv" and argv[1:3] == ["tool", "install"]:
            assert argv[3] == "--force"
            file = Path(argv[-1])
            if self.uv_fails:
                return system.Result(2, "error: could not build\nerror: no\n")
            with tarfile.open(file) as tar:
                self.installed.append(tar.getnames())
                self.archives.append(file)
            return system.Result(0, "")
        if os.path.basename(argv[0]) == "uv" and argv[1:] == ["tool", "dir", "--bin"]:
            if self.dir_fails:
                return system.Result(1, "")
            return system.Result(0, f"{self.bin}\n")
        if argv[0] == str(self.bin / "orchi"):
            self.child_interactive = interactive
            return system.Result(self.child_code, "")
        raise AssertionError(f"update started {argv}")

    def program(self, name):
        return [c for c in self.calls if os.path.basename(c[0]) == name]


@pytest.fixture
def computer(home, tmp_path, monkeypatch, site):  # noqa: F811
    return Computer(tmp_path, monkeypatch, site)


def update(capsys, *args):
    code = cli.main([*args, "update"] if args else ["update"])
    return code, capsys.readouterr().out


def test_update_moves_to_the_newest_tag_and_says_from_and_to_in_one_line(computer, site, capsys):
    code, out = update(capsys)
    assert code == 0
    assert out == "Updated Orchi from 0.1.0 to 0.2.0.\n"
    assert [p for p, _ in site.seen] == ["/repos/o/r/releases/latest", "/repos/o/r/tarball/v0.2.0"]


def test_it_installs_the_archive_of_that_tag_with_uv_and_leaves_no_download_behind(computer, capsys):
    update(capsys)
    assert computer.installed == [["o-r-abc123/pyproject.toml"]]
    assert computer.archives and all(not f.exists() and not f.parent.exists() for f in computer.archives)


def test_then_the_new_orchi_runs_the_steps_with_the_terminal_and_its_code_is_returned(computer, capsys):
    computer.child_code = 1
    code, out = update(capsys)
    assert code == 1 and out == "Updated Orchi from 0.1.0 to 0.2.0.\n"
    assert computer.calls[-1] == [str(computer.bin / "orchi")]
    assert computer.child_interactive is True
    # The install came first, and the old program started no step itself.
    assert [os.path.basename(c[0]) for c in computer.calls] == ["uv", "uv", "orchi"]


def test_when_it_is_already_the_newest_it_says_so_in_one_line_and_changes_nothing(computer, site, capsys):
    site.tag = "v0.1.0"
    code, out = update(capsys)
    assert code == 0 and out == "Orchi 0.1.0 is the newest.\n"
    assert computer.calls == []
    assert [p for p, _ in site.seen] == ["/repos/o/r/releases/latest"]


def test_a_version_ahead_of_the_newest_tag_is_left_alone(computer, site, capsys, monkeypatch):
    monkeypatch.setattr(orchi, "__version__", "0.10.0")
    site.tag = "v0.9.0"
    code, out = update(capsys)
    assert code == 0 and out == "Orchi 0.10.0 is the newest.\n" and computer.calls == []


def test_versions_are_compared_as_numbers_not_text(computer, site, capsys, monkeypatch):
    monkeypatch.setattr(orchi, "__version__", "0.9.0")
    site.tag = "v0.10.0"
    code, out = update(capsys)
    assert code == 0 and out == "Updated Orchi from 0.9.0 to 0.10.0.\n"


def test_with_no_network_it_says_so_plainly_and_changes_nothing(computer, site, capsys):
    site.stop()
    code, out = update(capsys)
    assert code == 1 and out == "Could not reach GitHub. Nothing changed.\n"
    assert computer.calls == []


def test_with_no_release_it_says_so_plainly_and_changes_nothing(computer, site, capsys):
    site.releases_status = 404
    code, out = update(capsys)
    assert code == 1 and out == "No release found. Nothing changed.\n"
    assert computer.calls == []


def test_a_release_with_no_tag_name_is_no_release(computer, site, capsys):
    site.tag = ""
    code, out = update(capsys)
    assert code == 1 and out == "No release found. Nothing changed.\n" and computer.calls == []


def test_a_tag_that_is_not_a_version_changes_nothing(computer, site, capsys):
    site.tag = "nightly"
    code, out = update(capsys)
    assert code == 1 and out == "The newest release, nightly, is not a version number. Nothing changed.\n"
    assert computer.calls == []


def test_without_uv_it_says_so_and_changes_nothing(computer, site, capsys):
    (computer.path / "uv").unlink()
    code, out = update(capsys)
    assert code == 1 and out == "uv is not on PATH. Nothing changed.\n"
    assert [p for p, _ in site.seen] == ["/repos/o/r/releases/latest"]


def test_when_uv_cannot_install_it_says_why_and_the_steps_do_not_run(computer, capsys):
    computer.uv_fails = True
    code, out = update(capsys)
    assert code == 1 and out == "uv could not install Orchi 0.2.0: error: no\n"
    assert computer.program("orchi") == []


def test_when_uv_cannot_say_where_it_put_orchi_the_old_one_on_path_is_not_run(computer, capsys):
    computer.dir_fails = True
    (computer.path / "orchi").write_text("#!/bin/sh\nexit 0\n")
    (computer.path / "orchi").chmod(0o755)
    code = cli.main(["update"])
    shown = capsys.readouterr()
    assert code == 1 and shown.out == "Updated Orchi from 0.1.0 to 0.2.0.\n"
    assert shown.err == "Run orchi to refresh what it installed.\n"
    assert computer.program("orchi") == []


def test_json_gives_one_object_with_from_to_and_whether_it_moved(computer, capsys):
    code, out = update(capsys, "--json")
    report = json.loads(out)
    assert code == 0
    assert report["command"] == "update" and report["from"] == "0.1.0" and report["to"] == "0.2.0"
    assert report["updated"] is True and report["ok"] is True
    assert report["summary"] == "Updated Orchi from 0.1.0 to 0.2.0."


def test_json_when_it_is_the_newest(computer, site, capsys):
    site.tag = "v0.1.0"
    code, out = update(capsys, "--json")
    report = json.loads(out)
    assert code == 0 and report["updated"] is False and report["to"] == "0.1.0" and report["ok"] is True


def test_the_token_goes_to_github_in_a_header_and_nowhere_else(computer, site, capsys, monkeypatch):
    site.token = TOKEN
    monkeypatch.setenv("ORCHI_GITHUB_TOKEN", TOKEN)
    code, out = update(capsys)
    assert code == 0, out
    assert [a for p, a in site.seen] == [f"Bearer {TOKEN}"] * 2
    assert TOKEN not in out and TOKEN not in json.dumps(computer.calls)


def test_without_the_token_a_private_repo_is_no_release(computer, site, capsys):
    site.token = TOKEN
    code, out = update(capsys)
    assert code == 1 and out == "No release found. Nothing changed.\n"


def test_a_redirect_to_another_host_does_not_carry_the_token(computer, site, capsys, monkeypatch):
    other = Site()
    other.tag = site.tag
    try:
        site.token = TOKEN
        # Another port is another host to the token, as codeload.github.com is to api.github.com.
        site.redirect_to = other.url
        other_path = f"/archive.tar.gz"

        class Handler(other.server.RequestHandlerClass):
            def do_GET(self):
                other.seen.append((self.path, self.headers.get("Authorization")))
                body = archive("0.2.0")
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        other.server.RequestHandlerClass = Handler
        monkeypatch.setenv("ORCHI_GITHUB_TOKEN", TOKEN)
        code, out = update(capsys)
        assert code == 0, out
        assert other.seen == [(other_path, None)]
    finally:
        other.stop()


# system.get

def test_get_takes_https_or_this_computer_and_nothing_else(monkeypatch):
    monkeypatch.delenv("ORCHI_NO_SYSTEM")
    get = REAL["system.get"]
    for url in ("http://example.com/x", "file:///etc/passwd", "ftp://example.com/x", "http://localhost.example.com/"):
        with pytest.raises(ValueError, match="https"):
            get(url)


def test_get_does_not_trust_a_name_for_this_computer(monkeypatch):
    monkeypatch.delenv("ORCHI_NO_SYSTEM")
    with pytest.raises(ValueError, match="https"):
        REAL["system.get"]("http://localhost:9/x", token=TOKEN)


def test_a_server_on_this_computer_is_never_asked_through_a_proxy(site, monkeypatch):
    monkeypatch.delenv("ORCHI_NO_SYSTEM")
    asked = []

    class Proxy(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            asked.append((self.path, self.headers.get("Authorization")))
            self.send_response(502)
            self.send_header("Content-Length", "0")
            self.end_headers()

    proxy = HTTPServer(("127.0.0.1", 0), Proxy)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    try:
        monkeypatch.setenv("http_proxy", f"http://127.0.0.1:{proxy.server_port}")
        monkeypatch.delenv("no_proxy", raising=False)
        monkeypatch.delenv("NO_PROXY", raising=False)
        body = REAL["system.get"](f"{site.url}/repos/o/r/releases/latest", token=TOKEN)
    finally:
        proxy.shutdown()
        proxy.server_close()
    assert json.loads(body)["tag_name"] == site.tag
    assert asked == []


def test_get_refuses_while_the_suite_has_the_system_switched_off():
    with pytest.raises(system.Refused):
        REAL["system.get"]("https://example.com/")


# From the code review of the pull request

def test_a_development_build_is_not_taken_back_to_an_older_release(computer, site, capsys, monkeypatch):
    monkeypatch.setattr(orchi, "__version__", "0.3.0.dev1")
    site.tag = "v0.2.0"
    code, out = update(capsys)
    assert code == 0 and out == "Orchi 0.3.0.dev1 is the newest.\n" and computer.calls == []


def test_json_says_not_ok_when_the_steps_after_the_update_fail(computer, capsys):
    computer.child_code = 1
    code, out = update(capsys, "--json")
    report = json.loads(out)
    assert code == 1 and report["updated"] is True and report["ok"] is False


def test_a_download_folder_that_cannot_be_cleared_does_not_undo_a_finished_install(computer, capsys, monkeypatch):
    def refuse(*args, **kwargs):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr("shutil.rmtree", refuse)
    code, out = update(capsys)
    assert code == 0 and out == "Updated Orchi from 0.1.0 to 0.2.0.\n"
    assert computer.program("orchi")


def test_the_scheme_in_capitals_is_still_a_server_on_this_computer_and_asked_without_a_proxy(site, monkeypatch):
    monkeypatch.delenv("ORCHI_NO_SYSTEM")
    asked = []

    class Proxy(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            asked.append(self.path)
            self.send_response(502)
            self.send_header("Content-Length", "0")
            self.end_headers()

    proxy = HTTPServer(("127.0.0.1", 0), Proxy)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    try:
        monkeypatch.setenv("http_proxy", f"http://127.0.0.1:{proxy.server_port}")
        monkeypatch.delenv("no_proxy", raising=False)
        monkeypatch.delenv("NO_PROXY", raising=False)
        body = REAL["system.get"]("HTTP" + site.url[4:] + "/repos/o/r/releases/latest", token=TOKEN)
    finally:
        proxy.shutdown()
        proxy.server_close()
    assert json.loads(body)["tag_name"] == site.tag
    assert asked == []


# From the second round of the code review

def test_a_dev_build_of_a_version_moves_to_that_version_when_it_is_released(computer, site, capsys, monkeypatch):
    monkeypatch.setattr(orchi, "__version__", "0.3.0.dev1")
    site.tag = "v0.3.0"
    code, out = update(capsys)
    assert code == 0 and out == "Updated Orchi from 0.3.0.dev1 to 0.3.0.\n"


def test_a_response_cut_short_is_no_release_not_a_traceback(computer, capsys, monkeypatch):
    import http.client

    def cut(*args, **kwargs):
        raise http.client.IncompleteRead(b"")

    monkeypatch.setattr(system, "get", cut)
    code, out = update(capsys)
    assert code == 1 and out == "Could not reach GitHub. Nothing changed.\n"
    assert computer.calls == []


@pytest.mark.parametrize("status", [401, 403])
def test_a_refused_request_points_at_the_token_not_the_network(computer, site, capsys, status):
    site.releases_status = status
    code, out = update(capsys)
    assert code == 1 and out == "GitHub refused the request. Check ORCHI_GITHUB_TOKEN. Nothing changed.\n"
    assert computer.calls == []


# From the third round of the code review

@pytest.mark.parametrize("now", ["0.3.0+abc123", "0.3.0.post1"])
def test_a_local_or_post_release_build_of_the_newest_version_is_the_newest(computer, site, capsys, monkeypatch, now):
    monkeypatch.setattr(orchi, "__version__", now)
    site.tag = "v0.3.0"
    code, out = update(capsys)
    assert code == 0 and out == f"Orchi {now} is the newest.\n" and computer.calls == []


def test_a_release_candidate_moves_to_its_release(computer, site, capsys, monkeypatch):
    monkeypatch.setattr(orchi, "__version__", "0.3.0rc1")
    site.tag = "v0.3.0"
    code, out = update(capsys)
    assert code == 0 and out == "Updated Orchi from 0.3.0rc1 to 0.3.0.\n"


def test_a_warning_after_the_bin_folder_does_not_hide_it(computer, capsys, monkeypatch):
    real = computer.run

    def run(argv, **kw):
        found = real(argv, **kw)
        if [os.fspath(a) for a in argv][1:] == ["tool", "dir", "--bin"]:
            return system.Result(0, found.stdout + "warning: a newer uv is available\n")
        return found

    monkeypatch.setattr(system, "run", run)
    code, out = update(capsys)
    assert code == 0 and computer.program("orchi")
