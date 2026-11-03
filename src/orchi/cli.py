"""The `orchi` command.

Commands are entries in COMMANDS: a name, a one-line help text and a handler that
takes the parsed arguments and returns an exit code. Adding `update`, `uninstall`
or `tickets` means adding an entry (and any options to its parser), and a global
option such as `--json` goes on the parser from build_parser().
"""
import argparse
import sys
from collections import namedtuple

from orchi import __version__

Command = namedtuple("Command", "help handler")

EXIT_USAGE = 2


def _not_built(name):
    def handler(args):
        print("orchi %s is not built yet." % name if name else "orchi is not built yet.", file=sys.stderr)
        return EXIT_USAGE

    return handler


# Bare `orchi` runs the handler under None.
DEFAULT = Command("set up or fix everything", _not_built(""))

COMMANDS = {
    "doctor": Command("check everything and change nothing", _not_built("doctor")),
}


def build_parser():
    parser = argparse.ArgumentParser(
        prog="orchi",
        allow_abbrev=False,
        description="Orchi dresses Herdr and runs the orchestration layer. "
        "With no command it sets up or fixes; `doctor` only checks.",
    )
    parser.add_argument("--version", action="version", version="orchi %s" % __version__)
    sub = parser.add_subparsers(dest="command", metavar="command")
    for name, command in COMMANDS.items():
        sub.add_parser(name, help=command.help, description=command.help, allow_abbrev=False)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    command = COMMANDS[args.command] if args.command else DEFAULT
    return command.handler(args)
