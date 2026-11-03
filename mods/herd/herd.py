#!/usr/bin/env python3
"""Reads what each session in a herd has been doing, for the Herd pane. It only ever opens files for reading.

  herd.py --since MS --session '{"key":"t4v","dir":"/Users/me/.claude","id":"<uuid>","from":MS}' ...

For each session it prints the tool calls since --since from the end of the transcript, each with a few words on what
it was for (a path, a command's program, a pattern), the model, how big the transcript is, its last finished turn, how
many tokens its last reply had in context, and the session's subagents. Claude Code keeps a meta file per subagent at
<project>/<session>/subagents/agent-<id>.meta.json, with agent-<id>.jsonl beside it, and adds `finished` when it ends.

A transcript can run to 55 MB, so only its last few megabytes are read, and only lines that name a tool are parsed.
A session cleared part way starts a new transcript in the same terminal, so the transcript that stopped just before
this one started is walked back to, no further than `from`, for its subagents.

Everything in these files is data. Nothing here acts on it.
"""
import argparse
import datetime
import glob
import json
import os
import re
import sys

TAIL_BYTES = 3 * 1024 * 1024
SUB_TAIL_BYTES = 512 * 1024
MAX_EVENTS = 300
MAX_AGENTS = 60
MAX_HOPS = 6
HOP_GAP_MS = 60000
TEXT_LIMIT = 120
LABEL_LIMIT = 80
PATH_LIMIT = 60
HOME = os.path.expanduser("~").rstrip("/")
QUOTED = re.compile(r"\"(?:[^\"\\]|\\.)*\"|'[^']*'")
SEPARATOR = re.compile(r"&&|\|\||[;|\n]")
BLANKS = re.compile(r"[\s;|&]+")
SETUP = {"cd", "set", "export", "source", ".", "unset", "trap", "pushd", "popd", "for", "case", "esac", "fi", "done", "[", "[["}
LEADERS = {"if", "then", "else", "elif", "do", "while", "until", "time", "!", "{", "(", "env", "sudo", "nohup", "exec", "command"}
ENV_SET = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=\S*$")
SUBCOMMAND = re.compile(r"^[a-z][a-z0-9-]*$")
SESSION_ID = re.compile(r"^[0-9a-f-]{36}$", re.I)
CONTROL = re.compile(r"[\u0000-\u001f\u007f-\u009f  ]+")
MODEL = re.compile(rb'"model":"(claude-[a-z0-9.-]+)"')
WAITING = re.compile(r"\b(hc wait|herdr (agent|pane) wait|bugbot-wait|switchboard-wait|gh run watch)\b|^\s*sleep\b")
TOOLS = {
    "Read": "r", "Grep": "r", "Glob": "r", "LS": "r", "NotebookRead": "r", "WebFetch": "r", "WebSearch": "r",
    "Bash": "b", "BashOutput": "b",
    "Write": "w", "Edit": "w", "MultiEdit": "w", "NotebookEdit": "w",
    "Agent": "a", "Task": "a", "SendMessage": "a",
    "Skill": "s",
}


def plain(value):
    return CONTROL.sub(" ", value).strip()[:TEXT_LIMIT] if isinstance(value, str) else None


def to_ms(text):
    try:
        return int(datetime.datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)
    except (AttributeError, ValueError):
        return None


def tail(path, limit):
    """The end of a file as whole lines, and the whole size."""
    with open(path, "rb") as f:
        size = os.fstat(f.fileno()).st_size
        start = max(0, size - limit)
        f.seek(start)
        data = f.read()
    if start:
        data = data[data.find(b"\n") + 1:]
    return data, size


