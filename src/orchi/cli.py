"""The `orchi` command.

Commands are entries in COMMANDS: a name, a one-line help text and a handler that
takes the parsed arguments and returns an exit code. Adding `update`, `uninstall`
or `tickets` means adding an entry (and any options to its parser), and a global
option such as `--json` goes on the parser from build_parser().
"""
import argparse
import sys
from collections import namedtuple

from orchi import __version__, engine

Command = namedtuple("Command", "help handler")


def _steps(fix):
    """Run every step: checked and fixed, or, for doctor, only checked."""
    def handler(args):
        return engine.main(fix=fix, as_json=args.json)

    return handler


# Bare `orchi` runs the handler under None.
DEFAULT = Command("set up or fix everything", _steps(fix=True))

COMMANDS = {
    "doctor": Command("check everything and change nothing", _steps(fix=False)),
}


def build_parser():
    parser = argparse.ArgumentParser(
        prog="orchi",
        allow_abbrev=False,
        description="Orchi dresses Herdr and runs the orchestration layer. "
        "With no command it sets up or fixes; `doctor` only checks.",
    )
    parser.add_argument("--version", action="version", version="orchi %s" % __version__)
    parser.add_argument("--json", action="store_true", help="print one JSON object instead of lines")
    sub = parser.add_subparsers(dest="command", metavar="command")
    for name, command in COMMANDS.items():
        sub.add_parser(name, help=command.help, description=command.help, allow_abbrev=False)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    command = COMMANDS[args.command] if args.command else DEFAULT
    return command.handler(args)
