"""Orchi's settings, from ~/.config/orchi/settings.json ($ORCHI_SETTINGS overrides), with a default for every value.

src/orchi/settings.schema.json lists every key. read() gives them all, already checked: folders with ~
expanded, numbers in range, lists without blanks or repeats. A value that can't be used reads as unset, and
validate() names it, one line each, for `orchi doctor`.

Until setup moves them, two older files in Herdr's app home fill in what settings.json leaves out: orchi.json's
workerLimit, and linear.json's teams, repos, legwork.dir and legwork.projects. linear.json's apiKey is never read
here, because no secret is ever a setting.

This file is the one source. bin/orchi_settings.py is a copy of it, so the scripts in bin/ can import it without the
package installed, and a test checks the copy matches. The mods read the same keys the same way in
mods/<mod>/settings.js, and a test runs one set of fixtures through both readers.
"""
import json
import os
import re

SOURCES = ("legwork", "github", "linear", "markdown")
WORKER_LIMIT = (1, 50, 6)
USAGE_GUARD_PERCENT = (1, 100, 95)
ORCHI_DIR = "~/orchi-build"
GH_COMMAND = "gh"
CLAUDE_DIR = "~/.claude"

KEYS = ("claude_dir", "orchi_dir", "legwork_dir", "worker_limit", "usage_guard_percent", "sources",
        "github", "linear", "markdown")
GROUPS = {"github": ("own_owners", "repos", "command"), "linear": ("teams", "projects", "repos", "legwork_projects"),
          "markdown": ("paths",)}

# What JavaScript's trim() takes off, so both readers see the same value.
SPACE = ("\t\n\x0b\x0c\r \xa0            "
         "    　﻿")
