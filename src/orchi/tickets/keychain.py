"""The macOS keychain, read through one function so every test can put a fake in its place.

Orchi keeps the Linear API key as a generic password under the service LINEAR_SERVICE. find_password() is the only
code that starts the security binary. It never prints, logs or passes on what it reads.
"""
import subprocess

SECURITY = "/usr/bin/security"
LINEAR_SERVICE = "orchi-linear"


def find_password(service):
    """The password stored under `service`, or None when there is none, or no keychain on this computer."""
    try:
        done = subprocess.run([SECURITY, "find-generic-password", "-s", service, "-w"], capture_output=True, text=True,
                              stdin=subprocess.DEVNULL, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    password = done.stdout.strip() if done.returncode == 0 else ""
    return password or None
