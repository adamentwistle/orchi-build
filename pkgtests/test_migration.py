"""The migration: the Linear key moves from linear.json into the keychain, and the other old values into settings.json.
docs/setup-migration.md is the spec. The keychain is the fake Mac's dict (mac_help.py); no test reaches the real one."""
import json
import os
import stat
from pathlib import Path

import pytest

from engine_help import home, snapshot  # noqa: F401
from mac_help import LINEAR_KEY, mac, run_orchi  # noqa: F401
from orchi import settings, store
from orchi.tickets import keychain
from test_setup import detail, go, settings_file

ASK = "Move your Linear API key from linear.json into the keychain?"
ASK_SAME = "Remove your Linear API key from linear.json? It is already in the keychain."
ASK_DIFFERENT = "Remove the Linear API key from linear.json? The keychain already holds a different one, which stays."
STILL = "linear.json still holds your Linear API key"
OTHER = "lin_api_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"


def linear_json(home):
    return home / ".config" / "herdr-app" / "linear.json"


def put(home, **fields):
    path = linear_json(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"apiKey": LINEAR_KEY, **fields}, indent=2) + "\n")
    return path


def mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


def backups():
    base = store.state_dir() / "backups"
    return sorted(base.glob("*")) if base.exists() else []


def copy_of(path):
    (run,) = backups()
    return run / str(path).lstrip("/")


# The key

def test_a_yes_moves_the_key_into_the_keychain_and_out_of_linear_json(mac, home):
    path = put(home, teams=["ENG"], repos={"ENG": "~/code"})
    code, report = go(["Linear key"])
    assert code == 0, report["summary"]
    assert mac.asked == [ASK]
    assert mac.keychain == {keychain.LINEAR_SERVICE: LINEAR_KEY}
    after = json.loads(path.read_text())
    assert after == {"teams": ["ENG"], "repos": {"ENG": "~/code"}}
    assert report["steps"][0]["status"] == "fixed"


def test_the_rest_of_linear_json_stays_in_its_order(mac, home):
    path = linear_json(home)
    path.parent.mkdir(parents=True)
    path.write_text('{"zeta": 1, "apiKey": "%s", "alpha": {"b": 1, "a": 2}}\n' % LINEAR_KEY)
    go(["Linear key"])
    assert list(json.loads(path.read_text())) == ["zeta", "alpha"]
    assert list(json.loads(path.read_text())["alpha"]) == ["b", "a"]


def test_the_backup_has_the_key_and_is_private(mac, home):
    path = put(home)
    path.chmod(0o644)
    go(["Linear key"])
    copy = copy_of(path)
    assert json.loads(copy.read_text())["apiKey"] == LINEAR_KEY
    assert mode(copy) == 0o600
    here, base = copy.parent, store.state_dir() / "backups"
    while True:
        assert mode(here) == 0o700, here
        if here == base:
            break
        here = here.parent


def test_the_closing_line_names_the_backup_and_how_to_undo_the_move(mac, home):
    path = put(home)
    _, report = go(["Linear key"])
    (run,) = backups()
    summary = report["summary"]
    assert str(run) in summary and "plain text" in summary and "Delete" in summary
    assert f"cp -p {copy_of(path)} {path}" in summary
    assert "security delete-generic-password -s orchi-linear" in summary


def test_linear_json_keeps_its_permissions(mac, home):
    path = put(home)
    path.chmod(0o640)
    go(["Linear key"])
    assert mode(path) == 0o640


def test_a_link_stays_a_link_and_the_file_it_points_at_is_written(mac, home, tmp_path):
    target = tmp_path / "dotfiles" / "linear.json"
    target.parent.mkdir()
    target.write_text(json.dumps({"apiKey": LINEAR_KEY, "teams": ["ENG"]}))
    link = linear_json(home)
    link.parent.mkdir(parents=True)
    link.symlink_to(target)
    code, _ = go(["Linear key"])
    assert code == 0
    assert link.is_symlink() and os.readlink(link) == str(target)
    assert json.loads(target.read_text()) == {"teams": ["ENG"]}


