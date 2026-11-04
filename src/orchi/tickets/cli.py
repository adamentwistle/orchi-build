"""`orchi tickets`, `show`, and the writes `comment`, `move`, `create` and `sync`: plain lines, or JSON with --json.

A write prints its plan and makes it only with --yes, or after a yes typed at a terminal (ADR 0005).
"""
import argparse
import json
import re
import sys

from orchi import refs, settings
from orchi.tickets import SOURCES, SourceError, chosen, list_tickets, show, sync, writes
from orchi.tickets.files import unreadable

CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def configure(parser):
    """The tickets parser's own options. `--json` is on it already, from orchi.cli, and on each action here."""
    parser.add_argument("--source", action="append", choices=SOURCES, metavar="source",
                        help="read this source for this call: legwork, github, linear or markdown; once for each")
    sub = parser.add_subparsers(dest="action", metavar="action")
    one = _action(sub, "show", "one ticket by its reference")
    one.add_argument("ref", help="linear:ENG-12, gh:owner/repo#12, legwork:<project> or md:<file>#<anchor>")

    said = _write(sub, "comment", "comment on a Linear or GitHub ticket")
    said.add_argument("ref", help="linear:ENG-12 or gh:owner/repo#12")
    said.add_argument("text", help="the comment")

    moved = _write(sub, "move", "set a Linear or GitHub ticket's state")
    moved.add_argument("ref", help="linear:ENG-12 or gh:owner/repo#12")
    moved.add_argument("state", help="one of the Linear team's states, or open or closed on GitHub")
    moved.add_argument("--comment", help="comment first")
    moved.add_argument("--project", help="put a Linear issue in this project of its team too")
    moved.add_argument("--back", action="store_true", help="let a Linear issue move to an earlier state")

    made = _write(sub, "create", "make a Linear or GitHub ticket")
    where = made.add_mutually_exclusive_group(required=True)
    where.add_argument("--team", help="the Linear team, by key")
    where.add_argument("--repo", help="the GitHub repo, as owner/repo")
    made.add_argument("title")
    made.add_argument("--body", default="", help="its description")
    made.add_argument("--state", help="its Linear state")

    synced = _write(sub, "sync", "move a legwork project's Linear issues the way /wrap does")
    synced.add_argument("project", help="legwork:<project>")
    synced.add_argument("issues", nargs="*", help="Linear issues on its linear: line this session worked on")
    synced.add_argument("--pr", action="append", default=[], metavar="url", help="a pull request of this session")


def _action(sub, name, text):
    parser = sub.add_parser(name, help=text, description=text[0].upper() + text[1:] + ".", allow_abbrev=False)
    parser.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="print one JSON object instead of lines")
    return parser


def _write(sub, name, text):
    parser = _action(sub, name, text)
    yes = parser.add_mutually_exclusive_group()
    yes.add_argument("--yes", action="store_true", help="make the changes without asking")
    yes.add_argument("--dry-run", action="store_true", help="print the changes and make none")
    return parser


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
        _dump({"tickets": tickets, "problems": problems, "sources": chosen(s, args.source)})
    else:
        width = max((len(t["ref"]) for t in tickets), default=0)
        state = max((len(_plain(t["state"])) for t in tickets), default=0)
        for t in tickets:
            print(f"{_plain(t['ref']):<{width}}  {_plain(t['state']):<{state}}  {_plain(t['title'])}".rstrip())
        for p in problems:
            print(f"{p['source']}: {_plain(p['message'])}", file=sys.stderr)
    return 1 if problems else 0


def _show(args, s):
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


def _terminal():
    """True when a person can see the question and answer it: stdin and stdout both a terminal."""
    try:
        return sys.stdin.isatty() and sys.stdout.isatty()
    except (AttributeError, ValueError):
        return False


def _lines(plan, outcome):
    items = plan.items
    width = max((len(_plain(i.ticket)) for i in items), default=0)
    action = max((len(i.do) for i in items), default=0)
    for i in items:
        line = f"{_plain(i.ticket):<{width}}  {i.do:<{action}}  {_plain(i.detail())}"
        if outcome and i.do != "skip":
            line += "  " + (f"failed: {_plain(i.error)}" if i.status == "failed" else
                            f"done {i.created}" if i.status == "done" and i.created else i.status)
        print(line.rstrip())


def _planned(args, fill):
    """Fills a plan, prints it, and makes it only after a yes."""
    plan = writes.Plan()
    try:
        fill(plan)
    except writes.UsageError as e:
        print(_plain(e), file=sys.stderr)
        return 2
    except SourceError as e:
        plan.problem(str(e))
    as_json = getattr(args, "json", False)
    asked = written = False
    if plan.changes:
        if args.yes:
            written = True
        elif not args.dry_run and not as_json and _terminal():
            _lines(plan, outcome=False)
            # What can't be done is said before the question, so a yes is to the whole picture.
            for problem in plan.problems:
                print(_plain(problem), file=sys.stderr, flush=True)
            print("Make these changes? (y/N) ", end="", flush=True)
            asked = True
            try:
                written = sys.stdin.readline().strip().lower() in ("y", "yes")
            except (KeyboardInterrupt, EOFError):
                print()
                written = False
    if written:
        plan.apply()
    if as_json:
        _dump({"changes": [c.as_json() for c in plan.changes], "skipped": [x.as_json() for x in plan.skipped],
               "problems": plan.problems, "written": written})
    elif written or not asked:
        _lines(plan, outcome=written)
        if not plan.items and not plan.problems:
            print("Nothing to change.")
    if not asked:
        for problem in plan.problems:
            print(_plain(problem), file=sys.stderr)
    unmade = bool(plan.changes) and not written and not args.dry_run
    if unmade and not as_json:
        print("Nothing changed." if asked else "Nothing changed. Add --yes to make these changes.", file=sys.stderr)
    return 1 if plan.problems or plan.failed or unmade else 0


def _ref(text, what):
    try:
        return writes.writable_ref(text) if what == "write" else refs.parse(text)
    except refs.RefError as e:
        raise writes.UsageError(f"{json.dumps(text)} is not a ticket reference: {e}") from None


def _comment(args, s):
    return _planned(args, lambda plan: writes.comment(plan, _ref(args.ref, "write"), args.text, s))


def _move(args, s):
    return _planned(args, lambda plan: writes.move(plan, _ref(args.ref, "write"), args.state, s, args.comment,
                                                   args.project, args.back))


def _create(args, s):
    return _planned(args, lambda plan: writes.create(plan, s, args.title, args.body, args.team, args.repo, args.state))


def _sync(args, s):
    def fill(plan):
        project = _ref(args.project, "read")
        if project["source"] != "legwork":
            raise writes.UsageError("orchi tickets sync: name a legwork project first, such as legwork:<project>")
        issues = [_ref(text, "read") for text in args.issues]
        for issue in issues:
            if issue["source"] != "linear":
                raise writes.UsageError(f"orchi tickets sync: {issue['ref']} is not a Linear issue")
        links = []
        for url in args.pr:
            link = sync.pr_link(url)
            if link is None:
                raise writes.UsageError(f"orchi tickets sync: {url} is not a pull request link")
            links.append(link)
        sync.plan(plan, project, issues, links, s)

    return _planned(args, fill)


ACTIONS = {"show": _show, "comment": _comment, "move": _move, "create": _create, "sync": _sync}


def run(args):
    if args.source and args.action:
        print(f"orchi tickets: --source is for the list, not {args.action}", file=sys.stderr)
        return 2
    s = settings.read()
    return ACTIONS[args.action](args, s) if args.action else _list(args, s)