# Only A to Z change case: owners, repos and team keys are ASCII, and other letters would lean on the Unicode tables
# of each runtime, which differ between Python and Node versions.
LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")
UPPER = str.maketrans("abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
REPO = re.compile(r"[a-z0-9-]+/[a-z0-9._-]+")
SECRET_WORDS = {"apikey", "apikeys", "token", "tokens", "secret", "secrets", "password", "passwd", "pat", "credential",
                "credentials"}
# A key word after one of these names a secret, as in api_key, privateKey and ssh_key; team_key and key_file don't.
SECRET_KEYS = {"api", "private", "ssh", "access", "secret", "signing", "auth"}


def path():
    """$ORCHI_SETTINGS as an absolute path, ~ expanded, else ~/.config/orchi/settings.json."""
    custom = os.environ.get("ORCHI_SETTINGS")
    return os.path.abspath(os.path.expanduser(custom)) if custom else os.path.expanduser("~/.config/orchi/settings.json")


def old_dir():
    """Herdr's app home, where orchi.json and linear.json are: $HERDR_APP_HOME, else ~/.config/herdr-app."""
    return os.path.expanduser(os.environ.get("HERDR_APP_HOME") or "~/.config/herdr-app")


def read(home=None):
    """Every setting, from settings.json, then the old files, then the defaults."""
    return resolve(_text(path()), _text(os.path.join(old_dir(), "orchi.json")),
                   _text(os.path.join(old_dir(), "linear.json")), home)


def resolve(settings=None, orchi=None, linear=None, home=None):
    """Every setting from the text of settings.json, orchi.json and linear.json. None is a file that isn't there, and
    a file that isn't a JSON object counts as not there."""
    home = os.path.expanduser("~") if home is None else home
    return _resolve(_parse(settings)[0] or {}, _parse(orchi)[0] or {}, _parse(linear)[0] or {}, home, _quiet)


def validate(text=None):
    """One plain line per value in settings.json that can't be used, naming the key and why. Given no text, it reads
    the file, and a file that isn't there is fine."""
    if text is None:
        try:
            with open(path(), encoding="utf-8") as f:
                text = f.read()
        except FileNotFoundError:
            return []
        except (OSError, ValueError) as e:
            return [f"{path()}: can't be read: {e}"]
    s, why = _parse(text)
    if s is None:
        return [f"{path()}: {why}"]
    problems = []
    _resolve(s, {}, {}, os.path.expanduser("~"), lambda key, why: problems.append(f"{key}: {why}"))
    return problems


def profile_dir(s=None):
    """The Claude Code profile the settings set, or None. Sessions Orchi starts get it as CLAUDE_CONFIG_DIR."""
    s = read() if s is None else s
    return _folder(s.get("claude_dir"), os.path.expanduser("~"))


def claude_dir(s=None):
    """The Claude Code profile folder: the settings, else ~/.claude, never the shell's CLAUDE_CONFIG_DIR. The panels
    read it the same way, so a script and a panel always agree on the switchboard's folder."""
    return profile_dir(s) or _expand(CLAUDE_DIR, os.path.expanduser("~"))


def switchboard_dir(s=None):
    return os.path.join(claude_dir(s), "switchboard")


def _text(file):
    try:
        with open(file, encoding="utf-8") as f:
            return f.read()
    except (OSError, ValueError):
        return None


def _no_constant(name):
    raise ValueError(f"{name} is not allowed")


def _int(digits):
    """A whole number from JSON. One too long for Python's int becomes infinite, as JavaScript reads it, so it is out
    of range rather than spoiling the file."""
    try:
        return int(digits)
    except ValueError:
        return float(digits)


def _parse(text):
    """(the object, None), or (None, why not). JSON has no NaN or Infinity, and JavaScript refuses them."""
    if text is None:
        return None, None
    try:
        value = json.loads(text, parse_constant=_no_constant, parse_int=_int)
    except (ValueError, RecursionError) as e:
        return None, f"not valid JSON: {e}"
    return (value, None) if isinstance(value, dict) else (None, "not a JSON object")


def _quiet(key, why):
    pass


def _show(value):
    """A value as JSON, short, on one printable line."""
    shown = json.dumps(value, ensure_ascii=False)
    if not shown.isprintable():
        shown = json.dumps(value)
    return shown if len(shown) <= 40 else shown[:37] + "..."


def _name(key):
    """A name from the file as it is, or quoted with its escapes when it can't be printed on one line."""
    return key if key.isprintable() else json.dumps(key)


def _trim(value):
    return value.strip(SPACE) if isinstance(value, str) else ""


def _expand(text, home):
    if text == "~" or text.startswith("~/"):
        text = home + text[1:]
    return text.rstrip("/") or "/"


def _folder(value, home):
    """A full path, from / or ~/, ~ expanded. A relative one would mean a different folder from each working folder."""
    text = _trim(value)
    path = _expand(text, home) if text else None
    return path if path and path.startswith("/") else None


def _command(value, home):
    """A command as one word: a name on PATH, or a path from / or ~/, ~ expanded. Spaces would make it a command line,
    and a path from the working folder would run a different program from each folder."""
    text = _trim(value)
    if not text or any(c in SPACE or ord(c) < 0x20 or 0x7f <= ord(c) <= 0x9f for c in text):
        return None
    text = _expand(text, home) if text == "~" or text.startswith("~/") else text
    return None if "/" in text and not text.startswith("/") else text


def _whole(value, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float):
        if not value.is_integer():
            return None
        value = int(value)
    return value if low <= value <= high else None


def _list(value, key, bad, item, why):
    """What `item` makes of each entry of a list, once each, or None when it isn't a list."""
    if not isinstance(value, list):
        bad(key, f"{_show(value)} is not a list")
        return None
    out, seen = [], set()
    for entry in value:
        got = item(entry)
        if got is None:
            bad(key, f"{_show(entry)} {why}")
        elif got not in seen:
            seen.add(got)
            out.append(got)
    return out


def _js_order(items):
    """An object's entries in the order JavaScript lists them: names that are array indexes first, by number, then
    the rest as written. When two names come out the same, as " eng " and "ENG" do, the one listed last wins in both
    readers."""
    def index(k):
        return len(k) <= 10 and re.fullmatch(r"0|[1-9][0-9]*", k) is not None and int(k) < 2 ** 32 - 1
    return sorted((kv for kv in items if index(kv[0])), key=lambda kv: int(kv[0])) + [kv for kv in items if not index(kv[0])]


def _map(value, key, bad, name, name_why, item, why, same_why):
    """An object with its names and values made over by `name` and `item`, or None when it isn't an object."""
    if not isinstance(value, dict):
        bad(key, f"{_show(value)} is not an object")
        return None
    out, first = {}, {}
    for k, entry in _js_order(list(value.items())):
        n = name(k)
        if not n:
            bad(key, f"{_show(k)} {name_why}")
            continue
        got = item(entry)
        if got is None:
            bad(f"{key}.{_name(k)}", f"{_show(entry)} {why}")
            continue
        if n in first:
            bad(key, f"{_show(k)} {same_why} {_show(first[n])}")
        first.setdefault(n, k)
        out[n] = got
    return out


def _first(*values):
    return next((v for v in values if v is not None), None)


def _secret(name):
    """Whether a name is a secret's, as key, apiKey, private_key and githubToken are, and keyboard_layout, team_key and
    key_file aren't."""
    words = [w for w in re.split(r"[^a-z0-9]+", re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name).lower()) if w]
    keyed = any(a in SECRET_KEYS and b in ("key", "keys") for a, b in zip(words, words[1:]))
    return words in (["key"], ["keys"]) or keyed or bool(SECRET_WORDS & set(words))


