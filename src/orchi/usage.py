"""The usage-watch step: its first read of Claude Code's login while the user is at the screen, then its launch agent.

docs/usage-watch.md ("Setup's first read") is the spec. The first read runs in the foreground, so macOS can ask whether
`security` may read the entry. `ok` loads the launch agent; no login or a refused keychain leaves it off and says so;
any other status clears up by itself, so the agent is loaded anyway. A private window leaves the real launch agent alone.
"""
import os
import re
from xml.sax.saxutils import escape

from orchi import herdr, paths, system
from orchi.engine import Step, broken, needs_fix, ok
from orchi.tools import XCODE_SELECT, SetupError, last_line

LABEL = "orchi.usage-watch"
PYTHON = "/usr/bin/python3"
LAUNCHCTL = "/bin/launchctl"
FIRST_READ = 130
UNLOAD_TRIES = 10
STATUSES = ("ok", "no-login", "keychain-denied", "keychain-locked", "login-expired", "rate-limited", "offline",
            "endpoint-changed")


class UsageWatch(Step):
    """usage-watch has read the login once and its launch agent is loaded."""
    name = "usage-watch"

    def script(self):
        return str(paths.data_dir() / "bin" / "usage-watch")

    def plist(self):
        return herdr.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"

    def domain(self):
        return f"gui/{os.getuid()}"

    def report(self):
        done = system.run([PYTHON, self.script(), "--status", "--json"], timeout=60)
        return system.json_object(done.stdout)

    def rendered(self):
        text = (paths.data_dir() / "launchd" / "orchi.usage-watch.plist.template").read_text()
        text = re.sub(r"<!--.*?-->\s*", "", text, flags=re.S)
        settings_path = os.environ.get("ORCHI_SETTINGS")
        block = ("\t<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>ORCHI_SETTINGS</key>\n"
                 f"\t\t<string>{escape(os.path.abspath(os.path.expanduser(settings_path)))}</string>\n\t</dict>\n"
                 if settings_path else "")
        text = "".join(block if line.strip() == "@ORCHI_SETTINGS@" else line for line in text.splitlines(keepends=True))
        return text.replace("@ORCHI@", escape(str(paths.data_dir()))).replace("@HOME@", escape(str(herdr.home())))

    def check(self):
        if herdr.private_window():
            return ok()
        # Without the developer tools /usr/bin/python3 is only a stub that opens Apple's installer.
        if system.run([XCODE_SELECT, "-p"]).returncode != 0:
            return broken("needs the developer tools")
        found = self.report()
        if found is None:
            return broken("usage-watch gave no report")
        why = found.get("broken")
        if why == "cache folder not private":
            return broken(why)
        if why:
            return needs_fix(why)
        try:
            same = self.plist().read_text() == self.rendered()
        except OSError:
            same = False
        return ok() if same else needs_fix("launch agent file out of date")

    def loaded(self):
        return system.run([LAUNCHCTL, "print", f"{self.domain()}/{LABEL}"], timeout=30).returncode == 0

    def fix(self, ctx):
        # The first read happens here, in the foreground, so the user can click Allow.
        first = ctx.run([PYTHON, self.script(), "--now"], timeout=FIRST_READ)
        # The status is the last line that is one, since a warning printed after it is merged into the same output.
        lines = [line.strip() for line in first.stdout.splitlines()]
        status = next((line for line in reversed(lines) if line in STATUSES), last_line(first.stdout))
        if status not in STATUSES:
            raise SetupError(status or "usage-watch's first read did not finish")
        if status == "no-login":
            raise SetupError("no Claude Code login: sign in to Claude Code, then run orchi again")
        if status == "keychain-denied":
            raise SetupError("the keychain refused usage-watch: allow it, then run orchi again")
        plist = self.plist()
        ctx.folder(plist.parent)
        ctx.write(plist, self.rendered())
        if self.loaded():
            ctx.run([LAUNCHCTL, "bootout", f"{self.domain()}/{LABEL}"], timeout=30)
            # Bootout returns before the agent is gone, and loading it again meanwhile fails with an I/O error.
            for _ in range(UNLOAD_TRIES):
                if not self.loaded():
                    break
                system.sleep(1)
        done = ctx.run([LAUNCHCTL, "bootstrap", self.domain(), str(plist)], timeout=30)
        if done.returncode != 0:
            raise SetupError(last_line(done.stdout) or "launchctl could not load the launch agent")
        return "loaded"


def steps():
    return [UsageWatch()]
