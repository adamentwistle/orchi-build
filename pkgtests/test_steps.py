"""The first real steps: Orchi's own files are there, the settings folder is there, and the settings are valid."""
import io
import json

import pytest

from engine_help import home  # noqa: F401
from orchi import engine, paths, screen, settings, steps, store


def by_name(name):
    return next(s for s in steps.steps() if s.name == name)


def test_the_steps_have_names_and_run_in_order():
    assert [s.name for s in steps.steps()][:3] == ["Orchi files", "Settings folder", "Settings"]


def test_orchi_files_are_found_in_a_checkout(home):
    assert by_name("Orchi files").check() == engine.ok()


def test_orchi_files_missing_is_broken(home, monkeypatch):
    def missing():
        raise FileNotFoundError("gone")

    monkeypatch.setattr(paths, "data_dir", missing)
    assert by_name("Orchi files").check().status == "broken"


def test_a_missing_settings_folder_needs_a_fix_and_the_fix_makes_it(home):
    folder = home / ".config" / "orchi"
    step = by_name("Settings folder")
    assert step.check() == engine.needs_fix("missing")
    code = engine.run([step], fix=True, screen=screen.Screen(io.StringIO()), store=store.Store())
    assert code == 0
    assert folder.is_dir()
    assert {r["path"] for r in store.Store().owned()} == {str(home / ".config"), str(folder)}


def test_a_settings_folder_that_is_a_file_is_broken(home):
    (home / ".config").mkdir()
    (home / ".config" / "orchi").write_text("")
    assert by_name("Settings folder").check().status == "broken"


def test_no_settings_file_is_valid(home):
    assert by_name("Settings").check() == engine.ok()


def test_settings_with_bad_values_are_broken_and_each_is_named(home):
    path = home / ".config" / "orchi" / "settings.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"worker_limit": 99, "sources": ["fax"]}))
    result = by_name("Settings").check()
    assert result.status == "broken"
    for problem in settings.validate():
        assert problem in result.detail


def test_settings_that_are_not_json_are_broken(home):
    path = home / ".config" / "orchi" / "settings.json"
    path.parent.mkdir(parents=True)
    path.write_text("{half")
    assert "not valid JSON" in by_name("Settings").check().detail


@pytest.mark.parametrize("name", ["Orchi files", "Settings"])
def test_steps_orchi_cannot_fix_have_no_fix(name):
    assert not by_name(name).can_fix()


def test_the_settings_folder_can_be_fixed():
    assert by_name("Settings folder").can_fix()
