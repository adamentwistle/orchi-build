"""`orchi tickets` and `orchi tickets show <ref>`: plain lines, or JSON with --json."""
import argparse
import json
import re
import sys

from orchi import refs, settings
from orchi.tickets import SOURCES, SourceError, list_tickets, show
from orchi.tickets.files import unreadable

CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def configure(parser):
    """The tickets parser's own options. `--json` is on it already, from orchi.cli, and on `show` here."""
    parser.add_argument("--source", action="append", choices=SOURCES, metavar="source",
                        help="read this source for this call: legwork, github, linear or markdown; once for each")
    sub = parser.add_subparsers(dest="action", metavar="action")
    one = sub.add_parser("show", help="one ticket by its reference", description="One ticket by its reference.",
                         allow_abbrev=False)
    one.add_argument("ref", help="linear:ENG-12, gh:owner/repo#12, legwork:<project> or md:<file>#<anchor>")
    one.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="print one JSON object instead of lines")


def _plain(text, lines=False):
    """Text a terminal shows as text: no escape codes, and on one line unless `lines`."""
    # A file name that isn't UTF-8 holds surrogates, which can't be printed; they show as \udcff escapes instead.
    text = CONTROL.sub(" ", str(text or "")).encode("utf-8", "backslashreplace").decode("utf-8")
    return text if lines else re.sub(r"[\t\n]", " ", text)


def _dump(value):
    print(json.dumps(value, indent=2))


def _list(args, s):
    tickets, problems = list_tickets(s, args.source)
    if args.json:
        _dump({"tickets": tickets, "problems": problems})
    else:
        width = max((len(t["ref"]) for t in tickets), default=0)
        state = max((len(_plain(t["state"])) for t in tickets), default=0)
        for t in tickets:
            print(f"{_plain(t['ref']):<{width}}  {_plain(t['state']):<{state}}  {_plain(t['title'])}".rstrip())
        for p in problems:
            print(f"{p['source']}: {_plain(p['message'])}", file=sys.stderr)
    return 1 if problems else 0


def _show(args, s):
    if args.source:
        print("orchi tickets: --source is for the list, not show", file=sys.stderr)
        return 2
    try:
        ref = refs.parse(args.ref)
    except refs.RefError as e:
        print(f"{json.dumps(args.ref)} is not a ticket reference: {e}", file=sys.stderr)
        return 2
    try:
        got = show(ref, s)
    except SourceError as e:
        print(f"{ref['ref']}: {_plain(e)}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"{ref['ref']}: {_plain(unreadable(e))}", file=sys.stderr)
        return 1
    if got is None:
        print(f"{ref['ref']} was not found", file=sys.stderr)
        return 1
    if getattr(args, "json", False):
        _dump(got)
        return 0
    print(_plain(got["title"]))
    print("  ".join(_plain(x) for x in (got["ref"], got["state"], got["updated"]) if x))
    if got["url"]:
        print(_plain(got["url"]))
    if got["body"]:
        print()
        print(_plain(got["body"], lines=True))
    return 0


def run(args):
    s = settings.read()
    return _show(args, s) if args.action == "show" else _list(args, s)
