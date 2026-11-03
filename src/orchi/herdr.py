"""The steps that put Orchi's look and panels into the Herdr app: themes, mods, layout, keys, sounds, settings, the
launcher and the browser pane.

Each step works out the files it wants from the package's content folders (paths.data_dir()), compares them with what
is installed, and says exactly what is missing or out of date. Its fix copies what is wanted through the engine's
Context, so everything it makes is recorded as Orchi's and anything it overwrites is backed up first. Content is copied,
never linked: the data folder moves when the package is updated, and a link into it would dangle.

A fix removes only a file Orchi made, that is still unchanged, and that the package no longer ships. Anything else in
a folder it installs into, such as an icon another tool added or a file the app generates, is left alone.

docs/adr/0005-herdr-content-steps.md has the reasons.
"""
import copy
import json
import os
import shutil
import subprocess
from collections import namedtuple
from pathlib import Path

from orchi import paths, settings
from orchi import store as store_mod
from orchi.engine import Step, broken, needs_fix, ok
from orchi.screen import NEEDS_FIX

# Files and folders the app writes into a mod's folder itself, and files that never ship.
NOT_SHIPPED_DIRS = {"tests", "__pycache__", ".pytest_cache"}
NOT_SHIPPED_NAMES = {".DS_Store", "gpui-kit.d.ts", "jsconfig.json"}
NOT_SHIPPED_ENDINGS = (".pyc", ".error")

NODE_MAJOR = 22
SHOWN = 3

# data is the bytes to write. done says the file already holds everything wanted, for files Orchi only adds to. again
# makes the Want afresh, so a file Orchi only adds to is merged again just before it is written, not at the start.
Want = namedtuple("Want", "data executable done again", defaults=(False, False, None))


def home():
    return Path(os.path.abspath(os.path.expanduser("~")))


def app_home():
    """Herdr's app home: $HERDR_APP_HOME, else ~/.config/herdr-app."""
    return Path(os.path.abspath(settings.old_dir()))


def private_window():
    """Whether Herdr's app home is not the usual one for this user. A private window (scripts/herdr-dev) shares
    ~/.local with the real one, so what Orchi writes there is left alone."""
    return app_home() != home() / ".config" / "herdr-app"


def local(*parts):
    return home().joinpath(".local", *parts)


def quoted(text):
    """Text in double quotes for a shell script, with what the shell would act on inside them escaped."""
    return '"' + "".join("\\" + c if c in '\\"$`' else c for c in str(text)) + '"'


def label(path, base=None):
    """A path as short as is plain: under the app home, else under the home folder as ~/..., else whole."""
    base = base or app_home()
    for root, prefix in ((base, "~/" if base == home() else ""), (home(), "~/")):
        try:
            return prefix + str(Path(path).relative_to(root))
        except ValueError:
            continue
    return str(path)


def raise_(error):
    raise error


def shipped(folder):
    """The files the package ships in a content folder, as (path relative to the folder, source path), with each
    mod.json first, since a mod folder without one yet joins the shown layout as a block."""
    root = paths.data_dir() / folder
    if not root.is_dir():
        raise FileNotFoundError(f"{folder}/ is missing from Orchi's files")
    found = []
    for here, folders, files in os.walk(root, onerror=raise_):
        folders[:] = sorted(f for f in folders if f not in NOT_SHIPPED_DIRS)
        for name in sorted(files):
            if name in NOT_SHIPPED_NAMES or name.endswith(NOT_SHIPPED_ENDINGS):
                continue
            path = Path(here) / name
            found.append((path.relative_to(root), path))
    return sorted(found, key=lambda f: (f[0].parts[0], not (len(f[0].parts) == 2 and f[0].name == "mod.json"),
                                        str(f[0])))


def copies(folder, target, suffix=None):
    """Wants for every file the package ships in a content folder, to be put in target."""
    out = {}
    for rel, source in shipped(folder):
        if suffix is None or rel.suffix == suffix:
            out[store_mod.full(target / rel)] = Want(source.read_bytes(), bool(source.stat().st_mode & 0o111))
    return out


