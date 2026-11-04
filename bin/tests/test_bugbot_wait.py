"""Tests for bin/bugbot-wait: a verdict counts only when it comes from Bugbot itself.

gh is replaced by a stub on PATH that answers from a JSON file the test writes.
Identities are Bugbot's real ones: reviews and inline comments by
"cursor[bot]" (type Bot), check run by app slug "cursor". The GraphQL call
that finds out whether Bugbot is enabled on the repo sees the same App user as
login "cursor" with __typename Bot.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "bugbot-wait"
REPO = "acme/web"
AFTER = "2026-10-01T00:00:00Z"
HEAD = "abc1234def5678"

STUB = r'''#!/usr/bin/env python3
import json, os, sys
data = json.load(open(os.environ["GH_FIXTURE"]))
args = sys.argv[1:]
if os.environ.get("GH_LOG"):
    with open(os.environ["GH_LOG"], "a") as f:
        f.write(json.dumps(args) + "\n")
key = " ".join(a for a in args if not a.startswith("-"))
for pattern, out in data.items():
    if pattern in key:
        print(out if isinstance(out, str) else json.dumps(out))
        sys.exit(0)
print("no fixture for " + key, file=sys.stderr)
sys.exit(1)
'''

BOT = {"login": "cursor[bot]", "type": "Bot", "id": 206951365}
CLEAN = "<!-- BUGBOT_REVIEW -->\nBugbot reviewed for commit abc1234 and found no new issues."
FINDINGS = "<!-- BUGBOT_REVIEW -->\nBugbot found 1 issue for commit abc1234."
GQL_BOT = {"__typename": "Bot", "login": "cursor"}


def seen(authors=(), suites=()):
    """One pull request as the detection query returns it. suites: (app slug, [check run names])."""
    return {"reviews": {"nodes": [{"author": a} for a in authors]},
            "commits": {"nodes": [{"commit": {"checkSuites": {"nodes": [
                {"app": {"slug": slug}, "checkRuns": {"nodes": [{"name": n} for n in names]}}
                for slug, names in suites]}}}]}}


def detect(current=None, recent=()):
    return {"data": {"repository": {"current": current, "recent": {"nodes": list(recent)}}}}


ENABLED = detect(recent=[seen(authors=[GQL_BOT])])


def review(user, body=CLEAN, at="2026-10-02T10:00:00Z"):
    return {"user": user, "body": body, "submitted_at": at}


def run(user=None, name="Cursor Bugbot", slug="cursor", summary="Bugbot no issues found"):
    return {"name": name, "status": "completed", "conclusion": "success",
            "completed_at": "2026-10-02T10:00:00Z", "app": {"slug": slug},
            "output": {"summary": summary}}


@pytest.fixture
def bw(tmp_path):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    stub = bindir / "gh"
    stub.write_text(STUB)
    stub.chmod(0o755)
    fixture = tmp_path / "gh.json"
    log = tmp_path / "gh.log"

    def call(reviews=(), comments=(), runs=(), graphql=ENABLED, trigger=False):
        log.write_text("")
        fixture.write_text(json.dumps({
            "api graphql": graphql,
            f"api repos/{REPO}/pulls/7/reviews": [list(reviews)],
            f"api repos/{REPO}/pulls/7/comments": [list(comments)],
            f"api repos/{REPO}/commits/{HEAD}/check-runs": {"check_runs": list(runs)},
            "pr view 7": {"headRefOid": HEAD},
        }))
        env = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}", GH_FIXTURE=str(fixture),
                   GH_LOG=str(log))
        p = subprocess.run([sys.executable, str(SCRIPT), "7", "--repo", REPO, "--after", AFTER,
                            "--timeout", "0", "--interval", "1", *(["--trigger"] if trigger else [])],
                           capture_output=True, text=True, env=env, timeout=30)
        call.calls = [json.loads(line) for line in log.read_text().splitlines()]
        return p.returncode, json.loads(p.stdout)
    return call


def test_clean_review_from_bugbot_is_clear(bw):
    rc, out = bw(reviews=[review(BOT)])
    assert (rc, out["state"]) == (0, "CLEAR")


def test_clean_review_from_a_lookalike_user_is_ignored(bw):
    rc, out = bw(reviews=[review({"login": "cursor-fan", "type": "User", "id": 1})])
    assert (rc, out["state"]) == (2, "TIMEOUT")


def test_review_named_cursor_bot_but_typed_user_is_ignored(bw):
    rc, out = bw(reviews=[review({"login": "cursor[bot]", "type": "User", "id": 1})])
    assert (rc, out["state"]) == (2, "TIMEOUT")


def test_findings_list_only_bugbot_comments(bw):
    comments = [
        {"user": BOT, "path": "a.py", "line": 3, "body": "real", "html_url": "u1",
         "created_at": "2026-10-02T10:00:00Z"},
        {"user": {"login": "bugbot-helper", "type": "User", "id": 2}, "path": "b.py", "line": 1,
         "body": "fake", "html_url": "u2", "created_at": "2026-10-02T10:00:00Z"},
    ]
    rc, out = bw(reviews=[review(BOT, FINDINGS)], comments=comments)
    assert rc == 1 and out["state"] == "FINDINGS"
    assert [c["body"] for c in out["comments"]] == ["real"]


def test_check_run_from_the_cursor_app_is_clear(bw):
    rc, out = bw(runs=[run()])
    assert (rc, out["state"], out["source"]) == (0, "CLEAR", "check_run")


def test_check_run_named_cursor_bugbot_from_another_app_is_ignored(bw):
    rc, out = bw(runs=[run(slug="github-actions")])
    assert (rc, out["state"]) == (2, "TIMEOUT")


def test_bugbot_review_on_a_recent_pull_request_means_enabled(bw):
    rc, out = bw(reviews=[review(BOT)])
    assert (rc, out["state"]) == (0, "CLEAR")
    query = bw.calls[0]
    assert query[:2] == ["api", "graphql"]
    assert {"owner=acme", "name=web", "pr=7"} <= set(query)


def test_bugbot_check_run_on_a_recent_pull_request_means_enabled(bw):
    rc, out = bw(reviews=[review(BOT)],
                 graphql=detect(recent=[seen(), seen(suites=[("cursor", ["Cursor Bugbot"])])]))
    assert (rc, out["state"]) == (0, "CLEAR")


def test_bugbot_on_the_current_pull_request_means_enabled(bw):
    rc, out = bw(reviews=[review(BOT)],
                 graphql=detect(current=seen(suites=[("cursor", ["Cursor Bugbot"])]), recent=[seen()]))
    assert (rc, out["state"]) == (0, "CLEAR")


def test_detection_filters_to_bugbot_before_the_page_limit(bw):
    bw(reviews=[review(BOT)])
    query = next(a for a in bw.calls[0] if a.startswith("query="))
    assert re.search(r'reviews\(first: \d+, author: "cursor\[bot\]"\)', query)
    assert re.search(r'checkSuites\(first: \d+, filterBy: \{checkName: "Cursor Bugbot"\}\)', query)


def test_lookalikes_do_not_mean_enabled(bw):
    lookalike = seen(authors=[{"__typename": "User", "login": "cursor"},
                              {"__typename": "Bot", "login": "cursor-fan"}],
                     suites=[("github-actions", ["Cursor Bugbot"]), ("cursor", ["Cursor Review"])])
    rc, out = bw(reviews=[review(BOT)], graphql=detect(current=lookalike, recent=[lookalike]))
    assert (rc, out["state"]) == (4, "NO_BUGBOT")


def test_no_bugbot_found_stops_before_posting(bw):
    rc, out = bw(reviews=[review(BOT)], graphql=detect(current=seen(), recent=[seen(), seen()]), trigger=True)
    assert (rc, out["state"]) == (4, "NO_BUGBOT")
    assert out["reason"] == ("Bugbot is not enabled on acme/web: no Cursor Bugbot check or review "
                             "on this pull request or the last 20")
    assert [c[:2] for c in bw.calls] == [["api", "graphql"]]


def test_it_runs_the_gh_command_orchi_settings_name(tmp_path):
    # The smoke test's repo was visible only to the account behind gh-personal, and plain gh failed with exit 3.
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "gh").write_text("#!/bin/sh\necho 'Could not resolve to a Repository' >&2\nexit 1\n")
    (bindir / "gh-other").write_text(STUB)
    for stub in bindir.iterdir():
        stub.chmod(0o755)
    fixture = tmp_path / "gh.json"
    fixture.write_text(json.dumps({"api graphql": ENABLED, f"api repos/{REPO}/pulls/7/reviews": [[review(BOT)]],
                                   f"api repos/{REPO}/pulls/7/comments": [[]], "pr view 7": {"headRefOid": HEAD},
                                   f"api repos/{REPO}/commits/{HEAD}/check-runs": {"check_runs": []}}))
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"github": {"command": "gh-other"}}))
    env = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}", GH_FIXTURE=str(fixture),
               ORCHI_SETTINGS=str(settings), HOME=str(tmp_path))
    p = subprocess.run([sys.executable, str(SCRIPT), "7", "--repo", REPO, "--after", AFTER, "--timeout", "0"],
                       capture_output=True, text=True, env=env, timeout=30)
    assert (p.returncode, json.loads(p.stdout)["state"]) == (0, "CLEAR"), p.stdout


def test_a_gh_command_that_is_not_there_is_a_gh_error(tmp_path):
    # From the review: a missing program crashed with exit 1, which callers read as FINDINGS.
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"github": {"command": "gh-not-installed-anywhere"}}))
    env = dict(os.environ, ORCHI_SETTINGS=str(settings), HOME=str(tmp_path))
    p = subprocess.run([sys.executable, str(SCRIPT), "7", "--repo", REPO, "--after", AFTER, "--timeout", "0"],
                       capture_output=True, text=True, env=env, timeout=30)
    assert p.returncode == 3, p.stderr
    assert json.loads(p.stdout)["state"] == "ERROR"


def test_the_gh_command_is_read_once_for_the_whole_wait(tmp_path):
    # From the review: a settings edit in the middle of a wait must not switch accounts between calls.
    bindir = tmp_path / "bin"
    bindir.mkdir()
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"github": {"command": "gh-other"}}))
    (bindir / "gh").write_text("#!/bin/sh\necho 'wrong account' >&2\nexit 1\n")
    (bindir / "gh-other").write_text(STUB.replace(
        "args = sys.argv[1:]",
        "args = sys.argv[1:]\nopen(os.environ['ORCHI_SETTINGS'], 'w').write('{\"github\": {\"command\": \"gh\"}}')"))
    for stub in bindir.iterdir():
        stub.chmod(0o755)
    fixture = tmp_path / "gh.json"
    fixture.write_text(json.dumps({"api graphql": ENABLED, f"api repos/{REPO}/pulls/7/reviews": [[review(BOT)]],
                                   f"api repos/{REPO}/pulls/7/comments": [[]], "pr view 7": {"headRefOid": HEAD},
                                   f"api repos/{REPO}/commits/{HEAD}/check-runs": {"check_runs": []}}))
    env = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}", GH_FIXTURE=str(fixture),
               ORCHI_SETTINGS=str(settings), HOME=str(tmp_path))
    p = subprocess.run([sys.executable, str(SCRIPT), "7", "--repo", REPO, "--after", AFTER, "--timeout", "0"],
                       capture_output=True, text=True, env=env, timeout=30)
    assert (p.returncode, json.loads(p.stdout)["state"]) == (0, "CLEAR"), p.stdout
