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