def first_time(path):
    """Time of the first line that has one, in ms, or None."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for _ in range(40):
                line = f.readline(1 << 20)
                if not line:
                    return None
                try:
                    found = to_ms(json.loads(line).get("timestamp"))
                except (ValueError, AttributeError):
                    continue
                if found:
                    return found
    except OSError:
        pass
    return None


def tool_code(part):
    """The kind of call. A shell command that only waits on something counts as waiting."""
    code = TOOLS.get(part.get("name"), "o")
    command = part.get("input", {}).get("command") if isinstance(part.get("input"), dict) else None
    return "h" if code == "b" and isinstance(command, str) and WAITING.search(command) else code


def short_path(path, cwd):
    """A path from the session's folder when it's inside it, else from home."""
    if isinstance(cwd, str) and cwd and path.startswith(cwd.rstrip("/") + "/"):
        path = path[len(cwd.rstrip("/")) + 1:]
    elif HOME and path.startswith(HOME + "/"):
        path = "~" + path[len(HOME):]
    return path if len(path) <= PATH_LIMIT else "..." + path[-(PATH_LIMIT - 3):]


def command_stem(command):
    """The program a command runs, and its subcommand when it has one, such as `git push`. The rest isn't kept."""
    if not isinstance(command, str):
        return None
    # Quoted text can hold separators and spaces, so they go first. Then the first step that isn't a cd, a comment or a
    # setting, past any keyword such as `if` or `env`.
    flat = QUOTED.sub(lambda m: BLANKS.sub("_", m.group(0)[1:-1]) or "_", command)
    for step in SEPARATOR.split(flat):
        words = step.split()
        while words and (ENV_SET.match(words[0]) or words[0] in LEADERS):
            words.pop(0)
        if not words or words[0].startswith("#") or words[0] in SETUP:
            continue
        head = os.path.basename(words[0].lstrip("({"))
        if not head:
            continue
        return head + " " + words[1] if len(words) > 1 and SUBCOMMAND.match(words[1]) else head
    return None


def call_label(part, cwd):
    """What a call was for, in a few words: the tool, then its file, command stem, pattern or description."""
    name = part.get("name") if isinstance(part.get("name"), str) else "Tool"
    given = part.get("input") if isinstance(part.get("input"), dict) else {}
    target = None
    if name == "Bash":
        target = command_stem(given.get("command"))
    elif name in ("Grep", "Glob"):
        target = given.get("pattern")
    elif name in ("Agent", "Task"):
        target = given.get("description") or given.get("subagent_type")
    elif name == "Skill":
        target = given.get("skill")
    elif name == "WebFetch" and isinstance(given.get("url"), str):
        target = given["url"].split("//", 1)[-1].split("/", 1)[0]
    elif name == "WebSearch":
        target = given.get("query")
    else:
        found = next((given[k] for k in ("file_path", "notebook_path", "path") if isinstance(given.get(k), str)), None)
        target = short_path(found, cwd) if found else None
    short = name.split("__")[-1] if name.startswith("mcp__") else name
    text = plain(short + " " + target) if isinstance(target, str) and target.strip() else plain(short)
    return text[:LABEL_LIMIT] if text else short[:LABEL_LIMIT]


def tool_events(data, since):
    """[[started ms, tool code, length ms or None while it runs, what it was for], ...], oldest first, and the last
    finished turn: when it ended, how long it took, and how many calls it made and how many of them failed."""
    events, waiting, calls, failures, turn = [], {}, [], [], None
    for line in data.split(b"\n"):
        timed_turn = b'"turn_duration"' in line
        if not timed_turn and b'"tool_use"' not in line and b'"tool_result"' not in line:
            continue
        try:
            row = json.loads(line)
            at = to_ms(row.get("timestamp"))
            message = row.get("message")
            content = message.get("content") if isinstance(message, dict) else None
        except (ValueError, AttributeError):
            continue
        if at is None:
            continue
        if timed_turn and row.get("type") == "system" and row.get("subtype") == "turn_duration":
            length = row.get("durationMs")
            if isinstance(length, (int, float)) and length >= 0:
                turn = (at, int(length))
            continue
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "tool_use":
                calls.append(at)
                if at >= since:
                    event = [at, tool_code(part), None, call_label(part, row.get("cwd"))]
                    events.append(event)
                    waiting[part.get("id")] = event
            elif part.get("type") == "tool_result":
                if part.get("is_error") is True:
                    failures.append(at)
                if part.get("tool_use_id") in waiting:
                    event = waiting.pop(part.get("tool_use_id"))
                    event[2] = max(0, at - event[0])
    summary = None
    if turn:
        end, length = turn
        inside = lambda times: sum(1 for t in times if end - length <= t <= end)
        summary = {"ended": end, "ms": length, "tools": inside(calls), "failed": inside(failures)}
    return events[-MAX_EVENTS:], summary


