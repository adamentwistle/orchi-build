"""Ticket references: `linear:ENG-12`, `gh:owner/repo#12`, `legwork:<project>` and `md:<file>#<anchor>`.

A bare `ENG-12` reads as Linear. parse() gives what a reference names, or raises RefError with a plain message.
This is the one parser. Each mod that needs it carries the same mods/<mod>/refs.js, and tests/tickets/refs.json runs
through both, so they agree on every reference and every message. Every pattern here is ASCII only, written out, so
neither runtime's Unicode tables decide what a digit or a space is.
"""
import re

SPACE = " \t\r\n"
PREFIX = re.compile(r"([A-Za-z][A-Za-z0-9_-]*):([\s\S]*)")
KEY = re.compile(r"[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8}")
GH = re.compile(r"([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,9})")
LEGWORK = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}")
MD = re.compile(r"((?:/|~/)[^\x00-\x20\x7f-\x9f#,]{0,1000}\.md)#([a-z0-9_-]{1,100})")
LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")

EMPTY = "a ticket reference can't be empty"
BARE = "a reference with no source is a Linear key, such as ENG-12"
LINEAR = "a Linear key is written like ENG-12"
GITHUB = "a GitHub issue is written gh:owner/repo#12"
LEGWORK_PROJECT = "a legwork project is written legwork:<project file name>"
MARKDOWN = "a Markdown task is written md:<file from / or ~/>#<anchor>"


class RefError(ValueError):
    pass


def _linear(key):
    return {"source": "linear", "id": key, "ref": f"linear:{key}", "key": key}


def _github(rest):
    m = GH.fullmatch(rest)
    if not m or m.group(2) in (".", ".."):
        raise RefError(GITHUB)
    repo = f"{m.group(1)}/{m.group(2)}".translate(LOWER)
    number = int(m.group(3))
    return {"source": "github", "id": f"{repo}#{number}", "ref": f"gh:{repo}#{number}", "repo": repo, "number": number}


def _legwork(rest):
    if not LEGWORK.fullmatch(rest):
        raise RefError(LEGWORK_PROJECT)
    return {"source": "legwork", "id": rest, "ref": f"legwork:{rest}", "project": rest}


def _markdown(rest):
    m = MD.fullmatch(rest)
    if not m or any(part in (".", "..") for part in m.group(1).split("/")):
        raise RefError(MARKDOWN)
    return {"source": "markdown", "id": rest, "ref": f"md:{rest}", "file": m.group(1), "anchor": m.group(2)}


def parse(text):
    """What a ticket reference names: its source (as settings name it), id, the reference written out in full, and
    the parts its source needs. Raises RefError for anything else."""
    text = text.strip(SPACE) if isinstance(text, str) else ""
    if not text:
        raise RefError(EMPTY)
    m = PREFIX.fullmatch(text)
    if not m:
        if KEY.fullmatch(text):
            return _linear(text)
        raise RefError(BARE)
    prefix, rest = m.groups()
    if prefix == "linear":
        if KEY.fullmatch(rest):
            return _linear(rest)
        raise RefError(LINEAR)
    if prefix == "gh":
        return _github(rest)
    if prefix == "legwork":
        return _legwork(rest)
    if prefix == "md":
        return _markdown(rest)
    raise RefError(f"{prefix} is not a ticket source: use linear, gh, legwork or md")
