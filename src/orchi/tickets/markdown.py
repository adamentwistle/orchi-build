"""Markdown task files: each top-level task list item, `- [ ] ...` or `- [x] ...`, is a ticket.

The files are the ones markdown.paths names, and the .md files directly inside the folders it names. A task's anchor is
its text made into a GitHub-style anchor in ASCII, with -1, -2 added until no other task has it. Lines indented under an item are its body.
Items inside code blocks are not tasks.
"""
import os
import re
import textwrap
from datetime import datetime, timezone
from pathlib import Path

from orchi import refs
from orchi.tickets.files import expand, listing, read, tilde
from orchi.tickets.shape import SourceError, ticket

ITEM = re.compile(r"[-*+] \[([ xX])\] (.*\S)")
# A code block opens with three or more backticks or tildes, indented up to three spaces, and closes with at least as
# many of the same character and nothing after them. A backtick opener's info string has no backticks.
OPENS = re.compile(r" {0,3}(`{3,}|~{3,})(.*)")
CLOSES = re.compile(r" {0,3}(`{3,}|~{3,})[ \t]*")
KEEP = set("abcdefghijklmnopqrstuvwxyz0123456789 _-")


def slug(text):
    kept = "".join(c for c in text.translate(refs.LOWER) if c in KEEP).replace(" ", "-")[:90]
    return kept or "task"


def tasks(text):
    """Each task: its anchor, title, whether it is done, and its body."""
    out, used, current, fence, in_task = [], set(), None, None, False
    # splitlines() would also break at characters such as U+2028 that can sit inside a task's text.
    for line in (raw.rstrip("\r") for raw in text.split("\n")):
        indented, blank = line[:1] in (" ", "\t"), not line.strip()
        if fence and in_task and not (indented or blank):
            # A code block in a task's body ends with the task, so this line is read afresh.
            current, fence, in_task = None, None, False
        opens = None if fence else OPENS.fullmatch(line)
        if opens and opens.group(1)[0] == "`" and "`" in opens.group(2):
            opens = None
        if fence or opens:
            if current is not None and (indented or blank):
                current["body"].append(line)
            else:
                current = None
            if opens:
                fence, in_task = opens.group(1), current is not None
            elif _closes(line, fence):
                fence, in_task = None, False
            continue
        m = ITEM.fullmatch(line.rstrip())
        if m:
            title = m.group(2).strip()
            anchor, base, n = slug(title), slug(title), 0
            while anchor in used:
                n += 1
                anchor = f"{base}-{n}"
            used.add(anchor)
            current = {"anchor": anchor, "title": title, "done": m.group(1) != " ", "body": []}
            out.append(current)
        elif current is not None and (indented or blank):
            current["body"].append(line)
        else:
            current = None
    for task in out:
        task["body"] = textwrap.dedent("\n".join(task["body"])).strip()
    return out


def _closes(line, fence):
    m = CLOSES.fullmatch(line)
    return bool(m) and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence)


def files(s):
    """The Markdown files the settings name, a line for each path that can't be used, and the folders that can't be
    read."""
    found, problems, locked, seen = [], [], [], set()
    for place in s["markdown"]["paths"]:
        path = Path(place)
        try:
            if path.is_dir():
                names = listing(path)
            elif path.is_file():
                names = [path]
            else:
                problems.append(f"{tilde(path)} is not there")
                continue
        except OSError:
            # A folder that can't be listed, or, before Python 3.13, a path under one that can't be searched.
            problems.append(f"{tilde(path)} can't be read")
            locked.append(path)
            continue
        for name in names:
            if os.path.realpath(name) in seen:
                continue
            seen.add(os.path.realpath(name))
            found.append(name)
    return found, problems, locked


def _updated(path):
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except OSError:
        return None


def _ticket(path, task, with_body):
    file = tilde(path)
    return ticket(f"md:{file}#{task['anchor']}", task["title"], "done" if task["done"] else "open", not task["done"],
                  url=f"{path.as_uri()}#{task['anchor']}", updated=_updated(path), project=file,
                  body=task["body"] if with_body else None)


def _named(path):
    """Why a path can't go in a reference, or None when it can."""
    text = tilde(path)
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return "its name isn't UTF-8"
    if not text.endswith(".md"):
        return "its name doesn't end in .md"
    try:
        refs.parse(f"md:{text}#task")
        return None
    except refs.RefError:
        return "its path has a space, comma, # or control character"


def list_open(s):
    found, problems, _ = files(s)
    tickets = []
    for path in found:
        why = _named(path)
        if why:
            problems.append(f"{tilde(path)} can't be named in a reference: {why}")
            continue
        text = read(path)
        if text is None:
            problems.append(f"{tilde(path)} can't be read")
            continue
        tickets += [_ticket(path, task, with_body=False) for task in tasks(text) if not task["done"]]
    return tickets, problems


def show(ref, s):
    found, _, locked = files(s)
    wanted = os.path.realpath(expand(ref["file"]))
    path = next((p for p in found if os.path.realpath(p) == wanted), None)
    if path is None:
        for folder in locked:
            if wanted.startswith(os.path.realpath(folder).rstrip("/") + "/"):
                raise SourceError(f"{tilde(folder)} can't be read")
        raise SourceError(f"{ref['file']} is not in markdown.paths")
    text = read(path)
    if text is None:
        raise SourceError(f"{ref['file']} can't be read")
    task = next((t for t in tasks(text) if t["anchor"] == ref["anchor"]), None)
    return _ticket(path, task, with_body=True) if task else None
