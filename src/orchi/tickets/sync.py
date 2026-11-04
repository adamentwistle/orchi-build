"""orchi tickets sync legwork:<project>: the Linear part of legwork's /wrap, as a plan (ADR 0005).

It reads the project's file: the issues on its `linear:` line, its status, and its newest log entry, which is the
session being wrapped. The session's pull requests are the GitHub pull request links in that entry and any given with
--pr. Each issue the session worked on moves the way the tracker's /wrap does; a shelved project cancels them all.
"""
import re

from orchi import refs
from orchi.tickets import github, legwork, linear
from orchi.tickets.writes import read, settled

PR_URL = re.compile(r"https://github\.com/([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)/pull/([1-9][0-9]{0,9})(?![A-Za-z0-9_])")
EVIDENCE = re.compile(r"https://github\.com/[A-Za-z0-9-]+/[A-Za-z0-9._-]+/"
                      r"(?:commit/[0-9a-f]{7,40}|releases/tag/[A-Za-z0-9._+/-]+)")
# A link at the end of a sentence or in brackets doesn't take the full stop or bracket with it.
TRAILING = "./,;:"
ENTRY = re.compile(r"- (\d{4}-\d{2}-\d{2})\b:?[ \t]*(.*)")
FENCE = re.compile(r" {0,3}(```+|~~~+)")


def pr_link(text):
    """The pull request link, written the one way, or None when text isn't one."""
    m = PR_URL.fullmatch(text.strip())
    return f"https://github.com/{m.group(1)}/{m.group(2)}/pull/{int(m.group(3))}" if m else None


def newest_entry(text):
    """The newest log entry of a project's text after its frontmatter, as (date, text), or None. Lines in a fenced
    block, such as the next prompt, are never headings or entries."""
    fence, in_log, entry = None, False, None
    for line in text.split("\n"):
        m = FENCE.match(line)
        # A backtick fence's info string has no backtick, so ```orchi``` at the start of a line is code, not a fence.
        if m and m.group(1)[0] == "`" and "`" in line[m.end():]:
            m = None
        if fence:
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence) and not line[m.end():].strip():
                fence = None
            if entry is not None:
                entry[1].append(line.strip())
            continue
        if m:
            fence = m.group(1)
            if entry is not None:
                entry[1].append(line.strip())
            continue
        if line.startswith("## ") or line.startswith("# "):
            if entry is not None:
                break
            in_log = line.lstrip("#").strip().lower() == "log"
            continue
        if not in_log:
            continue
        if entry is None:
            m = ENTRY.match(line)
            if m:
                entry = (m.group(1), [m.group(2)])
            continue
        if line.startswith("- ") or not line.strip():
            break
        entry[1].append(line.strip())
    return None if entry is None else (entry[0], " ".join(x for x in entry[1] if x))


def linked(value):
    """The Linear keys on a `linear:` line, in order, once each."""
    keys = []
    for word in re.split(r"[\s,]+", value or ""):
        word = word.strip("\"'[]")
        word = word[len("linear:"):] if word.startswith("linear:") else word
        if refs.KEY.fullmatch(word) and word not in keys:
            keys.append(word)
    return keys


def names(key, text, any_case=False):
    # A letter or digit on either side makes it another word, such as ENG-12A or ENG-120; eng-12-fix still names it.
    return re.search(rf"(?<![A-Za-z0-9]){re.escape(key)}(?![A-Za-z0-9])", text, re.I if any_case else 0) is not None


def plan(p, ref, extra, pr_links, s):
    """Fills plan p for the project `ref`, with `extra` the Linear references named after it and `pr_links` the
    --pr links."""
    got = legwork.project_file(ref, s)
    if got is None:
        p.problem(f"{ref['ref']} was not found")
        return
    fields, rest = legwork.fields(got[1])
    keys = linked(fields.get("linear"))
    strays = [r["ref"] for r in extra if r["key"] not in keys]
    if keys:
        entry = newest_entry(rest)
        shelved = fields.get("status", "").strip("\"'").lower() == "icebox"
        if entry is None and shelved and re.fullmatch(r"\d{4}-\d{2}-\d{2}", fields.get("updated", "")):
            # Shelving needs only a date, and the file's updated: is the day it was shelved.
            entry = (fields["updated"], "")
        if entry is None:
            p.problem(f"{ref['ref']} has no log entry to sync")
            return
        if not _issues(p, ref, fields, keys, {r["key"] for r in extra}, entry, pr_links, s):
            return
    for stray in strays:
        p.skip(stray, f"not on {ref['ref']}'s linear: line")


