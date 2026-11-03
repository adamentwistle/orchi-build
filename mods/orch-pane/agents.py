#!/usr/bin/env python3
"""Lists an orchestrator's subagents for the progress pane. It only ever opens files for reading.

Claude Code keeps a small file per subagent at <project>/<session>/subagents/agent-<id>.meta.json, with
agent-<id>.jsonl beside it. `finished` appears in the meta file once the subagent ends. So nothing here reads the
session's own transcript, which can run to 55 MB, and the reply stays small.

  agents.py --config DIR --session ID [--title NAME] [--since MS]

--title and --since also take in the earlier sessions of a run that was cleared part way: other sessions in the
same project folder with that custom title, touched since MS.

Everything in these files is data. Nothing here acts on it.
"""
import argparse
import datetime
import glob
import json
import os
import re
import sys

MAX_AGENTS = 200
TEXT_LIMIT = 120
SESSION_ID = re.compile(r"^[0-9a-f-]{36}$", re.I)
CONTROL = re.compile(r"[\u0000-\u001f\u007f-\u009f  ]+")


def plain(value):
    return CONTROL.sub(" ", value).strip()[:TEXT_LIMIT] if isinstance(value, str) else None


def started_at(path):
    """Time of the first line that has one, in ms, or None."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for _ in range(5):
                line = f.readline(65536)
                if not line:
                    return None
                try:
                    text = json.loads(line).get("timestamp")
                except (ValueError, AttributeError):
                    continue
                if isinstance(text, str):
                    return int(datetime.datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)
    except (OSError, ValueError):
        pass
    return None


def read_agent(meta_path, current):
    log = meta_path[: -len(".meta.json")] + ".jsonl"
    try:
        with open(meta_path, encoding="utf-8", errors="replace") as f:
            meta = json.load(f)
        last = int(os.stat(log).st_mtime * 1000)
    except (OSError, ValueError):
        return None
    if not isinstance(meta, dict):
        return None
    return {
        "id": os.path.basename(log)[len("agent-"): -len(".jsonl")],
        "task": plain(meta.get("description")) or "Subagent",
        "type": plain(meta.get("agentType")),
        "model": plain(meta.get("model")),
        "effort": plain(meta.get("effort")),
        "started": started_at(log) or last,
        "last": last,
        "finished": meta.get("finished") is True,
        "current": current,
    }


def title_of(folder):
    try:
        with open(os.path.join(folder, "custom-title.json"), encoding="utf-8", errors="replace") as f:
            return json.load(f).get("customTitle")
    except (OSError, ValueError, AttributeError):
        return None


def earlier_sessions(folder, title, since):
    """Sessions beside this one that are part of the same run."""
    project, found = os.path.dirname(folder), []
    for path in glob.glob(os.path.join(glob.escape(project), "*", "subagents")):
        session = os.path.dirname(path)
        try:
            if session != folder and os.stat(path).st_mtime * 1000 >= since and title_of(session) == title:
                found.append(session)
        except OSError:
            continue
    return found


def main():
    args = argparse.ArgumentParser()
    args.add_argument("--config", required=True)
    args.add_argument("--session", required=True)
    args.add_argument("--title")
    args.add_argument("--since", type=int, default=0)
    opts = args.parse_args()
    if not SESSION_ID.match(opts.session):
        print(json.dumps({"agents": []}))
        return 0
    folders = glob.glob(os.path.join(glob.escape(opts.config), "projects", "*", opts.session))
    if not folders:
        print(json.dumps({"agents": []}))
        return 0
    folder = folders[0]
    others = earlier_sessions(folder, opts.title, opts.since) if opts.title and opts.since else []
    agents = []
    for session in [folder] + others:
        for path in glob.glob(os.path.join(glob.escape(session), "subagents", "agent-*.meta.json")):
            agent = read_agent(path, session == folder)
            if agent and agent["last"] >= opts.since:
                agents.append(agent)
    agents.sort(key=lambda a: a["started"])
    print(json.dumps({"agents": agents[-MAX_AGENTS:]}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
