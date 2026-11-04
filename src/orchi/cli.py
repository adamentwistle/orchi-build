"""The `orchi` command.

Commands are entries in COMMANDS: a name, a one-line help text, a handler that
takes the parsed arguments and returns an exit code, and optionally a function that
adds the command's own options to its parser. Adding a command means adding an entry,
and a global option such as `--json` goes on the parser from
build_parser(). `--json` also goes on every command's parser, so it works before or
after the command.
"""
import argparse
import sys
from collections import namedtuple

from orchi import __version__, engine, system, uninstall, update
from orchi.plain import plain
from orchi.tickets import cli as tickets

Command = namedtuple("Command", "help handler options", defaults=(None,))


def _steps(fix):
    """Run every step: checked and fixed, or, for doctor, only checked."""
    def handler(args):
        return engine.main(fix=fix, as_json=args.json)

    return handler


# Bare `orchi` runs the handler under None.
DEFAULT = Command("set up or fix everything", _steps(fix=True))

COMMANDS = {
    "doctor": Command("check and change nothing", _steps(fix=False)),
    "update": Command("move to the newest release, then set up", update.run),
    "uninstall": Command("remove what Orchi made", uninstall.run, uninstall.configure),
    "tickets": Command("list and change tickets", tickets.run, tickets.configure),
}


def build_parser():
    parser = argparse.ArgumentParser(
        prog="orchi",
        allow_abbrev=False,
        description="Set up or fix everything.",
    )
    parser.add_argument("--version", action="version", version="orchi %s" % __version__)
    json_help = "print one JSON object instead of lines"
    parser.add_argument("--json", action="store_true", help=json_help)
    sub = parser.add_subparsers(dest="command", metavar="command")
    for name, command in COMMANDS.items():
        parser_of = sub.add_parser(name, help=command.help, description=command.help, allow_abbrev=False)
        # SUPPRESS leaves the value alone unless it is given here, so `orchi --json doctor` keeps it.
        parser_of.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help=json_help)
        if command.options:
            command.options(parser_of)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    command = COMMANDS[args.command] if args.command else DEFAULT
    try:
        return command.handler(args)
    except system.Refused as e:
        # ORCHI_NO_SYSTEM is set (the tests, a scratch-home check): one line, not a traceback.
        print(f"orchi: {plain(e)}", file=sys.stderr)
        return 1