def test_linear_json_is_not_recorded_as_orchis_and_the_keychain_entry_is_no_record(mac, home):
    path = put(home)
    go(["Linear key"])
    owned = json.dumps(store.Store().owned())
    assert str(path) not in owned and keychain.LINEAR_SERVICE not in owned


def test_a_rerun_after_a_finished_move_changes_nothing(mac, home):
    put(home, teams=["ENG"])
    go(["Linear key"])
    mac.asked.clear()
    before = snapshot(home / ".config")
    code, report = go(["Linear key"])
    assert code == 0 and report["steps"][0]["status"] == "ok"
    assert mac.asked == [] and snapshot(home / ".config") == before and len(backups()) == 1


def test_a_clean_mac_has_nothing_to_move(mac, home):
    code, report = go(["Linear key"])
    assert code == 0 and report["steps"][0]["status"] == "ok" and mac.asked == [] and mac.calls == []


def test_a_blank_key_is_nothing_to_move(mac, home):
    path = put(home)
    path.write_text(json.dumps({"apiKey": "  "}))
    code, report = go(["Linear key"])
    assert report["steps"][0]["status"] == "ok" and mac.asked == []


def test_the_same_key_already_in_the_keychain_only_needs_the_removal(mac, home):
    path = put(home)
    mac.keychain[keychain.LINEAR_SERVICE] = LINEAR_KEY
    code, report = go(["Linear key"])
    assert code == 0 and mac.asked == [ASK_SAME]
    assert ("keychain-store", keychain.LINEAR_SERVICE) not in mac.calls
    assert "apiKey" not in json.loads(path.read_text())
    assert "delete-generic-password" not in report["summary"]


def test_a_different_key_in_the_keychain_stays_and_the_removal_is_asked(mac, home):
    path = put(home)
    mac.keychain[keychain.LINEAR_SERVICE] = OTHER
    code, _ = go(["Linear key"])
    assert code == 0 and mac.asked == [ASK_DIFFERENT]
    assert mac.keychain[keychain.LINEAR_SERVICE] == OTHER
    assert ("keychain-store", keychain.LINEAR_SERVICE) not in mac.calls
    assert "apiKey" not in json.loads(path.read_text())
    assert json.loads(copy_of(path).read_text())["apiKey"] == LINEAR_KEY


def test_a_no_changes_nothing_and_is_asked_again_each_run(mac, home):
    path = put(home)
    before = path.read_bytes()
    mac.answers = {"keychain": "No"}
    code, report = go(["Linear key"])
    assert code == 1 and report["steps"][0]["status"] == "broken" and detail(report, "Linear key") == STILL
    assert path.read_bytes() == before and mac.keychain == {} and backups() == []
    assert ("keychain-store", keychain.LINEAR_SERVICE) not in mac.calls
    go(["Linear key"])
    assert mac.asked == [ASK, ASK]


def test_a_no_to_the_removal_leaves_the_file_and_the_keychain_as_they_are(mac, home):
    path = put(home)
    mac.keychain[keychain.LINEAR_SERVICE] = OTHER
    mac.answers = {"Remove": "No"}
    code, report = go(["Linear key"])
    assert code == 1 and detail(report, "Linear key") == STILL
    assert json.loads(path.read_text())["apiKey"] == LINEAR_KEY and backups() == []


def test_doctor_names_a_key_still_in_linear_json_without_asking(mac, home):
    put(home)
    code, report = go(["Linear key"], fix=False)
    assert code == 1 and detail(report, "Linear key") == STILL and mac.asked == []


def test_with_no_terminal_it_is_broken_and_nothing_waits(mac, home):
    path = put(home)
    before = path.read_bytes()
    mac.terminal = False
    code, report = go(["Linear key"])
    assert code == 1 and "needs a terminal" in detail(report, "Linear key")
    assert path.read_bytes() == before and mac.keychain == {} and backups() == []


