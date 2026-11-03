"""GitHub Issues, through the gh command settings name in github.command, so a wrapper such as gh-personal works.

run() is the only code that starts gh, so tests put a fake in its place.
"""
import json
import subprocess

from orchi import refs
from orchi.tickets.shape import SourceError, ticket

LIST_FIELDS = "number,title,state,url,updatedAt,labels"
VIEW_FIELDS = "number,title,state,url,updatedAt,labels,body"
LIMIT = 200
NOT_FOUND = ("Could not resolve to an issue", "GraphQL: Could not resolve to an issue")


def run(argv):
    """What gh prints, or SourceError with gh's first line of complaint."""
    try:
        done = subprocess.run(argv, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=60)
    except FileNotFoundError:
        raise SourceError(f"{argv[0]} is not installed") from None
    except subprocess.TimeoutExpired:
        raise SourceError(f"{argv[0]} didn't answer in 60 s") from None
    except OSError as e:
        raise SourceError(f"{argv[0]} can't be run: {e.strerror}") from None
    if done.returncode != 0:
        said = next((line.strip() for line in (done.stderr or "").splitlines() if line.strip()), "")
        raise SourceError(said or f"{argv[0]} failed")
    return done.stdout


def _json(argv):
    try:
        return json.loads(run(argv))
    except ValueError:
        raise SourceError(f"{argv[0]} gave something that isn't JSON") from None


def _ticket(repo, issue, body=None):
    state = str(issue.get("state") or "").lower()
    labels = [label["name"] for label in issue.get("labels") or [] if isinstance(label, dict) and isinstance(label.get("name"), str)]
    return ticket(f"gh:{repo}#{issue['number']}", str(issue.get("title") or ""), state, state == "open",
                  url=issue.get("url"), updated=issue.get("updatedAt"), project=repo, labels=labels, body=body)


def list_open(s):
    command, tickets, problems = s["github"]["command"], [], []
    for repo in s["github"]["repos"]:
        try:
            refs.parse(f"gh:{repo}#1")
        except refs.RefError:
            problems.append(f"{repo} can't be named in a reference")
            continue
        try:
            # One more than the limit, so a repo with more says so.
            issues = _json([command, "issue", "list", "--repo", repo, "--state", "open", "--limit", str(LIMIT + 1),
                            "--json", LIST_FIELDS])
        except SourceError as e:
            problems.append(f"{repo}: {e}")
            continue
        if not isinstance(issues, list):
            problems.append(f"{repo}: {command} gave an answer Orchi can't read")
            continue
        if len(issues) > LIMIT:
            problems.append(f"{repo}: showing the first {LIMIT} open issues")
        for issue in issues[:LIMIT]:
            try:
                tickets.append(_ticket(repo, issue))
            except (AttributeError, KeyError, TypeError, ValueError):
                continue
    return tickets, problems


def show(ref, s):
    try:
        issue = _json([s["github"]["command"], "issue", "view", str(ref["number"]), "--repo", ref["repo"],
                       "--json", VIEW_FIELDS])
    except SourceError as e:
        if str(e).startswith(NOT_FOUND):
            return None
        raise
    try:
        return _ticket(ref["repo"], issue, body=str(issue.get("body") or ""))
    except (AttributeError, KeyError, TypeError, ValueError):
        raise SourceError(f"{s['github']['command']} gave an issue Orchi can't read") from None
