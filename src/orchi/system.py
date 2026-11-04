"""Where setup meets the computer: the programs it starts, the pages it downloads and the platform it runs on.

Every installer, `launchctl`, `brew`, the Claude Code and Herdr commands and every download go through run() and
fetch(), so tests put a fake in their place (pkgtests/mac_help.py) and the guard in pkgtests/conftest.py fails any
test that reaches a real one. The keychain has its own seam, in orchi.tickets.keychain.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import namedtuple
from urllib.parse import urlsplit

# Set, it makes run() and fetch() refuse. The test suite sets it for itself and every child process it starts, so a test
# that runs the real command in a child can't start a real installer, read the keychain or load a launch agent.
SWITCH_OFF = "ORCHI_NO_SYSTEM"

# Where a tool can be after an installer put it there, though the shell that started orchi doesn't know yet.
EXTRA_DIRS = ("/opt/homebrew/bin", "/usr/local/bin", "~/.local/bin")

Result = namedtuple("Result", "returncode stdout")


class Refused(Exception):
    """run() or fetch() was called while SWITCH_OFF is set."""


def _guard(what):
    if os.environ.get(SWITCH_OFF):
        raise Refused(f"{what} is refused while {SWITCH_OFF} is set")


def platform():
    """darwin, linux, windows, or what Python calls it."""
    name = sys.platform
    return "windows" if name in ("win32", "cygwin") else "linux" if name.startswith("linux") else name


def sleep(seconds):
    time.sleep(seconds)


class HttpsOnly(urllib.request.HTTPRedirectHandler):
    """A redirect to anything but https is refused, since the installer would then be fetched in the clear."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith("https://"):
            raise urllib.error.URLError(f"{req.full_url} redirects to {newurl}, which is not an https address")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url, timeout=60):
    """The text of a page. HTTPS only: an installer fetched over anything else could be swapped on the way."""
    _guard(f"downloading {url}")
    if not url.startswith("https://"):
        raise ValueError(f"{url} is not an https address")
    with urllib.request.build_opener(HttpsOnly).open(url, timeout=timeout) as page:
        return page.read().decode("utf-8")


# Only the addresses themselves: a name such as localhost is whatever the hosts file says it is.
LOCAL_HOSTS = ("127.0.0.1", "::1")


def _check_address(url):
    parts = urlsplit(url)
    if parts.scheme == "https" or (parts.scheme == "http" and parts.hostname in LOCAL_HOSTS):
        return
    raise ValueError(f"{url} is not an https address")


class _KeepTokenHome(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only to an address get() would take, and drops the token when it leaves the host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        try:
            _check_address(newurl)
        except ValueError as e:
            raise urllib.error.URLError(str(e)) from None
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and urlsplit(newurl).netloc != urlsplit(req.full_url).netloc:
            new.headers.pop("Authorization", None)
            new.unredirected_hdrs.pop("Authorization", None)
        return new


def get(url, token=None, timeout=60):
    """The bytes at an address. HTTPS only, or a server on this computer, which is how a test plays GitHub. The token
    goes in an Authorization header to the host asked, and no further: a redirect to another host leaves it behind."""
    _guard(f"downloading {url}")
    _check_address(url)
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"} if token else {})
    # Only https goes through a proxy named in the environment. A server on this computer is asked directly, whatever
    # the case of its scheme and wherever a redirect came from, or the proxy would be sent the token.
    proxies = {scheme: found for scheme, found in urllib.request.getproxies().items() if scheme == "https"}
    opener = urllib.request.build_opener(_KeepTokenHome, urllib.request.ProxyHandler(proxies))
    with opener.open(request, timeout=timeout) as page:
        return page.read()


def _with_extra_dirs(env):
    """The environment a program gets, with the folders tools are installed in after its own PATH, so a script that
    starts `node` through env finds the one Homebrew put in /opt/homebrew/bin even when the shell doesn't list it."""
    env = dict(os.environ if env is None else env)
    parts = [p for p in env.get("PATH", "").split(os.pathsep) if p]
    for folder in (os.path.expanduser(d) for d in EXTRA_DIRS):
        if os.path.isdir(folder) and folder not in parts:
            parts.append(folder)
    env["PATH"] = os.pathsep.join(parts)
    return env


def run(argv, input=None, timeout=None, env=None, interactive=False):
    """Run a program without a shell and give back (exit code, its output). A program that isn't there exits 127 and
    one that takes longer than timeout seconds 124. With interactive set it uses the terminal for input and shows its
    output on standard error, so `--json` keeps standard output to itself."""
    _guard(f"starting {os.fspath(argv[0])}")
    kw = {"env": _with_extra_dirs(env), "timeout": timeout, "text": True}
    tty = None
    if interactive:
        if not sys.stdin.isatty():
            try:
                tty = open("/dev/tty", encoding="utf-8")
            except OSError:
                tty = None
        kw.update(stdin=tty or None, stdout=sys.stderr, stderr=sys.stderr)
    else:
        kw.update(stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if input is None:
            kw["stdin"] = subprocess.DEVNULL
        else:
            kw["input"] = input
    try:
        done = subprocess.run([os.fspath(a) for a in argv], **kw)
    except FileNotFoundError:
        return Result(127, "")
    except OSError as e:
        return Result(127, e.strerror or "")
    except subprocess.TimeoutExpired:
        return Result(124, "")
    finally:
        if tty:
            tty.close()
    return Result(done.returncode, done.stdout or "")


def json_object(text):
    """The JSON object in a program's output, which may be followed by a warning since errors are merged into the output:
    the whole text, else the last line that is one. None when there is none."""
    for part in (text, *reversed(text.splitlines())):
        try:
            found = json.loads(part)
        except ValueError:
            continue
        if isinstance(found, dict):
            return found
    return None


def find(name):
    """The path of a program on PATH, else in EXTRA_DIRS, or None. It has to be something that can run."""
    for folder in [*os.environ.get("PATH", "").split(os.pathsep), *(os.path.expanduser(d) for d in EXTRA_DIRS)]:
        path = os.path.join(folder, name)
        if folder and os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def add_to_path(folder):
    """Put a folder first on PATH for the rest of this run, unless it's there."""
    parts = os.environ.get("PATH", "").split(os.pathsep)
    if folder not in parts:
        os.environ["PATH"] = os.pathsep.join([folder, *parts])
