"""Setup for Claude Code: which profile folder Orchi works under, Orchi's skills and commands linked into it, the
planning skills plugin, and the trust question for the folders Orchi starts sessions in.

In a private window (scripts/herdr-dev) that has no claude_dir of its own, these leave the shared ~/.claude alone.
"""
import json
import os
from pathlib import Path

from orchi import herdr, paths, settings, settings_write, system
from orchi import store as store_mod
from orchi.engine import Step, broken, needs_fix, ok
from orchi.tools import SetupError, Tool, succeeded

PLUGIN = "mattpocock-skills"
MARKETPLACE = "claude-plugins-official"
MARKETPLACE_SOURCE = "anthropics/claude-plugins-official"
# The browser skill is the Browser pane step's, which copies it.
NOT_LINKED = {"herdr-browser"}
SHOWN = 3


def leave_alone():
    """Whether this is a private window with no profile of its own, which must not touch the shared one."""
    return herdr.private_window() and settings.profile_dir() is None


def profile():
    return Path(settings.claude_dir())


class ClaudeProfile(Step):
    """claude_dir is set: the shell's CLAUDE_CONFIG_DIR, else ~/.claude. One already set stays, and a private window
    without one gets none."""
    name = "Claude profile"

    def detected(self):
        named = (os.environ.get("CLAUDE_CONFIG_DIR") or "").strip()
        if not named:
            return herdr.home() / ".claude"
        return Path(os.path.abspath(os.path.expanduser(named)))

    def written(self):
        folder = self.detected()
        try:
            return "~/" + str(folder.relative_to(herdr.home()))
        except ValueError:
            return str(folder)

    def check(self):
        # A private window with no profile of its own must not write one: that would make the shared one its own.
        if leave_alone() or "claude_dir" in settings_write.current():
            return ok()
        return needs_fix(f"set to {self.written()}")

    def fix(self, ctx):
        value = self.written()
        settings_write.change(ctx, lambda s: s.setdefault("claude_dir", value))
        return f"set to {value}"


class SkillsAndCommands(Step):
    """Orchi's skills and commands are linked into the profile, so Claude Code reads them where they are."""
    name = "Skills and commands"

    def wanted(self):
        """{link: what it points at}, in the order to make them."""
        if leave_alone():
            return {}
        out = {}
        data, here = paths.data_dir(), profile()
        for folder in sorted((data / "skills").iterdir()):
            if folder.is_dir() and folder.name not in NOT_LINKED:
                out[store_mod.full(here / "skills" / folder.name)] = str(folder)
        for file in sorted((data / "commands").glob("*.md")):
            out[store_mod.full(here / "commands" / file.name)] = str(file)
        return out

    def roots(self):
        return [] if leave_alone() else [store_mod.full(profile() / "skills"), store_mod.full(profile() / "commands")]

    def stale(self, wanted):
        """Links Orchi made here that the package no longer ships and nobody has changed since."""
        store = store_mod.Store()
        roots = self.roots()
        return sorted(Path(r["path"]) for r in store.owned()
                      if r.get("step") == self.name and r.get("kind") == "link" and Path(r["path"]) not in wanted
                      and any(root in Path(r["path"]).parents for root in roots) and store.owns(r["path"]))

    def state(self, path, target):
        if not os.path.lexists(path):
            return "missing"
        if os.path.islink(path):
            return None if os.readlink(path) == target else "changed"
        if os.path.isdir(path):
            return "folder"
        return "changed"

    def names(self, found):
        shown = ", ".join(f"{p.name}" for p in found[:SHOWN])
        return shown + (f" and {len(found) - SHOWN} more" if len(found) > SHOWN else "")

    def check(self):
        wanted = self.wanted()
        found = {"missing": [], "changed": [], "folder": []}
        for path, target in wanted.items():
            state = self.state(path, target)
            if state:
                found[state].append(path)
        if found["folder"]:
            return broken(f"{self.names(found['folder'])} in the profile is a folder Orchi didn't make. Move it away "
                          "and run orchi again")
        parts = [f"{what}: {self.names(paths_)}" for what, paths_ in
                 (("missing", found["missing"]), ("out of date", found["changed"]), ("no longer shipped", self.stale(wanted)))
                 if paths_]
        return needs_fix("; ".join(parts)) if parts else ok()

    def fix(self, ctx):
        wanted = self.wanted()
        made = 0
        for path, target in wanted.items():
            if self.state(path, target):
                ctx.folder(path.parent)
                ctx.link(target, path)
                made += 1
        gone = sum(ctx.remove(path) for path in self.stale(wanted))
        said = [f"linked {made}"] if made else []
        if gone:
            said.append(f"removed {gone}")
        return ", ".join(said) or None


