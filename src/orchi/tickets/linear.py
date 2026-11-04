"""Linear, through its GraphQL API with one API key.

The key is LINEAR_API_KEY when that is set, for agents and tests, else the keychain's, under keychain.LINEAR_SERVICE.
It is never printed or logged, and no message here holds it. post() is the only code that reaches Linear, so tests put
a fake in its place.
"""
import http.client
import json
import os
import re
import urllib.error
import urllib.request

from orchi import refs
from orchi.tickets import keychain
from orchi.tickets.shape import SourceError, ticket

API_URL = "https://api.linear.app/graphql"
MAX_PAGES = 8
PAGE = 250
DONE_TYPES = ("completed", "canceled")
NO_KEY = "no Linear API key in the keychain or LINEAR_API_KEY"
BAD_KEY = "Invalid Linear API key"
ODD = "Linear gave an answer Orchi can't read"

FIELDS = "identifier title url updatedAt state { name type } project { name } labels { nodes { name } }"
ISSUES_QUERY = """query Tickets($filter: IssueFilter, $after: String) {
  issues(first: %d, after: $after, orderBy: updatedAt, filter: $filter) {
    nodes { %s }
    pageInfo { hasNextPage endCursor }
  }
}""" % (PAGE, FIELDS)
ISSUE_QUERY = """query Ticket($id: String!) {
  issue(id: $id) { %s description }
}""" % FIELDS


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is an error: following one would send the key to wherever it points."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(_NoRedirect)


def urlopen(request, timeout):
    return OPENER.open(request, timeout=timeout)


