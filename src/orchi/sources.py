"""Setup's questions about tickets: which sources to read, and for Linear the API key and which teams and projects.

Both answers go in settings.json, even "none", so a question is asked once. The Linear key goes in the keychain through
orchi.tickets.keychain and nowhere else: it is not echoed, not written to a file and not in any message here.
"""
import os
from pathlib import Path

from orchi import herdr, migrate, settings, settings_write
from orchi import store as store_mod
from orchi.engine import Step, broken, needs_fix, ok
from orchi.tickets import keychain, linear
from orchi.tickets.shape import SourceError
from orchi.tools import SetupError

OPTIONAL = (("github", "GitHub issues"), ("linear", "Linear"), ("markdown", "Markdown task files"))
NUMBERS = "(numbers, separated by commas)"


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
    shows its name, with its id after it when two projects share the name."""
    names = list(found.values())
    text = {i: (f"{i}  {n}" if keyed else n if names.count(n) == 1 else f"{n} ({i[:8]})") for i, n in found.items()}
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
    return [TicketSources(), migrate.LinearKey(), Linear(), HouseRules()]
