"""orchi.system, the one place setup starts a program or downloads a page, and the guards that keep every other test off
the real ones."""
import os
import subprocess
import sys

import pytest

from conftest import REAL, ROOT
from orchi import system


@pytest.fixture
def on(monkeypatch):
    """The real run and fetch, with the suite's switch off for this test."""
    monkeypatch.delenv("ORCHI_NO_SYSTEM")


def test_every_test_starts_with_a_system_that_fails_instead_of_starting_a_program():
    with pytest.raises(AssertionError, match="fake orchi.system.run"):
        system.run(["/bin/echo", "hi"])
    with pytest.raises(AssertionError, match="fake orchi.system.fetch"):
        system.fetch("https://example.com/install.sh")
    with pytest.raises(AssertionError, match="fake orchi.system.sleep"):
        system.sleep(1)


@pytest.mark.parametrize("argv", [["launchctl", "list"], ["/opt/homebrew/bin/brew", "install", "gh"], ["xcode-select", "-p"],
                                  ["sh", "-c", "npm install -g agent-browser"], ["env", "brew", "list"]])
def test_the_programs_that_change_a_mac_cannot_be_started_by_any_other_route(argv):
    with pytest.raises(AssertionError, match="changes the Mac"):
        subprocess.Popen(argv)


def test_the_suite_switches_the_real_run_off_for_itself_and_every_child_it_starts():
    assert os.environ["ORCHI_NO_SYSTEM"] == "1"
    with pytest.raises(system.Refused):
        REAL["system.run"](["/bin/echo", "hi"])
    with pytest.raises(system.Refused):
        REAL["system.fetch"]("https://example.com/")
    child = subprocess.run([sys.executable, "-c", "from orchi import system; system.run(['/bin/echo','x'])"],
                           env={**os.environ, "PYTHONPATH": str(ROOT / "src")}, capture_output=True, text=True)
    assert child.returncode != 0 and "Refused" in child.stderr


def test_the_real_run_gives_the_exit_code_and_the_output(monkeypatch, on):
    monkeypatch.setattr(system, "run", REAL["system.run"])
    done = system.run(["/bin/sh", "-c", "echo out; echo err >&2; exit 3"])
    assert done.returncode == 3 and done.stdout.strip() == "out\nerr"


def test_the_real_run_passes_input_and_the_environment_it_is_given(monkeypatch, on):
    monkeypatch.setattr(system, "run", REAL["system.run"])
    done = system.run(["/bin/sh", "-c", "cat; echo $ORCHI_TEST_WORD"], input="piped\n", env={"ORCHI_TEST_WORD": "yes", "PATH": "/bin"})
    assert done.stdout == "piped\nyes\n"


def test_a_program_that_is_not_there_exits_127_and_one_that_takes_too_long_exits_124(monkeypatch, on):
    monkeypatch.setattr(system, "run", REAL["system.run"])
    assert system.run(["/nowhere/nothing"]).returncode == 127
    assert system.run(["/bin/sleep", "5"], timeout=0.2).returncode == 124


def test_fetch_takes_https_only(monkeypatch, on):
    monkeypatch.setattr(system, "fetch", REAL["system.fetch"])
    for url in ("http://example.com/install.sh", "file:///etc/passwd", "ftp://example.com/x"):
        with pytest.raises(ValueError, match="https"):
            system.fetch(url)


def test_find_looks_on_path_then_in_the_extra_folders_and_wants_something_it_can_run(tmp_path, monkeypatch):
    on_path, extra = tmp_path / "path", tmp_path / "extra"
    on_path.mkdir()
    extra.mkdir()
    monkeypatch.setenv("PATH", str(on_path))
    monkeypatch.setattr(system, "EXTRA_DIRS", (str(extra),))
    (extra / "tool").write_text("")
    assert system.find("tool") is None
    (extra / "tool").chmod(0o755)
    assert system.find("tool") == str(extra / "tool")
    (on_path / "tool").write_text("")
    (on_path / "tool").chmod(0o755)
    assert system.find("tool") == str(on_path / "tool")
    assert system.find("nothing") is None


def test_a_folder_found_by_find_joins_path_once(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", "/usr/bin")
    system.add_to_path(str(tmp_path))
    system.add_to_path(str(tmp_path))
    assert os.environ["PATH"].split(os.pathsep) == [str(tmp_path), "/usr/bin"]


@pytest.mark.parametrize("name, said", [("darwin", "darwin"), ("linux", "linux"), ("win32", "windows"),
                                        ("cygwin", "windows"), ("freebsd14", "freebsd14")])
def test_the_platform_has_a_plain_name(monkeypatch, name, said):
    monkeypatch.setattr(system, "platform", REAL["system.platform"])
    monkeypatch.setattr(sys, "platform", name)
    assert system.platform() == said


def test_a_redirect_to_anything_but_https_is_refused():
    import urllib.error
    import urllib.request
    handler = system.HttpsOnly()
    request = urllib.request.Request("https://example.com/install.sh")
    with pytest.raises(urllib.error.URLError):
        handler.redirect_request(request, None, 302, "Found", {}, "http://example.com/install.sh")
    assert handler.redirect_request(request, None, 302, "Found", {}, "https://example.com/other.sh") is not None


def test_a_program_finds_the_tools_in_the_extra_folders_on_its_path(tmp_path, monkeypatch, on):
    monkeypatch.setattr(system, "run", REAL["system.run"])
    folder = tmp_path / "brew-bin"
    folder.mkdir()
    monkeypatch.setattr(system, "EXTRA_DIRS", (str(folder),))
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    done = system.run(["/bin/sh", "-c", 'printf %s "$PATH"'])
    assert str(folder) in done.stdout.split(os.pathsep)
    assert done.stdout.split(os.pathsep)[:2] == ["/usr/bin", "/bin"]