def post(query, variables, key):
    """Linear's answer to one GraphQL request, as JSON, or SourceError."""
    body = json.dumps({"query": query, "variables": variables}).encode()
    request = urllib.request.Request(API_URL, data=body, method="POST",
                                     headers={"Content-Type": "application/json", "Authorization": key})
    try:
        with urlopen(request, timeout=30) as answer:
            text = answer.read()
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise SourceError(BAD_KEY) from None
        message = _message(e)
        raise SourceError(_plain_error(message) if message else f"Linear answered {e.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException):
        raise SourceError("Linear can't be reached") from None
    try:
        return json.loads(text)
    except ValueError:
        raise SourceError("Linear's answer isn't JSON") from None


def _message(error):
    try:
        return str(json.loads(error.read())["errors"][0]["message"])
    except Exception:
        return None


def api_key():
    key = os.environ.get("LINEAR_API_KEY", "").strip() or keychain.find_password(keychain.LINEAR_SERVICE)
    if not key:
        raise SourceError(NO_KEY)
    # A request header carries only visible ASCII, and Linear's keys are made of it.
    if not re.fullmatch(r"[!-~]+", key):
        raise SourceError("the Linear API key has a character a key can't have")
    return key


def issues_filter(teams, projects):
    """Open issues in the teams or the projects; with neither, the ones assigned to you."""
    still_open = {"state": {"type": {"nin": list(DONE_TYPES)}}}
    team = {"team": {"key": {"in": list(teams)}}}
    project = {"project": {"id": {"in": list(projects)}}}
    if teams and projects:
        return {**still_open, "or": [team, project]}
    if teams:
        return {**still_open, **team}
    if projects:
        return {**still_open, **project}
    return {**still_open, "assignee": {"isMe": {"eq": True}}}


def _errors(answer):
    errors = answer.get("errors") if isinstance(answer, dict) else None
    if not errors:
        return None
    first = errors[0] if isinstance(errors, list) and errors and isinstance(errors[0], dict) else {}
    return _plain_error(str(first.get("message") or "Linear refused the request"))


def _plain_error(message):
    return BAD_KEY if "authenticat" in message.lower() else message


def _data(answer, field):
    """answer.data[field], or SourceError when the answer isn't shaped like one of Linear's."""
    data = answer.get("data") if isinstance(answer, dict) else None
    if not isinstance(data, dict) or field not in data:
        raise SourceError(ODD)
    return data[field]


def _ticket(node, body=None):
    key = node.get("identifier")
    if not isinstance(key, str) or not refs.KEY.fullmatch(key):
        raise ValueError("not a Linear key")
    state = node.get("state") or {}
    labels = [label["name"] for label in (node.get("labels") or {}).get("nodes") or []
              if isinstance(label, dict) and isinstance(label.get("name"), str)]
    return ticket(f"linear:{key}", str(node.get("title") or ""), str(state.get("name") or ""),
                  state.get("type") not in DONE_TYPES, url=node.get("url"), updated=node.get("updatedAt"),
                  project=(node.get("project") or {}).get("name"), labels=labels, body=body)


def _page(answer):
    """One page's nodes and the page itself, or SourceError."""
    problem = _errors(answer)
    if problem:
        raise SourceError(problem)
    page = _data(answer, "issues")
    nodes = page.get("nodes") if isinstance(page, dict) else None
    if not isinstance(nodes, list):
        raise SourceError(ODD)
    return nodes, page


def list_open(s):
    key, flt = api_key(), issues_filter(s["linear"]["teams"], s["linear"]["projects"])
    tickets, after = [], None
    for pages in range(1, MAX_PAGES + 1):
        try:
            nodes, page = _page(post(ISSUES_QUERY, {"filter": flt, "after": after}, key))
        except SourceError as e:
            if pages == 1:
                raise
            # The pages already read still count.
            return tickets, [f"showing the first {(pages - 1) * PAGE} open issues: {e}"]
        for node in nodes:
            try:
                tickets.append(_ticket(node))
            except (AttributeError, TypeError, ValueError):
                continue
        info = page.get("pageInfo") if isinstance(page.get("pageInfo"), dict) else {}
        if not info.get("hasNextPage"):
            return tickets, []
        if not isinstance(info.get("endCursor"), str):
            return tickets, [f"showing the first {pages * PAGE} open issues"]
        after = info["endCursor"]
    return tickets, [f"showing the first {MAX_PAGES * PAGE} open issues"]


def show(ref, s):
    try:
        answer = post(ISSUE_QUERY, {"id": ref["key"]}, api_key())
    except SourceError as e:
        if "not found" in str(e).lower():
            return None
        raise
    problem = _errors(answer)
    if problem:
        if "not found" in problem.lower():
            return None
        raise SourceError(problem)
    node = _data(answer, "issue")
    if node is None:
        return None
    try:
        return _ticket(node, body=str(node.get("description") or ""))
    except (AttributeError, TypeError, ValueError):
        raise SourceError(ODD) from None


# Writes. Each is one request through post(), so the same fake covers them. A ticket is read for a write with its
# team's states and projects, because a state or project is set by id.

WRITABLE_QUERY = """query Writable($id: String!) {
  issue(id: $id) {
    id identifier state { id name type } project { id name }
    team { id key states { nodes { id name type position } } projects(first: 250) { nodes { id name } } }
  }
}"""
TEAM_QUERY = """query Team($key: String!) {
  teams(filter: { key: { eq: $key } }) { nodes { id key states { nodes { id name type position } } } }
}"""
COMMENT_MUTATION = """mutation Comment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}"""
UPDATE_MUTATION = """mutation Update($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}"""
CREATE_MUTATION = """mutation Create($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { identifier url } }
}"""


def _nodes(value, need=("name",)):
    """A connection's nodes, each a dict whose `need` fields are strings, or SourceError."""
    nodes = value.get("nodes") if isinstance(value, dict) else None
    if not isinstance(nodes, list) or not all(_has(n, need) for n in nodes):
        raise SourceError(ODD)
    return nodes


def _has(node, need):
    return isinstance(node, dict) and all(isinstance(node.get(k), str) for k in need)


def writable(key):
    """An issue with its id, state, project and team (the team's states and projects), or None when it isn't there."""
    try:
        answer = post(WRITABLE_QUERY, {"id": key}, api_key())
    except SourceError as e:
        if "not found" in str(e).lower():
            return None
        raise
    problem = _errors(answer)
    if problem:
        if "not found" in problem.lower():
            return None
        raise SourceError(problem)
    node = _data(answer, "issue")
    if node is None:
        return None
    team = node.get("team") if isinstance(node, dict) else None
    # Everything a write uses later is checked here, so a write never stops half made on a missing field.
    if not _has(node, ("id",)) or not _has(node.get("state"), ("id", "name", "type")) \
            or not _has(team, ("id", "key")) or node.get("project") is not None and not _has(node["project"], ("id",)):
        raise SourceError(ODD)
    _nodes(team.get("states"), ("id", "name", "type"))
    _nodes(team.get("projects") or {"nodes": []}, ("id", "name"))
    return node


def team(key):
    """A team by its key, with its id and states, or None when there is no such team."""
    answer = post(TEAM_QUERY, {"key": key}, api_key())
    problem = _errors(answer)
    if problem:
        raise SourceError(problem)
    teams = _data(answer, "teams")
    nodes = teams.get("nodes") if isinstance(teams, dict) else None
    if not isinstance(nodes, list):
        raise SourceError(ODD)
    found = [n for n in nodes if isinstance(n, dict) and n.get("key") == key and isinstance(n.get("id"), str)]
    if not found:
        return None
    _nodes(found[0].get("states"), ("id", "name", "type"))
    return found[0]


def states(team_node):
    return _nodes(team_node.get("states"))


def projects(team_node):
    return _nodes(team_node.get("projects") or {"nodes": []})


def _position(state, team_node):
    here = state.get("position")
    if here is None:
        here = next((x.get("position") for x in states(team_node) if x.get("id") == state.get("id")), None)
    return here if isinstance(here, (int, float)) and not isinstance(here, bool) else None


def in_order(team_node):
    """The team's states in their order on the board; one with no position keeps its place after those with one."""
    numbered = [(n, s) for n, s in enumerate(states(team_node))]
    return [s for _n, s in sorted(numbered, key=lambda x: (_position(x[1], team_node) is None,
                                                         _position(x[1], team_node) or 0, x[0]))]


# The kinds of state in their order on every board. Completed and canceled are one level: both are the end.
LEVELS = {"triage": 0, "backlog": 1, "unstarted": 2, "started": 3, "completed": 4, "canceled": 4}


def rank(state, team_node):
    """Where a state sits on its team's board, to compare: by its kind, then by its place among its team's states."""
    level = LEVELS.get(state.get("type"), 0)
    if level == 4:
        return (4, 0)
    ids = [x["id"] for x in in_order(team_node)]
    return (level, ids.index(state["id"]) if state.get("id") in ids else 0)


def find_project(team_node, name):
    """The one team project with this name, whatever its case, or None when none or several have it."""
    want = name.strip().lower()
    same = [p for p in projects(team_node) if p["name"].strip().lower() == want]
    return same[0] if len(same) == 1 else None


def find_state(team_node, name):
    """The team's state with this name, whatever its case, or None."""
    want = name.strip().lower()
    return next((s for s in states(team_node) if s["name"].strip().lower() == want), None)


def _mutate(query, variables, field):
    answer = post(query, variables, api_key())
    problem = _errors(answer)
    if problem:
        raise SourceError(problem)
    done = _data(answer, field)
    if not isinstance(done, dict) or done.get("success") is not True:
        raise SourceError("Linear didn't make the change")
    return done


def comment(issue_id, body):
    _mutate(COMMENT_MUTATION, {"input": {"issueId": issue_id, "body": body}}, "commentCreate")


def update(issue_id, **fields):
    """Sets fields such as stateId or projectId on one issue."""
    _mutate(UPDATE_MUTATION, {"id": issue_id, "input": fields}, "issueUpdate")


def create(team_id, title, body=None, state_id=None):
    """A new issue on the team; gives its reference, or None when Linear made it without naming it."""
    fields = {"teamId": team_id, "title": title}
    if body:
        fields["description"] = body
    if state_id:
        fields["stateId"] = state_id
    done = _mutate(CREATE_MUTATION, {"input": fields}, "issueCreate")
    # The issue is made by now: an answer that doesn't name it is no reason to call it failed and make it again.
    key = done["issue"].get("identifier") if isinstance(done.get("issue"), dict) else None
    return f"linear:{key}" if isinstance(key, str) and refs.KEY.fullmatch(key) else None