def read_object(path, name):
    """The JSON object in a file, {} when there is no file or it is empty. A file that can't be read, or is not a JSON
    object, is an error that names it, because Orchi would otherwise write over what it can't read."""
    if not os.path.lexists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except (OSError, ValueError) as e:
        raise ValueError(f"{name} can't be read: {getattr(e, 'strerror', None) or e}") from None
    if not text.strip():
        return {}
    try:
        found = json.loads(text)
    except ValueError:
        raise ValueError(f"{name} is not valid JSON, so Orchi leaves it alone") from None
    if not isinstance(found, dict):
        raise ValueError(f"{name} is not a JSON object, so Orchi leaves it alone")
    return found


def merged(path, name, combine):
    """A Want for a JSON file Orchi only adds to: combine(object) changes a copy, and the file is done when that
    copy is what is already there."""
    have = read_object(path, name)
    wanted = copy.deepcopy(have)
    combine(wanted)
    return Want(json.dumps(wanted, indent=2, ensure_ascii=False).encode() + b"\n",
                done=os.path.lexists(path) and same_json(wanted, have), again=lambda: merged(path, name, combine))


def same_json(a, b):
    """Whether two JSON values are the same, with 1, 1.0 and true told apart, which Python's == does not."""
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


class Files(Step):
    """A step that keeps a set of files as the package ships them."""

    def wanted(self):
        """{path: Want}, in the order to write them."""
        raise NotImplementedError

    def roots(self):
        """Folders this step manages, where a file it made and the package has dropped is taken away."""
        return []

    def blocked(self):
        """A plain line when something stops the step, such as a mod folder that is a link, else None."""
        return None

    def base(self):
        return app_home()

    def label(self, path):
        return label(path, self.base())

    def check(self):
        why = self.blocked()
        if why:
            return broken(why)
        _, missing, changed, stale = self.plan()
        parts = [f"{what}: {self.names(found)}" for what, found in
                 (("missing", missing), ("out of date", changed), ("no longer shipped", stale)) if found]
        return needs_fix("; ".join(parts)) if parts else ok()

    def fix(self, ctx):
        return self.apply(ctx)

    def plan(self):
        wanted = self.wanted()
        missing, changed = [], []
        for path, want in wanted.items():
            state = self.state(path, want)
            if state == "missing":
                missing.append(path)
            elif state:
                changed.append(path)
        return wanted, missing, changed, self.stale(wanted)

    def state(self, path, want):
        """None when the file is as wanted, else missing or changed."""
        if not os.path.lexists(path):
            return "missing"
        if want.done:
            return None
        if os.path.islink(path):
            return "changed"
        if os.path.isdir(path):
            raise IsADirectoryError(f"{self.label(path)} is a folder")
        if path.read_bytes() != want.data or (want.executable and not os.access(path, os.X_OK)):
            return "changed"
        return None

    def stale(self, wanted):
        """Files Orchi made here that the package no longer ships and nobody has changed since, and the empty folders
        Orchi made that held them."""
        roots = self.roots()
        if not roots:
            return []
        store = store_mod.Store()
        kept = {parent for path in wanted for parent in path.parents}
        files, folders = [], []
        for record in store.owned():
            path = Path(record["path"])
            if record.get("step") != self.name or path in wanted or not any(root in path.parents for root in roots):
                continue
            if record.get("kind") in ("file", "link") and store.owns(path):
                files.append(path)
            elif (record.get("kind") == "folder" and path not in kept and store.owns(path)
                  and os.path.isdir(path) and not os.listdir(path)):
                folders.append(path)
        return sorted(files) + sorted(folders, key=lambda p: (-len(p.parts), str(p)))

    def names(self, found):
        shown = ", ".join(self.label(p) for p in found[:SHOWN])
        return shown + (f" and {len(found) - SHOWN} more" if len(found) > SHOWN else "")

    def apply(self, ctx, leave=()):
        wanted, missing, changed, stale = self.plan()
        todo = set(missing) | set(changed)
        wrote = 0
        for path, want in wanted.items():
            if path in todo and path not in leave:
                if want.again:
                    want = want.again()
                    if want.done:
                        continue
                if want.again and os.path.islink(path):
                    # A file Orchi only adds to is written where a link points, so the link stays.
                    path = Path(os.path.realpath(path))
                ctx.folder(path.parent)
                ctx.write(path, want.data, mode=0o755 if want.executable else None)
                wrote += 1
        gone = sum(ctx.remove(path) for path in stale)
        while True:
            # A folder that held only what just went is empty now.
            more = sum(ctx.remove(path) for path in self.stale(wanted))
            if not more:
                break
            gone += more
        said = [f"wrote {wrote} file{'' if wrote == 1 else 's'}"] if wrote else []
        if gone:
            said.append(f"removed {gone}")
        return ", ".join(said) or None


