"""The scripts hold no person, no old repo name and no home folder of anyone's.

Paths, owners and limits come from Orchi's settings (bin/orchi_settings.py), and the user is "you" in what a
script prints and "the user" in what it says about them.
"""
import re
from pathlib import Path

import pytest

BIN = Path(__file__).resolve().parent.parent
SCRIPTS = sorted(p for p in BIN.iterdir() if p.is_file() and not p.name.endswith(".pyc"))
NAMES = re.compile(r"Adam|(?i:herdr[ -]build)|/Users/|/home/[a-z]|~/Projects|\bE:/")


def test_the_scripts_are_found():
    names = {p.name for p in SCRIPTS}
    assert {"herdr", "herdr-adapter", "switchboard-lock", "usage-guard", "pane-notify"} <= names


@pytest.mark.parametrize("script", SCRIPTS, ids=lambda p: p.name)
def test_no_name_or_home_folder(script):
    hits = [(n, line.strip()) for n, line in enumerate(script.read_text().splitlines(), 1) if NAMES.search(line)]
    assert hits == []
