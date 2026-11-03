"""Tests for bin/usage-guard.

The usage cache, the clock, the throttle folder and Orchi's settings are all files and variables of the test's
own, so nothing reads the real cache or settings.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "usage-guard"
NOW = 1_800_000_000.0


def stamp(seconds_away):
    return (datetime.fromtimestamp(NOW, timezone.utc) + timedelta(seconds=seconds_away)).isoformat()


class Bed:
    def __init__(self, tmp_path):
        self.tmp = tmp_path
        self.cache = tmp_path / "usage.json"
        self.settings = tmp_path / "settings.json"
        self.usage()

    def usage(self, session=10, weekly=10, fable=10, away=2 * 3600 * 24):
        self.cache.write_text(json.dumps({
            "sessionUsage": session, "sessionResetAt": stamp(3 * 3600),
            "weeklyUsage": weekly, "weeklyResetAt": stamp(away),
            "fableUsage": fable, "fableResetAt": stamp(away),
        }))
        os.utime(self.cache, (NOW, NOW))

    def set(self, value):
        self.settings.write_text(value if isinstance(value, str) else json.dumps(value))

    def run(self, *args, hook=None, own_cache=True):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("USAGE_GUARD_", "ORCHI_", "HERDR_"))}
        env.update(USAGE_GUARD_NOW=str(NOW), USAGE_GUARD_STAMPS=str(self.tmp / "stamps"),
                   ORCHI_SETTINGS=str(self.settings), HERDR_APP_HOME=str(self.tmp / "app"), HOME=str(self.tmp))
        if own_cache:
            env["USAGE_GUARD_CACHE"] = str(self.cache)
        done = subprocess.run([sys.executable, str(SCRIPT), *args], input=json.dumps(hook or {}),
                              capture_output=True, text=True, env=env, timeout=30)
        assert done.returncode == 0, done.stderr
        return done.stdout

    def verdicts(self):
        """{window: 'PAUSE' or 'ok'} from --check."""
        out = {}
        for line in self.run("--check").splitlines():
            if "->" in line:
                out[line.split(" used")[0].strip()] = line.rsplit("-> ", 1)[1]
        return out


@pytest.fixture
def bed(tmp_path):
    return Bed(tmp_path)


WINDOWS = ["5-hour window", "weekly all-models limit", "weekly Fable limit"]


def test_by_default_every_window_pauses_at_95_percent(bed):
    bed.usage(session=96, weekly=96, fable=96)
    assert bed.verdicts() == {w: "PAUSE" for w in WINDOWS}
    bed.usage(session=94, weekly=94, fable=94)
    assert bed.verdicts() == {w: "ok" for w in WINDOWS}


def test_the_setting_moves_every_window(bed):
    bed.set({"usage_guard_percent": 80})
    bed.usage(session=81, weekly=81, fable=79)
    assert bed.verdicts() == {WINDOWS[0]: "PAUSE", WINDOWS[1]: "PAUSE", WINDOWS[2]: "ok"}


def test_a_window_at_exactly_the_percent_pauses(bed):
    bed.set({"usage_guard_percent": 100})
    bed.usage(session=100, weekly=99.9, fable=10)
    assert bed.verdicts()[WINDOWS[0]] == "PAUSE"
    assert bed.verdicts()[WINDOWS[1]] == "ok"


@pytest.mark.parametrize("bad", ['{"usage_guard_percent": 0}', '{"usage_guard_percent": 101}',
                                 '{"usage_guard_percent": "high"}', "not json", ""])
def test_a_value_that_cannot_be_used_leaves_the_default(bed, bad):
    bed.set(bad)
    bed.usage(session=96, weekly=94, fable=10)
    assert bed.verdicts()[WINDOWS[0]] == "PAUSE"
    assert bed.verdicts()[WINDOWS[1]] == "ok"


def test_a_window_close_to_its_reset_is_left_alone(bed):
    bed.usage(weekly=99, away=1800)
    assert bed.verdicts()[WINDOWS[1]] == "ok"


def test_the_hook_tells_claude_to_pause_when_a_window_trips(bed):
    bed.set({"usage_guard_percent": 50})
    bed.usage(weekly=60)
    reply = json.loads(bed.run(hook={"hook_event_name": "UserPromptSubmit", "session_id": "s1"}))
    assert "weekly all-models limit is 60% used" in reply["hookSpecificOutput"]["additionalContext"]


def test_the_hook_is_silent_below_the_percent(bed):
    bed.set({"usage_guard_percent": 50})
    bed.usage(weekly=40)
    assert bed.run(hook={"hook_event_name": "UserPromptSubmit", "session_id": "s1"}) == ""


# Where the usage is read from. usage-watch writes ~/.cache/orchi/usage.json; ccstatusline's own file is only a fallback.

def write_cache(bed, folder, weekly, age=0, extra=None):
    path = bed.tmp / ".cache" / folder / "usage.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {"sessionUsage": 10, "sessionResetAt": stamp(3 * 3600), "weeklyUsage": weekly,
            "weeklyResetAt": stamp(2 * 3600 * 24), "fableUsage": 10, "fableResetAt": stamp(2 * 3600 * 24)}
    data.update(extra or {})
    path.write_text(json.dumps(data))
    os.utime(path, (NOW - age, NOW - age))
    return path


def weekly_verdict(bed):
    out = bed.run("--check", own_cache=False)
    return next((l.rsplit("-> ", 1)[1] for l in out.splitlines() if l.startswith("weekly all-models")), None)


def test_it_reads_the_cache_usage_watch_writes(bed):
    write_cache(bed, "orchi", weekly=97)
    assert weekly_verdict(bed) == "PAUSE"


def test_it_works_with_no_ccstatusline_installed(bed):
    write_cache(bed, "orchi", weekly=10)
    assert weekly_verdict(bed) == "ok"
    assert not (bed.tmp / ".cache" / "ccstatusline").exists()


def test_the_orchi_cache_wins_over_ccstatusline_when_both_are_fresh(bed):
    write_cache(bed, "orchi", weekly=10)
    write_cache(bed, "ccstatusline", weekly=99)
    assert weekly_verdict(bed) == "ok"


def test_ccstatusline_cache_is_the_fallback_when_there_is_no_orchi_cache(bed):
    write_cache(bed, "ccstatusline", weekly=97)
    assert weekly_verdict(bed) == "PAUSE"


def test_fallback_when_the_orchi_cache_is_stale(bed):
    write_cache(bed, "orchi", weekly=10, age=2 * 3600)
    write_cache(bed, "ccstatusline", weekly=97)
    assert weekly_verdict(bed) == "PAUSE"


def test_fallback_when_the_orchi_cache_holds_an_error(bed):
    write_cache(bed, "orchi", weekly=10, extra={"error": "no-login"})
    write_cache(bed, "ccstatusline", weekly=97)
    assert weekly_verdict(bed) == "PAUSE"


def test_a_cache_that_is_not_json_is_skipped(bed):
    (bed.tmp / ".cache" / "orchi").mkdir(parents=True)
    (bed.tmp / ".cache" / "orchi" / "usage.json").write_text("not json")
    os.utime(bed.tmp / ".cache" / "orchi" / "usage.json", (NOW, NOW))
    write_cache(bed, "ccstatusline", weekly=97)
    assert weekly_verdict(bed) == "PAUSE"


def write_raw(bed, folder, data):
    path = bed.tmp / ".cache" / folder / "usage.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))
    os.utime(path, (NOW, NOW))


def test_an_orchi_cache_with_no_windows_gives_way_to_the_fallback(bed):
    write_raw(bed, "orchi", {})
    write_cache(bed, "ccstatusline", weekly=97)
    assert weekly_verdict(bed) == "PAUSE"


def test_an_orchi_cache_whose_resets_have_passed_gives_way_to_the_fallback(bed):
    write_cache(bed, "orchi", weekly=99, extra={"sessionResetAt": stamp(-3600), "weeklyResetAt": stamp(-86400),
                                                "fableResetAt": stamp(-86400)})
    write_cache(bed, "ccstatusline", weekly=97)
    assert weekly_verdict(bed) == "PAUSE"


def test_an_orchi_cache_with_a_value_that_is_not_a_number_gives_way_to_the_fallback(bed):
    write_raw(bed, "orchi", {"weeklyUsage": "n/a", "weeklyResetAt": stamp(86400)})
    write_cache(bed, "ccstatusline", weekly=97)
    assert weekly_verdict(bed) == "PAUSE"


def test_a_value_that_is_not_a_number_never_stops_the_hook(bed):
    write_cache(bed, "orchi", weekly=10, extra={"weeklyUsage": "n/a", "sessionUsage": 99})
    out = bed.run("--check", own_cache=False)
    assert "5-hour window" in out and "-> PAUSE" in out.splitlines()[0]
    hook = {"hook_event_name": "UserPromptSubmit", "session_id": "s1"}
    assert "5-hour window is 99% used" in json.loads(bed.run(hook=hook, own_cache=False))[
        "hookSpecificOutput"]["additionalContext"]


def test_a_cache_that_is_not_json_is_skipped_when_it_is_fresh(bed):
    path = bed.tmp / ".cache" / "orchi" / "usage.json"
    path.parent.mkdir(parents=True)
    path.write_text("not json")
    os.utime(path, (NOW, NOW))
    write_cache(bed, "ccstatusline", weekly=97)
    assert weekly_verdict(bed) == "PAUSE"


def test_with_no_cache_anywhere_the_hook_is_silent(bed):
    assert bed.run(hook={"hook_event_name": "UserPromptSubmit", "session_id": "s1"}, own_cache=False) == ""
    assert "no usable usage cache" in bed.run("--check", own_cache=False)


def test_the_cache_path_is_named_in_one_place():
    text = SCRIPT.read_text()
    assert text.count(".cache/orchi/usage.json") == 1
    assert text.count(".cache/ccstatusline/usage.json") == 1


def test_script_is_executable():
    assert os.access(SCRIPT, os.X_OK)
