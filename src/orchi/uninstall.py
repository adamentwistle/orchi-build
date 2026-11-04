"""`orchi uninstall`: remove what the ownership records say Orchi made, and say what it kept.

A record counts only while what is at the path is still what Orchi made, so a file the user changed, or put something
else in the place of, is kept. A folder goes only when nothing else is in it. The backups, the keychain entry, the
settings the user wrote and everything else that is theirs stay. docs/adr/0007-update-and-uninstall.md has the reasons.
"""
import contextlib
import os
import sys
from pathlib import Path

from orchi import herdr, screen, system
from orchi import store as store_mod
from orchi.engine import last_line
from orchi.tickets import keychain
from orchi.tickets.files import tilde
from orchi.usage import LABEL, LAUNCHCTL

TOOL = "To remove the orchi command: uv tool uninstall orchi"
CHANGED = "you changed it"
HOLDS = "holds other files"
AGENT = "the usage-watch launch agent"
# What `launchctl print` exits with when the job isn't loaded (113), or launchctl isn't there (127).
NOT_LOADED = (113, 127)


def configure(parser):
    parser.add_argument("--yes", action="store_true", help="remove without asking")


def counts(files=0, links=0, folders=0, agent=False):
    return {"files": files, "links": links, "folders": folders, "launch_agent": agent}


def said(found):
    """'3 files, 1 link and the usage-watch launch agent', or '' when there is nothing."""
    parts = [f"{n} {word}" if n == 1 else f"{n} {word}s" for n, word in
             ((found["files"], "file"), (found["links"], "link"), (found["folders"], "folder")) if n]
    if found["launch_agent"]:
        parts.append(AGENT)
    return ", ".join(parts[:-1]) + " and " + parts[-1] if len(parts) > 1 else "".join(parts)


class Plan:
    """What the records say: what can go, what is kept and why, and which records point at nothing."""

    def __init__(self, store):
        self.files, self.links, self.folders, self.kept, self.gone = [], set(), [], [], []
        self.problems = []
        self.agent = None
        records = store.owned()
        going = set()
        for r in records:
            path = Path(r["path"])
            if r.get("kind") == "folder":
                continue
            agent = path.name == f"{LABEL}.plist" and r.get("step") == "usage-watch"
            if not os.path.lexists(path):
                self.gone.append(path)
                if agent:
                    # The job stays loaded in launchd after its file is deleted by hand.
                    self.agent = path
            elif not store.owns(path):
                self.kept.append((path, CHANGED))
            elif agent:
                self.agent = path
                going.add(path)
            else:
                self.files.append(path)
                going.add(path)
                if os.path.islink(path):
                    self.links.add(path)
        holding = []
        for path in sorted((Path(r["path"]) for r in records if r.get("kind") == "folder"),
                           key=lambda p: (-len(p.parts), str(p))):
            if not os.path.lexists(path):
                self.gone.append(path)
            elif not store.owns(path):
                self.kept.append((path, CHANGED))
            else:
                try:
                    names = os.listdir(path)
                except OSError as e:
                    self.kept.append((path, f"could not read it: {e.strerror or e}"))
                    self.problems.append(str(path))
                    continue
                if all(path / name in going for name in names):
                    self.folders.append(path)
                    going.add(path)
                else:
                    holding.append(path)
        self.kept.extend((path, HOLDS) for path in holding)

    def counts(self):
        return counts(len(self.files) - len(self.links), len(self.links), len(self.folders), bool(self.agent))


def unload_agent():
    """Take the launch agent out of launchd, so its file can go. None when done, else why not."""
    target = f"gui/{os.getuid()}/{LABEL}"
    found = system.run([LAUNCHCTL, "print", target], timeout=30)
    if found.returncode in NOT_LOADED:
        return None
    if found.returncode != 0:
        # A timeout or any other failure doesn't say the job is gone, so its file stays.
        return last_line(found.stdout) or "launchctl could not say whether it is loaded"
    done = system.run([LAUNCHCTL, "bootout", target], timeout=30)
    return None if done.returncode == 0 else (last_line(done.stdout) or "launchctl failed")


def remove(store, plan):
    """Take away what the plan says, checking each thing again just before. Returns what went, what is kept besides
    what the plan kept, and what went wrong. What went is recorded as gone however this ends, Ctrl-C included."""
    gone, kept, problems = [], [], []
    done = counts()
    try:
        _take_away(store, plan, gone, kept, problems, done)
    finally:
        with store_mod.shielded():
            # The agent's record goes only once its job is unloaded, even when its file was deleted by hand.
            store.disown_many([*gone, *(p for p in plan.gone if p != plan.agent)])
    return done, kept, problems


