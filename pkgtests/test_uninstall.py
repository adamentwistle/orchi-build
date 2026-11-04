"""orchi uninstall, after a whole fake setup on the fake Mac (mac_help.py), in a private home. Nothing here touches the
real home, Herdr, launchd or the keychain."""
import json
import os
from pathlib import Path

import pytest

from engine_help import home, snapshot  # noqa: F401
from mac_help import mac, run_orchi  # noqa: F401
from orchi import cli, store
from orchi.tickets import keychain

KEEP = ("keep me\n",)


def tree(root, skip=()):
    """What is under root, by path: a file's bytes, a link's target, or that it is a folder. No times."""
    return {path: what for path, (what, *_) in snapshot(root).items()
            if not any(path == s or path.startswith(s + "/") for s in skip)}


def state_of(home):
    return str(store.state_dir().relative_to(home))


def apart(home):
    """What a comparison leaves out: the state folder, and the user's keys.json, which setup adds Orchi's keys to."""
    return (state_of(home), ".config/herdr-app/keys.json")


def still(home):
    """Everything under home with its times, except the lock, which a run rewrites with its pid."""
    return {p: v for p, v in snapshot(home).items() if p != f"{state_of(home)}/lock"}


def user_files(home):
    """Things that are the user's, in folders Orchi installs into."""
    files = {
        home / ".claude" / "skills" / "mine" / "SKILL.md": "my skill\n",
        home / ".claude" / "commands" / "mine.md": "my command\n",
        home / ".config" / "herdr-app" / "themes" / "mine.json": "{}\n",
        home / ".config" / "herdr-app" / "mods" / "mine" / "mod.json": "{}\n",
        home / ".local" / "bin" / "my-tool": "#!/bin/sh\n",
        home / ".config" / "herdr-app" / "keys.json": '{"mine": {"x": "y"}}\n',
    }
    for path, text in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return files


@pytest.fixture
def setup_done(mac, home):
    """A Mac that has been through a whole setup, with the user's own files around it, before and after."""
    mac.everything()
    mac.answers = {"Also read": "No"}
    mine = user_files(home)
    before = tree(home, skip=apart(home))
    code, report, _ = run_orchi()
    assert code == 0, report["summary"]
    mac.calls.clear()
    mac.asked.clear()
    return mac, home, before, mine


def uninstall(capsys, *args):
    code = cli.main(["uninstall", *args])
    return code, capsys.readouterr().out


def owned_paths(home):
    return {r["path"] for r in json.loads((store.state_dir() / "owned.json").read_text())["owned"]}


def test_after_a_whole_setup_uninstall_leaves_nothing_of_orchis_and_everything_of_the_users(setup_done, capsys):
    mac, home, before, mine = setup_done
    owned = owned_paths(home)
    assert len(owned) > 50
    assert (home / "Library" / "LaunchAgents" / "orchi.usage-watch.plist").exists() and mac.loaded
    code, out = uninstall(capsys, "--yes")
    assert code == 0, out
    after = tree(home, skip=apart(home))
    assert after == before
    assert not any(os.path.lexists(p) for p in owned)
    for path, text in mine.items():
        if path.name != "keys.json":
            assert path.read_text() == text
    # A file of the user's that Orchi added to stays as it is, and the copy from before is in the backups.
    assert json.loads((home / ".config" / "herdr-app" / "keys.json").read_text())["mine"] == {"x": "y"}
    assert list(store.state_dir().glob("backups/*/**/keys.json"))


def test_the_launch_agent_is_unloaded_before_its_file_goes(setup_done, capsys):
    mac, home, *_ = setup_done
    uninstall(capsys, "--yes")
    assert mac.loaded is False
    domain = f"gui/{os.getuid()}/orchi.usage-watch"
    assert [c for c in mac.calls if c[0] == "launchctl"] == [("launchctl", "print", domain), ("launchctl", "bootout", domain)]
    assert not (home / "Library" / "LaunchAgents" / "orchi.usage-watch.plist").exists()


