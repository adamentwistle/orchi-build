"""The steps bare `orchi` and `orchi doctor` run, in order. Each is one thing Orchi checks and can fix."""
import os

from orchi import herdr, paths, settings
from orchi.engine import Step, broken, needs_fix, ok


class OrchiFiles(Step):
    """Orchi's own files (mods, themes, skills and the rest) are where the command expects them."""
    name = "Orchi files"

    def check(self):
        try:
            paths.data_dir()
        except FileNotFoundError:
            return broken("not found beside the orchi command")
        return ok()


class SettingsFolder(Step):
    """The folder settings.json lives in."""
    name = "Settings folder"

    def folder(self):
        return os.path.dirname(settings.path())

    def check(self):
        folder = self.folder()
        if os.path.isdir(folder):
            return ok()
        if os.path.lexists(folder):
            return broken(f"{folder} is not a folder")
        return needs_fix("missing")

    def fix(self, ctx):
        ctx.folder(self.folder())
        return "created"


class Settings(Step):
    """settings.json, when there is one, holds only values Orchi can use."""
    name = "Settings"

    def check(self):
        problems = settings.validate()
        return broken("; ".join(problems)) if problems else ok()


def steps():
    return [OrchiFiles(), SettingsFolder(), Settings(), *herdr.steps()]
