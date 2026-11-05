"""Setup's questions about tickets: where the legwork tracker is, which sources to read, which GitHub repos and Markdown
files they mean, and for Linear the API key and which teams and projects.

Both answers go in settings.json, even "none", so a question is asked once. The Linear key goes in the keychain through
orchi.tickets.keychain and nowhere else: it is not echoed, not written to a file and not in any message here.
"""
import os
from pathlib import Path

from orchi import claude, herdr, migrate, settings, settings_write
from orchi import store as store_mod
from orchi.engine import Step, broken, needs_fix, ok
from orchi.plain import plain
from orchi.tickets import keychain, linear
from orchi.tickets.shape import SourceError
from orchi.tools import SetupError

OPTIONAL = (("github", "GitHub issues"), ("linear", "Linear"), ("markdown", "Markdown task files"))
NUMBERS = "(numbers, separated by commas)"


class LegworkTracker(Step):
    """The folder of project files that planning, runs and /wrap work from. Legwork finds it at $LEGWORK_DIR, else
    ~/legwork, so a tracker made here goes there and legwork's own commands find the same one."""
    name = "Legwork tracker"

    def place(self):
        custom = os.environ.get("LEGWORK_DIR", "").strip()
        return Path(os.path.expanduser(custom)) if custom else herdr.home() / "legwork"

    def check(self):
        if claude.leave_alone():
            return ok()
        folder = settings.read()["legwork_dir"]
        if folder is None:
            return needs_fix("no tracker chosen")
        return ok() if (Path(folder) / "projects").is_dir() else needs_fix(f"no projects folder in {herdr.label(folder)}")

    def fix(self, ctx):
        folder = Path(settings.read()["legwork_dir"] or self.place())
        if not (folder / "projects").is_dir():
            if ctx.ask(f"Make a legwork tracker in {herdr.label(folder)}?", ["Yes", "No"]) == "No":
                raise SetupError("no tracker, so nothing can be planned")
            ctx.folder(folder / "projects")
        settings_write.change(ctx, lambda s: s.__setitem__("legwork_dir", str(folder)))
        return herdr.label(folder)


class TicketSources(Step):
    """The sources planning reads, chosen once. Legwork is always one."""
    name = "Ticket sources"

    def check(self):
        return ok() if "sources" in settings_write.current() else needs_fix("not chosen")

    def fix(self, ctx):
        chosen = ["legwork"]
        for source, label in OPTIONAL:
            if ctx.ask(f"Also read {label}?", ["Yes", "No"]) == "Yes":
                chosen.append(source)
        settings_write.change(ctx, lambda s: s.__setitem__("sources", chosen))
        return ", ".join(chosen)


class Listed(Step):
    """What a chosen source reads, typed once at setup. The answer goes in settings.json even when it's empty, so the
    question isn't asked again."""
    source = group = key = question = None

    def valid(self, item):
        """The item as settings.json keeps it, or raises SetupError."""
        raise NotImplementedError

    def wanted(self):
        return self.source in settings.read()["sources"]

    def chosen(self):
        found = settings_write.current().get(self.group)
        return isinstance(found, dict) and self.key in found

    def check(self):
        return ok() if not self.wanted() or self.chosen() else needs_fix("not chosen")

    def fix(self, ctx):
        items = [self.valid(x.strip()) for x in ctx.ask_text(self.question).split(",") if x.strip()]

        def apply(s):
            found = s.setdefault(self.group, {})
            if not isinstance(found, dict):
                raise ValueError(f"settings.json holds a {self.group} setting that is not an object, so Orchi leaves it alone")
            found[self.key] = items

        settings_write.change(ctx, apply)
        return f"{len(items)} chosen"


class GitHubRepos(Listed):
    """The repos whose issues are tickets."""
    name = "GitHub repos"
    source, group, key = "github", "github", "repos"
    question = "GitHub repos, as owner/repo, separated by commas (Enter for none)"

    def valid(self, item):
        found = item.lower()
        if not settings.REPO.fullmatch(found):
            raise SetupError(f"{plain(item)} is not owner/repo")
        return found


class MarkdownPaths(Listed):
    """The Markdown task files, or folders of them."""
    name = "Markdown paths"
    source, group, key = "markdown", "markdown", "paths"
    question = "Markdown task files or folders, from / or ~/, separated by commas (Enter for none)"

    def valid(self, item):
        if not item.startswith(("/", "~/")):
            raise SetupError(f"{plain(item)} is not a path from / or ~/")
        return item


def stored_key():
    """The key Orchi would use now: LINEAR_API_KEY, else the keychain's, else None."""
    return os.environ.get("LINEAR_API_KEY", "").strip() or keychain.find_password(keychain.LINEAR_SERVICE)


def key_in_linear_json():
    """Whether the old linear.json still holds a key, which setup's migration moves. Never the key itself."""
    try:
        found = herdr.read_object(os.path.join(settings.old_dir(), "linear.json"), "linear.json").get("apiKey")
    except ValueError:
        return False
    return isinstance(found, str) and bool(found.strip())