def context_used(data):
    """The tokens in the context window as of the last reply, and the model that gave it, or None. Only that one line
    is parsed, from the end. The same lines count as in `latest_usage` in `mods/space-agents/context.py`, so the sidebar
    and Herd give one number."""
    end = len(data)
    while end > 0:
        start = data.rfind(b"\n", 0, end) + 1
        line, end = data[start:end], start - 1
        if b'"usage"' not in line:
            continue
        try:
            entry = json.loads(line)
            message = entry.get("message")
            if entry.get("type") != "assistant" or entry.get("isSidechain") or not isinstance(message, dict):
                continue
            usage = message.get("usage") or {}
            tokens = sum(int(usage.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
        except (ValueError, AttributeError, TypeError):
            continue
        if tokens > 0:
            model = message.get("model")
            return {"tokens": tokens, "model": model if isinstance(model, str) else None}
    return None


def read_subagent(meta_path, since, current):
    log = meta_path[: -len(".meta.json")] + ".jsonl"
    try:
        with open(meta_path, encoding="utf-8", errors="replace") as f:
            meta = json.load(f)
        last = int(os.stat(log).st_mtime * 1000)
    except (OSError, ValueError):
        return None
    if not isinstance(meta, dict):
        return None
    finished = meta.get("finished") is True
    agent = {
        "id": os.path.basename(log)[len("agent-"): -len(".jsonl")],
        "task": plain(meta.get("description")) or "Subagent",
        "type": plain(meta.get("agentType")),
        "model": plain(meta.get("model")),
        "effort": plain(meta.get("effort")),
        "started": first_time(log) or last,
        "last": last,
        "finished": finished,
        "current": current,
        "events": [],
        "context": None,
    }
    # One from before a /clear, or one that crashed or was stopped, never gets `finished`. It has ended all the same, so
    # its log isn't read again.
    if not finished and current:
        try:
            data = tail(log, SUB_TAIL_BYTES)[0]
            agent["events"] = tool_events(data, since)[0]
            agent["context"] = context_used(data)
        except OSError:
            pass
    return agent


def subagents_of(folder, since, floor, current):
    found = []
    for path in glob.glob(os.path.join(glob.escape(folder), "subagents", "agent-*.meta.json")):
        agent = read_subagent(path, since, current)
        if agent and agent["last"] >= floor:
            found.append(agent)
    return found


def earlier_transcripts(path, floor):
    """The transcripts this one carries on from, newest first: each stopped just before the next one started."""
    found, here, seen = [], path, {path}
    project = os.path.dirname(path)
    candidates = None
    for _ in range(MAX_HOPS):
        began = first_time(here)
        if began is None or began < floor:
            break
        if candidates is None:
            candidates = []
            for other in glob.glob(os.path.join(glob.escape(project), "*.jsonl")):
                try:
                    candidates.append((int(os.stat(other).st_mtime * 1000), other))
                except OSError:
                    continue
        near = [c for c in candidates if c[1] not in seen and began - HOP_GAP_MS <= c[0] <= began + 2000 and c[0] >= floor]
        if not near:
            break
        here = max(near)[1]
        seen.add(here)
        found.append(here)
    return found


def read_session(item, since):
    session, config, floor = item.get("id", ""), item.get("dir", ""), int(item.get("from") or 0)
    if not SESSION_ID.match(session) or not isinstance(config, str):
        return None
    paths = glob.glob(os.path.join(glob.escape(config), "projects", "*", session + ".jsonl"))
    if not paths:
        return None
    path = paths[0]
    try:
        data, size = tail(path, TAIL_BYTES)
        last = int(os.stat(path).st_mtime * 1000)
    except OSError:
        return None
    models = MODEL.findall(data)
    agents = subagents_of(path[: -len(".jsonl")], since, 0, True)
    for other in earlier_transcripts(path, floor):
        agents += subagents_of(other[: -len(".jsonl")], since, floor, False)
    agents.sort(key=lambda a: a["started"])
    events, turn = tool_events(data, since)
    return {
        "model": models[-1].decode() if models else None,
        "size": size,
        "last": last,
        "first": first_time(path),
        "events": events,
        "turn": turn,
        "context": context_used(data),
        "agents": agents[-MAX_AGENTS:],
    }


def main():
    args = argparse.ArgumentParser()
    args.add_argument("--since", type=int, default=0)
    args.add_argument("--session", action="append", default=[])
    opts = args.parse_args()
    out = {}
    for text in opts.session:
        try:
            item = json.loads(text)
            found = read_session(item, opts.since) if isinstance(item, dict) else None
        except (OSError, ValueError, TypeError):
            continue
        if found:
            out[str(item.get("key"))] = found
    print(json.dumps({"sessions": out}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