class PlanningSkills(Tool):
    """The grilling and domain-modeling skills come from the mattpocock-skills plugin, installed, not copied."""
    name = "Planning skills"
    label = "the planning skills"

    def installed(self):
        try:
            found = json.loads((profile() / "plugins" / "installed_plugins.json").read_text())["plugins"]
        except (OSError, ValueError, KeyError, TypeError):
            return False
        return isinstance(found, dict) and any(str(k).startswith(PLUGIN + "@") for k in found)

    def missing(self):
        return None if leave_alone() or self.installed() else "not installed"

    def needs(self):
        if not system.find("claude"):
            raise SetupError("needs Claude Code")

    def touches(self):
        """The profile files the plugin commands change, backed up before they run."""
        if leave_alone():
            return []
        folder = profile() / "plugins"
        return [folder / "installed_plugins.json", folder / "known_marketplaces.json", profile() / "settings.json"]

    def install(self, ctx):
        claude = system.find("claude")
        # The default profile is the one Claude Code uses when the variable is not set, and setting it would make Claude
        # Code keep that profile's state in a different file.
        env = dict(os.environ)
        if profile() == herdr.home() / ".claude":
            env.pop("CLAUDE_CONFIG_DIR", None)
        else:
            env["CLAUDE_CONFIG_DIR"] = str(profile())
        # A new Claude Code may not know the official marketplace yet; adding one it knows is harmless.
        ctx.run([claude, "plugin", "marketplace", "add", MARKETPLACE_SOURCE], env=env, timeout=300)
        succeeded(ctx.run([claude, "plugin", "install", f"{PLUGIN}@{MARKETPLACE}"], env=env, timeout=300), PLUGIN)


class FolderTrust(Step):
    """Claude Code's folder trust question is answered for the folders Orchi starts sessions in, so a session starts
    without stopping at it."""
    name = "Folder trust"

    def file(self):
        # Claude Code keeps the default profile's state in ~/.claude.json, and any other profile's inside the profile.
        here = profile()
        return herdr.home() / ".claude.json" if here == herdr.home() / ".claude" else here / ".claude.json"

    def folders(self):
        if leave_alone():
            return []
        s = settings.read()
        return [Path(d) for d in (s["orchi_dir"], s["legwork_dir"]) if d and os.path.isdir(d)]

    def projects(self):
        found = herdr.read_object(self.file(), ".claude.json").get("projects", {})
        if not isinstance(found, dict):
            raise ValueError(".claude.json holds projects that are not an object, so Orchi leaves it alone")
        return found

    def untrusted(self):
        folders = self.folders()
        if not folders:
            return []
        projects = self.projects()
        return [f for f in folders
                if not (isinstance(projects.get(str(f)), dict) and projects[str(f)].get("hasTrustDialogAccepted") is True)]

    def check(self):
        found = self.untrusted()
        return needs_fix(f"not trusted: {', '.join(herdr.label(f) for f in found)}") if found else ok()

    def fix(self, ctx):
        todo = self.untrusted()
        config = herdr.read_object(self.file(), ".claude.json")
        projects = self.projects()
        for folder in todo:
            entry = projects.get(str(folder))
            projects[str(folder)] = {**(entry if isinstance(entry, dict) else {}), "hasTrustDialogAccepted": True}
        config["projects"] = projects
        # A link stays a link: the file it points at is written.
        path = Path(os.path.realpath(self.file()))
        ctx.folder(path.parent)
        ctx.write(path, json.dumps(config, indent=2, ensure_ascii=False) + "\n", mode=None if path.exists() else 0o600)
        return f"trusted {len(todo)}"


def steps():
    return [ClaudeProfile(), SkillsAndCommands(), PlanningSkills(), FolderTrust()]