def test_a_keychain_write_that_fails_leaves_linear_json_alone(mac, home):
    path = put(home)
    before = path.read_bytes()
    mac.install_fails.add("keychain")
    code, report = go(["Linear key"])
    assert code == 1 and report["steps"][0]["status"] == "broken"
    assert path.read_bytes() == before and mac.keychain == {}


def test_a_read_back_that_is_empty_leaves_linear_json_alone(mac, home):
    path = put(home)
    before = path.read_bytes()
    mac.unreadable_reads = 2  # the look before the add, then the read-back
    code, report = go(["Linear key"])
    assert code == 1 and path.read_bytes() == before


def test_a_read_back_that_differs_leaves_linear_json_alone(mac, home, monkeypatch):
    path = put(home)
    before = path.read_bytes()

    def store_other(service, password):
        mac.keychain[service] = OTHER
        return True
    monkeypatch.setattr(keychain, "store_password", store_other)
    code, _ = go(["Linear key"])
    assert code == 1 and path.read_bytes() == before


def test_a_key_with_a_character_security_will_not_take_is_never_passed_on(mac, home):
    path = put(home)
    path.write_text(json.dumps({"apiKey": 'lin_api_ab"cd'}))
    before = path.read_bytes()
    code, report = go(["Linear key"])
    assert code == 1 and "quote mark" in detail(report, "Linear key")
    assert path.read_bytes() == before and mac.asked == [] and mac.keychain == {}
    assert ("keychain-store", keychain.LINEAR_SERVICE) not in mac.calls


def test_a_stop_between_the_write_and_the_removal_is_finished_by_the_next_run(mac, home, monkeypatch):
    path = put(home, teams=["ENG"])
    real = store.replace_file

    def refuse(target, *args, **kw):
        if Path(target).name == "linear.json":
            raise OSError(13, "Permission denied")
        return real(target, *args, **kw)
    monkeypatch.setattr(store, "replace_file", refuse)
    code, report = go(["Linear key"])
    assert code == 1 and "linear.json can't be written" in detail(report, "Linear key")
    assert mac.keychain == {keychain.LINEAR_SERVICE: LINEAR_KEY} and json.loads(path.read_text())["apiKey"] == LINEAR_KEY
    monkeypatch.setattr(store, "replace_file", real)
    mac.asked.clear()
    code, _ = go(["Linear key"])
    assert code == 0 and mac.asked == [ASK_SAME]
    assert json.loads(path.read_text()) == {"teams": ["ENG"]}


@pytest.mark.parametrize("text", ["{not json", "[1, 2]"])
def test_a_linear_json_that_is_not_an_object_is_left_alone_and_named(mac, home, text):
    path = linear_json(home)
    path.parent.mkdir(parents=True)
    path.write_text(text)
    code, report = go(["Linear key"])
    assert code == 1 and "linear.json" in detail(report, "Linear key")
    assert path.read_text() == text and mac.keychain == {} and mac.asked == []


def test_a_backup_that_cannot_be_taken_stops_the_step_before_anything_changes(mac, home, monkeypatch):
    path = put(home)
    before = path.read_bytes()

    def fail(self, target):
        raise store.StoreError("no room for the backup")
    monkeypatch.setattr(store.Store, "backup", fail)
    code, report = go(["Linear key"])
    assert code == 1 and "no room" in detail(report, "Linear key")
    assert path.read_bytes() == before and mac.keychain == {}
    assert ("keychain-store", keychain.LINEAR_SERVICE) not in mac.calls


def test_a_private_window_never_reaches_the_keychain(mac, home, monkeypatch, tmp_path):
    put(home)
    private = tmp_path / "private-herdr"
    private.mkdir()
    (private / "linear.json").write_text(json.dumps({"apiKey": LINEAR_KEY}))
    monkeypatch.setenv("HERDR_APP_HOME", str(private))
    code, report = go(["Linear key"])
    assert code == 0 and report["steps"][0]["status"] == "ok"
    assert mac.asked == [] and mac.calls == [] and mac.keychain == {}