def _unknown(obj, known, prefix, bad):
    for k in sorted(k for k in obj if k not in known):
        bad(prefix + _name(k), "a secret never goes in settings; take it out" if _secret(k) else "Orchi has no such setting")


def _resolve(s, orchi, linear, home, bad):
    """Every setting from settings `s`, else the old orchi.json and linear.json, else the default. `bad` hears about
    each value in `s` that can't be used."""
    _unknown(s, KEYS, "", bad)

    def folder(key):
        if key not in s:
            return None
        got = _folder(s[key], home)
        if got is None:
            bad(key, f"{_show(s[key])} is not a folder path from / or ~/")
        return got

    def number(key, old, limits):
        low, high, default = limits
        if key in s:
            got = _whole(s[key], low, high)
            if got is not None:
                return got
            bad(key, f"{_show(s[key])} is not a whole number from {low} to {high}")
        return _first(_whole(old, low, high), default)

    def group(key):
        value = s.get(key, {})
        if not isinstance(value, dict):
            bad(key, f"{_show(value)} is not an object")
            return {}
        _unknown(value, GROUPS[key], f"{key}.", bad)
        return value

    def command(key, g):
        if key not in g:
            return None
        got = _command(g[key], home)
        if got is None:
            bad(f"github.{key}", f"{_show(g[key])} is not one command name or path")
        return got

    def listed(g, gkey, key, item, why):
        return _list(g[key], f"{gkey}.{key}", bad, item, why) if key in g else None

    def mapped(g, gkey, key, name, name_why, item, why, same_why):
        return _map(g[key], f"{gkey}.{key}", bad, name, name_why, item, why, same_why) if key in g else None

    def old_list(value, item):
        return _list(value, "", _quiet, item, "")

    def old_map(value, name, item):
        return _map(value, "", _quiet, name, "", item, "", "")

    old_legwork = linear.get("legwork") if isinstance(linear.get("legwork"), dict) else {}
    owner = lambda v: _trim(v).translate(LOWER) or None  # noqa: E731
    repo = lambda v: _trim(v).translate(LOWER) if REPO.fullmatch(_trim(v).translate(LOWER)) else None  # noqa: E731
    team = lambda v: _trim(v).translate(UPPER) or None  # noqa: E731
    text = lambda v: _trim(v) or None  # noqa: E731
    place = lambda v: _folder(v, home)  # noqa: E731
    source = lambda v: v if v in SOURCES else None  # noqa: E731

    out = {
        "claude_dir": folder("claude_dir"),
        "orchi_dir": _first(folder("orchi_dir"), _expand(ORCHI_DIR, home)),
        "legwork_dir": _first(folder("legwork_dir"), _folder(old_legwork.get("dir"), home)),
        "worker_limit": number("worker_limit", orchi.get("workerLimit"), WORKER_LIMIT),
        "usage_guard_percent": number("usage_guard_percent", None, USAGE_GUARD_PERCENT),
    }
    chosen = _list(s["sources"], "sources", bad, source,
                   "is not a ticket source: use legwork, github, linear or markdown") if "sources" in s else None
    out["sources"] = [x for x in SOURCES if x == "legwork" or x in (chosen or ())]

    g = group("github")
    out["github"] = {
        "own_owners": _first(listed(g, "github", "own_owners", owner, "is not a GitHub owner"), []),
        "repos": _first(listed(g, "github", "repos", repo, "is not owner/repo"), []),
        "command": _first(command("command", g), GH_COMMAND),
    }
    ln = group("linear")
    out["linear"] = {
        "teams": _first(listed(ln, "linear", "teams", team, "is not a team key"), old_list(linear.get("teams"), team), []),
        "projects": _first(listed(ln, "linear", "projects", text, "is not a project id"), []),
        "repos": _first(mapped(ln, "linear", "repos", team, "is not a team key", place, "is not a folder path from / or ~/",
                               "is the same team as"),
                        old_map(linear.get("repos"), team, place), {}),
        "legwork_projects": _first(
            mapped(ln, "linear", "legwork_projects", text, "is not a Linear project id", text,
                   "is not a legwork project file", "is the same project as"),
            old_map(old_legwork.get("projects"), text, text), {}),
    }
    md = group("markdown")
    out["markdown"] = {"paths": _first(listed(md, "markdown", "paths", place, "is not a file or folder path from / or ~/"), [])}
    return out
