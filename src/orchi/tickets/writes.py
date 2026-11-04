"""Ticket writes as a plan: each change is planned with what it would do, and made only when apply() runs.

A plan holds, in order, the changes and the tickets left alone, and apart from them the problems. The command line
decides whether to apply it; nothing here asks. Writes are Linear and GitHub only, and reach only what settings
choose (ADR 0005).
"""
from orchi import refs
from orchi.tickets import github, linear
from orchi.tickets.shape import SourceError

WRITABLE = ("linear", "github")


class UsageError(ValueError):
    """A write asked for in a way that can't work, whatever the tickets hold. The command exits 2."""


class Change:
    def __init__(self, ref, do, apply, where=None, **shown):
        self.ref, self.do, self.where, self.shown, self._apply = ref, do, where, shown, apply
        self.status, self.error, self.created = "planned", None, None

    @property
    def ticket(self):
        return self.ref or self.where

    def detail(self):
        if self.do == "state":
            return f"{self.shown['from']} to {self.shown['to']}"
        return self.shown.get("text") or self.shown.get("to") or self.shown.get("title") or ""

    def as_json(self):
        out = {"ref": self.ref, "do": self.do, **({"where": self.where} if self.where else {}), **self.shown,
               "status": self.status}
        if self.error:
            out["error"] = self.error
        if self.created:
            out["created"] = self.created
        return out


class Skip:
    do = "skip"

    def __init__(self, ref, reason):
        self.ref, self.reason = ref, reason

    @property
    def ticket(self):
        return self.ref

    def detail(self):
        return self.reason

    def as_json(self):
        return {"ref": self.ref, "reason": self.reason}


class Plan:
    def __init__(self):
        self.items, self.problems = [], []

    def change(self, ref, do, apply, **shown):
        self.items.append(Change(ref, do, apply, **shown))

    def skip(self, ref, reason):
        self.items.append(Skip(ref, reason))

    def problem(self, message):
        self.problems.append(message)

    @property
    def changes(self):
        return [i for i in self.items if isinstance(i, Change)]

    @property
    def skipped(self):
        return [i for i in self.items if isinstance(i, Skip)]

    def apply(self):
        """Makes each change in order. When one fails, the rest of that ticket's are not tried."""
        failed = set()
        for c in self.changes:
            if c.ticket in failed:
                c.status = "not tried"
                continue
            try:
                c.created = c._apply()
                c.status = "done"
            except SourceError as e:
                c.status, c.error = "failed", str(e)
                failed.add(c.ticket)

    @property
    def failed(self):
        return any(c.status == "failed" for c in self.changes)


# What settings choose

def refused(source, s, team=None, repo=None):
    """Why settings keep a write from this ticket, or None when they don't."""
    if source not in s["sources"]:
        return f"{source} is not one of the sources in settings"
    if team is not None and s["linear"]["teams"] and team not in s["linear"]["teams"]:
        return f"{team} is not one of linear.teams"
    if repo is not None and repo not in [r.lower() for r in s["github"]["repos"]]:
        return f"{repo} is not one of github.repos"
    return None


def _team_of(key):
    return key.rsplit("-", 1)[0]


def writable_ref(text):
    """A parsed reference to a ticket orchi tickets can write, or UsageError. RefError goes to the caller."""
    ref = refs.parse(text)
    if ref["source"] not in WRITABLE:
        raise UsageError(f"{ref['ref']}: orchi tickets writes only Linear and GitHub tickets")
    return ref


def settled(plan, ref, s):
    """True when settings let this ticket be written; else the reason is a problem."""
    if ref["source"] == "linear":
        why = refused("linear", s, team=_team_of(ref["key"]))
    else:
        why = refused("github", s, repo=ref["repo"])
    if why:
        plan.problem(f"{ref['ref']}: {why}")
    return why is None


def read(plan, ref, s):
    """The ticket as a write needs it, or None, with the problem planned."""
    try:
        got = linear.writable(ref["key"]) if ref["source"] == "linear" else github.show(ref, s)
    except SourceError as e:
        plan.problem(f"{ref['ref']}: {e}")
        return None
    if got is None:
        plan.problem(f"{ref['ref']} was not found")
    elif ref["source"] == "linear" and not in_team(plan, ref["ref"], got, s):
        return None
    elif ref["source"] == "github" and not _in_repo(plan, ref, got, s):
        return None
    return got


def _in_repo(plan, ref, issue, s):
    """True when the issue gh gave is still in the repo asked for. A transferred issue can answer to its old number."""
    m = github.CREATED.fullmatch(str(issue.get("url") or "").split("#")[0])
    if m is None:
        plan.problem(f"{ref['ref']}: {s['github']['command']} gave an issue Orchi can't read")
        return False
    repo = f"{m.group(1)}/{m.group(2)}".lower()
    if repo == ref["repo"]:
        return True
    plan.problem(f"{ref['ref']}: {refused('github', s, repo=repo) or f'it moved to {repo}'}")
    return False