def test_the_test_home_is_the_only_linear_json_the_step_can_see(mac, home, tmp_path):
    assert Path(settings.old_dir()) == home / ".config" / "herdr-app"
    assert str(tmp_path) in str(linear_json(home)) and str(Path.home()) == str(home)
    assert store.state_dir() == home / ".local" / "state" / "orchi"


def test_the_key_is_in_no_report_summary_error_or_state_file_except_the_backup(mac, home, capsys):
    put(home)
    code, report, out = run_orchi()
    seen = capsys.readouterr()
    everything = out + seen.out + seen.err
    assert LINEAR_KEY not in everything and LINEAR_KEY not in json.dumps(report)
    for found in (store.state_dir()).rglob("*"):
        if found.is_file() and "backups" not in found.parts:
            assert LINEAR_KEY not in found.read_text(errors="ignore"), found
    assert LINEAR_KEY not in json.dumps(mac.envs)


def test_the_key_is_in_no_message_when_the_move_fails(mac, home):
    put(home)
    mac.install_fails.add("keychain")
    _, report, out = run_orchi()
    assert LINEAR_KEY not in out


def test_the_linear_step_then_finds_the_key_in_the_keychain_and_does_not_ask_for_it(mac, home):
    put(home)
    mac.settings(sources=["legwork", "linear"])
    code, report = go(["Linear key", "Linear"])
    assert code == 0, report["summary"]
    assert "Linear API key" not in mac.asked


def test_a_run_that_says_no_to_the_move_leaves_linear_to_say_the_key_is_still_there(mac, home):
    put(home)
    mac.settings(sources=["legwork", "linear"])
    mac.answers = {"keychain": "No"}
    _, report = go(["Linear key", "Linear"])
    assert detail(report, "Linear") == "the key is still in linear.json"


# The other values

def old_files(home, worker=None, **linear):
    folder = home / ".config" / "herdr-app"
    folder.mkdir(parents=True, exist_ok=True)
    if worker is not None:
        (folder / "orchi.json").write_text(json.dumps({"workerLimit": worker}))
    if linear:
        (folder / "linear.json").write_text(json.dumps(linear))


def test_the_old_values_move_into_settings_json(mac, home):
    old_files(home, worker=9, teams=["eng", "ops"], repos={"eng": "~/code/eng"},
              legwork={"dir": "~/legwork", "projects": {"p1": "alpha"}})
    code, report = go(["Old settings"])
    assert code == 0, report["summary"]
    assert settings_file() == {"worker_limit": 9, "legwork_dir": "~/legwork",
                               "linear": {"teams": ["ENG", "OPS"], "repos": {"ENG": "~/code/eng"},
                                          "legwork_projects": {"p1": "alpha"}}}
    assert mac.asked == []


def test_the_effective_settings_do_not_change(mac, home):
    old_files(home, worker=9, teams=["eng"], repos={"eng": "~/code/eng"}, legwork={"dir": "~/legwork"})
    before = settings.read()
    go(["Old settings"])
    assert settings.read() == before


def test_a_value_settings_json_already_sets_is_not_replaced(mac, home):
    old_files(home, worker=9, teams=["eng"], repos={"eng": "~/code/eng"})
    mac.settings(worker_limit=3, linear={"teams": ["OPS"]})
    go(["Old settings"])
    assert settings_file() == {"worker_limit": 3, "linear": {"teams": ["OPS"], "repos": {"ENG": "~/code/eng"}}}


def test_an_invalid_old_value_is_dropped_not_copied(mac, home):
    old_files(home, worker=999, teams=["", 4], legwork={"dir": "relative/dir"})
    code, report = go(["Old settings"])
    assert code == 0 and report["steps"][0]["status"] == "ok" and not Path(settings.path()).exists()


def test_a_value_equal_to_the_default_is_not_copied(mac, home):
    old_files(home, worker=settings.WORKER_LIMIT[2])
    code, report = go(["Old settings"])
    assert report["steps"][0]["status"] == "ok" and not Path(settings.path()).exists()


