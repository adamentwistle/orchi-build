"""Changes to ~/.config/orchi/settings.json from a step's fix.

The file is read as a JSON object, changed in a copy, and written whole through the fix's Context, so a file Orchi
didn't make is backed up first and every key already in it stays. A file that isn't a JSON object is an error that
names it, because Orchi would otherwise write over what it can't read.
"""
import copy
import json
import os

from orchi import herdr, settings


def current():
    """The JSON object in settings.json, {} when there is none."""
    return herdr.read_object(settings.path(), "settings.json")


def change(ctx, apply):
    """apply(object) changes a copy of the settings; the file is written if that differs. True when it was."""
    path = settings.path()
    # A link stays a link: the file it points at is written.
    target = os.path.realpath(path) if os.path.islink(path) else path
    have = current()
    wanted = copy.deepcopy(have)
    apply(wanted)
    if os.path.lexists(path) and herdr.same_json(wanted, have):
        return False
    ctx.folder(os.path.dirname(target))
    ctx.write(target, json.dumps(wanted, indent=2, ensure_ascii=False) + "\n")
    return True
