"""Helpers for the sources that are files on this computer."""
import os
from pathlib import Path

from orchi import settings


def tilde(path):
    """A path with the home folder written as ~, as references and settings write it."""
    home = os.path.expanduser("~").rstrip("/")
    text = str(path)
    if home and text == home:
        return "~"
    return "~" + text[len(home):] if home and text.startswith(home + "/") else text


def expand(text):
    """A path with ~ expanded, the way settings expand theirs."""
    return settings._expand(text, os.path.expanduser("~")) if text == "~" or text.startswith("~/") else text


def unreadable(error):
    """An OSError as one plain line: the path, and why it can't be read."""
    where = f"{tilde(error.filename)} " if error.filename else ""
    return f"{where}can't be read: {error.strerror or error}"


def listing(folder):
    """The .md files directly inside a folder, by name, leaving out hidden ones and links that lead out of it. An
    OSError means the folder can't be listed; pathlib's glob() would hide that and list nothing."""
    inside = os.path.realpath(folder).rstrip("/") + "/"
    names = sorted(n for n in os.listdir(folder) if n.endswith(".md") and not n.startswith("."))
    return [p for p in (Path(folder) / n for n in names) if p.is_file() and os.path.realpath(p).startswith(inside)]


def read(path):
    """A file's text, or None when it can't be read as UTF-8."""
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (OSError, ValueError):
        return None
