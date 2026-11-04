"""orchi tickets: the open tickets of every chosen source in one list, and one ticket by its reference.

Each source is a module with list_open(settings), which gives (tickets, problems), and show(ref, settings), which gives
one ticket or None. A ticket has the shape in shape.py, and a reference is what orchi.refs makes of one.
"""
from orchi.tickets import github, legwork, linear, markdown
from orchi.tickets.files import unreadable
from orchi.tickets.shape import SourceError

READERS = {"legwork": legwork, "github": github, "linear": linear, "markdown": markdown}
SOURCES = tuple(READERS)


def chosen(s, sources=None):
    """The sources one call reads: those given, else the ones settings choose."""
    return list(s["sources"]) if sources is None else [x for x in SOURCES if x in sources]


def list_tickets(s, sources=None):
    """Every open ticket of the sources (the chosen ones when None), and one {source, message} per problem."""
    tickets, problems = [], []
    for name in chosen(s, sources):
        try:
            got, bad = READERS[name].list_open(s)
        except SourceError as e:
            got, bad = [], [str(e)]
        except OSError as e:
            # A folder the user can't open, say. The other sources still list.
            got, bad = [], [unreadable(e)]
        tickets += got
        problems += [{"source": name, "message": message} for message in bad]
    return tickets, problems


def show(ref, s):
    """One ticket, open or done, by a parsed reference, or None when its source has no such ticket."""
    return READERS[ref["source"]].show(ref, s)