def test_it_says_what_it_removed_and_what_it_kept_and_how_to_remove_the_command(setup_done, capsys):
    mac, home, *_ = setup_done
    code, out = uninstall(capsys, "--yes")
    lines = out.splitlines()
    assert lines[0].startswith("Removed ") and "files" in lines[0] and "folders" in lines[0]
    assert "launch agent" in lines[0]
    assert any(line.strip().startswith("~/.local/state/orchi/backups") for line in lines)
    assert lines[-1] == "To remove the orchi command: uv tool uninstall orchi"
    assert not mac.program("uv")


def test_backups_the_keychain_entry_and_the_usage_cache_are_kept_and_listed(setup_done, capsys):
    mac, home, *_ = setup_done
    (home / ".cache" / "orchi").mkdir(parents=True)
    (home / ".cache" / "orchi" / "usage.json").write_text("{}")
    mac.keychain[keychain.LINEAR_SERVICE] = "a-key"
    code, out = uninstall(capsys, "--yes")
    assert (home / ".cache" / "orchi" / "usage.json").exists()
    assert mac.keychain == {keychain.LINEAR_SERVICE: "a-key"}
    assert not [c for c in mac.calls if c[0] == "keychain-delete" or c[0] == "keychain-store"]
    assert "keychain" in out and "orchi-linear" in out
    assert "usage" in out and ".cache/orchi" in out
    assert "a-key" not in out


def test_without_a_keychain_entry_it_does_not_mention_the_keychain(setup_done, capsys):
    code, out = uninstall(capsys, "--yes")
    assert "keychain" not in out


def test_a_file_the_user_changed_is_kept_and_named_and_the_rest_goes(setup_done, capsys):
    mac, home, before, mine = setup_done
    theme = next((home / ".config" / "herdr-app" / "themes").glob("orchi*.json"))
    theme.write_text(theme.read_text() + "\n")
    code, out = uninstall(capsys, "--yes")
    assert code == 0
    assert theme.exists() and theme.read_text().endswith("\n\n")
    assert any(str(theme.relative_to(home)) in line and "changed" in line for line in out.splitlines() if line.startswith(" "))
    # What it can't take away stays with the folders that hold it.
    assert theme.parent.is_dir() and theme.parent.parent.is_dir()
    remaining = set(tree(home, skip=apart(home))) - set(before)
    assert remaining == {str(theme.relative_to(home))}


def test_a_user_edited_settings_file_is_kept_and_an_unedited_one_goes(setup_done, capsys):
    mac, home, *_ = setup_done
    settings_file = home / ".config" / "orchi" / "settings.json"
    assert settings_file.exists()
    settings_file.write_text(settings_file.read_text().replace("{", '{\n  "worker_limit": 3,', 1))
    code, out = uninstall(capsys, "--yes")
    assert settings_file.exists() and '"worker_limit": 3' in settings_file.read_text()
    assert ".config/orchi/settings.json" in out


def test_a_settings_file_orchi_made_and_nobody_changed_goes(setup_done, capsys):
    mac, home, *_ = setup_done
    settings_file = home / ".config" / "orchi" / "settings.json"
    assert settings_file.exists()
    uninstall(capsys, "--yes")
    assert not settings_file.exists() and not settings_file.parent.exists()


def test_a_link_the_user_pointed_somewhere_else_is_kept(setup_done, capsys):
    mac, home, *_ = setup_done
    link = next(p for p in (home / ".claude" / "skills").iterdir() if p.is_symlink())
    target = link.resolve()
    link.unlink()
    link.symlink_to(home)
    code, out = uninstall(capsys, "--yes")
    assert link.is_symlink() and os.readlink(link) == str(home)
    assert str(link.relative_to(home)) in out
    assert target.exists()


def test_a_folder_that_holds_something_else_is_kept(setup_done, capsys):
    mac, home, *_ = setup_done
    folder = home / ".config" / "herdr-app" / "sounds"
    (folder / "mine.mp3").write_text("x")
    code, out = uninstall(capsys, "--yes")
    assert (folder / "mine.mp3").exists()
    assert str(folder.relative_to(home)) in out and "holds" in out


def test_a_file_the_user_deleted_is_not_a_problem(setup_done, capsys):
    mac, home, before, _ = setup_done
    next((home / ".config" / "herdr-app" / "themes").glob("orchi*.json")).unlink()
    code, out = uninstall(capsys, "--yes")
    assert code == 0 and tree(home, skip=apart(home)) == before


