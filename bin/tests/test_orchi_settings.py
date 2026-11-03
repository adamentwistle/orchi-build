"""orchi_settings: the copy of src/orchi/settings.py that the scripts beside it import.

The reader itself is tested in pkgtests/test_settings.py. These check the copy is that file, and the parts the
scripts lean on: where the files are, and the profile and switchboard folders.
"""
import json
import sys
from pathlib import Path

BIN = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BIN))
import orchi_settings as st  # noqa: E402


def test_it_is_the_packages_reader_byte_for_byte():
    assert (BIN / "orchi_settings.py").read_bytes() == (BIN.parent / "src" / "orchi" / "settings.py").read_bytes()


def write(tmp_path, monkeypatch, value):
    f = tmp_path / "settings.json"
    f.write_text(value if isinstance(value, str) else json.dumps(value))
    monkeypatch.setenv("ORCHI_SETTINGS", str(f))


def test_a_custom_path_is_expanded_and_absolute(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ORCHI_SETTINGS", "~/s.json")
    assert st.path() == str(tmp_path / "s.json")
    (tmp_path / "s.json").write_text('{"claude_dir": "/p"}')
    assert st.claude_dir() == "/p"


def test_default_path_is_under_the_home(tmp_path, monkeypatch):
    monkeypatch.delenv("ORCHI_SETTINGS", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    assert st.path() == str(tmp_path / ".config/orchi/settings.json")


def test_the_old_files_are_under_herdr_app_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERDR_APP_HOME", str(tmp_path / "app"))
    (tmp_path / "app").mkdir()
    (tmp_path / "app" / "orchi.json").write_text('{"workerLimit": 9}')
    write(tmp_path, monkeypatch, {})
    assert st.read()["worker_limit"] == 9


def test_claude_dir_is_the_settings_else_the_default_never_the_env(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/env/claude")
    write(tmp_path, monkeypatch, {})
    assert st.claude_dir() == str(tmp_path / ".claude")
    assert st.switchboard_dir() == str(tmp_path / ".claude/switchboard")
    write(tmp_path, monkeypatch, {"claude_dir": "~/.claude-alt/"})
    assert st.claude_dir() == str(tmp_path / ".claude-alt")
    assert st.switchboard_dir() == str(tmp_path / ".claude-alt/switchboard")


def test_profile_dir_is_set_only_by_the_settings(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/env/claude")
    write(tmp_path, monkeypatch, {})
    assert st.profile_dir() is None
    write(tmp_path, monkeypatch, {"claude_dir": "  "})
    assert st.profile_dir() is None
    write(tmp_path, monkeypatch, {"claude_dir": "~/.claude-alt"})
    assert st.profile_dir() == str(tmp_path / ".claude-alt")


def test_the_helpers_take_read_settings_too(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    s = st.resolve('{"claude_dir": "/p"}')
    assert st.claude_dir(s) == "/p"
    assert st.profile_dir(s) == "/p"
    assert st.switchboard_dir(s) == "/p/switchboard"
    assert st.claude_dir(st.resolve()) == str(tmp_path / ".claude")
