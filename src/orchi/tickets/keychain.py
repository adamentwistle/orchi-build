"""The macOS keychain, read through one function so every test can put a fake in its place.

Orchi keeps the Linear API key as a generic password under the service LINEAR_SERVICE. find_password() is the only
code that starts the security binary. It never prints, logs or passes on what it reads.
"""
import os
import re
import subprocess

from orchi import system

SECURITY = "/usr/bin/security"
LINEAR_SERVICE = "orchi-linear"
ACCOUNT = "orchi"
# What store_password will pass to `security -i`, whose own quoting is not Orchi's to guess at. Every Linear key is this.
SAFE = re.compile(r"[A-Za-z0-9._~+/=-]+")


def find_password(service):
    """The password stored under `service`, or None when there is none, or no keychain on this computer."""
    if os.environ.get(system.SWITCH_OFF):
        return None
    try:
        done = subprocess.run([SECURITY, "find-generic-password", "-s", service, "-w"], capture_output=True, text=True,
                              stdin=subprocess.DEVNULL, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    password = done.stdout.strip() if done.returncode == 0 else ""
    return password or None


def store_password(service, password):
    """Add a generic password to the login keychain, never over one that is there. The password goes down a pipe to
    `security -i`, so it is on no command line any other process could read. `security -i` exits 0 even when its command
    failed, so a True only says it ran: read the password back with find_password to know it is kept."""
    if os.environ.get(system.SWITCH_OFF) or not (SAFE.fullmatch(service) and SAFE.fullmatch(password)):
        return False
    try:
        done = subprocess.run([SECURITY, "-i"], input=f"add-generic-password -a {ACCOUNT} -s {service} -w {password}\n",
                              capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return done.returncode == 0