def test_a_launch_agent_file_the_user_changed_is_kept_and_stays_loaded(setup_done, capsys):
    mac, home, *_ = setup_done
    plist = home / "Library" / "LaunchAgents" / "orchi.usage-watch.plist"
    plist.write_text(plist.read_text() + "<!-- mine -->\n")
    code, out = uninstall(capsys, "--yes")
    assert plist.exists() and mac.loaded is True
    assert not mac.program("launchctl", "bootout")
    assert "Library/LaunchAgents/orchi.usage-watch.plist" in out


def test_a_launch_agent_that_will_not_unload_keeps_its_file(setup_done, capsys):
    mac, home, *_ = setup_done
    plist = home / "Library" / "LaunchAgents" / "orchi.usage-watch.plist"
    real = mac.launchctl

    def stuck(argv, done):
        return done(5, "Boot-out failed") if argv[1] == "bootout" else real(argv, done)

    mac.launchctl = stuck
    code, out = uninstall(capsys, "--yes")
    assert code == 1 and plist.exists() and mac.loaded is True
    assert "launch agent" in out and "could not" in out.lower()


# Asking

def test_it_asks_once_before_removing_anything(setup_done, capsys):
    mac, home, before, _ = setup_done
    mac.answers = {"Remove": "No"}
    code, out = uninstall(capsys)
    assert len(mac.asked) == 1 and mac.asked[0].startswith("Remove ") and "launch agent" in mac.asked[0]
    assert code == 0 and "Nothing removed" in out
    assert mac.loaded is True and not mac.program("launchctl", "bootout")
    assert tree(home, skip=apart(home)) != before
    mac.answers = {"Remove": "Yes"}
    mac.asked.clear()
    code, out = uninstall(capsys)
    assert len(mac.asked) == 1 and code == 0
    assert tree(home, skip=apart(home)) == before


def test_yes_removes_without_asking(setup_done, capsys):
    mac, *_ = setup_done
    uninstall(capsys, "--yes")
    assert mac.asked == []


def test_with_no_terminal_and_no_yes_nothing_is_removed(setup_done, capsys):
    mac, home, before, _ = setup_done
    mac.terminal = False
    code, out = uninstall(capsys)
    assert code == 1 and out.splitlines()[0] == "Nothing removed. Run it at a terminal, or with --yes."
    assert tree(home, skip=apart(home)) != before and mac.loaded is True


def test_with_nothing_to_remove_it_asks_nothing(setup_done, capsys):
    mac, *_ = setup_done
    uninstall(capsys, "--yes")
    mac.asked.clear()
    code, out = uninstall(capsys)
    assert code == 0 and mac.asked == []
    assert out.splitlines()[0] == "Nothing to remove."
    assert out.splitlines()[-1] == "To remove the orchi command: uv tool uninstall orchi"


def test_a_rerun_changes_nothing(setup_done, capsys):
    mac, home, *_ = setup_done
    uninstall(capsys, "--yes")
    after_first = still(home)
    mac.calls.clear()
    code, out = uninstall(capsys, "--yes")
    assert code == 0 and out.startswith("Nothing to remove.")
    assert still(home) == after_first
    assert not mac.program("launchctl", "bootout")


def test_a_rerun_after_a_kept_file_changes_nothing_either(setup_done, capsys):
    mac, home, *_ = setup_done
    theme = next((home / ".config" / "herdr-app" / "themes").glob("orchi*.json"))
    theme.write_text("mine")
    uninstall(capsys, "--yes")
    after_first = still(home)
    code, out = uninstall(capsys, "--yes")
    assert code == 0 and "Nothing to remove." in out and str(theme.relative_to(home)) in out
    assert still(home) == after_first


def test_before_any_setup_there_is_nothing_to_remove_and_nothing_is_made(mac, home, capsys):
    code, out = uninstall(capsys, "--yes")
    assert code == 0 and out.splitlines()[0] == "Nothing to remove."
    assert not store.state_dir().exists()


def test_it_waits_for_no_one_while_a_run_holds_the_lock(setup_done, capsys):
    mac, home, before, _ = setup_done
    with store.Store().lock():
        code, out = uninstall(capsys, "--yes")
    assert code == 1 and out.startswith("Another orchi run is going")
    assert tree(home, skip=apart(home)) != before


