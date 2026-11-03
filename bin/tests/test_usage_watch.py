"""Tests for bin/usage-watch (docs/usage-watch.md is the spec).

No test reaches the real keychain, launchd or the network. The keychain read, the request and the launch agent
check are functions passed in, and the guard below makes starting any program or opening any connection raise
for every test in this file, so a test that reached one would fail. The guard's own tests prove it trips.
HOME is a folder of the test's own, so the cache, state, lock and log files are too.
"""
import hashlib
import http.client
import importlib.machinery
import importlib.util
import io
import json
import os
import socket
import stat
import subprocess
import unicodedata
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from email.utils import format_datetime
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "usage-watch"
NOW = 1_800_000_000.0
LOGIN = "fake-login-7f3a9c"
PLAIN = "Claude Code-credentials"


class RealWorld(BaseException):
    """Raised when a test reaches a real program or connection. A BaseException, so no `except Exception` hides it."""


def _refuse(*args, **kwargs):
    raise RealWorld(f"a test reached the real world: {args[:2]!r}")


def load():
    loader = importlib.machinery.SourceFileLoader("usage_watch", str(SCRIPT))
    spec = importlib.util.spec_from_loader("usage_watch", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


@pytest.fixture(autouse=True)
def guard(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
    monkeypatch.setenv("USER", "someone")
    for name in ("run", "Popen", "call", "check_call", "check_output"):
        monkeypatch.setattr(subprocess, name, _refuse)
    monkeypatch.setattr(os, "system", _refuse)
    monkeypatch.setattr(socket.socket, "connect", _refuse)
    monkeypatch.setattr(socket, "create_connection", _refuse)
    monkeypatch.setattr(http.client.HTTPConnection, "connect", _refuse)


@pytest.fixture
def uw():
    return load()


def home():
    return Path(os.environ["HOME"])


def cache_dir():
    return home() / ".cache" / "orchi"


def keychain(value=None, code=0, calls=None):
    """A fake keychain holding one value under every name, or answering every lookup with `code`."""
    def read(service, account, timeout):
        if calls is not None:
            calls.append((service, account, timeout))
        if code:
            return code, ""
        return 0, value if value is not None else json.dumps({"claudeAiOauth": {"accessToken": LOGIN, "refreshToken": "r"}})
    return read


def endpoint(code=200, body=None, headers=None, calls=None):
    def fetch(token, timeout):
        if calls is not None:
            calls.append((token, timeout))
        b = body if body is not None else json.dumps(ANSWER).encode()
        return code, headers or {}, b
    return fetch


def refuse_read(*a):
    raise AssertionError("the keychain was read")


def refuse_fetch(*a):
    raise AssertionError("the endpoint was asked")


ANSWER = {
    "five_hour": {"utilization": 29.0, "resets_at": "2026-09-19T23:41:00+00:00"},
    "seven_day": {"utilization": 40, "resets_at": "2026-09-21T08:00:00+00:00"},
    "limits": [{"kind": "weekly_scoped", "percent": 9, "resets_at": "2026-09-21T08:00:00+00:00",
                "scope": {"model": {"display_name": "Fable 5"}}}],
}


# The guard


def test_the_guard_stops_the_real_keychain_read(uw):
    with pytest.raises(RealWorld):
        uw.read_keychain(PLAIN, "someone", 1)


def test_the_guard_stops_the_real_request(uw):
    with pytest.raises(RealWorld):
        uw.fetch_usage(LOGIN, 1)


def test_the_guard_stops_the_real_launch_agent_check(uw):
    with pytest.raises(RealWorld):
        uw.agent_loaded()


# The one name


def test_no_profile_is_the_plain_name(uw):
    assert uw.service_names(None) == [PLAIN]


def test_a_profile_adds_eight_hex_of_its_path(uw):
    path = "/tmp/made-up/profile-a"
    assert uw.service_names(path) == [f"{PLAIN}-{hashlib.sha256(path.encode()).hexdigest()[:8]}"]


def test_the_path_is_hashed_in_nfc(uw):
    composed, decomposed = "/tmp/café", unicodedata.normalize("NFD", "/tmp/café")
    assert composed != decomposed
    assert uw.service_names(decomposed) == uw.service_names(composed)


def test_the_default_profile_also_tries_the_plain_name(uw):
    path = str(home() / ".claude")
    assert uw.service_names(path) == [f"{PLAIN}-{hashlib.sha256(path.encode()).hexdigest()[:8]}", PLAIN]


def test_the_account_is_user(uw, monkeypatch):
    assert uw.account() == "someone"
    monkeypatch.setenv("USER", "has space")
    assert uw.account() == "claude-code-user"
    monkeypatch.delenv("USER")
    assert uw.account()  # the login name, from the password database


def test_the_real_read_is_one_named_lookup_with_no_shell(uw, monkeypatch):
    seen = []

    def run(argv, **kw):
        seen.append((argv, kw))
        return subprocess.CompletedProcess(argv, 0, stdout="value\n" if kw.get("text") else b"value\n")

    monkeypatch.setattr(subprocess, "run", run)
    assert uw.read_keychain("Name-1", "someone", 7) == (0, "value")
    (argv, kw), = seen
    assert argv == ["/usr/bin/security", "find-generic-password", "-a", "someone", "-s", "Name-1", "-w"]
    assert kw.get("shell") in (None, False)
    assert kw["stderr"] == subprocess.DEVNULL and kw["stdin"] == subprocess.DEVNULL and kw["timeout"] == 7


def test_a_read_that_times_out_is_a_locked_keychain(uw, monkeypatch):
    def run(argv, **kw):
        raise subprocess.TimeoutExpired(argv, kw["timeout"])

    monkeypatch.setattr(subprocess, "run", run)
    assert uw.read_keychain("Name-1", "someone", 1)[0] != 0
    assert uw.read_login(uw.read_keychain, None, 1) == ("keychain-locked", None)


# The login


def test_the_login_is_the_access_token(uw):
    calls = []
    assert uw.read_login(keychain(calls=calls), "/tmp/p", 10) == ("ok", LOGIN)
    assert [c[0] for c in calls] == uw.service_names("/tmp/p")


def test_only_the_named_entries_are_tried(uw):
    calls = []
    assert uw.read_login(keychain(code=44, calls=calls), str(home() / ".claude"), 10) == ("no-login", None)
    assert [c[0] for c in calls] == uw.service_names(str(home() / ".claude"))


def test_the_plain_name_is_the_fallback_for_the_default_profile(uw):
    def read(service, account, timeout):
        return (0, json.dumps({"claudeAiOauth": {"accessToken": LOGIN}})) if service == PLAIN else (44, "")
    assert uw.read_login(read, str(home() / ".claude"), 10) == ("ok", LOGIN)


def test_a_refused_keychain_is_denied(uw):
    calls = []
    assert uw.read_login(keychain(code=51, calls=calls), str(home() / ".claude"), 10) == ("keychain-denied", None)
    assert len(calls) == 1


def test_a_locked_keychain_is_tried_again_soon(uw):
    assert uw.read_login(keychain(code=36), None, 10) == ("keychain-locked", None)
    s = uw.run(NOW, read=keychain(code=36), fetch=refuse_fetch, profile=None)
    assert (s["status"], s["nextAt"]) == ("keychain-locked", "2027-01-15T08:05:00Z")
    put_state(status="keychain-locked")
    assert uw.report(uw.load_state(), NOW + 60, True)["broken"] is None
    put_state(status="keychain-locked", okAt="2027-01-15T06:59:00Z")
    assert uw.report(uw.load_state(), NOW + 60, True)["broken"] == "keychain locked"


@pytest.mark.parametrize("value", ["", "not json", "[]", json.dumps({"claudeAiOauth": {}}),
                                   json.dumps({"claudeAiOauth": {"accessToken": ""}}),
                                   json.dumps({"claudeAiOauth": {"accessToken": 12}}),
                                   json.dumps({"claudeAiOauth": {"accessToken": "a\r\nX-Other: b"}}),
                                   json.dumps({"claudeAiOauth": {"accessToken": "has space"}})])
def test_an_entry_without_a_usable_login_is_no_login(uw, value):
    assert uw.read_login(keychain(value), None, 10) == ("no-login", None)


def test_a_value_shown_as_hex_is_read(uw):
    value = json.dumps({"claudeAiOauth": {"accessToken": LOGIN}}).encode().hex()
    assert uw.read_login(keychain(value), None, 10) == ("ok", LOGIN)


# The request


class FakeConnection:
    made = []

    def __init__(self, host, port=None, timeout=None, context=None):
        self.host, self.port, self.timeout, self.context = host, port, timeout, context
        FakeConnection.made.append(self)

    def request(self, method, path, headers=None):
        self.sent = (method, path, dict(headers or {}))

    def getresponse(self):
        class R:
            status = 200

            def getheaders(self):
                return [("Retry-After", "5"), ("Content-Type", "application/json")]

            def read(self, n=None):
                return b'{"ok": 1}'
        return R()

    def close(self):
        self.closed = True


def test_the_request_goes_only_to_the_usage_endpoint(uw, monkeypatch):
    FakeConnection.made = []
    monkeypatch.setattr(http.client, "HTTPSConnection", FakeConnection)
    code, headers, body = uw.fetch_usage(LOGIN, 9)
    assert (code, body) == (200, b'{"ok": 1}')
    assert headers["retry-after"] == "5"
    conn, = FakeConnection.made
    assert conn.host == "api.anthropic.com" and conn.port in (None, 443) and conn.timeout == 9
    assert conn.context is not None and conn.context.verify_mode.name == "CERT_REQUIRED"
    method, path, sent = conn.sent
    assert (method, path) == ("GET", "/api/oauth/usage")
    assert sent["Authorization"] == f"Bearer {LOGIN}"
    assert sent["anthropic-beta"] == "oauth-2025-04-20"
    assert sent["User-Agent"].startswith("orchi-usage-watch/")
    assert getattr(conn, "closed", False)


def test_a_failed_request_is_no_answer(uw, monkeypatch):
    class Broken(FakeConnection):
        def request(self, *a, **k):
            raise OSError("no route " + LOGIN)
    monkeypatch.setattr(http.client, "HTTPSConnection", Broken)
    assert uw.fetch_usage(LOGIN, 9) == (None, {}, b"")


def test_the_endpoint_is_fixed_in_the_code(uw, monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example:8080")
    monkeypatch.setenv("https_proxy", "http://proxy.example:8080")
    FakeConnection.made = []
    monkeypatch.setattr(http.client, "HTTPSConnection", FakeConnection)
    uw.fetch_usage(LOGIN, 9)
    assert [c.host for c in FakeConnection.made] == ["api.anthropic.com"]


# The answer


def test_buckets_map_to_the_cache_keys(uw):
    assert uw.parse_usage(json.dumps(ANSWER).encode()) == {
        "sessionUsage": 29.0, "sessionResetAt": "2026-09-19T23:41:00+00:00",
        "weeklyUsage": 40, "weeklyResetAt": "2026-09-21T08:00:00+00:00",
        "fableUsage": 9, "fableResetAt": "2026-09-21T08:00:00+00:00",
    }


def test_limits_fill_in_for_missing_buckets(uw):
    body = {"limits": [
        {"kind": "session", "percent": 12, "resets_at": "2026-09-19T23:00:00Z"},
        {"kind": "weekly_all", "percent": 50, "resets_at": "2026-09-21T08:00:00Z"},
        {"kind": "weekly_scoped", "percent": 0, "resets_at": None, "scope": {"model": {"display_name": "FABLE"}}},
    ]}
    assert uw.parse_usage(json.dumps(body).encode()) == {
        "sessionUsage": 12, "sessionResetAt": "2026-09-19T23:00:00+00:00",
        "weeklyUsage": 50, "weeklyResetAt": "2026-09-21T08:00:00+00:00",
    }


def test_no_five_hour_limit_is_zero_with_no_reset(uw):
    body = dict(ANSWER, five_hour=None)
    out = uw.parse_usage(json.dumps(body).encode())
    assert out["sessionUsage"] == 0 and "sessionResetAt" not in out


def test_fable_matches_any_case_and_skips_other_models(uw):
    body = {"seven_day": {"utilization": 1, "resets_at": "2026-09-21T08:00:00Z"}, "limits": [
        {"kind": "weekly_scoped", "percent": 70, "resets_at": "2026-09-21T08:00:01Z",
         "scope": {"model": {"display_name": "Opus"}}},
        {"kind": "weekly_scoped", "percent": 33, "resets_at": "2026-09-21T08:00:02.051388+00:00",
         "scope": {"model": {"display_name": "fable"}}},
    ]}
    out = uw.parse_usage(json.dumps(body).encode())
    assert (out["fableUsage"], out["fableResetAt"]) == (33, "2026-09-21T08:00:02+00:00")


@pytest.mark.parametrize("body", [b"", b"<html>", b"[]", b"null", json.dumps({"other": 1}).encode(),
                                  json.dumps({"seven_day": {"utilization": True}}).encode(),
                                  json.dumps({"five_hour": {"utilization": "40"}}).encode(),
                                  json.dumps({"seven_day": {"utilization": float("nan")}}).encode()])
def test_an_answer_with_no_session_or_weekly_number_is_a_changed_endpoint(uw, body):
    assert uw.parse_usage(body) is None


# What each answer means


@pytest.mark.parametrize("code,status", [(200, "ok"), (401, "login-expired"), (403, "login-expired"),
                                         (429, "rate-limited"), (404, "endpoint-changed"), (410, "endpoint-changed"),
                                         (301, "endpoint-changed"), (302, "endpoint-changed"), (500, "offline"),
                                         (503, "offline"), (None, "offline"), (408, "offline"),
                                         (400, "endpoint-changed"), (405, "endpoint-changed"),
                                         (418, "endpoint-changed"), (422, "endpoint-changed")])
def test_each_answer_has_a_status(uw, code, status):
    assert uw.outcome(code, {}, json.dumps(ANSWER).encode(), NOW)[0] == status


def test_a_good_code_with_a_bad_body_is_a_changed_endpoint(uw):
    assert uw.outcome(200, {}, b"{}", NOW)[:2] == ("endpoint-changed", None)


def test_retry_after_in_seconds_or_as_a_date(uw):
    assert uw.retry_after("120", NOW) == 120
    when = datetime.fromtimestamp(NOW + 900, timezone.utc)
    assert uw.retry_after(format_datetime(when, usegmt=True), NOW) == 900
    assert uw.retry_after("soon", NOW) is None
    assert uw.retry_after("0", NOW) is None
    assert uw.retry_after(None, NOW) is None


@pytest.mark.parametrize("status,failures,retry,wait", [
    ("ok", 0, None, 300),
    ("no-login", 1, None, 3600), ("keychain-denied", 1, None, 3600), ("endpoint-changed", 3, None, 3600),
    ("login-expired", 1, None, 900), ("login-expired", 2, None, 1800), ("login-expired", 3, None, 3600),
    ("login-expired", 9, None, 3600),
    ("offline", 1, None, 300), ("offline", 2, None, 600), ("offline", 4, None, 2400), ("offline", 5, None, 3600),
    ("offline", 60, None, 3600),
    ("rate-limited", 1, None, 300), ("rate-limited", 1, 45, 45), ("rate-limited", 1, 99999, 3600),
])
def test_how_long_each_status_waits(uw, status, failures, retry, wait):
    assert uw.wait_for(status, failures, retry) == wait


# A pass


def state():
    return json.loads((cache_dir() / "usage-watch.json").read_text())


def usage():
    return json.loads((cache_dir() / "usage.json").read_text())


def mode(p):
    return stat.S_IMODE(os.stat(p).st_mode)


def test_a_good_pass_writes_the_cache_and_the_state(uw):
    s = uw.run(NOW, read=keychain(), fetch=endpoint(), profile=None)
    assert s["status"] == "ok"
    assert usage() == dict(uw.parse_usage(json.dumps(ANSWER).encode()), updatedAt="2027-01-15T08:00:00Z")
    assert state() == {"status": "ok", "checkedAt": "2027-01-15T08:00:00Z", "okAt": "2027-01-15T08:00:00Z",
                       "nextAt": "2027-01-15T08:05:00Z", "retryAt": None, "failures": 0, "http": 200}
    assert mode(cache_dir()) == 0o700
    assert mode(cache_dir() / "usage.json") == 0o600
    assert mode(cache_dir() / "usage-watch.json") == 0o600
    assert sorted(p.name for p in cache_dir().iterdir()) == ["usage-watch.json", "usage-watch.lock", "usage.json"]


def test_an_existing_folder_keeps_its_mode(uw):
    cache_dir().mkdir(parents=True, mode=0o755)
    os.chmod(cache_dir(), 0o755)
    uw.run(NOW, read=keychain(), fetch=endpoint(), profile=None)
    assert mode(cache_dir()) == 0o755
    assert mode(cache_dir() / "usage.json") == 0o600


def test_a_failed_pass_leaves_the_cache_as_it_was(uw):
    uw.run(NOW, read=keychain(), fetch=endpoint(), profile=None)
    before = (cache_dir() / "usage.json").read_bytes()
    s = uw.run(NOW + 400, read=keychain(), fetch=endpoint(500), profile=None)
    assert s["status"] == "offline" and s["okAt"] == "2027-01-15T08:00:00Z" and s["failures"] == 1
    assert (cache_dir() / "usage.json").read_bytes() == before


def test_no_login_never_asks_the_endpoint(uw):
    s = uw.run(NOW, read=keychain(code=44), fetch=refuse_fetch, profile=None)
    assert s["status"] == "no-login" and s["http"] is None
    assert not (cache_dir() / "usage.json").exists()


def test_the_profile_comes_from_the_settings(uw, tmp_path):
    Path(os.environ["ORCHI_SETTINGS"]).write_text(json.dumps({"claude_dir": "/tmp/made-up/profile-b"}))
    calls = []
    uw.run(NOW, read=keychain(calls=calls), fetch=endpoint())
    assert [c[0] for c in calls] == uw.service_names("/tmp/made-up/profile-b")


def test_a_pass_before_the_next_try_does_nothing(uw):
    uw.run(NOW, read=keychain(), fetch=endpoint(500), profile=None)
    assert uw.run(NOW + 60, read=refuse_read, fetch=refuse_fetch, profile=None)["status"] == "offline"
    assert state()["checkedAt"] == "2027-01-15T08:00:00Z"


def test_now_goes_before_the_next_try(uw):
    uw.run(NOW, read=keychain(), fetch=endpoint(500), profile=None)
    assert uw.run(NOW + 60, force=True, read=keychain(), fetch=endpoint(), profile=None)["status"] == "ok"


def test_now_still_honours_retry_after(uw):
    uw.run(NOW, read=keychain(), fetch=endpoint(429, headers={"retry-after": "600"}), profile=None)
    assert state()["nextAt"] == state()["retryAt"] == "2027-01-15T08:10:00Z"
    assert uw.run(NOW + 60, force=True, read=refuse_read, fetch=refuse_fetch, profile=None)["status"] == "rate-limited"


def test_failures_add_up_across_passes_and_reset_on_success(uw):
    t = NOW
    for expected in (1, 2, 3):
        s = uw.run(t, read=keychain(), fetch=endpoint(401), profile=None)
        assert s["failures"] == expected
        t += 4000
    assert state()["nextAt"] == uw.iso(t - 4000 + 3600)
    assert uw.run(t, read=keychain(), fetch=endpoint(), profile=None)["failures"] == 0


def test_a_damaged_state_file_is_started_over(uw):
    cache_dir().mkdir(parents=True)
    (cache_dir() / "usage-watch.json").write_text("{half")
    assert uw.run(NOW, read=keychain(), fetch=endpoint(), profile=None)["status"] == "ok"
    (cache_dir() / "usage-watch.json").write_text(json.dumps({"status": "ok", "nextAt": "not a time", "failures": "x"}))
    assert uw.run(NOW + 1, read=keychain(), fetch=endpoint(500), profile=None)["failures"] == 1


def test_a_pass_while_another_runs_does_nothing(uw):
    import fcntl
    cache_dir().mkdir(parents=True)
    with open(cache_dir() / "usage-watch.lock", "w") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        assert uw.run(NOW, read=refuse_read, fetch=refuse_fetch, profile=None) is None


def test_a_lock_file_left_by_a_dead_pass_does_not_block(uw):
    cache_dir().mkdir(parents=True)
    (cache_dir() / "usage-watch.lock").write_text("")
    assert uw.run(NOW, read=keychain(), fetch=endpoint(), profile=None)["status"] == "ok"


def test_a_write_that_fails_part_way_leaves_the_old_file_and_no_scraps(uw, monkeypatch):
    uw.run(NOW, read=keychain(), fetch=endpoint(), profile=None)
    before = (cache_dir() / "usage.json").read_bytes()

    def replace(a, b):
        raise OSError("disk full")
    monkeypatch.setattr(os, "replace", replace)
    with pytest.raises(OSError):
        uw.run(NOW + 400, read=keychain(), fetch=endpoint(), profile=None)
    assert (cache_dir() / "usage.json").read_bytes() == before
    assert sorted(p.name for p in cache_dir().iterdir()) == ["usage-watch.json", "usage-watch.lock", "usage.json"]


def test_a_symlinked_lock_file_is_not_followed(uw, tmp_path):
    cache_dir().mkdir(parents=True)
    target = tmp_path / "elsewhere"
    target.write_text("keep")
    os.symlink(target, cache_dir() / "usage-watch.lock")
    with pytest.raises(OSError):
        uw.run(NOW, read=refuse_read, fetch=refuse_fetch, profile=None)
    assert target.read_text() == "keep"


# What doctor sees


def put_state(**kw):
    cache_dir().mkdir(parents=True, exist_ok=True)
    s = {"status": "ok", "checkedAt": "2027-01-15T08:00:00Z", "okAt": "2027-01-15T08:00:00Z",
         "nextAt": "2027-01-15T08:05:00Z", "failures": 0, "http": 200}
    s.update(kw)
    (cache_dir() / "usage-watch.json").write_text(json.dumps(s))


@pytest.mark.parametrize("kw,loaded,broken", [
    ({}, True, None),
    ({"status": "endpoint-changed"}, True, "endpoint changed"),
    ({"status": "no-login", "okAt": None}, True, "no login"),
    ({"status": "keychain-denied"}, True, "keychain denied"),
    ({"status": "login-expired"}, True, None),
    ({"status": "login-expired", "okAt": "2027-01-15T06:59:00Z"}, True, "login expired"),
    ({"status": "offline", "okAt": "2027-01-15T06:59:00Z"}, True, "offline"),
    ({"status": "rate-limited", "okAt": None}, True, "rate limited"),
    ({"okAt": "2027-01-15T06:59:00Z"}, True, "no usage for over an hour"),
    ({}, False, "launch agent not loaded"),
])
def test_doctor_names_it_broken(uw, kw, loaded, broken):
    put_state(**kw)
    assert uw.report(uw.load_state(), NOW + 60, loaded)["broken"] == broken


def test_doctor_with_no_state_says_it_never_ran(uw):
    assert uw.report(uw.load_state(), NOW, True)["broken"] == "never ran"


def test_status_never_touches_the_keychain_or_the_network(uw):
    put_state()
    out = io.StringIO()
    with redirect_stdout(out):
        code = uw.main(["--status", "--json"], read=refuse_read, fetch=refuse_fetch, loaded=lambda: True, now=NOW + 60)
    assert code == 0
    assert json.loads(out.getvalue()) == {"status": "ok", "checkedAt": "2027-01-15T08:00:00Z",
                                          "okAt": "2027-01-15T08:00:00Z", "nextAt": "2027-01-15T08:05:00Z",
                                          "retryAt": None, "failures": 0, "http": 200, "loaded": True,
                                          "broken": None}


def test_status_lines_and_exit_codes(uw):
    put_state(status="endpoint-changed")
    out = io.StringIO()
    with redirect_stdout(out):
        assert uw.main(["--status"], loaded=lambda: True, now=NOW + 60) == 1
    assert out.getvalue() == "endpoint changed\n"
    put_state()
    out = io.StringIO()
    with redirect_stdout(out):
        assert uw.main(["--status"], loaded=lambda: True, now=NOW + 60) == 0
    assert out.getvalue() == "ok\n"


def test_now_prints_the_status(uw):
    out = io.StringIO()
    with redirect_stdout(out):
        assert uw.main(["--now"], read=keychain(), fetch=endpoint(), now=NOW) == 0
    assert out.getvalue() == "ok\n"
    out = io.StringIO()
    with redirect_stdout(out):
        assert uw.main(["--now"], read=keychain(code=44), fetch=refuse_fetch, now=NOW + 1) == 1
    assert out.getvalue() == "no-login\n"


def test_now_gives_the_keychain_time_for_a_prompt(uw):
    calls = []
    with redirect_stdout(io.StringIO()):
        uw.main(["--now"], read=keychain(calls=calls), fetch=endpoint(), now=NOW)
    assert calls[0][2] == 120
    calls.clear()
    uw.main([], read=keychain(calls=calls), fetch=endpoint(), now=NOW + 10_000)
    assert calls[0][2] == 10


def test_an_unknown_option_is_a_usage_error(uw):
    with redirect_stderr(io.StringIO()):
        assert uw.main(["--dump"], read=refuse_read, fetch=refuse_fetch) == 2


# The log, and the login staying put


def test_the_log_gets_a_line_only_when_the_status_changes(uw):
    err = io.StringIO()
    with redirect_stderr(err):
        uw.main([], read=keychain(), fetch=endpoint(500), now=NOW)
        uw.main([], read=keychain(), fetch=endpoint(500), now=NOW + 400)
        uw.main([], read=keychain(), fetch=endpoint(), now=NOW + 2000)
    assert err.getvalue().splitlines() == ["2027-01-15T08:00:00Z offline http 500",
                                           "2027-01-15T08:33:20Z ok http 200"]


def test_the_login_appears_in_no_output_and_no_file(uw):
    out, err = io.StringIO(), io.StringIO()
    calls = []
    with redirect_stdout(out), redirect_stderr(err):
        for n, code in enumerate((200, 401, 429, 500, 404, None, 302)):
            uw.main(["--now"], read=keychain(), fetch=endpoint(code, headers={"retry-after": "1"}, calls=calls),
                    now=NOW + 10 * n)
        uw.main([], read=keychain(), fetch=endpoint(calls=calls), now=NOW + 99999)
        uw.main(["--status", "--json"], loaded=lambda: True, now=NOW)
        uw.main(["--status"], loaded=lambda: True, now=NOW)
    assert len(calls) == 8
    assert LOGIN not in out.getvalue() + err.getvalue()
    for p in home().rglob("*"):
        if p.is_file():
            assert LOGIN.encode() not in p.read_bytes(), p
    assert b"refreshToken" not in b"".join(p.read_bytes() for p in home().rglob("*") if p.is_file())


# The launch agent


def test_the_launch_agent_template(uw):
    import plistlib
    text = (SCRIPT.parent.parent / "launchd" / "orchi.usage-watch.plist.template").read_text()
    text = text.replace("@ORCHI@", "/opt/orchi").replace("@HOME@", "/tmp/made-up-home").replace("@ORCHI_SETTINGS@\n", "")
    plist = plistlib.loads(text.encode())
    assert plist["Label"] == uw.LABEL == "orchi.usage-watch"
    assert plist["ProgramArguments"] == ["/usr/bin/python3", "/opt/orchi/bin/usage-watch"]
    assert plist["StartInterval"] == 300 and plist["RunAtLoad"] is True
    assert plist["ProcessType"] == "Background"
    assert plist["StandardErrorPath"] == "/tmp/made-up-home/.cache/orchi/usage-watch.log"
    assert "EnvironmentVariables" not in plist or "HTTPS_PROXY" not in plist["EnvironmentVariables"]


def test_the_real_launch_agent_check_asks_launchctl_by_label(uw, monkeypatch):
    seen = []

    def run(argv, **kw):
        seen.append(argv)
        return subprocess.CompletedProcess(argv, 0)
    monkeypatch.setattr(subprocess, "run", run)
    assert uw.agent_loaded() is True
    assert seen == [["/bin/launchctl", "print", f"gui/{os.getuid()}/orchi.usage-watch"]]


# The readers

READERS = ["bin/usage-guard", "bin/switchboard-wait", "mods/orchi/main.js", "mods/herd/main.js",
           "mods/claude-chat/commands.js"]


@pytest.mark.parametrize("reader", READERS)
def test_each_reader_reads_the_usage_cache(reader):
    text = (SCRIPT.parent.parent / reader).read_text()
    assert ".cache/orchi/usage.json" in text
    if reader == "bin/usage-guard":  # ccstatusline's file only as its optional fallback, after the usage cache
        assert text.index(".cache/orchi/usage.json") < text.index(".cache/ccstatusline/usage.json")
    else:
        assert ".cache/ccstatusline" not in text


# Found in review


def test_a_null_weekly_bucket_is_missing_not_zero(uw):
    body = {"seven_day": None, "limits": [{"kind": "weekly_all", "percent": 87, "resets_at": "2026-09-21T08:00:00Z"}]}
    out = uw.parse_usage(json.dumps(body).encode())
    assert (out["weeklyUsage"], out["weeklyResetAt"]) == (87, "2026-09-21T08:00:00+00:00")
    assert uw.parse_usage(json.dumps({"seven_day": None}).encode()) is None


def test_no_five_hour_limit_takes_no_reset_from_limits(uw):
    body = dict(ANSWER, five_hour=None, limits=[{"kind": "session", "percent": 5, "resets_at": "2026-09-19T23:00:00Z"}])
    out = uw.parse_usage(json.dumps(body).encode())
    assert out["sessionUsage"] == 0 and "sessionResetAt" not in out


@pytest.mark.parametrize("value", [-2, 150, 10 ** 400])
def test_a_usage_outside_0_to_100_is_not_a_number(uw, value):
    body = ('{"five_hour": {"utilization": %d, "resets_at": "2026-09-19T23:00:00Z"}}' % value).encode()
    assert uw.parse_usage(body) is None


@pytest.mark.parametrize("reset", ["soon", "2026-09-19", "x" * 5000, "2026-09-19T23:41:00+00:00 and more",
                                   "2026-09-19T23:41:00." + "1" * 40 + "Z"])
def test_a_reset_that_is_not_a_time_is_left_out(uw, reset):
    body = {"seven_day": {"utilization": 40, "resets_at": reset}}
    assert uw.parse_usage(json.dumps(body).encode()) == {"weeklyUsage": 40}


@pytest.mark.parametrize("damaged", [{"status": []}, {"status": "made-up"}, {"status": {"a": 1}}, [1, 2]])
def test_a_state_file_of_the_wrong_shape_reads_as_none(uw, damaged):
    cache_dir().mkdir(parents=True)
    (cache_dir() / "usage-watch.json").write_text(json.dumps(damaged))
    out = io.StringIO()
    with redirect_stdout(out):
        assert uw.main(["--status", "--json"], read=refuse_read, fetch=refuse_fetch, loaded=lambda: True, now=NOW) == 1
    assert json.loads(out.getvalue())["broken"] == "never ran"
    assert uw.run(NOW, read=keychain(), fetch=endpoint(), profile=None)["status"] == "ok"


def test_fields_of_the_wrong_type_are_dropped(uw):
    put_state(okAt=[1], checkedAt=5, nextAt={"a": 1}, failures="x", http="200")
    s = uw.load_state()
    assert s == {"status": "ok", "okAt": None, "checkedAt": None, "nextAt": None, "retryAt": None, "failures": 0,
                 "http": None}


@pytest.mark.parametrize("kind", ["fifo", "symlink", "big"])
def test_a_state_file_that_is_not_a_small_plain_file_is_not_read(uw, kind, tmp_path):
    import signal

    def stuck(*a):
        raise AssertionError("reading the state file blocked")
    cache_dir().mkdir(parents=True)
    path = cache_dir() / "usage-watch.json"
    if kind == "fifo":
        os.mkfifo(path)
    elif kind == "symlink":
        (tmp_path / "real.json").write_text(json.dumps({"status": "ok", "nextAt": "2099-01-01T00:00:00Z"}))
        os.symlink(tmp_path / "real.json", path)
    else:
        path.write_text(json.dumps({"status": "ok", "pad": "x" * 200_000}))
    old = signal.signal(signal.SIGALRM, stuck)
    signal.alarm(3)
    try:
        assert uw.load_state() is None
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old)


def test_times_are_taken_when_the_answer_comes(uw):
    times = iter([NOW, NOW + 100])
    s = uw.run(clock=lambda: next(times), force=True, read=keychain(),
               fetch=endpoint(429, headers={"retry-after": "60"}), profile=None)
    assert (s["checkedAt"], s["nextAt"]) == (uw.iso(NOW + 100), uw.iso(NOW + 160))
    times = iter([NOW + 200, NOW + 300])
    s = uw.run(clock=lambda: next(times), force=True, read=keychain(), fetch=endpoint(), profile=None)
    assert (s["okAt"], s["nextAt"], usage()["updatedAt"]) == (uw.iso(NOW + 300), uw.iso(NOW + 600), uw.iso(NOW + 300))


def test_now_goes_before_a_429_that_gave_no_retry_after(uw):
    uw.run(NOW, read=keychain(), fetch=endpoint(429), profile=None)
    assert state()["retryAt"] is None and state()["nextAt"] == "2027-01-15T08:05:00Z"
    calls = []
    assert uw.run(NOW + 10, force=True, read=keychain(), fetch=endpoint(calls=calls), profile=None)["status"] == "ok"
    assert len(calls) == 1


@pytest.mark.parametrize("kind", ["symlink", "writable by others"])
def test_a_cache_folder_that_is_not_private_is_refused(uw, kind, tmp_path):
    (home() / ".cache").mkdir()
    if kind == "symlink":
        inside = tmp_path / "elsewhere"
        inside.mkdir(mode=0o700)
        os.symlink(inside, cache_dir())
    else:
        inside = cache_dir()
        inside.mkdir()
        os.chmod(inside, 0o777)
    err = io.StringIO()
    with redirect_stderr(err):
        assert uw.main([], read=refuse_read, fetch=refuse_fetch, now=NOW) == 1
    assert err.getvalue() == f"usage-watch: {home()}/.cache/orchi is not a private folder\n"
    assert list(inside.iterdir()) == []


def test_a_value_that_is_not_utf8_is_no_login_not_a_crash(uw, monkeypatch):
    def run(argv, **kw):
        out = b"\xff\xfe\x80{}"
        return subprocess.CompletedProcess(argv, 0, stdout=out.decode() if kw.get("text") else out)
    monkeypatch.setattr(subprocess, "run", run)
    assert uw.read_login(uw.read_keychain, None, 1) == ("no-login", None)


# Found in the pull request review


def test_no_five_hour_limit_alone_is_a_changed_endpoint(uw):
    assert uw.parse_usage(json.dumps({"five_hour": None}).encode()) is None
    assert uw.outcome(200, {}, json.dumps({"five_hour": None, "renamed": {}}).encode(), NOW)[0] == "endpoint-changed"


def test_the_command_reads_the_clock_again_when_the_answer_comes(uw, monkeypatch):
    import types
    ticks = iter([NOW, NOW + 100, NOW + 100])
    monkeypatch.setattr(uw, "time", types.SimpleNamespace(time=lambda: next(ticks), strptime=uw.time.strptime))
    with redirect_stdout(io.StringIO()):
        uw.main(["--now"], read=keychain(), fetch=endpoint(429, headers={"retry-after": "60"}))
    assert (state()["checkedAt"], state()["retryAt"]) == (uw.iso(NOW + 100), uw.iso(NOW + 160))


def test_the_launch_agent_pass_due_now_is_not_skipped_by_a_second(uw):
    times = iter([NOW, NOW + 2])
    uw.run(clock=lambda: next(times), read=keychain(), fetch=endpoint(), profile=None)
    calls = []
    uw.run(NOW + 300, read=keychain(), fetch=endpoint(calls=calls), profile=None)
    assert len(calls) == 1
    assert uw.run(NOW + 330, read=refuse_read, fetch=refuse_fetch, profile=None)["checkedAt"] == uw.iso(NOW + 300)


@pytest.mark.parametrize("value", ["²", "٣٠", "1²"])
def test_a_retry_after_with_other_digits_is_unreadable(uw, value):
    assert uw.retry_after(value, NOW) is None


def test_a_retry_after_date_in_minus_0000_is_utc(uw, monkeypatch):
    import time as clock
    monkeypatch.setenv("TZ", "America/Los_Angeles")
    clock.tzset()
    try:
        when = datetime(2026, 10, 21, 7, 28, tzinfo=timezone.utc).timestamp()
        assert uw.retry_after("Wed, 21 Oct 2026 07:28:00 -0000", when - 60) == 60
    finally:
        monkeypatch.delenv("TZ")
        clock.tzset()


@pytest.mark.parametrize("given,written", [
    ("2026-09-21T08:00:00.05+0000", "2026-09-21T08:00:00+00:00"),
    ("2026-09-21T10:00:00+02:00", "2026-09-21T08:00:00+00:00"),
    ("2026-09-21T08:00Z", "2026-09-21T08:00:00+00:00"),
    ("2026-09-21T08:00:00.051388+00:00", "2026-09-21T08:00:00+00:00"),
])
def test_a_reset_time_is_written_in_one_form_every_reader_parses(uw, given, written):
    out = uw.parse_usage(json.dumps({"seven_day": {"utilization": 1, "resets_at": given}}).encode())
    assert out["weeklyResetAt"] == written
    assert datetime.fromisoformat(written).utcoffset().total_seconds() == 0


def test_a_reset_time_that_is_not_a_real_date_is_left_out(uw):
    out = uw.parse_usage(json.dumps({"seven_day": {"utilization": 1, "resets_at": "2026-13-40T08:00:00Z"}}).encode())
    assert out == {"weeklyUsage": 1}


def test_a_limit_with_no_usable_percent_is_passed_over(uw):
    body = {"limits": [
        {"kind": "weekly_all", "percent": 150, "resets_at": "2026-09-20T08:00:00Z"},
        {"kind": "weekly_all", "resets_at": "2026-09-20T09:00:00Z"},
        {"kind": "weekly_all", "percent": 40, "resets_at": "2026-09-21T08:00:00Z"},
    ]}
    assert uw.parse_usage(json.dumps(body).encode()) == {"weeklyUsage": 40, "weeklyResetAt": "2026-09-21T08:00:00+00:00"}


def test_doctor_names_a_cache_folder_that_is_not_private(uw):
    put_state()
    os.chmod(cache_dir(), 0o777)
    out = io.StringIO()
    with redirect_stdout(out):
        assert uw.main(["--status"], read=refuse_read, fetch=refuse_fetch, loaded=lambda: True, now=NOW + 60) == 1
    assert out.getvalue() == "cache folder not private\n"


def test_a_cache_folder_that_cannot_be_made_is_one_line_not_a_traceback(uw):
    (home() / ".cache").write_text("a file where the folder should be")
    err = io.StringIO()
    with redirect_stderr(err):
        assert uw.main([], read=refuse_read, fetch=refuse_fetch, now=NOW) == 1
    line, = err.getvalue().splitlines()
    assert line.startswith(f"usage-watch: {home()}/.cache/orchi: ")


# Found in the second review round


@pytest.mark.parametrize("body", [b'{"seven_day": {"utilization": 1, "resets_at": "9999-12-31T23:00:00-02:00"}}',
                                  b"[" * 100000 + b"]" * 100000])
def test_an_answer_at_the_edges_is_a_changed_endpoint_not_a_crash(uw, body):
    out = uw.parse_usage(body)
    assert out is None or out == {"weeklyUsage": 1}


def test_a_deeply_nested_state_file_reads_as_none(uw):
    cache_dir().mkdir(parents=True)
    (cache_dir() / "usage-watch.json").write_text("[" * 30000 + "]" * 30000)
    assert uw.load_state() is None


def test_the_launch_agent_pass_never_goes_before_a_retry_after(uw):
    uw.run(NOW, read=keychain(), fetch=endpoint(429, headers={"retry-after": "310"}), profile=None)
    assert uw.run(NOW + 300, read=refuse_read, fetch=refuse_fetch, profile=None)["checkedAt"] == uw.iso(NOW)


def test_a_trailing_newline_passes_no_check(uw, monkeypatch):
    value = json.dumps({"claudeAiOauth": {"accessToken": LOGIN + "\n"}})
    assert uw.read_login(keychain(value), None, 10) == ("no-login", None)
    monkeypatch.setenv("USER", "someone\n")
    assert uw.account() == "claude-code-user"
    out = uw.parse_usage(json.dumps({"seven_day": {"utilization": 1, "resets_at": "2026-09-21T08:00:00Z\n"}}).encode())
    assert out == {"weeklyUsage": 1}


def test_a_reset_time_takes_only_ascii_digits(uw):
    odd = "٢٠٢٦-09-21T08:00:00Z"
    assert uw.parse_usage(json.dumps({"seven_day": {"utilization": 1, "resets_at": odd}}).encode()) == {"weeklyUsage": 1}


def test_the_doubling_starts_over_when_the_status_changes(uw):
    uw.run(NOW, read=keychain(), fetch=endpoint(500), profile=None)
    uw.run(NOW + 400, read=keychain(), fetch=endpoint(500), profile=None)
    s = uw.run(NOW + 1100, read=keychain(), fetch=endpoint(401), profile=None)
    assert (s["failures"], s["nextAt"]) == (1, uw.iso(NOW + 1100 + 900))


def test_a_now_pass_logs_a_change_of_status_too(uw):
    err = io.StringIO()
    with redirect_stdout(io.StringIO()), redirect_stderr(err):
        uw.main(["--now"], read=keychain(), fetch=endpoint(), now=NOW)
        uw.main([], read=keychain(), fetch=endpoint(), now=NOW + 400)
    assert err.getvalue().splitlines() == ["2027-01-15T08:00:00Z ok http 200"]


@pytest.mark.parametrize("argv", [["--now", "--json"], ["--json"], ["--status", "--now"]])
def test_options_that_do_not_go_together_are_a_usage_error(uw, argv):
    with redirect_stderr(io.StringIO()), redirect_stdout(io.StringIO()):
        assert uw.main(argv, read=refuse_read, fetch=refuse_fetch, loaded=lambda: True) == 2


# Found in the third review round


@pytest.mark.parametrize("value,seconds", [("Mon, 01 Jan 99999999999999999999 00:00:00 GMT", None),
                                           ("9" * 5000, 10 ** 9)])
def test_a_retry_after_at_the_edges_is_not_a_crash(uw, value, seconds):
    assert uw.retry_after(value, NOW) == seconds
    assert uw.outcome(429, {"retry-after": value}, b"", NOW)[0] == "rate-limited"


@pytest.mark.parametrize("value", ["[" * 100000, ("[" * 100000).encode().hex()])
def test_a_deeply_nested_keychain_value_is_no_login(uw, value):
    assert uw.read_login(keychain(value), None, 10) == ("no-login", None)


def test_a_skipped_pass_reads_no_settings(uw, monkeypatch):
    put_state(nextAt="2027-01-15T09:00:00Z")
    monkeypatch.setattr(uw.orchi_settings, "profile_dir", lambda *a: (_ for _ in ()).throw(AssertionError("read")))
    assert uw.run(NOW, read=refuse_read, fetch=refuse_fetch)["status"] == "ok"
