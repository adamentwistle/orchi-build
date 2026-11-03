"""The one shape every ticket has, whatever its source, and the error a source gives when it can't be read."""
from orchi import refs


class SourceError(Exception):
    """A source that can't be read, with one plain line saying why. It never holds a key."""


def ticket(ref, title, state, still_open, url=None, updated=None, project=None, labels=(), body=None):
    """A ticket as `orchi tickets` gives it. `body` is only read for `show`, so a listed ticket's is None."""
    parsed = refs.parse(ref)
    return {
        "ref": parsed["ref"], "source": parsed["source"], "id": parsed["id"],
        "title": title, "state": state, "open": bool(still_open), "url": url, "updated": updated,
        "project": project, "labels": list(labels), "body": body,
    }