def _take_away(store, plan, gone, kept, problems, done):
    todo = [(p, False) for p in plan.files]
    if plan.agent and os.path.lexists(plan.agent) and not store.owns(plan.agent):
        # Changed since the question was asked: the user's now, loaded or not.
        kept.append((plan.agent, CHANGED))
    elif plan.agent:
        why = unload_agent()
        if why:
            kept.append((plan.agent, f"could not unload the launch agent: {why}"))
            problems.append("the launch agent")
        else:
            todo.append((plan.agent, True))
    for path, agent in todo:
        if not os.path.lexists(path):
            gone.append(path)
            done["launch_agent"] |= agent
        elif not store.owns(path):
            kept.append((path, CHANGED))
        else:
            try:
                link = os.path.islink(path)
                os.unlink(path)
            except OSError as e:
                kept.append((path, f"could not remove it: {e.strerror or e}"))
                problems.append(str(path))
                continue
            gone.append(path)
            if agent:
                done["launch_agent"] = True
            else:
                done["links" if link else "files"] += 1
    for path in plan.folders:
        if not os.path.lexists(path):
            gone.append(path)
            continue
        try:
            if not store.owns(path) or os.listdir(path):
                kept.append((path, HOLDS))
                continue
            os.rmdir(path)
        except OSError as e:
            kept.append((path, f"could not remove it: {e.strerror or e}"))
            problems.append(str(path))
            continue
        gone.append(path)
        done["folders"] += 1


def extras(store):
    """What else is the user's and stays, found without changing anything."""
    found = []
    backups = store.root / "backups"
    if backups.is_dir():
        found.append((backups, "your backups"))
    cache = herdr.home() / ".cache" / "orchi"
    if cache.is_dir():
        found.append((cache, "the usage cache"))
    if keychain.find_password(keychain.LINEAR_SERVICE):
        found.append((keychain.LINEAR_SERVICE, "your Linear key, in the keychain"))
    return found


def _holds_more(path, listed):
    """Whether a folder kept for holding other files holds something not listed itself."""
    try:
        return any(path / name not in listed for name in os.listdir(path))
    except OSError:
        return True


def tidy(kept):
    """The kept things, in order, without a folder kept only because of something else that is listed."""
    listed = {p for p, _ in kept if isinstance(p, Path)}
    return sorted(((p, why) for p, why in kept if why != HOLDS or _holds_more(p, listed)), key=lambda k: str(k[0]))


def report_of(head, kept, ok, removed=None):
    kept = tidy(kept)
    lines = [head]
    if kept:
        lines.append("Kept:")
        lines.extend(f"  {tilde(p) if isinstance(p, Path) else p}  {why}" for p, why in kept)
    lines.append(TOOL)
    return {
        "command": "uninstall", "ok": ok, "removed": removed or counts(),
        "kept": [{"path": str(p) if isinstance(p, Path) else f"keychain: {p}", "why": why} for p, why in kept],
        "summary": "\n".join(lines),
    }


def run(args):
    out = screen.Screen(sys.stdout, as_json=args.json)
    store = store_mod.Store()
    if not (store.root / "owned.json").exists():
        out.finish(report_of("Nothing to remove.", extras(store), True))
        return 0
    with contextlib.ExitStack() as held:
        try:
            held.enter_context(store.lock())
        except store_mod.Busy as e:
            out.finish(report_of(str(e), [], False))
            return 1
        except (store_mod.StoreError, OSError) as e:
            out.finish(report_of(f"Orchi's state folder can't be used: {e}", [], False))
            return 1
        try:
            return _run(args, out, store)
        except store_mod.StoreError as e:
            out.finish(report_of(f"Orchi's state folder can't be used: {e}", [], False))
            return 1


def _run(args, out, store):
    plan = Plan(store)
    planned = plan.counts()
    if not said(planned):
        store.disown_many(plan.gone)
        out.finish(report_of("Nothing to remove.", [*plan.kept, *extras(store)], not plan.problems))
        return 1 if plan.problems else 0
    if not args.yes:
        try:
            answer = out.ask(f"Remove {said(planned)} that Orchi made?", ["Yes", "No"])
        except (screen.NoTerminal, screen.NoAnswer):
            out.finish(report_of("Nothing removed. Run it at a terminal, or with --yes.", [], False))
            return 1
        if answer != "Yes":
            out.finish(report_of("Nothing removed.", plan.kept, not plan.problems))
            return 1 if plan.problems else 0
    done, kept, problems = remove(store, plan)
    problems = [*plan.problems, *problems]
    head = "Removed " + (said(done) or "nothing") + "."
    out.finish(report_of(head, [*plan.kept, *kept, *extras(store)], not problems, done))
    return 1 if problems else 0
