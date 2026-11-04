"""The tools setup checks for and installs, each after the user agrees: the developer command-line tools, Homebrew,
the GitHub CLI, terminal-notifier, Node, agent-browser, Claude Code, and the Herdr app and core.

Each is installed the way its makers say to: Apple's own installer, Homebrew's script, `brew install`, `npm install -g`,
or the installer script from the maker's own address. Every program and download goes through orchi.system, and a
question is asked before anything is installed. An installer that fails is broken with the last line it printed.
"""
import os

from orchi import herdr, settings, system
from orchi import store as store_mod
from orchi.engine import SetupError, Step, last_line, needs_fix, ok

HOMEBREW_URL = "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"
CLAUDE_URL = "https://claude.ai/install.sh"
HERDR_APP_URL = "https://releases.herdr.dev/app/install.sh"
HERDR_CORE_URL = "https://releases.herdr.dev/core/install.sh"
XCODE_SELECT = "/usr/bin/xcode-select"
INSTALL_WAIT = 30 * 60
POLL = 5
LONG = 30 * 60


def succeeded(done, what):
    if done.returncode == 124:
        raise SetupError(f"{what} took too long")
    if done.returncode != 0:
        raise SetupError(last_line(done.stdout) or f"{what} failed")


class Tool(Step):
    """A tool that is there or isn't, and is installed after a yes."""
    label = None

    def missing(self):
        """None when the tool is there, else why it isn't, in a few words."""
        raise NotImplementedError

    def needs(self):
        """Raises SetupError when something this tool needs is missing."""

    def install(self, ctx):
        raise NotImplementedError

    def check(self):
        why = self.missing()
        return ok() if why is None else needs_fix(why)

    def fix(self, ctx):
        self.needs()
        if ctx.ask(f"Install {self.label or self.name}?", ["Yes", "No"]) == "No":
            raise SetupError("not installed")
        self.install(ctx)
        return "installed"


class DeveloperTools(Tool):
    """Git and the developer command-line tools, from Apple's installer window."""
    name = "Developer tools"
    label = "the developer tools"

    def missing(self):
        return None if system.run([XCODE_SELECT, "-p"]).returncode == 0 else "not installed"

    def install(self, ctx):
        # It exits at once while the installer window opens; "already installed" exits non-zero and is fine too.
        ctx.run([XCODE_SELECT, "--install"])
        waited = 0
        while self.missing() and waited < INSTALL_WAIT:
            system.sleep(POLL)
            waited += POLL
        if self.missing():
            raise SetupError("finish the installer window, then run orchi again")


class Homebrew(Tool):
    name = "Homebrew"

    def missing(self):
        return None if system.find("brew") else "not installed"

    def install(self, ctx):
        # Its script asks for the password and a key press, so it runs with the terminal.
        succeeded(ctx.run(["/bin/bash", "-c", system.fetch(HOMEBREW_URL)], interactive=True, timeout=LONG), "Homebrew")
        found = system.find("brew")
        if found:
            system.add_to_path(os.path.dirname(found))


class Brewed(Tool):
    """A tool `brew install` puts in place."""
    formula = None
    binary = None

    def missing(self):
        return None if system.find(self.binary) else "not installed"

    def needs(self):
        if not system.find("brew"):
            raise SetupError("needs Homebrew")

    def install(self, ctx):
        brew = system.find("brew")
        succeeded(ctx.run([brew, "install", self.formula], timeout=LONG), self.formula)
        system.add_to_path(os.path.dirname(brew))


class GitHubCLI(Brewed):
    """The command github.command names, which is gh unless the settings say otherwise."""
    name = "GitHub CLI"
    label = "the GitHub CLI"
    formula = "gh"

    def command(self):
        return settings.read()["github"]["command"]

    def missing(self):
        command = self.command()
        found = os.path.isfile(command) and os.access(command, os.X_OK) if "/" in command else system.find(command)
        return None if found else (f"{command} is not on PATH" if command != self.formula else "not installed")

    def needs(self):
        command = self.command()
        if command != self.formula:
            raise SetupError(f"{command} is not on PATH")
        super().needs()


class TerminalNotifier(Brewed):
    name = "terminal-notifier"
    formula = binary = "terminal-notifier"


class Node(Brewed):
    name = "Node"
    formula = "node"

    def missing(self):
        node = system.find("node")
        if not node:
            return "not installed"
        major = herdr.node_major(node)
        if major is None:
            return f"could not read the version of node at {node}"
        return None if major >= herdr.NODE_MAJOR else f"node at {node} is version {major}"


class AgentBrowser(Tool):
    """agent-browser and the browser it drives. Its install has two stages, so a note in the state folder says the second
    one finished: the program being there is not enough."""
    name = "agent-browser"

    def marker(self):
        return store_mod.state_dir() / "agent-browser-browser"

    def missing(self):
        if not system.find("agent-browser"):
            return "not installed"
        return None if self.marker().is_file() else "browser not downloaded"

    def needs(self):
        if not system.find("agent-browser") and not system.find("npm"):
            raise SetupError("needs Node")

    def install(self, ctx):
        if not system.find("agent-browser"):
            succeeded(ctx.run([system.find("npm"), "install", "-g", "agent-browser"], timeout=LONG), "npm")
        found = system.find("agent-browser")
        if not found:
            raise SetupError("npm did not put agent-browser on PATH")
        # Its own command downloads the browser it drives, and does nothing if it already has it.
        succeeded(ctx.run([found, "install"], timeout=LONG), "agent-browser install")
        ctx.folder(self.marker().parent)
        ctx.write(self.marker(), "")


class Official(Tool):
    """A tool installed by the script at its maker's address, run by the shell its maker names."""
    url = shell = None

    def install(self, ctx):
        succeeded(ctx.run([self.shell, "-s"], input=system.fetch(self.url), timeout=LONG), self.name)


class ClaudeCode(Official):
    name = "Claude Code"
    url, shell = CLAUDE_URL, "/bin/bash"

    def missing(self):
        return None if system.find("claude") else "not installed"


class HerdrApp(Official):
    name = "Herdr app"
    url, shell = HERDR_APP_URL, "/bin/sh"

    def missing(self):
        app = herdr.home() / "Applications" / "Herdr.app"
        return None if app.is_dir() or system.find("herdr-app") else "not installed"


class HerdrCore(Official):
    name = "Herdr core"
    url, shell = HERDR_CORE_URL, "/bin/sh"

    def missing(self):
        return None if system.find("hc") else "not installed"


def steps():
    return [DeveloperTools(), Homebrew(), GitHubCLI(), TerminalNotifier(), Node(), AgentBrowser(), ClaudeCode(),
            HerdrApp(), HerdrCore()]