def _issues(p, ref, fields, keys, extra, entry, pr_links, s):
    date, text = entry
    status = fields.get("status", "").strip("\"'").lower()
    if status == "icebox":
        for key in keys:
            _shelve(p, key, date, s)
        return True
    links = list(dict.fromkeys(pr_links + [pr_link(m.group(0)) for m in PR_URL.finditer(text)]))
    prs = []
    for url in links:
        try:
            prs.append(github.pull(s["github"]["command"], url))
        except linear.SourceError as e:
            p.problem(f"{url}: {e}")
            return False
    by_any = any(names(k, pr["text"], any_case=True) for pr in prs for k in keys)
    name = fields.get("name", "").strip("\"'") or ref["project"]
    evidence = EVIDENCE.search(text)
    evidence = evidence.group(0).rstrip(TRAILING) if evidence else None
    for key in keys:
        own = [pr for pr in prs if names(key, pr["text"], any_case=True)] if by_any else prs
        if names(key, text) or key in extra or (by_any and own):
            _wrap(p, key, date, status, own, evidence, name, s)
    return True


def _issue(p, key, s):
    ref = refs.parse(f"linear:{key}")
    node = read(p, ref, s) if settled(p, ref, s) else None
    if node is not None and node["state"]["type"] in linear.DONE_TYPES:
        p.skip(ref["ref"], f"already {node['state']['name']}")
        return None
    return node


def _target(team, move):
    """The team's state for a move: by its name, else the first on the board of the kind it is."""
    found = linear.find_state(team, move)
    if found or move == "In Review":
        return found
    if move == "In Progress":
        review = linear.find_state(team, "In Review")
        return next((x for x in linear.in_order(team) if x["type"] == "started"
                     and (review is None or linear.rank(x, team) < linear.rank(review, team))), None)
    kind = {"Done": "completed", "Canceled": "canceled"}[move]
    return next((x for x in linear.in_order(team) if x["type"] == kind and x["name"].strip().lower() != "duplicate"),
                None)


def _wrap(p, key, date, status, prs, evidence, name, s):
    ref = f"linear:{key}"
    node = _issue(p, key, s)
    if node is None:
        return
    merged = next((pr for pr in prs if pr["state"] == "MERGED"), None)
    opened = next((pr for pr in prs if pr["state"] == "OPEN" and not pr["draft"]), None)
    why_not = None
    if merged:
        move, link = "Done", merged["url"]
    elif opened:
        move, link = "In Review", opened["url"]
    elif status == "done" and evidence:
        move, link = "Done", evidence
    else:
        move, link = "In Progress", None
        if status == "done":
            why_not = "not Done: no merged pull request or commit or release link"
    team, now = node["team"], node["state"]
    target = _target(team, move)
    if target is None and move == "In Review":
        # A team with no In Review state: the work has started, so In Progress.
        move, target = "In Progress", _target(team, "In Progress")
    if target is None:
        p.skip(ref, f"{team['key']} has no {move} state")
    elif linear.rank(target, team) <= linear.rank(now, team):
        p.skip(ref, f"already {now['name']}")
    else:
        if link:
            body = f"Legwork session {date}: moved to {target['name']}.\n{link}"
            p.change(ref, "comment", lambda: linear.comment(node["id"], body), text=body)
        p.change(ref, "state", lambda: linear.update(node["id"], stateId=target["id"]),
                 **{"from": now["name"], "to": target["name"]})
    goal = None if node.get("project") else linear.find_project(team, name)
    if goal is not None:
        p.change(ref, "project", lambda: linear.update(node["id"], projectId=goal["id"]), to=goal["name"])
    if why_not:
        p.skip(ref, why_not)


def _shelve(p, key, date, s):
    ref = f"linear:{key}"
    node = _issue(p, key, s)
    if node is None:
        return
    target = _target(node["team"], "Canceled")
    if target is None:
        p.skip(ref, f"{node['team']['key']} has no Canceled state")
        return
    body = f"Shelved in legwork on {date}."
    p.change(ref, "comment", lambda: linear.comment(node["id"], body), text=body)
    p.change(ref, "state", lambda: linear.update(node["id"], stateId=target["id"]),
             **{"from": node["state"]["name"], "to": target["name"]})
