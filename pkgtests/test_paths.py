"""orchi.paths.data_dir() says where the shipped content lives: the checkout, or the installed wheel."""
from pathlib import Path

import pytest

from conftest import DATA_FOLDERS, ROOT
from orchi import paths


def test_from_a_checkout_it_is_the_repo_root():
    assert paths.data_dir() == ROOT


def test_every_content_folder_is_under_it():
    for name in DATA_FOLDERS:
        assert (paths.data_dir() / name).is_dir(), name


def test_it_returns_a_path():
    assert isinstance(paths.data_dir(), Path)


def test_an_installed_copy_prefers_the_data_folder_beside_the_code(tmp_path, monkeypatch):
    package = tmp_path / "site" / "orchi"
    (package / "data" / "mods").mkdir(parents=True)
    monkeypatch.setattr(paths, "__file__", str(package / "paths.py"))
    assert paths.data_dir() == package / "data"


def test_a_copy_with_no_content_anywhere_fails_loudly(tmp_path, monkeypatch):
    package = tmp_path / "site" / "orchi"
    package.mkdir(parents=True)
    monkeypatch.setattr(paths, "__file__", str(package / "paths.py"))
    with pytest.raises(FileNotFoundError):
        paths.data_dir()
