# How full each Claude Code session's context is, for the sidebar. Run as: python3 -I -S context.py <pid>...
# Each pid is a terminal's foreground process. Claude Code writes <config>/sessions/<pid>.json naming its session,
# and the session's transcript ends with the latest turn's usage. Prints {"<pid>": {"tokens": n, "model": "..."}},
# leaving out any pid it can't place. Reads at most the last 512 KiB of each transcript and gives up after 5 s.
import json
import os
import re
import signal
import sys

signal.alarm(5)
TAIL = 512 * 1024


def settings_dir(home):
    """claude_dir from Orchi's settings, ~/.config/orchi/settings.json, when it is set."""
    try:
        with open(os.path.join(home, ".config", "orchi", "settings.json"), encoding="utf-8") as f:
            value = json.load(f).get("claude_dir")
    except (OSError, ValueError, AttributeError):
        return None
    return os.path.expanduser(value.strip()) if isinstance(value, str) and value.strip() else None


def config_dirs():
    home = os.path.expanduser("~")
    dirs = [d for d in (settings_dir(home), os.environ.get("CLAUDE_CONFIG_DIR")) if d]
    try:
        dirs += sorted(os.path.join(home, d) for d in os.listdir(home) if d.startswith(".claude"))
    except OSError:
        pass
    return [d for d in dict.fromkeys(os.path.realpath(d) for d in dirs) if os.path.isdir(os.path.join(d, "sessions"))]


def transcript(config, session):
    cwd = session.get("cwd") or ""
    sid = session.get("sessionId") or ""
    if not re.fullmatch(r"[0-9A-Za-z-]+", sid):
        return None
    path = os.path.join(config, "projects", re.sub(r"[^A-Za-z0-9]", "-", cwd), sid + ".jsonl")
    if os.path.isfile(path):
        return path
    projects = os.path.join(config, "projects")
    try:
        for d in os.listdir(projects):
            p = os.path.join(projects, d, sid + ".jsonl")
            if os.path.isfile(p):
                return p
    except OSError:
        pass
    return None


def latest_usage(path):
    with open(path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - TAIL))
        lines = f.read().split(b"\n")
    for line in reversed(lines):
        if b'"usage"' not in line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        message = entry.get("message") if isinstance(entry, dict) else None
        if entry.get("type") != "assistant" or entry.get("isSidechain") or not isinstance(message, dict):
            continue
        usage = message.get("usage") or {}
        tokens = sum(int(usage.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
        if tokens > 0:
            return {"tokens": tokens, "model": message.get("model")}
    return None


def main(pids):
    out = {}
    dirs = config_dirs()
    for pid in pids:
        if not pid.isdigit():
            continue
        for config in dirs:
            try:
                with open(os.path.join(config, "sessions", pid + ".json")) as f:
                    session = json.load(f)
            except (OSError, ValueError):
                continue
            path = transcript(config, session)
            usage = latest_usage(path) if path else None
            if usage:
                out[pid] = usage
                break
    print(json.dumps(out))


if __name__ == "__main__":
    main(sys.argv[1:])
