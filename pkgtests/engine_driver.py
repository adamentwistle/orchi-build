"""Runs the engine on made-up steps in a child process, for the tests that need a real terminal, a kill or a lock held
by another process. Every file it touches is under $DRIVE_DIR.

Usage: engine_driver.py SCENARIO [doctor] [--json]
  files  two steps, each making one file
  slow   a step whose check takes a moment, so the spinner turns, then the two files
  ask    a step whose fix asks which theme, then writes the answer
  kill   the two files, and the second fix kills the run with SIGKILL after its first write when $DRIVE_KILL is set
  hold   take the lock, say "held", and wait to be killed

$DRIVE_KILL_AT kills the run with SIGKILL at a set point: "own" just before a made thing is recorded as Orchi's,
"backup" just after the first backup is taken.
"""
import os
import signal
import sys
import time
from pathlib import Path

from orchi import engine, screen, store

DIR = Path(os.environ["DRIVE_DIR"])


class FileStep(engine.Step):
    def __init__(self, name, file, text):
        self.name, self.path, self.text = name, DIR / file, text

    def check(self):
        if not self.path.exists():
            return engine.needs_fix("missing")
        return engine.ok() if self.path.read_text() == self.text else engine.needs_fix("out of date")

    def touches(self):
        return [self.path]

    def fix(self, ctx):
        ctx.write(self.path, self.text)


class Slow(engine.Step):
    name = "Slow"

    def check(self):
        time.sleep(0.6)
        return engine.ok()


class Theme(engine.Step):
    name = "Theme"
    path = DIR / "theme"

    def check(self):
        return engine.ok() if self.path.exists() else engine.needs_fix("not chosen")

    def fix(self, ctx):
        ctx.write(self.path, ctx.ask("Which theme", ["Dark", "Light"]))


class Killed(FileStep):
    def fix(self, ctx):
        ctx.write(DIR / "b-first", "first")
        if os.environ.get("DRIVE_KILL"):
            os.kill(os.getpid(), signal.SIGKILL)
        ctx.write(self.path, self.text)


def kill_at(point):
    def before(call):
        def killed(*args, **kwargs):
            os.kill(os.getpid(), signal.SIGKILL)
        return killed

    def after(call):
        def killed(*args, **kwargs):
            call(*args, **kwargs)
            os.kill(os.getpid(), signal.SIGKILL)
        return killed

    if point == "own":
        store.Store.own = before(store.Store.own)
    elif point == "backup":
        store.Store.backup = after(store.Store.backup)


def files():
    return [FileStep("First file", "a", "A"), FileStep("Second file", "b", "B")]


def main(argv):
    scenario, rest = argv[0], argv[1:]
    kill_at(os.environ.get("DRIVE_KILL_AT"))
    if scenario == "hold":
        with store.Store().lock():
            print("held", flush=True)
            time.sleep(60)
        return 0
    steps = {
        "files": files,
        "slow": lambda: [Slow()] + files(),
        "ask": lambda: [Theme()],
        "kill": lambda: [FileStep("First file", "a", "A"), Killed("Second file", "b", "B")],
    }[scenario]()
    return engine.run(steps, fix="doctor" not in rest, screen=screen.Screen(sys.stdout, as_json="--json" in rest),
                      store=store.Store())


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