def test_a_missing_settings_json_is_made_and_recorded_as_orchis(mac, home):
    old_files(home, worker=9)
    go(["Old settings"])
    assert store.Store().owns(settings.path())
    assert backups() == []


def test_a_settings_json_orchi_did_not_make_is_backed_up_first(mac, home):
    old_files(home, worker=9)
    mac.settings(sources=["legwork"])
    go(["Old settings"])
    assert json.loads(copy_of(settings.path()).read_text()) == {"sources": ["legwork"]}
    assert settings_file() == {"sources": ["legwork"], "worker_limit": 9}


def test_a_settings_json_that_is_not_json_is_named_and_left_alone(mac, home):
    old_files(home, worker=9)
    path = Path(settings.path())
    path.parent.mkdir(parents=True)
    path.write_text("{oops")
    code, report = go(["Old settings"])
    assert code == 1 and "settings.json" in detail(report, "Old settings")
    assert path.read_text() == "{oops"


def test_a_rerun_of_the_old_values_changes_nothing_and_the_old_files_stay(mac, home):
    old_files(home, worker=9, teams=["eng"])
    old = {n: (home / ".config" / "herdr-app" / n).read_bytes() for n in ("orchi.json", "linear.json")}
    go(["Old settings"])
    before = snapshot(home / ".config")
    code, report = go(["Old settings"])
    assert code == 0 and report["steps"][0]["status"] == "ok" and snapshot(home / ".config") == before
    assert {n: (home / ".config" / "herdr-app" / n).read_bytes() for n in old} == old


def test_a_linear_group_that_is_not_an_object_is_broken_not_written_over(mac, home):
    old_files(home, teams=["eng"])
    mac.settings(linear="nope")
    code, report = go(["Old settings"])
    assert code == 1 and report["steps"][0]["status"] == "broken"
    assert settings_file() == {"linear": "nope"}


def test_a_full_run_walks_the_migration_with_the_key_and_the_old_values(mac, home):
    old_files(home, worker=9)
    put(home, teams=["eng"])
    code, report, out = run_orchi()
    assert code == 0, report["summary"]
    assert mac.keychain == {keychain.LINEAR_SERVICE: LINEAR_KEY}
    assert LINEAR_KEY not in out
    code, report, _ = run_orchi()
    assert code == 0 and not report["changed"]


# Review findings

def test_a_yes_that_fails_still_warns_that_the_backup_holds_the_key(mac, home):
    put(home)
    mac.install_fails.add("keychain")
    _, report = go(["Linear key"])
    (run,) = backups()
    assert str(run) in report["summary"] and "plain text" in report["summary"] and "Delete" in report["summary"]
    assert "To undo" not in report["summary"]


def test_a_settings_json_that_is_a_link_stays_a_link_and_its_target_is_written(mac, home, tmp_path):
    old_files(home, worker=9)
    target = tmp_path / "dotfiles" / "settings.json"
    target.parent.mkdir()
    target.write_text(json.dumps({"sources": ["legwork"]}))
    target.chmod(0o600)
    link = Path(settings.path())
    link.parent.mkdir(parents=True)
    link.symlink_to(target)
    code, _ = go(["Old settings"])
    assert code == 0 and link.is_symlink() and os.readlink(link) == str(target)
    assert json.loads(target.read_text()) == {"sources": ["legwork"], "worker_limit": 9}
    assert mode(target) == 0o600


@pytest.mark.parametrize("key, kind", [("lin_api_ab cd", "space"), ('lin_api_ab"cd', "quote"), ("lin_api_ab\\cd", "backslash"),
                                       ("lin_api_abé", "letter"), ("lin_api_ab$cd", "symbol")])
def test_a_key_security_will_not_take_is_refused_with_the_kind_of_character(mac, home, key, kind):
    put(home).write_text(json.dumps({"apiKey": key}))
    _, report = go(["Linear key"])
    message = detail(report, "Linear key")
    assert kind in message and key not in message
