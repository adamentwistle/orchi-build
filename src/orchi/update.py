"""`orchi update`: move to the newest release, then run the steps with the new code.

The newest release is GitHub's latest one, the source archive install.sh installs, put in place with `uv tool install`.
The running program is the old code, so the steps run in the new `orchi` as a child. docs/adr/0007-update-and-uninstall.md
has the reasons.
"""
import contextlib
import http.client
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.error

import orchi
from orchi import system
from orchi.engine import last_line
from orchi.plain import dumps, plain

REPO = "adamentwistle/orchi-build"
API = "https://api.github.com"
INSTALL_WAIT = 10 * 60


class Stop(Exception):
    """Something that ends the update before it changes anything, as one plain line."""


def version_of(text):
    """The numbers of a version or a tag (0.2.0 or v0.2.0), or None when it is not one."""
    found = re.fullmatch(r"v?(\d+(?:\.\d+)*)", str(text).strip())
    if not found:
        return None
    numbers = [int(n) for n in found.group(1).split(".")]
    while len(numbers) > 1 and numbers[-1] == 0:
        numbers.pop()
    return tuple(numbers)


def latest_tag(api, repo, token):
    try:
        body = system.get(f"{api}/repos/{repo}/releases/latest", token=token, timeout=30)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise Stop("GitHub refused the request. Check ORCHI_GITHUB_TOKEN. Nothing changed.") from None
        raise Stop("No release found. Nothing changed." if e.code == 404 else "Could not reach GitHub. Nothing changed.")
    except (OSError, ValueError, http.client.HTTPException):
        raise Stop("Could not reach GitHub. Nothing changed.") from None
    try:
        tag = json.loads(body).get("tag_name")
    except (ValueError, AttributeError):
        tag = None
    if not isinstance(tag, str) or not tag.strip():
        raise Stop("No release found. Nothing changed.")
    return tag.strip()


def install(uv, api, repo, token, tag, shown):
    folder = None
    try:
        folder = tempfile.mkdtemp(prefix="orchi-update-")
        archive = os.path.join(folder, "orchi.tar.gz")
        try:
            data = system.get(f"{api}/repos/{repo}/tarball/{tag}", token=token, timeout=300)
        except (OSError, ValueError, http.client.HTTPException):
            raise Stop(f"Could not download Orchi {shown}. Nothing changed.") from None
        try:
            with open(archive, "wb") as f:
                f.write(data)
        except OSError as e:
            raise Stop(f"Could not keep the download of Orchi {shown}: {e.strerror or e}. Nothing changed.") from None
        done = system.run([uv, "tool", "install", "--force", archive], timeout=INSTALL_WAIT)
    except OSError as e:
        # No folder to put the download in.
        raise Stop(f"Could not keep the download of Orchi {shown}: {e.strerror or e}. Nothing changed.") from None
    finally:
        if folder:
            # Clearing the download is tidying: it never undoes an install that finished.
            with contextlib.suppress(OSError):
                shutil.rmtree(folder)
    if done.returncode == 124:
        raise Stop(f"uv took too long to install Orchi {shown}.")
    if done.returncode != 0:
        raise Stop(f"uv could not install Orchi {shown}: {last_line(done.stdout) or 'it failed'}")


def new_orchi(uv):
    """The orchi command uv just installed, or None. Never one found on PATH, which may be an older copy."""
    done = system.run([uv, "tool", "dir", "--bin"], timeout=60)
    # uv's warnings share the output, so the folder is the last line that is one.
    lines = [line.strip() for line in done.stdout.splitlines()] if done.returncode == 0 else []
    folder = next((line for line in reversed(lines) if os.path.isabs(line) and os.path.isdir(line)), None)
    return os.path.join(folder, "orchi") if folder else None


def update(args):
    """The facts of the update, and the exit code of the steps it ran, as (report, code)."""
    api = (os.environ.get("ORCHI_API_URL") or API).rstrip("/")
    repo = os.environ.get("ORCHI_REPO") or REPO
    token = os.environ.get("ORCHI_GITHUB_TOKEN") or None
    now = orchi.__version__
    report = {"command": "update", "ok": False, "from": now, "to": None, "updated": False, "summary": ""}
    try:
        tag = latest_tag(api, repo, token)
        newest = version_of(tag)
        if newest is None:
            raise Stop(f"The newest release, {tag}, is not a version number. Nothing changed.")
        shown = tag.lstrip("v")
        # A development build such as 0.3.0.dev1 counts by its leading numbers, so it is never taken back.
        leading = re.match(r"\d+(?:\.\d+)*", now)
        have = version_of(leading.group(0)) if leading else None
        # 0.3.0.dev1 and 0.3.0rc1 are before 0.3.0. 0.3.0.post1 and 0.3.0+local are not.
        early = leading and re.match(r"\.?(dev|a|b|rc)", now[len(leading.group(0)):])
        if have is not None and (have > newest or have == newest and not early):
            report.update(ok=True, to=now, summary=f"Orchi {now} is the newest.")
            return report, 0
        uv = system.find("uv")
        if not uv:
            raise Stop("uv is not on PATH. Nothing changed.")
        install(uv, api, repo, token, tag, shown)
    except Stop as e:
        report["summary"] = str(e)
        return report, 1
    except system.Refused as e:
        # ORCHI_NO_SYSTEM is set: any download or install update tries is refused, and it says so in one line.
        report["summary"] = f"{e}. Nothing changed."
        return report, 1
    report.update(to=shown, updated=True, summary=f"Updated Orchi from {now} to {shown}.")
    return report, None


def run(args):
    report, code = update(args)
    if code is not None:
        _say(report, args.json)
        return code
    if not args.json:
        _say(report, False)
    # The steps, in the new Orchi, with the terminal: they refresh the content and ask what they need.
    try:
        command = new_orchi(system.find("uv"))
        if command is None:
            code = 1
            print("Run orchi to refresh what it installed.", file=sys.stderr)
        else:
            code = system.run([command], interactive=True).returncode
    except system.Refused as e:
        # Said here rather than by the command line, so --json still gives its one object.
        print(f"orchi: {plain(e)}", file=sys.stderr)
        code = 1
    if args.json:
        # One object, said once the steps are done, so ok says whether they worked.
        report["ok"] = code == 0
        _say(report, True)
    return code


def _say(report, as_json):
    sys.stdout.write((dumps(report) if as_json else plain(report["summary"], lines=True)) + "\n")
    sys.stdout.flush()
