"""The package has one version string."""
import re

import orchi

from conftest import ROOT


def test_version_is_0_1_0():
    assert orchi.__version__ == "0.1.4"


def test_version_is_a_plain_release_number():
    assert re.fullmatch(r"\d+\.\d+\.\d+", orchi.__version__)


def test_the_version_lives_in_one_place():
    pyproject = (ROOT / "pyproject.toml").read_text()
    assert re.search(r'^dynamic\s*=\s*\[.*"version".*\]', pyproject, re.M)
    assert not re.search(r'^version\s*=', pyproject, re.M)
