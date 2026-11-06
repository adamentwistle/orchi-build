"""For every test under this folder: ORCHI_SETTINGS, ORCHI_STATE and HERDR_APP_HOME start out pointing into a temporary
folder of the test's own, where there are no files, and LEGWORK_DIR is unset, so no test reads the real settings,
`orchi`'s state, Herdr's own files or the caller's tracker. A test that wants settings writes them there or points these elsewhere.

It sits at the top so pytest loads it before bin/tests and pkgtests, whose tests import pkgtests/conftest.py by name.
"""
import os

import pytest

# Every child process a test starts inherits this, so none can start a real installer, read the keychain or load a
# launch agent through orchi.system or orchi.tickets.keychain (the real versions refuse while it is set).
os.environ["ORCHI_NO_SYSTEM"] = "1"


@pytest.fixture(autouse=True)
def no_real_settings(tmp_path_factory, monkeypatch):
    base = tmp_path_factory.mktemp("no-settings")
    monkeypatch.setenv("ORCHI_SETTINGS", str(base / "settings.json"))
    monkeypatch.setenv("ORCHI_STATE", str(base / "state"))
    monkeypatch.setenv("HERDR_APP_HOME", str(base / "herdr-app"))
    # The caller's own tracker, which legwork and Orchi read before ~/legwork. A test that wants one names its own.
    monkeypatch.delenv("LEGWORK_DIR", raising=False)


# No test reaches the real keychain or the network. Orchi's keychain reads go through
# orchi.tickets.keychain.find_password, which pkgtests/conftest.py fakes; this catches anything that starts the
# security binary another way. Linear's API and gh are faked at their seams the same way; this stops any socket to a
# host that isn't this computer. Neither reaches into a child process, so a test that starts orchi in one names only
# the file sources in its settings.
import ipaddress  # noqa: E402
import os  # noqa: E402
import shlex  # noqa: E402
import socket  # noqa: E402
import subprocess  # noqa: E402


def _words(args, shell):
    if isinstance(args, (str, bytes, os.PathLike)):
        text = os.fsdecode(args)
        if not shell:
            return [text]
        try:
            return shlex.split(text)
        except ValueError:
            return text.split()
    # Every word of every argument, so `sh -c "security ..."` and `env security` are seen too.
    return [w for a in args for w in os.fsdecode(a).split()]


CHANGES_A_MAC = {"launchctl", "brew", "xcode-select", "npm"}


class _NoKeychain(subprocess.Popen):
    def __init__(self, args, *rest, **kw):
        words = _words(args, kw.get("shell", False)) + ([os.fsdecode(kw["executable"])] if kw.get("executable") else [])
        for w in words:
            if os.path.basename(w) == "security":
                raise AssertionError("a test reached the real security binary: fake orchi.tickets.keychain.find_password")
            if os.path.basename(w) in CHANGES_A_MAC:
                raise AssertionError(f"a test started {os.path.basename(w)}, which changes the Mac: fake orchi.system.run")
        super().__init__(args, *rest, **kw)


def _local(host):
    if host in (None, "", "localhost"):
        return True
    try:
        return ipaddress.ip_address(host if isinstance(host, str) else host.decode()).is_loopback
    except ValueError:
        return False


def _no_network(what):
    raise AssertionError(f"a test reached the network ({what}): fake the source at its seam")


@pytest.fixture(autouse=True)
def no_keychain_or_network(monkeypatch):
    real_connect, real_connect_ex, real_getaddrinfo = socket.socket.connect, socket.socket.connect_ex, socket.getaddrinfo

    def connect(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6) and not _local(address[0]):
            _no_network(address[0])
        return real_connect(self, address)

    def connect_ex(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6) and not _local(address[0]):
            _no_network(address[0])
        return real_connect_ex(self, address)

    def getaddrinfo(host, *rest, **kw):
        if not _local(host):
            _no_network(host)
        return real_getaddrinfo(host, *rest, **kw)

    monkeypatch.setattr(subprocess, "Popen", _NoKeychain)
    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket.socket, "connect_ex", connect_ex)
    monkeypatch.setattr(socket, "getaddrinfo", getaddrinfo)
