"""For every test under this folder: ORCHI_SETTINGS and HERDR_APP_HOME start out pointing into a temporary folder of
the test's own, where there are no files, so no test reads the real settings or Herdr's own files. A test that
wants settings writes them there or points these elsewhere.

It sits at the top so pytest loads it before bin/tests and pkgtests, whose tests import pkgtests/conftest.py by name.
"""
import pytest


@pytest.fixture(autouse=True)
def no_real_settings(tmp_path_factory, monkeypatch):
    base = tmp_path_factory.mktemp("no-settings")
    monkeypatch.setenv("ORCHI_SETTINGS", str(base / "settings.json"))
    monkeypatch.setenv("HERDR_APP_HOME", str(base / "herdr-app"))
