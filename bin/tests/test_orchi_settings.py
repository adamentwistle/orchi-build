"""orchi_settings: reads ~/.config/orchi/settings.json, or $ORCHI_SETTINGS, with a default for every value."""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import orchi_settings as st  # noqa: E402


def write(tmp_path, monkeypatch, value):
    f = tmp_path / "settings.json"
    f.write_text(value if isinstance(value, str) else json.dumps(value))
    monkeypatch.setenv("ORCHI_SETTINGS", str(f))


def test_missing_broken_or_not_an_object_is_no_settings(tmp_path, monkeypatch):
    monkeypatch.setenv("ORCHI_SETTINGS", str(tmp_path / "none.json"))
    assert st.load() == {}
    for text in ("", "{", "[]", "3", "null"):
        write(tmp_path, monkeypatch, text)
        assert st.load() == {}


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


def test_claude_dir_is_the_settings_else_the_default_never_the_env(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/env/claude")
    write(tmp_path, monkeypatch, {})
    assert st.claude_dir() == str(tmp_path / ".claude")
    write(tmp_path, monkeypatch, {"claude_dir": "~/.claude-alt/"})
    assert st.claude_dir() == str(tmp_path / ".claude-alt")
    assert st.switchboard_dir() == str(tmp_path / ".claude-alt/switchboard")
    assert st.claude_dir({"claude_dir": "  "}) == str(tmp_path / ".claude")


def test_owners_are_lower_case_strings_only(tmp_path, monkeypatch):
    write(tmp_path, monkeypatch, {"github": {"own_owners": ["Acme-Labs", " ", 3, "x"]}})
    assert st.owners("own") == ["acme-labs", "x"]
    assert st.owners("own", {"github": {"own_owners": "me"}}) == []
    assert st.owners("own", {"github": []}) == []
    assert st.owners("own", {}) == []
