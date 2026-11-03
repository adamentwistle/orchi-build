"""Orchi's settings, from $ORCHI_SETTINGS or ~/.config/orchi/settings.json.

Only the values the scripts need are read here, and each has a default, so a missing or broken file reads as no
settings. The scripts beside this file import it; Python puts a script's own folder on its path.
"""
import json
import os


def path():
    """$ORCHI_SETTINGS as an absolute path, ~ expanded, else ~/.config/orchi/settings.json."""
    custom = os.environ.get("ORCHI_SETTINGS")
    return os.path.abspath(os.path.expanduser(custom)) if custom else os.path.expanduser("~/.config/orchi/settings.json")


def load():
    try:
        with open(path(), encoding="utf-8") as f:
            s = json.load(f)
    except (OSError, ValueError):
        return {}
    return s if isinstance(s, dict) else {}


def _folder(v):
    if not isinstance(v, str) or not v.strip():
        return None
    return os.path.expanduser(v.strip()).rstrip("/") or "/"


def claude_dir(s=None):
    """The Claude Code profile folder: the settings, else ~/.claude. The panels read it the same way, so a script and
    a panel always agree on the switchboard's folder, whatever profile the shell runs."""
    s = load() if s is None else s
    return _folder(s.get("claude_dir")) or os.path.expanduser("~/.claude")


def switchboard_dir(s=None):
    return os.path.join(claude_dir(s), "switchboard")


def owners(key, s=None):
    """A list of GitHub owners from settings' "github" object, lower-cased: key "own" reads github.own_owners."""
    s = load() if s is None else s
    github = s.get("github") if isinstance(s.get("github"), dict) else {}
    got = github.get(f"{key}_owners")
    return [o.strip().lower() for o in got if isinstance(o, str) and o.strip()] if isinstance(got, list) else []