class Themes(Files):
    """The themes are in Herdr's themes folder."""
    name = "Themes"

    def wanted(self):
        return copies("themes", app_home() / "themes", ".json")

    def roots(self):
        return [app_home() / "themes"]


class Mods(Files):
    """Every mod is in Herdr's mods folder, without the files the app generates in them."""
    name = "Mods"

    def wanted(self):
        return copies("mods", app_home() / "mods")

    def roots(self):
        return [app_home() / "mods"]

    def blocked(self):
        for rel, _ in shipped("mods"):
            folder = app_home() / "mods" / rel.parts[0]
            if os.path.islink(folder):
                return f"{self.label(folder)} is a link. Move it away and run orchi again"
        return None


class Layout(Files):
    """The layout is in Herdr's layouts folder. One that holds a mod Orchi's lacks is replaced only on a yes."""
    name = "Layout"

    def wanted(self):
        return copies("layouts", app_home() / "layouts", ".json")

    def roots(self):
        return [app_home() / "layouts"]

    def check(self):
        found = super().check()
        if found.status == NEEDS_FIX:
            wanted = self.wanted()
            for path, want in wanted.items():
                lost = self.lost(path, want)
                if lost:
                    return needs_fix(f"{self.label(path)} holds {', '.join(lost)}, which Orchi's layout doesn't")
        return found

    def fix(self, ctx):
        leave = set()
        for path, want in self.wanted().items():
            lost = self.lost(path, want)
            if lost and ctx.ask(f"Replace {self.label(path)}? It holds {', '.join(lost)}, which Orchi's layout "
                                "doesn't.", ["Replace it and keep a backup", "Keep mine"]) == "Keep mine":
                leave.add(path)
        said = self.apply(ctx, leave)
        return ", ".join(filter(None, [said, "kept yours" if leave else None])) or None

    def lost(self, path, want):
        """The mods in an installed layout that is not Orchi's, that the layout Orchi ships lacks."""
        if not os.path.isfile(path) or store_mod.Store().owns(path):
            return []
        return sorted(layout_mods(path.read_bytes()) - layout_mods(want.data))


def layout_mods(data):
    try:
        node = json.loads(data)
    except ValueError:
        return set()
    found, todo = set(), [node]
    while todo:
        here = todo.pop()
        if isinstance(here, dict):
            if isinstance(here.get("mod"), str):
                found.add(here["mod"])
            todo.extend(here.values())
        elif isinstance(here, list):
            todo.extend(here)
    return found


class Keys(Files):
    """The key bindings Orchi names are in Herdr's keys.json, and the rest of the file is left as it is."""
    name = "Keys"

    def wanted(self):
        path = app_home() / "keys.json"
        extras = [json.loads(source.read_text()) for _, source in shipped("keys")]

        def combine(keys):
            for extra in extras:
                for scope, entries in extra.items():
                    if not isinstance(keys.setdefault(scope, {}), dict):
                        raise ValueError("keys.json holds a scope that is not an object, so Orchi leaves it alone")
                    keys[scope].update(entries)

        return {store_mod.full(path): merged(path, "keys.json", combine)}


class Sounds(Files):
    """The sounds are in Herdr's sounds folder."""
    name = "Sounds"

    def wanted(self):
        return copies("sounds", app_home() / "sounds", ".mp3")

    def roots(self):
        return [app_home() / "sounds"]