def test_json_gives_one_object_with_what_went_and_what_stayed(setup_done, capsys):
    mac, home, *_ = setup_done
    theme = next((home / ".config" / "herdr-app" / "themes").glob("orchi*.json"))
    theme.write_text("mine")
    code, out = uninstall(capsys, "--json", "--yes")
    report = json.loads(out)
    assert code == 0 and report["command"] == "uninstall" and report["ok"] is True
    assert report["removed"]["files"] > 20 and report["removed"]["launch_agent"] is True
    assert {"path": str(theme), "why": "you changed it"} in report["kept"]
    assert report["summary"].splitlines()[0].startswith("Removed ")


def test_it_runs_on_any_system_since_it_only_reads_the_records(setup_done, capsys):
    mac, home, before, _ = setup_done
    mac.platform = "linux"
    code, out = uninstall(capsys, "--yes")
    assert code == 0 and tree(home, skip=apart(home)) == before


def test_a_private_home_run_that_made_no_launch_agent_does_not_call_launchctl(mac, home, capsys, monkeypatch):
    mac.everything()
    mac.answers = {"Also read": "No"}
    monkeypatch.setenv("HERDR_APP_HOME", str(home / "private-herdr"))
    mac.settings(claude_dir=str(home / "private-claude"))
    run_orchi()
    mac.calls.clear()
    code, out = uninstall(capsys, "--yes")
    assert code == 0
    assert not [c for c in mac.calls if c[0] == "launchctl"]


# From the adversarial review

def test_a_launch_agent_whose_file_was_deleted_by_hand_is_still_unloaded(setup_done, capsys):
    mac, home, *_ = setup_done
    (home / "Library" / "LaunchAgents" / "orchi.usage-watch.plist").unlink()
    code, out = uninstall(capsys, "--yes")
    assert code == 0 and mac.loaded is False
    assert mac.program("launchctl", "bootout")
    uninstall(capsys, "--yes")
    assert not [r for r in json.loads((store.state_dir() / "owned.json").read_text())["owned"] if "usage-watch" in r["path"]]


@pytest.mark.parametrize("code", [124, 1])
def test_a_launchctl_print_that_fails_for_another_reason_than_not_loaded_keeps_the_file(setup_done, capsys, code):
    mac, home, *_ = setup_done
    plist = home / "Library" / "LaunchAgents" / "orchi.usage-watch.plist"
    real = mac.launchctl
    mac.launchctl = lambda argv, done: done(code, "") if argv[1] == "print" else real(argv, done)
    status, out = uninstall(capsys, "--yes")
    assert status == 1 and plist.exists() and mac.loaded is True
    assert not mac.program("launchctl", "bootout")
    assert "launch agent" in out


def test_a_plist_replaced_while_the_question_is_open_is_not_unloaded(setup_done, capsys, monkeypatch):
    mac, home, *_ = setup_done
    plist = home / "Library" / "LaunchAgents" / "orchi.usage-watch.plist"
    asked = mac.ask

    def ask(self, question, choices):
        plist.write_text("<plist>mine</plist>\n")
        return asked(question, choices)

    monkeypatch.setattr("orchi.screen.Screen.ask", ask)
    code, out = uninstall(capsys)
    assert plist.read_text() == "<plist>mine</plist>\n" and mac.loaded is True
    assert not mac.program("launchctl", "bootout")


def test_what_went_is_recorded_even_when_the_removal_is_cut_short(setup_done, capsys, monkeypatch):
    mac, home, *_ = setup_done
    real = os.rmdir

    def stop(path):
        raise KeyboardInterrupt

    monkeypatch.setattr("orchi.uninstall.os.rmdir", stop)
    with pytest.raises(KeyboardInterrupt):
        cli.main(["uninstall", "--yes"])
    left = {r["path"] for r in json.loads((store.state_dir() / "owned.json").read_text())["owned"]}
    assert not [p for p in left if not os.path.lexists(p)]
    monkeypatch.setattr("orchi.uninstall.os.rmdir", real)
    code, out = uninstall(capsys, "--yes")
    assert code == 0 and "Removed" in out


