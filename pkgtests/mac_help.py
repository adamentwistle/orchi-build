"""A Mac that is not there: the programs setup starts, the pages it downloads, launchd, Herdr and the keychain are all
replaced by a fake that keeps its state in a scratch home. Nothing here starts a real program or opens a connection.

A test asks for `mac` and then sets it up: mac.everything() puts every tool in place, and a test that wants a fresh
Mac does nothing. mac.calls lists every program setup started, as argument lists. mac.asked lists every question and
mac.answers says what to reply, by a word of the question; anything else is answered with the first choice.
"""
import json
import os
from pathlib import Path

import pytest

from engine_help import home  # noqa: F401
from orchi import screen, system
from orchi.store import state_dir
from orchi.tickets import keychain, linear

UID = 501
HOMEBREW_URL = "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"
CLAUDE_URL = "https://claude.ai/install.sh"
APP_URL = "https://releases.herdr.dev/app/install.sh"
CORE_URL = "https://releases.herdr.dev/core/install.sh"
LINEAR_KEY = "lin_api_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd"


class Mac:
    def __init__(self, home, tmp_path, monkeypatch):
        self.home, self.monkeypatch = home, monkeypatch
        self.bin = tmp_path / "usr-bin"
        self.brew_bin = tmp_path / "opt-homebrew-bin"
        self.bin.mkdir()
        self.brew_bin.mkdir()
        monkeypatch.setenv("PATH", str(self.bin))
        monkeypatch.setattr(system, "EXTRA_DIRS", (str(self.brew_bin), str(home / ".local" / "bin")))
        self.calls, self.asked, self.pages = [], [], []
        self.answers, self.secret, self.picks = {}, LINEAR_KEY, {}
        self.tools_dir = home / ".local" / "bin"
        self.clt = False
        self.keychain = {}
        self.unreadable_reads = 0
        self.loaded = False
        self.usage = None  # None: never ran; else the status of the last pass
        self.login = "ok"  # what a first read of Claude Code's login finds
        self.herdr_running = False
        self.herdr_errors = []
        self.layout = "main-linear"
        self.linear_teams = {"ENG": "Engineering", "OPS": "Operations"}
        self.linear_projects = {"p1": "Alpha", "p2": "Beta"}
        self.linear_refused = False
        self.install_fails = set()
        self.platform = "darwin"
        self.sleeps = []
        self.terminal = True
        self.envs = []
        self.installed_plugins = {}
        self.installers = {
            HOMEBREW_URL: lambda: self.executable(self.brew_bin / "brew"),
            CLAUDE_URL: lambda: self.executable(self.tools_dir / "claude"),
            APP_URL: lambda: ((home / "Applications" / "Herdr.app").mkdir(parents=True, exist_ok=True),
                              self.executable(self.tools_dir / "herdr-app")),
            CORE_URL: lambda: self.executable(self.tools_dir / "hc"),
        }
        monkeypatch.setattr(system, "platform", lambda: self.platform)
        monkeypatch.setattr(system, "run", self.run)
        monkeypatch.setattr(system, "fetch", self.fetch)
        monkeypatch.setattr(system, "sleep", self.sleeps.append)
        monkeypatch.setattr(keychain, "find_password", self.find_password)
        monkeypatch.setattr(keychain, "store_password", self.store_password, raising=False)
        monkeypatch.setattr(linear, "post", self.post)
        monkeypatch.setattr(screen.Screen, "ask", self.ask)
        monkeypatch.setattr(screen.Screen, "ask_many", self.ask_many, raising=False)
        monkeypatch.setattr(screen.Screen, "ask_secret", self.ask_secret, raising=False)

    # Setting the Mac up

    def executable(self, path, text="#!/bin/sh\nexit 0\n"):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        path.chmod(0o755)

    def node(self, major=22):
        self.executable(self.bin / "node", f"#!/bin/sh\necho {major}\n")

    def everything(self):
        """Every tool in place, Claude Code signed in, usage-watch loaded and Herdr there."""
        self.clt = True
        for name in ("brew", "gh", "terminal-notifier", "npm", "agent-browser"):
            self.executable(self.bin / name)
        self.node()
        self.executable(self.tools_dir / "claude")
        self.executable(self.tools_dir / "hc")
        self.executable(self.tools_dir / "herdr-app")
        (self.home / "Applications" / "Herdr.app").mkdir(parents=True)
        self.installed_plugins = {"mattpocock-skills@claude-plugins-official": [{"scope": "user"}]}
        self.write_plugins()
        self.usage, self.loaded = "ok", True
        marker = state_dir() / "agent-browser-browser"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text("")

    def claude_dir(self):
        return Path(os.environ.get("CLAUDE_CONFIG_DIR") or self.home / ".claude")

    def write_plugins(self, config=None):
        path = Path(config or self.claude_dir()) / "plugins" / "installed_plugins.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"version": 2, "plugins": self.installed_plugins}))

    def settings(self, **values):
        from orchi import settings
        path = Path(settings.path())
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(values))

    def program(self, *words):
        """The calls so far that started with these words."""
        return [c for c in self.calls if list(c[:len(words)]) == list(words)]

    # What the fake answers

    def ask(self, question, choices):
        self.asked.append(question)
        self.need_terminal(question)
        for word, answer in self.answers.items():
            if word.lower() in question.lower():
                return next(c for c in choices if c.lower().startswith(answer.lower()))
        return choices[0]

    def ask_many(self, question, choices):
        self.asked.append(question)
        self.need_terminal(question)
        for word, picked in self.picks.items():
            if word.lower() in question.lower():
                return [c for c in choices if any(c.startswith(p) or p in c for p in picked)]
        return []

    def need_terminal(self, question):
        if not self.terminal:
            raise screen.NoTerminal(f"needs a terminal to answer: {question}")

    def ask_secret(self, question):
        self.asked.append(question)
        self.need_terminal(question)
        if self.secret is None:
            raise screen.NoAnswer(f"no answer: {question}")
        return self.secret

    def fetch(self, url, timeout=60):
        self.pages.append(url)
        if url not in self.installers:
            raise AssertionError(f"setup fetched {url}, which no installer here belongs to")
        return f"#!/bin/sh\n# installer for {url}\n"

    def find_password(self, service):
        self.calls.append(("keychain-read", service))
        if self.unreadable_reads:
            self.unreadable_reads -= 1
            return None
        return self.keychain.get(service)

    def store_password(self, service, password):
        self.calls.append(("keychain-store", service))
        self.stored_with = password
        if "keychain" in self.install_fails:
            return False
        # security -i exits 0 even when the item is already there and the add failed.
        self.keychain.setdefault(service, password)
        return True

    def post(self, query, variables, key):
        self.calls.append(("linear", key == LINEAR_KEY))
        if self.linear_refused:
            raise linear.SourceError("Invalid Linear API key")
        return {"data": {"teams": {"nodes": [{"key": k, "name": n} for k, n in self.linear_teams.items()]},
                         "projects": {"nodes": [{"id": k, "name": n} for k, n in self.linear_projects.items()]}}}

    def run(self, argv, input=None, timeout=None, env=None, interactive=False):
        argv = [os.fspath(a) for a in argv]
        name = os.path.basename(argv[0])
        self.calls.append((name, *argv[1:]))
        self.envs.append(((name, *argv[1:]), env))
        done = lambda code=0, out="": system.Result(code, out)  # noqa: E731
        if name == "xcode-select":
            if argv[1] == "-p":
                return done(0 if self.clt else 2)
            self.clt = "xcode-select" not in self.install_fails
            return done(0)
        if name in ("sh", "bash"):
            url = next((u for u in self.installers if u in (input or "") or any(u in a for a in argv)), None)
            if url is None or url in self.install_fails:
                return done(1, "the installer failed")
            self.installers[url]()
            return done()
        if name == "brew" and argv[1] == "install":
            if argv[2] in self.install_fails:
                return done(1, "no formula")
            if argv[2] == "node":
                self.executable(self.brew_bin / "node", "#!/bin/sh\necho 22\n")
                self.executable(self.brew_bin / "npm")
            else:
                self.executable(self.brew_bin / argv[2])
            return done()
        if name == "npm":
            if "agent-browser" in self.install_fails:
                return done(1, "npm failed")
            self.executable(self.brew_bin / "agent-browser")
            return done()
        if name == "agent-browser":
            if "browser-download" in self.install_fails:
                return done(1, "download failed")
            return done()
        if name == "claude" and argv[1:3] == ["plugin", "marketplace"]:
            return done()
        if name == "claude" and argv[1:3] == ["plugin", "install"]:
            if "plugin" in self.install_fails:
                return done(1, "could not install")
            self.installed_plugins[argv[3]] = [{"scope": "user"}]
            self.write_plugins((env or {}).get("CLAUDE_CONFIG_DIR"))
            return done()
        if name == "launchctl":
            return self.launchctl(argv, done)
        if name == "python3" and os.path.basename(argv[1]) == "usage-watch":
            return self.usage_watch(argv, done)
        if name == "herdr-app":
            return self.herdr_app(argv, done)
        raise AssertionError(f"setup started {argv}, which this Mac does not have")

    def launchctl(self, argv, done):
        if argv[1] == "print":
            return done(0 if self.loaded else 113)
        if argv[1] == "bootstrap":
            if not Path(argv[3]).is_file():
                return done(5, "no plist")
            self.loaded = True
            return done()
        if argv[1] == "bootout":
            self.loaded = False
            return done()
        raise AssertionError(argv)

    def usage_watch(self, argv, done):
        if "--now" in argv:
            self.usage = self.login if self.login != "ok" else "ok"
            return done(0 if self.usage == "ok" else 1, self.usage)
        why = None
        if self.usage is None:
            why = "never ran"
        elif self.usage == "no-login":
            why = "no login"
        elif self.usage == "keychain-denied":
            why = "keychain denied"
        elif not self.loaded:
            why = "launch agent not loaded"
        report = {"status": self.usage, "loaded": self.loaded, "broken": why}
        return done(1 if why else 0, json.dumps(report))

    def herdr_app(self, argv, done):
        if not self.herdr_running:
            return done(1, "the app is not running")
        if argv[1] == "status":
            return done(0, json.dumps({"layout": self.layout, "errors": list(self.herdr_errors)}))
        if argv[1] == "do":
            return done(1, "the window did not answer") if "switch" in self.install_fails else done(0, "{}")
        raise AssertionError(argv)


@pytest.fixture
def mac(home, tmp_path, monkeypatch):
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    return Mac(home, tmp_path, monkeypatch)


def run_orchi(*args):
    """cli.main with --json, and its report."""
    from orchi import cli
    import io
    import contextlib
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = cli.main(["--json", *args])
    return code, json.loads(out.getvalue()), out.getvalue()


def states(report):
    return {s["name"]: s["status"] for s in report["steps"]}


ALL_STEPS = ["Orchi files", "Settings folder", "Settings", "Old settings", "Developer tools", "Homebrew", "GitHub CLI",
             "terminal-notifier", "Node", "agent-browser", "Claude Code", "Herdr app", "Herdr core", "Claude profile",
             "Skills and commands", "Planning skills", "Folder trust",
             "Themes", "Mods", "Layout", "Keys", "Sounds", "App settings", "Launcher", "Browser pane",
             "Ticket sources", "Linear key", "Linear", "House rules", "usage-watch", "Herdr reload"]