def listed(found, keyed):
    """Choice text for each {id: name}, and the id each stands for. A team shows its key before its name. A project
    shows its name, with its id after it when two projects share the name. The names and ids come from Linear, so they
    are shown without control characters, and two that look alike once those are gone still get a choice each."""
    names = [plain(n) for n in found.values()]
    text, used = {}, set()
    for (i, _), name in zip(found.items(), names):
        shown = f"{plain(i)}  {name}" if keyed else name if names.count(name) == 1 else f"{name} ({plain(i)[:8]})"
        while shown in used:
            shown += "'"
        used.add(shown)
        text[i] = shown
    return text, {t: i for i, t in text.items()}


class Linear(Step):
    """The Linear API key is in the keychain, and the teams and projects to pull in are chosen."""
    name = "Linear"

    def wanted(self):
        return "linear" in settings.read()["sources"]

    def chosen(self):
        group = settings_write.current().get("linear")
        if isinstance(group, dict) and ("teams" in group or "projects" in group):
            return True
        found = settings.read()["linear"]
        return bool(found["teams"] or found["projects"])

    def check(self):
        if not self.wanted():
            return ok()
        if not stored_key():
            if key_in_linear_json():
                # A private window may not move the key, and the panel there goes on reading it from linear.json.
                return ok() if herdr.private_window() else broken("the key is still in linear.json")
            return needs_fix("no API key")
        return ok() if self.chosen() else needs_fix("teams and projects not chosen")

    def fix(self, ctx):
        key = stored_key()
        asked = not key
        if asked:
            key = ctx.ask_secret("Linear API key")
        # Whatever its source: an odd character makes the request fail with a message that holds the key.
        if not keychain.SAFE.fullmatch(key):
            raise SetupError("a Linear API key has only letters, digits and . _ ~ + / = -")
        try:
            teams, projects = linear.choices(key)
        except SourceError as e:
            # A key Linear refuses is never kept.
            raise SetupError(str(e)) from None
        if asked:
            migrate.keep(key)
        if not self.chosen():
            self.choose(ctx, teams, projects)
        return "ready"

    def choose(self, ctx, teams, projects):
        picked_teams, picked_projects = [], []
        if teams:
            text, back = listed(teams, True)
            picked_teams = [back[c] for c in ctx.ask_many(f"Linear teams {NUMBERS}", list(text.values()))]
        if projects:
            text, back = listed(projects, False)
            picked_projects = [back[c] for c in ctx.ask_many(f"Linear projects {NUMBERS}", list(text.values()))]

        def apply(s):
            group = s.setdefault("linear", {})
            if not isinstance(group, dict):
                raise ValueError("settings.json holds a linear setting that is not an object, so Orchi leaves it alone")
            group["teams"], group["projects"] = picked_teams, picked_projects

        settings_write.change(ctx, apply)


# The line docs/legwork-sync.md gives; a test keeps the two the same.
SYNC_RULE = ("- After `/wrap` or `/shelve` updates a project that has a `linear:` line, sync its Linear issues with "
             "`orchi tickets sync legwork:<project> --pr <url> --yes`, one `--pr` for each pull request this session "
             "opened or merged, instead of moving them yourself; when this session's rules say no Linear writes, run "
             "`orchi tickets sync legwork:<project> --dry-run` and report what it would change.")


class HouseRules(Step):
    """The line that hands legwork's Linear moves to `orchi tickets sync`, offered for the legwork folder's house-rules.md.
    Nothing is written there without a yes, and a no is remembered in the state folder so it isn't asked every run."""
    name = "House rules"

    def file(self):
        folder = settings.read()["legwork_dir"]
        return Path(folder) / "house-rules.md" if folder else None

    def declined(self):
        return store_mod.state_dir() / "house-rules-declined"

    def declined_here(self):
        """A no is for the file it was given for, so another legwork folder is asked about afresh."""
        try:
            return self.declined().read_text(encoding="utf-8") == str(self.file())
        except OSError:
            return False

    def wanted(self):
        return "linear" in settings.read()["sources"] and self.file() is not None and self.file().parent.is_dir()

    def has(self):
        try:
            return SYNC_RULE in self.file().read_text(encoding="utf-8")
        except FileNotFoundError:
            return False

    def check(self):
        if not self.wanted() or self.has() or self.declined_here():
            return ok()
        return needs_fix("not added")

    def fix(self, ctx):
        file = self.file()
        if ctx.ask(f"Add the Linear sync line to {herdr.label(file)}?", ["Yes", "No"]) == "No":
            ctx.folder(self.declined().parent)
            ctx.write(self.declined(), str(file))
            return "left as it is"
        try:
            have = file.read_text(encoding="utf-8")
        except FileNotFoundError:
            have = ""
        joined = have + ("" if not have or have.endswith("\n\n") else "\n" if have.endswith("\n") else "\n\n")
        # A link stays a link: the file it points at is written.
        ctx.write(Path(os.path.realpath(file)), joined + SYNC_RULE + "\n")
        return "added"


def steps():
    return [TicketSources(), GitHubRepos(), MarkdownPaths(), migrate.LinearKey(), Linear(), HouseRules()]
