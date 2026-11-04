"""Setup's move of the old Herdr-side files: the Linear API key goes from linear.json into the keychain, and the other
old values go into settings.json. docs/setup-migration.md is the spec.

The key is a secret, so it moves only on a yes, after a backup, and the plaintext is removed only after the keychain has
been read back. It is on no command line, in no file and in no message here. The other values are not secrets and move
without a question, since settings.json already wins over the old files.
"""
import hmac
import json
import os
import shlex
from pathlib import Path

from orchi import herdr, settings, settings_write
from orchi import store as store_mod
from orchi.engine import SetupError, Step, _why, needs_fix, ok
from orchi.tickets import keychain

STILL = "linear.json still holds your Linear API key"
ASK = "Move your Linear API key from linear.json into the keychain?"
ASK_SAME = "Remove your Linear API key from linear.json? It is already in the keychain."
ASK_DIFFERENT = "Remove the Linear API key from linear.json? The keychain already holds a different one, which stays."


def same(a, b):
    return hmac.compare_digest(a.encode(), b.encode())


def keep(key):
    """Put the key in the keychain and read it back. Never deletes: an add that failed because an item was already
    there looks the same, and that item is the user's."""
    if not keychain.store_password(keychain.LINEAR_SERVICE, key):
        raise SetupError("the keychain did not keep the key")
    kept = keychain.find_password(keychain.LINEAR_SERVICE)
    if not kept or not same(kept, key):
        raise SetupError("the keychain did not keep the key")


def unsafe(key):
    """The kind of the first character keychain.SAFE does not allow, never the character itself."""
    bad = next(c for c in key if not keychain.SAFE.fullmatch(c))
    if bad.isspace():
        return "a space"
    if bad in "'\"`":
        return "a quote mark"
    if bad == "\\":
        return "a backslash"
    return "a letter outside A to Z" if bad.isalpha() else "a symbol"


class LinearKey(Step):
    """The Linear API key is not left in linear.json. A private window leaves it, since the keychain is the one real
    login keychain every window shares."""
    name = "Linear key"

    def file(self):
        return Path(settings.old_dir()) / "linear.json"

    def held(self):
        """The key in linear.json, or None. A file that can't be used is an error that names it."""
        found = herdr.read_object(os.fspath(self.file()), "linear.json").get("apiKey")
        return found.strip() if isinstance(found, str) and found.strip() else None

    def check(self):
        if herdr.private_window():
            return ok()
        return needs_fix(STILL) if self.held() else ok()

    def fix(self, ctx):
        key = self.held()
        if key is None:
            return "nothing to move"
        found = keychain.find_password(keychain.LINEAR_SERVICE)
        if found is None:
            if not keychain.SAFE.fullmatch(key):
                raise SetupError(f"the key in linear.json has {unsafe(key)} that Orchi will not pass to the keychain, "
                                 "so it stays there")
            question = ASK
        else:
            question = ASK_SAME if same(found, key) else ASK_DIFFERENT
        if ctx.ask(question, ["Yes", "No"]) != "Yes":
            raise SetupError(STILL)
        path = self.file()
        target = Path(os.path.realpath(path)) if os.path.islink(path) else path
        # The backup holds the key, and it is taken before anything else changes, so a failure here changes nothing.
        copy = ctx.store.backup(target)
        # Said now, not at the end: a move that fails after this has still left the key in the backup.
        ctx.note("The backup holds your Linear API key in plain text. Delete that folder once the keychain works.")
        wrote = found is None
        if wrote:
            try:
                keep(key)
            except SetupError as e:
                raise SetupError(f"{e}, so linear.json is untouched") from None
        self.remove(target)
        undo = f"cp -p {shlex.quote(str(copy))} {shlex.quote(str(target))}"
        if wrote:
            undo += f" && security delete-generic-password -s {keychain.LINEAR_SERVICE}"
        ctx.note(f"To undo the move: {undo}")
        return "moved to the keychain" if wrote else "removed from linear.json"

    def remove(self, target):
        """linear.json again, whole, without apiKey and with everything else as it was. It stays the user's file."""
        try:
            held = herdr.read_object(os.fspath(target), "linear.json")
            held.pop("apiKey", None)
            with store_mod.shielded():
                store_mod.replace_file(target, json.dumps(held, indent=2, ensure_ascii=False) + "\n")
        except (OSError, ValueError) as e:
            raise SetupError(f"linear.json can't be written: {_why(e)}") from None


# Where each old value goes in settings.json. The first four are folders: ~ is put back, since settings.json is the
# user's and a path with the home folder in it would not follow them to another Mac.
PLACES = (("worker_limit",), ("legwork_dir",), ("linear", "teams"), ("linear", "repos"), ("linear", "legwork_projects"))
FOLDERS = {("legwork_dir",), ("linear", "repos")}


def _text(name):
    try:
        with open(os.path.join(settings.old_dir(), name), encoding="utf-8") as f:
            return f.read()
    except (OSError, ValueError):
        return None


def _dig(values, place):
    for part in place:
        values = values[part]
    return values


def _tilde(value, home):
    if isinstance(value, dict):
        return {k: _tilde(v, home) for k, v in value.items()}
    if isinstance(value, str) and (value == home or value.startswith(home + "/")):
        return "~" + value[len(home):]
    return value


class OldSettings(Step):
    """The values in orchi.json and linear.json that settings.json doesn't set yet are in settings.json."""
    name = "Old settings"

    def moves(self):
        """[(place, value)] for each old value that is valid, not the default, and not already set in settings.json."""
        have = settings_write.current()
        home = os.path.expanduser("~")
        old = settings.resolve(None, _text("orchi.json"), _text("linear.json"), home)
        default = settings.resolve(None, None, None, home)
        found = []
        for place in PLACES:
            if len(place) == 1:
                already = place[0] in have
            else:
                group = have.get(place[0], {})
                if not isinstance(group, dict):
                    raise ValueError(f"settings.json holds a {place[0]} setting that is not an object, "
                                     "so Orchi leaves it alone")
                already = place[1] in group
            got = _dig(old, place)
            if got != _dig(default, place) and not already:
                found.append((place, _tilde(got, home) if place in FOLDERS else got))
        return found

    def check(self):
        return needs_fix("old values not in settings.json") if self.moves() else ok()

    def fix(self, ctx):
        found = self.moves()

        def apply(s):
            for place, value in found:
                group = s.setdefault(place[0], {}) if len(place) > 1 else s
                group[place[-1]] = value

        settings_write.change(ctx, apply)
        return "moved " + ", ".join(".".join(place) for place, _ in found)