class AppSettings(Files):
    """Herdr's settings.json has every setting Orchi's config names. A value already there stays."""
    name = "App settings"

    def wanted(self):
        path = app_home() / "settings.json"
        extra = json.loads((paths.data_dir() / "config" / "settings.json").read_text())

        def fill(have, want):
            for key, value in want.items():
                if key not in have:
                    have[key] = copy.deepcopy(value)
                elif isinstance(have[key], dict) and isinstance(value, dict):
                    fill(have[key], value)

        return {store_mod.full(path): merged(path, "settings.json", lambda settings_: fill(settings_, extra))}


class Launcher(Files):
    """Panel sessions find ~/.local/libexec/orchi-app first on PATH, and so reach the herdr wrapper in Orchi's bin.
    A launcher rather than a link, so it fails when the folder it points at goes, where a dangling link would fall
    through to the real herdr."""
    name = "Launcher"

    def base(self):
        return home()

    def wanted(self):
        if private_window():
            return {}
        script = f'#!/bin/sh\nexec {quoted(paths.data_dir() / "bin" / "herdr")} "$@"\n'
        return {store_mod.full(local("libexec", "orchi-app", "herdr")): Want(script.encode(), True)}


class BrowserPane(Files):
    """The herdr-browser command, its files and skill, and Browser in the + menu."""
    name = "Browser pane"

    def base(self):
        return home()

    def command(self):
        return local("bin", "herdr-browser")

    def roots(self):
        return [] if private_window() else [local("libexec", "herdr-browser")]

    def wanted(self):
        out = {}
        command = self.command()
        if private_window():
            if not os.access(command, os.X_OK):
                return {}
        else:
            node, agent, why = tools()
            if why:
                raise FileNotFoundError(f"{why}. The browser pane needs agent-browser and node {NODE_MAJOR} or later")
            libexec = local("libexec", "herdr-browser")
            out.update(copies("browser", libexec))
            wrapper = (f'#!/bin/sh\nAGENT_BROWSER_BIN={quoted(agent)} exec {quoted(node)} '
                       f'{quoted(libexec / "herdr-browser.mjs")} "$@"\n')
            out[store_mod.full(command)] = Want(wrapper.encode(), True)
            skill = (paths.data_dir() / "skills" / "herdr-browser" / "SKILL.md").read_bytes()
            for folder in skill_folders():
                out[store_mod.full(folder / "skills" / "herdr-browser" / "SKILL.md")] = Want(skill)
        program = app_home() / "programs.json"
        entries = json.loads((paths.data_dir() / "config" / "programs.json").read_text())["programs"]

        def combine(have):
            programs = have.setdefault("programs", {})
            if not isinstance(programs, dict):
                raise ValueError("programs.json holds programs that are not an object, so Orchi leaves it alone")
            for key, entry in entries.items():
                programs[key] = {**entry, "run": [str(command), *entry["run"][1:]]}

        out[store_mod.full(program)] = merged(program, "programs.json", combine)
        return out


def tools():
    """The node and agent-browser on PATH, and why they won't do, or None."""
    agent, node = shutil.which("agent-browser"), shutil.which("node")
    if not agent:
        return None, None, "agent-browser is not on PATH"
    if not node:
        return None, None, "node is not on PATH"
    agent, node = os.path.abspath(agent), os.path.abspath(node)
    try:
        major = subprocess.run([node, "-p", 'process.versions.node.split(".")[0]'], capture_output=True, text=True,
                               timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        major = ""
    if not (major.isascii() and major.isdecimal()):
        return None, None, f"could not read the version of node at {node}"
    if int(major) < NODE_MAJOR:
        return None, None, f"node at {node} is version {major}"
    return node, agent, None


def skill_folders():
    """Every Claude Code profile folder that exists: the one in Orchi's settings, CLAUDE_CONFIG_DIR and ~/.claude. When
    none does, ~/.claude, which is made."""
    found = []
    for named in (settings.profile_dir(), os.environ.get("CLAUDE_CONFIG_DIR"), "~/.claude"):
        if named:
            folder = Path(os.path.abspath(os.path.expanduser(named)))
            if folder.is_dir() and all(os.path.realpath(folder) != os.path.realpath(f) for f in found):
                found.append(folder)
    return found or [home() / ".claude"]


def steps():
    return [Themes(), Mods(), Layout(), Keys(), Sounds(), AppSettings(), Launcher(), BrowserPane()]