def in_team(plan, ref, node, s):
    """True when the issue Linear gave is in a team settings choose. An issue moved to another team keeps answering
    to its old key, so the key alone doesn't say."""
    why = refused("linear", s, team=node["team"]["key"])
    if why:
        plan.problem(f"{ref}: {why}")
    return why is None


def _comment(plan, ref, node, text, s):
    if ref["source"] == "linear":
        plan.change(ref["ref"], "comment", lambda: linear.comment(node["id"], text), text=text)
    else:
        command = s["github"]["command"]
        plan.change(ref["ref"], "comment", lambda: github.comment(command, ref["repo"], ref["number"], text), text=text)


# comment, move, create

def comment(plan, ref, text, s):
    if not settled(plan, ref, s):
        return
    node = read(plan, ref, s)
    if node is not None:
        _comment(plan, ref, node, text, s)


def move(plan, ref, state, s, text=None, project=None, back=False):
    """A state change, after the comment when there is one. A Linear issue never moves to an earlier state on its
    board, such as Done or In Review back to In Progress, unless `back`."""
    if ref["source"] == "github":
        if project is not None:
            raise UsageError(f"{ref['ref']}: --project is for Linear")
        if state.strip().lower() not in ("open", "closed"):
            raise UsageError(f"{ref['ref']}: a GitHub issue is open or closed")
    if not settled(plan, ref, s):
        return
    node = read(plan, ref, s)
    if node is None:
        return
    if ref["source"] == "github":
        want, now = state.strip().lower(), node["state"]
        if now not in ("open", "closed"):
            plan.problem(f"{ref['ref']}: {s['github']['command']} gave an issue Orchi can't read")
            return
        if text:
            _comment(plan, ref, node, text, s)
        if want == now:
            plan.skip(ref["ref"], f"already {now}")
        else:
            command = s["github"]["command"]
            plan.change(ref["ref"], "state", lambda: github.set_state(command, ref["repo"], ref["number"], want),
                        **{"from": now, "to": want})
        return
    team = node["team"]
    target = linear.find_state(team, state)
    if target is None:
        names = ", ".join(x["name"] for x in linear.states(team))
        plan.problem(f"{ref['ref']}: {state} is not a state of {team['key']}: {names}")
        return
    goal = None
    if project is not None:
        goal = linear.find_project(team, project)
        if goal is None:
            plan.problem(f"{ref['ref']}: {project} is not a project of {team['key']}")
            return
    now = node["state"]["name"]
    # A comment goes only with a state change: on its own it would tell of a move that didn't happen.
    if target["name"] == now:
        plan.skip(ref["ref"], f"already {now}")
    elif not back and linear.rank(target, team) < linear.rank(node["state"], team):
        plan.skip(ref["ref"], f"already {now}; --back moves it back")
    else:
        if text:
            _comment(plan, ref, node, text, s)
        plan.change(ref["ref"], "state", lambda: linear.update(node["id"], stateId=target["id"]),
                    **{"from": now, "to": target["name"]})
    if goal is not None:
        if (node.get("project") or {}).get("id") == goal["id"]:
            plan.skip(ref["ref"], f"already in {goal['name']}")
        else:
            plan.change(ref["ref"], "project", lambda: linear.update(node["id"], projectId=goal["id"]), to=goal["name"])


def create(plan, s, title, body="", team=None, repo=None, state=None):
    team = team.strip().upper() if team is not None else None
    if repo is not None:
        if state is not None:
            raise UsageError("--state is for Linear")
        try:
            repo = refs.parse(f"gh:{repo}#1")["repo"]
        except refs.RefError:
            raise UsageError(f"{repo} is not a repo written owner/repo") from None
        why = refused("github", s, repo=repo)
        if why:
            plan.problem(f"{repo}: {why}")
            return
        command = s["github"]["command"]
        plan.change(None, "create", lambda: github.create(command, repo, title, body or ""), where=repo, title=title)
        return
    why = refused("linear", s, team=team)
    if why:
        plan.problem(f"{team}: {why}")
        return
    try:
        node = linear.team(team)
    except SourceError as e:
        plan.problem(f"{team}: {e}")
        return
    if node is None:
        plan.problem(f"{team} is not a Linear team")
        return
    target = None
    if state is not None:
        target = linear.find_state(node, state)
        if target is None:
            names = ", ".join(x["name"] for x in linear.states(node))
            plan.problem(f"{team}: {state} is not a state of {team}: {names}")
            return
    state_id = target["id"] if target else None
    plan.change(None, "create", lambda: linear.create(node["id"], title, body, state_id), where=team, title=title)