def test_a_folder_that_cannot_be_read_is_kept_and_the_rest_still_reported(setup_done, capsys, monkeypatch):
    mac, home, *_ = setup_done
    real = os.listdir
    bad = str(home / ".config" / "herdr-app" / "sounds")

    def listdir(path="."):
        if os.fspath(path) == bad:
            raise PermissionError(13, "Permission denied")
        return real(path)

    monkeypatch.setattr("orchi.uninstall.os.listdir", listdir)
    code, out = uninstall(capsys, "--yes")
    assert code == 1 and out.startswith("Removed ") and ".config/herdr-app/sounds" in out
    assert "state folder" not in out
    assert not any(os.path.lexists(r["path"]) is False
                   for r in json.loads((store.state_dir() / "owned.json").read_text())["owned"])


# From the code review of the pull request

def test_a_deleted_launch_agent_file_whose_unload_fails_stays_on_record_for_the_next_run(setup_done, capsys):
    mac, home, *_ = setup_done
    (home / "Library" / "LaunchAgents" / "orchi.usage-watch.plist").unlink()
    real = mac.launchctl
    mac.launchctl = lambda argv, done: done(1, "refused") if argv[1] == "bootout" else real(argv, done)
    code, out = uninstall(capsys, "--yes")
    assert code == 1 and mac.loaded is True
    assert [p for p in owned_paths(home) if "usage-watch" in p]
    mac.launchctl = real
    code, out = uninstall(capsys, "--yes")
    assert code == 0 and mac.loaded is False
    assert not [p for p in owned_paths(home) if "usage-watch" in p]


def test_with_only_an_unreadable_folder_left_it_is_still_a_problem(setup_done, capsys, monkeypatch):
    mac, home, *_ = setup_done
    real = os.listdir
    bad = str(home / ".config" / "herdr-app" / "sounds")

    def listdir(path="."):
        if os.fspath(path) == bad:
            raise PermissionError(13, "Permission denied")
        return real(path)

    monkeypatch.setattr("orchi.uninstall.os.listdir", listdir)
    assert uninstall(capsys, "--yes")[0] == 1
    code, out = uninstall(capsys, "--yes")
    assert code == 1 and ".config/herdr-app/sounds" in out and "state folder" not in out


def test_a_kept_folder_that_cannot_be_read_when_the_report_is_made_does_not_stop_it(tmp_path):
    from orchi import uninstall as module
    gone = Path(tmp_path) / "vanished"
    kept = module.tidy([(gone, module.HOLDS)])
    assert kept == [(gone, module.HOLDS)]


def test_a_failure_that_is_not_the_state_folders_is_not_blamed_on_it(setup_done, capsys, monkeypatch):
    def broken(store):
        raise OSError(5, "Input/output error")

    monkeypatch.setattr("orchi.uninstall.extras", broken)
    try:
        cli.main(["uninstall", "--yes"])
    except OSError:
        pass
    assert "state folder" not in capsys.readouterr().out


# From the second round of the code review

def test_a_records_file_that_cannot_be_read_is_a_plain_line_and_exit_1(setup_done, capsys):
    (store.state_dir() / "owned.json").write_text("{not json")
    code, out = uninstall(capsys, "--yes")
    assert code == 1 and "state folder" in out and "Traceback" not in out


def test_saying_no_with_an_unreadable_folder_is_still_a_problem(setup_done, capsys, monkeypatch):
    mac, home, *_ = setup_done
    real = os.listdir
    bad = str(home / ".config" / "herdr-app" / "sounds")

    def listdir(path="."):
        if os.fspath(path) == bad:
            raise PermissionError(13, "Permission denied")
        return real(path)

    monkeypatch.setattr("orchi.uninstall.os.listdir", listdir)
    mac.answers = {"Remove": "No"}
    code, out = uninstall(capsys)
    assert code == 1 and "Nothing removed" in out and ".config/herdr-app/sounds" in out


# From the third round of the code review

def test_cut_short_while_unloading_a_deleted_agents_job_keeps_its_record(setup_done, capsys, monkeypatch):
    mac, home, *_ = setup_done
    (home / "Library" / "LaunchAgents" / "orchi.usage-watch.plist").unlink()

    def stop():
        raise KeyboardInterrupt

    monkeypatch.setattr("orchi.uninstall.unload_agent", stop)
    with pytest.raises(KeyboardInterrupt):
        cli.main(["uninstall", "--yes"])
    assert [p for p in owned_paths(home) if "usage-watch" in p] and mac.loaded is True
