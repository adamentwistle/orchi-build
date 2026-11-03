"""Legwork: each project file in the tracker's projects/ folder is a ticket. Its state is its status: line."""
import re
from pathlib import Path

from orchi import refs
from orchi.tickets.files import listing, read, tilde
from orchi.tickets.shape import SourceError, ticket

FIELD = re.compile(r"([A-Za-z_]+):[ \t]*(.*?)[ \t]*")
# A project that is done, or shelved on ice, is not open work.
CLOSED = ("done", "icebox")


def _split(text):
    """The frontmatter's fields and the text after it."""
    lines = [line.rstrip("\r") for line in text.split("\n")]
    if not lines or lines[0].strip() != "---":
        return {}, text
    for end in range(1, len(lines)):
        if lines[end].strip() == "---":
            fields = {}
            for line in lines[1:end]:
                m = FIELD.fullmatch(line)
                if m:
                    fields.setdefault(m.group(1), m.group(2))
            return fields, "\n".join(lines[end + 1:])
    return {}, text


def _ticket(path, text, with_body):
    fields, rest = _split(text)
    status = fields.get("status", "")
    category = fields.get("category", "")
    return ticket(f"legwork:{path.stem}", fields.get("name") or path.stem, status, status.strip("\"'").lower() not in CLOSED,
                  url=path.as_uri(), updated=fields.get("updated") or None, labels=[category] if category else [],
                  body=rest.strip() if with_body else None)


def _folder(s):
    return Path(s["legwork_dir"]) / "projects" if s["legwork_dir"] else None


def list_open(s):
    folder = _folder(s)
    if folder is None:
        return [], []
    try:
        if not folder.is_dir():
            return [], [f"{tilde(folder)} is not there"]
        paths = listing(folder)
    except OSError:
        return [], [f"{tilde(folder)} can't be read"]
    tickets, problems = [], []
    for path in paths:
        if path.name.startswith("_"):
            continue
        if not refs.LEGWORK.fullmatch(path.stem):
            problems.append(f"{tilde(path)} can't be named in a reference")
            continue
        text = read(path)
        if text is None:
            problems.append(f"{tilde(path)} can't be read")
            continue
        got = _ticket(path, text, with_body=False)
        if got["open"]:
            tickets.append(got)
    return tickets, problems


def show(ref, s):
    folder = _folder(s)
    if folder is None:
        raise SourceError("no legwork_dir in settings")
    try:
        paths = listing(folder)
    except OSError:
        raise SourceError(f"{tilde(folder)} can't be read") from None
    path = folder / f"{ref['project']}.md"
    if path not in paths:
        return None
    text = read(path)
    if text is None:
        raise SourceError(f"{tilde(path)} can't be read")
    return _ticket(path, text, with_body=True)
