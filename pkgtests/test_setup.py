"""The setup steps: platform, tools, Claude profile, skills, plugin, trust, ticket sources, Linear, usage-watch and the
reload at the end. Every program, download, launchd call and keychain call is the fake Mac's (mac_help.py)."""
import contextlib
import io
import json
import os
from pathlib import Path

import pytest

from engine_help import home, snapshot  # noqa: F401
from mac_help import ALL_STEPS, LINEAR_KEY, mac, run_orchi, states  # noqa: F401
from orchi import engine, paths, screen, settings, steps, store, system
from orchi.tickets import linear


def go(names, fix=True):
    """Run only the steps with these names, the way a whole run would, and give the report."""
    chosen = [s for s in steps.steps() if s.name in names]
    assert [s.name for s in chosen] == [n for n in ALL_STEPS if n in names]
    out = io.StringIO()
    code = engine.run(chosen, fix=fix, screen=screen.Screen(out, as_json=True), store=store.Store())
    return code, json.loads(out.getvalue())


def detail(report, name):
    return next(s["detail"] for s in report["steps"] if s["name"] == name)


def settings_file():
    return json.loads(Path(settings.path()).read_text())


# The whole run

def test_the_steps_run_in_the_order_setup_needs_them():
    assert [s.name for s in steps.steps()] == ALL_STEPS


def test_a_windows_or_linux_machine_is_not_ready_and_nothing_runs(mac, home):
    for platform in ("windows", "linux"):
        mac.platform = platform
        code, report, _ = run_orchi()
        assert code == 1 and report["steps"] == [] and report["ok"] is False
        assert platform.capitalize() in report["summary"] and "not ready" in report["summary"]
        code, report, _ = run_orchi("doctor")
        assert code == 1 and report["steps"] == []
    assert mac.calls == [] and not (home / ".config" / "orchi").exists()


def test_a_fresh_mac_walks_every_step_and_asks_only_what_it_cannot_find_out(mac, home):
    code, report, _ = run_orchi()
    assert code == 0, report["summary"]
    assert [s["name"] for s in report["steps"]] == ALL_STEPS
    assert {s["status"] for s in report["steps"]} <= {"ok", "fixed"}
    assert mac.asked == [
        "Install the developer tools?", "Install Homebrew?", "Install the GitHub CLI?", "Install terminal-notifier?",
        "Install Node?", "Install agent-browser?", "Install Claude Code?", "Install Herdr app?",
        "Install Herdr core?", "Install the planning skills?", "Also read GitHub issues?", "Also read Linear?",
        "Also read Markdown task files?", "Linear API key", "Linear teams (numbers, separated by commas)",
        "Linear projects (numbers, separated by commas)"]
    # Each installer is the official one, run after the answer.
    assert mac.program("xcode-select", "--install")
    assert any(u.endswith("Homebrew/install/HEAD/install.sh") for u in mac.pages)
    assert "https://claude.ai/install.sh" in mac.pages
    assert "https://releases.herdr.dev/app/install.sh" in mac.pages
    assert "https://releases.herdr.dev/core/install.sh" in mac.pages
    assert ("brew", "install", "gh") in mac.calls and ("brew", "install", "terminal-notifier") in mac.calls
    assert settings_file()["sources"] == ["legwork", "github", "linear", "markdown"]
    # A second run on the same Mac has nothing to do.
    mac.asked.clear()
    code, again, _ = run_orchi()
    assert code == 0 and again["summary"] == "All set." and mac.asked == []


INSTALLS = {"Developer tools", "Homebrew", "GitHub CLI", "terminal-notifier", "Node", "agent-browser", "Claude Code",
            "Herdr app", "Herdr core", "Planning skills"}


def test_a_mac_with_everything_asks_nothing_about_tools_and_a_second_run_changes_nothing(mac, home):
    mac.everything()
    mac.settings(sources=["legwork"], claude_dir="~/.claude", linear={"teams": [], "projects": []})
    code, report, _ = run_orchi()
    assert code == 0, report
    assert not [q for q in mac.asked if q.startswith("Install")]
    before = snapshot(home)
    mac.calls.clear()
    code, again, _ = run_orchi()
    assert code == 0 and again["changed"] == [] and again["summary"] == "All set."
    assert all(s["status"] == "ok" for s in again["steps"])
    after = snapshot(home)
    for volatile in (".local/state/orchi", ".local/state/orchi/state.json", ".local/state/orchi/lock"):
        after.pop(volatile, None)
        before.pop(volatile, None)
    assert after == before
    assert not [c for c in mac.calls if c[0] in ("brew", "npm", "launchctl") and c[1:2] != ("print",)]
    assert mac.pages == []


def test_a_fresh_mac_that_answers_no_to_every_question_installs_nothing(mac, home):
    mac.answers = {"Install": "No", "Also read": "No", "Move": "No"}
    mac.settings(sources=["legwork"], claude_dir="~/.claude")
    code, report, _ = run_orchi()
    assert code == 1
    got = states(report)
    for name in INSTALLS:
        assert got[name] == "broken", name
    assert mac.pages == [] and not mac.program("brew") and not mac.program("npm")
    assert not mac.program("xcode-select", "--install")
    assert detail(report, "Homebrew") == "not installed"


def test_a_run_with_no_terminal_names_each_question_and_waits_for_nothing(mac, home):
    mac.terminal = False
    mac.settings(sources=["legwork"], claude_dir="~/.claude")
    code, report, _ = run_orchi()
    assert code == 1
    assert detail(report, "Homebrew") == "needs a terminal to answer: Install Homebrew?"
    assert mac.pages == [] and not mac.program("brew")


def test_doctor_changes_nothing_and_names_what_a_run_would_fix(mac, home):
    code, report, _ = run_orchi("doctor")
    assert code == 1
    assert states(report)["Homebrew"] == "needs-fix"
    assert mac.calls == [c for c in mac.calls if c[0] in ("xcode-select", "launchctl", "python3")]
    assert not (home / ".local" / "state" / "orchi" / "owned.json").exists()


# Tools

@pytest.mark.parametrize("name, question, command", [
    ("Developer tools", "Install the developer tools?", ("xcode-select", "--install")),
    ("terminal-notifier", "Install terminal-notifier?", ("brew", "install", "terminal-notifier")),
    ("GitHub CLI", "Install the GitHub CLI?", ("brew", "install", "gh")),
    ("Node", "Install Node?", ("brew", "install", "node")),
])
def test_a_missing_tool_is_asked_about_then_installed_and_checked_again(mac, name, question, command):
    mac.everything()
    for gone in (mac.bin / "gh", mac.bin / "terminal-notifier", mac.bin / "node"):
        gone.unlink()
    mac.clt = name != "Developer tools"
    code, report = go([name])
    assert code == 0 and states(report) == {name: "fixed"}, report
    assert question in mac.asked and command in mac.calls
    assert go([name], fix=False)[0] == 0


def test_the_developer_tools_wait_for_the_installer_window_and_give_up_at_the_end(mac):
    mac.clt = False
    mac.install_fails.add("xcode-select")
    code, report = go(["Developer tools"])
    assert code == 1 and "finish the installer" in detail(report, "Developer tools")
    assert mac.sleeps and sum(mac.sleeps) <= 30 * 60 + 10


def test_homebrew_runs_its_official_script_with_the_terminal(mac):
    mac.clt = True
    code, report = go(["Homebrew"])
    assert code == 0, report
    ran = mac.program("bash")[0]
    assert ran[1] == "-c" and "Homebrew/install/HEAD/install.sh" in ran[2]


def test_a_tool_that_needs_homebrew_says_so_when_homebrew_is_missing(mac):
    code, report = go(["terminal-notifier"])
    assert code == 1 and detail(report, "terminal-notifier") == "needs Homebrew"
    assert mac.asked == []


def test_the_github_cli_follows_the_command_the_settings_name(mac):
    mac.everything()
    (mac.bin / "gh").unlink()
    mac.settings(github={"command": "gh-personal"})
    code, report = go(["GitHub CLI"])
    assert code == 1 and detail(report, "GitHub CLI") == "gh-personal is not on PATH"
    assert not mac.program("brew", "install")
    mac.executable(mac.bin / "gh-personal")
    assert go(["GitHub CLI"])[0] == 0


def test_node_older_than_22_is_replaced_and_still_old_is_broken(mac):
    mac.everything()
    mac.node(20)
    code, report = go(["Node"])
    assert code == 1 and "version 20" in detail(report, "Node")


def test_agent_browser_needs_node_then_installs_with_npm_and_downloads_its_browser(mac):
    mac.everything()
    (mac.bin / "agent-browser").unlink()
    code, report = go(["agent-browser"])
    assert code == 0, report
    assert ("npm", "install", "-g", "agent-browser") in mac.calls
    assert any(c[0].endswith("agent-browser") and c[1:] == ("install",) for c in mac.calls)
    (mac.brew_bin / "agent-browser").unlink()
    (mac.bin / "npm").unlink()
    code, report = go(["agent-browser"])
    assert code == 1 and detail(report, "agent-browser") == "needs Node"


@pytest.mark.parametrize("name, url, where", [
    ("Claude Code", "https://claude.ai/install.sh", ".local/bin/claude"),
    ("Herdr app", "https://releases.herdr.dev/app/install.sh", "Applications/Herdr.app"),
    ("Herdr core", "https://releases.herdr.dev/core/install.sh", ".local/bin/hc"),
])
def test_the_official_installer_is_downloaded_and_run_after_the_answer(mac, home, name, url, where):
    code, report = go([name])
    assert code == 0, report
    assert mac.pages == [url] and (home / where).exists()
    assert mac.asked == [f"Install {name}?"]


def test_a_failed_installer_is_broken_with_its_last_line(mac):
    mac.install_fails.add("https://claude.ai/install.sh")
    code, report = go(["Claude Code"])
    assert code == 1 and detail(report, "Claude Code") == "the installer failed"


# The Claude profile, skills, plugin and trust

def test_the_profile_is_the_shells_config_dir_else_dot_claude_and_is_written_as_claude_dir(mac, home, monkeypatch):
    assert go(["Claude profile"])[0] == 0
    assert settings_file() == {"claude_dir": "~/.claude"}
    Path(settings.path()).unlink()
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(home / "work-claude") + "/")
    assert go(["Claude profile"])[0] == 0
    assert settings_file() == {"claude_dir": "~/work-claude"}
    outside = "/opt/claude-profile"
    Path(settings.path()).unlink()
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", outside)
    go(["Claude profile"])
    assert settings_file() == {"claude_dir": outside}


def test_a_profile_the_settings_already_name_stays(mac, home, monkeypatch):
    mac.settings(claude_dir="~/mine", worker_limit=3)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(home / "other"))
    code, report = go(["Claude profile"])
    assert code == 0 and states(report) == {"Claude profile": "ok"}
    assert settings_file() == {"claude_dir": "~/mine", "worker_limit": 3}


def test_the_profile_keeps_every_other_setting_and_backs_up_a_file_orchi_did_not_make(mac, home):
    mac.settings(worker_limit=3, sources=["legwork", "github"])
    code, report = go(["Claude profile"])
    assert code == 0 and report["backup"]
    assert settings_file() == {"worker_limit": 3, "sources": ["legwork", "github"], "claude_dir": "~/.claude"}


def test_a_settings_file_that_is_not_json_is_left_alone(mac, home):
    path = Path(settings.path())
    path.parent.mkdir(parents=True)
    path.write_text("{ nope")
    code, report = go(["Claude profile"])
    assert code == 1 and "settings.json" in detail(report, "Claude profile")
    assert path.read_text() == "{ nope"


def shipped_skills():
    root = paths.data_dir() / "skills"
    return sorted(p.name for p in root.iterdir() if p.is_dir() and p.name != "herdr-browser")


def test_skills_and_commands_are_linked_into_the_profile_except_the_browser_skill(mac, home):
    mac.settings(claude_dir="~/.claude")
    code, report = go(["Skills and commands"])
    assert code == 0, report
    profile = home / ".claude"
    for name in shipped_skills():
        link = profile / "skills" / name
        assert link.is_symlink() and os.readlink(link) == str(paths.data_dir() / "skills" / name)
    assert not (profile / "skills" / "herdr-browser").exists()
    for file in (paths.data_dir() / "commands").glob("*.md"):
        assert os.readlink(profile / "commands" / file.name) == str(file)
    owned = {r["path"] for r in store.Store().owned()}
    assert str(profile / "skills" / shipped_skills()[0]) in owned
    assert go(["Skills and commands"], fix=False)[0] == 0


def test_a_skill_folder_that_is_not_orchis_is_named_and_left_alone(mac, home):
    mac.settings(claude_dir="~/.claude")
    mine = home / ".claude" / "skills" / "fanout"
    mine.mkdir(parents=True)
    (mine / "SKILL.md").write_text("mine")
    code, report = go(["Skills and commands"])
    assert code == 1 and "fanout" in detail(report, "Skills and commands") and "folder" in detail(report, "Skills and commands")
    assert (mine / "SKILL.md").read_text() == "mine"


def test_a_command_file_that_is_not_orchis_is_backed_up_then_replaced(mac, home):
    mac.settings(claude_dir="~/.claude")
    first = next((paths.data_dir() / "commands").glob("*.md")).name
    mine = home / ".claude" / "commands" / first
    mine.parent.mkdir(parents=True)
    mine.write_text("mine")
    code, report = go(["Skills and commands"])
    assert code == 0 and mine.is_symlink() and report["backup"]
    assert (Path(report["backup"]) / str(mine).lstrip("/")).read_text() == "mine"


def test_a_link_that_points_at_a_moved_data_folder_is_pointed_again(mac, home):
    mac.settings(claude_dir="~/.claude")
    go(["Skills and commands"])
    name = shipped_skills()[0]
    link = home / ".claude" / "skills" / name
    link.unlink()
    link.symlink_to("/gone/skills/" + name)
    assert go(["Skills and commands"], fix=False)[0] == 1
    assert go(["Skills and commands"])[0] == 0 and os.readlink(link) == str(paths.data_dir() / "skills" / name)


def test_a_skill_orchi_linked_and_no_longer_ships_goes_but_nothing_else(mac, home):
    mac.settings(claude_dir="~/.claude")
    go(["Skills and commands"])
    old = home / ".claude" / "skills" / "retired"
    old.symlink_to("/nowhere")
    store.Store().own(old, "link", "Skills and commands")
    other = home / ".claude" / "skills" / "theirs"
    other.mkdir()
    (other / "SKILL.md").write_text("x")
    assert go(["Skills and commands"])[0] == 0
    assert not old.exists() and not old.is_symlink() and (other / "SKILL.md").is_file()


def test_the_planning_plugin_is_asked_about_and_installed_into_the_profile(mac, home):
    mac.everything()
    mac.installed_plugins = {}
    mac.write_plugins()
    mac.settings(claude_dir="~/.claude")
    code, report = go(["Planning skills"])
    assert code == 0, report
    assert "Install the planning skills?" in mac.asked
    assert ("claude", "plugin", "install", "mattpocock-skills@claude-plugins-official") in [c[:4] for c in mac.calls]
    assert go(["Planning skills"], fix=False)[0] == 0


def test_the_plugin_is_installed_for_the_profile_setup_chose(mac, home):
    mac.everything()
    mac.installed_plugins = {}
    mac.write_plugins()
    mac.settings(claude_dir="~/.claude-other")
    mac.write_plugins(home / ".claude-other")
    go(["Planning skills"])
    ran = [env for argv, env in mac.envs if argv[1:3] == ("plugin", "install")]
    assert ran[0]["CLAUDE_CONFIG_DIR"] == str(home / ".claude-other")


def test_the_plugin_needs_claude_code(mac):
    mac.settings(claude_dir="~/.claude")
    code, report = go(["Planning skills"])
    assert code == 1 and detail(report, "Planning skills") == "needs Claude Code"


def test_the_folders_orchi_starts_sessions_in_are_trusted(mac, home):
    mac.settings(claude_dir="~/.claude", orchi_dir="~/orchi", legwork_dir="~/legwork")
    for name in ("orchi", "legwork"):
        (home / name).mkdir()
    config = home / ".claude.json"
    config.write_text(json.dumps({"numStartups": 4, "projects": {str(home / "orchi"): {"allowedTools": ["x"]}}}))
    code, report = go(["Folder trust"])
    assert code == 0, report
    got = json.loads(config.read_text())
    assert got["numStartups"] == 4
    assert got["projects"][str(home / "orchi")] == {"allowedTools": ["x"], "hasTrustDialogAccepted": True}
    assert got["projects"][str(home / "legwork")]["hasTrustDialogAccepted"] is True
    assert report["backup"] and go(["Folder trust"], fix=False)[0] == 0


def test_a_folder_that_does_not_exist_is_not_trusted_and_none_is_fine(mac, home):
    mac.settings(claude_dir="~/.claude", orchi_dir="~/nowhere")
    code, report = go(["Folder trust"])
    assert code == 0 and states(report) == {"Folder trust": "ok"}
    assert not (home / ".claude" / ".claude.json").exists()


# Ticket sources and Linear

def test_the_sources_are_asked_once_and_legwork_is_always_on(mac):
    mac.answers = {"GitHub": "Yes", "Linear": "No", "Markdown": "Yes"}
    code, report = go(["Ticket sources"])
    assert code == 0, report
    assert settings_file()["sources"] == ["legwork", "github", "markdown"]
    assert len(mac.asked) == 3 and not any("legwork" in q.lower() for q in mac.asked)
    mac.asked.clear()
    assert go(["Ticket sources"])[0] == 0 and mac.asked == []


def test_no_to_every_source_is_still_an_answer(mac):
    mac.answers = {"Also read": "No"}
    assert go(["Ticket sources"])[0] == 0
    assert settings_file()["sources"] == ["legwork"]
    assert go(["Ticket sources"], fix=False)[0] == 0


def test_linear_is_left_alone_when_it_is_not_a_source(mac):
    mac.settings(sources=["legwork"])
    code, report = go(["Linear"])
    assert code == 0 and states(report) == {"Linear": "ok"} and mac.asked == []


def test_the_linear_key_is_asked_for_without_echo_checked_against_linear_and_kept_in_the_keychain(mac, home):
    mac.settings(sources=["legwork", "linear"])
    mac.picks = {"teams": ["ENG"], "projects": ["Beta"]}
    code, report = go(["Linear"])
    assert code == 0, report
    assert mac.keychain == {"orchi-linear": LINEAR_KEY}
    assert ("linear", True) in mac.calls
    got = settings_file()
    assert got["linear"] == {"teams": ["ENG"], "projects": ["p2"]}
    assert "Linear API key" in mac.asked[0]
    # The key is in no output, record, setting or backup.
    for here, _, files in os.walk(home):
        for f in files:
            assert LINEAR_KEY.encode() not in (Path(here) / f).read_bytes(), f
    assert go(["Linear"], fix=False)[0] == 0


def test_the_linear_key_is_not_kept_when_linear_refuses_it(mac):
    mac.settings(sources=["legwork", "linear"])
    mac.linear_refused = True
    code, report = go(["Linear"])
    assert code == 1 and detail(report, "Linear") == "Invalid Linear API key"
    assert mac.keychain == {} and "linear" not in settings_file()


def test_a_key_with_a_character_the_keychain_call_will_not_take_is_refused(mac):
    mac.settings(sources=["legwork", "linear"])
    mac.secret = 'lin_api_"quote'
    code, report = go(["Linear"])
    assert code == 1 and "letters, digits" in detail(report, "Linear")
    assert mac.keychain == {} and not mac.program("linear")


@pytest.mark.parametrize("where", ["env", "keychain"])
def test_a_stored_key_with_a_control_character_is_refused_without_showing_it(mac, home, monkeypatch, where):
    mac.settings(sources=["legwork", "linear"])
    bad = "lin_api_abc\ndef"
    if where == "env":
        monkeypatch.setenv("LINEAR_API_KEY", bad)
    else:
        mac.keychain["orchi-linear"] = bad.replace("\n", "\t")
    seen = []
    monkeypatch.setattr(linear, "post", lambda query, variables, key: seen.append(key))
    code, report = go(["Linear"])
    assert code == 1 and "lin_api" not in detail(report, "Linear") and "abc" not in detail(report, "Linear")
    assert seen == []
    for here, _, files in os.walk(home):
        for f in files:
            assert b"lin_api_abc" not in (Path(here) / f).read_bytes(), f


def test_a_key_that_could_not_be_read_is_never_deleted_when_the_add_does_not_take(mac):
    mac.settings(sources=["legwork", "linear"])
    mac.keychain["orchi-linear"] = "the-original-key"
    mac.unreadable_reads = 2  # locked for the check and the fix, so setup asks for a key
    mac.secret = LINEAR_KEY
    code, report = go(["Linear"])
    assert code == 1
    assert mac.keychain == {"orchi-linear": "the-original-key"}


def test_a_key_the_keychain_does_not_keep_is_broken_and_not_used(mac):
    mac.settings(sources=["legwork", "linear"])
    mac.install_fails.add("keychain")
    code, report = go(["Linear"])
    assert code == 1 and "keychain" in detail(report, "Linear")


def test_a_key_in_the_keychain_is_not_asked_for_again_and_no_teams_means_the_issues_assigned_to_you(mac):
    mac.settings(sources=["legwork", "linear"])
    mac.keychain["orchi-linear"] = LINEAR_KEY
    code, report = go(["Linear"])
    assert code == 0 and not any("API key" in q for q in mac.asked)
    assert settings_file()["linear"] == {"teams": [], "projects": []}
    assert go(["Linear"], fix=False)[0] == 0


def test_teams_in_the_old_linear_json_count_as_chosen(mac, home):
    mac.settings(sources=["legwork", "linear"])
    mac.keychain["orchi-linear"] = LINEAR_KEY
    old = home / ".config" / "herdr-app" / "linear.json"
    old.parent.mkdir(parents=True)
    old.write_text(json.dumps({"teams": ["ENG"]}))
    assert go(["Linear"], fix=False)[0] == 0


def test_the_key_from_the_environment_is_enough(mac, monkeypatch):
    mac.settings(sources=["legwork", "linear"], linear={"teams": ["ENG"], "projects": []})
    monkeypatch.setenv("LINEAR_API_KEY", LINEAR_KEY)
    assert go(["Linear"], fix=False)[0] == 0


def test_linear_with_no_terminal_is_broken_not_stuck(mac):
    mac.terminal = False
    mac.settings(sources=["legwork", "linear"])
    code, report = go(["Linear"])
    assert code == 1 and "needs a terminal" in detail(report, "Linear")


# usage-watch

def test_usage_watch_reads_once_in_the_foreground_then_loads_its_launch_agent(mac, home):
    mac.everything()
    mac.usage, mac.loaded = None, False
    code, report = go(["usage-watch"])
    assert code == 0, report
    now = [i for i, c in enumerate(mac.calls) if "--now" in c]
    boot = [i for i, c in enumerate(mac.calls) if c[:2] == ("launchctl", "bootstrap")]
    assert now and boot and now[0] < boot[0]
    plist = home / "Library" / "LaunchAgents" / "orchi.usage-watch.plist"
    text = plist.read_text()
    assert str(paths.data_dir()) in text and str(home) in text and "@" not in text and "<!--" not in text
    assert str(plist) in {r["path"] for r in store.Store().owned()}
    assert mac.calls[boot[0]][2] == f"gui/{os.getuid()}"
    assert go(["usage-watch"], fix=False)[0] == 0


@pytest.mark.parametrize("login", ["no-login", "keychain-denied"])
def test_usage_watch_stays_off_when_the_first_read_finds_no_login_or_is_refused(mac, home, login):
    mac.everything()
    mac.usage, mac.loaded, mac.login = None, False, login
    code, report = go(["usage-watch"])
    assert code == 1
    assert "launchctl" not in {c[0] for c in mac.calls if c[:2] == ("launchctl", "bootstrap")}
    assert not mac.program("launchctl", "bootstrap")
    if login == "no-login":
        assert "sign in to Claude Code" in detail(report, "usage-watch")
    else:
        assert "keychain" in detail(report, "usage-watch")


def test_usage_watch_with_a_status_that_clears_up_by_itself_is_loaded_anyway(mac):
    mac.everything()
    mac.usage, mac.loaded, mac.login = None, False, "offline"
    go(["usage-watch"])
    assert mac.program("launchctl", "bootstrap")


def test_a_launch_agent_that_points_at_an_old_data_folder_is_loaded_again(mac, home):
    mac.everything()
    mac.usage, mac.loaded = None, False
    go(["usage-watch"])
    plist = home / "Library" / "LaunchAgents" / "orchi.usage-watch.plist"
    plist.write_text(plist.read_text().replace(str(paths.data_dir()), "/old/place"))
    mac.calls.clear()
    code, report = go(["usage-watch"])
    assert code == 0 and plist.read_text().count(str(paths.data_dir())) >= 1
    assert [c[1] for c in mac.calls if c[0] == "launchctl" and c[1] in ("bootout", "bootstrap")] == ["bootout", "bootstrap"]


def test_usage_watch_in_a_private_window_leaves_the_real_launch_agent_alone(mac, home, monkeypatch):
    monkeypatch.setenv("HERDR_APP_HOME", str(home / ".config" / "hd" / "x"))
    code, report = go(["usage-watch"])
    assert code == 0 and mac.calls == []


def test_the_settings_the_job_reads_go_into_its_launch_agent(mac, home, monkeypatch):
    mac.everything()
    mac.usage, mac.loaded = None, False
    go(["usage-watch"])
    text = (home / "Library" / "LaunchAgents" / "orchi.usage-watch.plist").read_text()
    assert "<key>ORCHI_SETTINGS</key>" in text and os.environ["ORCHI_SETTINGS"] in text


# The reload at the end

def test_herdr_is_reloaded_when_a_content_step_changed_and_its_errors_are_reported_once(mac, home):
    mac.everything()
    mac.herdr_running, mac.herdr_errors = True, ["mods/x: bad", "mods/y: bad"]
    mac.settings(sources=["legwork"], claude_dir="~/.claude")
    code, report, _ = run_orchi()
    got = states(report)
    assert got["Themes"] == "fixed" and got["Herdr reload"] == "broken"
    assert "mods/x: bad" in detail(report, "Herdr reload")
    assert ("herdr-app", "do", "layout.switch", json.dumps({"name": "main-linear"})) in mac.calls


def test_herdr_is_not_reloaded_when_nothing_changed_or_it_is_not_running(mac, home):
    mac.everything()
    mac.settings(sources=["legwork"], claude_dir="~/.claude")
    run_orchi()
    mac.herdr_running = True
    mac.calls.clear()
    code, report, _ = run_orchi()
    assert code == 0 and states(report)["Herdr reload"] == "ok"
    assert not mac.program("herdr-app", "do")


def test_a_content_change_with_no_window_open_needs_no_reload(mac, home):
    mac.everything()
    mac.settings(sources=["legwork"], claude_dir="~/.claude")
    code, report, _ = run_orchi()
    assert code == 0 and states(report)["Herdr reload"] == "ok"


def test_a_fresh_window_on_herdrs_own_layout_ends_showing_orchis(mac, home):
    """A new install lands on Herdr's shipped layout, which has none of Orchi's panels, so setup shows Orchi's."""
    mac.everything()
    mac.herdr_running, mac.layout = True, "main"
    mac.settings(sources=["legwork"], claude_dir="~/.claude")
    code, report, _ = run_orchi()
    assert code == 0 and states(report)["Herdr reload"] == "fixed"
    assert ("herdr-app", "do", "layout.switch", json.dumps({"name": "main-linear"})) in mac.calls


def test_a_later_run_keeps_the_layout_the_person_chose(mac, home):
    mac.everything()
    mac.herdr_running = True
    mac.settings(sources=["legwork"], claude_dir="~/.claude")
    run_orchi()
    mac.layout = "terminals"
    from orchi import herdr
    (herdr.app_home() / "themes" / "orchi-dark.json").unlink()
    mac.calls.clear()
    code, report, _ = run_orchi()
    assert code == 0 and states(report)["Themes"] == "fixed"
    assert mac.program("herdr-app", "do") == [("herdr-app", "do", "layout.switch", json.dumps({"name": "terminals"}))]


# Stopping, retrying and the shape of Linear's answers

def test_ctrl_c_during_an_installer_stops_the_run_and_the_next_run_carries_on(mac, home):
    mac.everything()
    for gone in (mac.bin / "gh", mac.bin / "terminal-notifier"):
        gone.unlink()
    mac.settings(sources=["legwork"], claude_dir="~/.claude")
    real = mac.run
    state = {"stopped": False}

    def run(argv, **kw):
        if os.path.basename(argv[0]) == "brew" and argv[1:3] == ["install", "terminal-notifier"] and not state["stopped"]:
            state["stopped"] = True
            raise KeyboardInterrupt
        return real(argv, **kw)

    mac.monkeypatch.setattr(system, "run", run)
    code, report, _ = run_orchi()
    assert code == 130 and report["stopped"] is True
    assert "usage-watch" not in states(report)
    code, report, _ = run_orchi()
    assert code == 0, report["summary"]
    assert (mac.brew_bin / "terminal-notifier").exists() and mac.program("launchctl", "bootstrap")


def test_a_launch_agent_that_will_not_load_is_broken_and_loaded_by_the_next_run(mac, home):
    mac.everything()
    mac.usage, mac.loaded = None, False
    real = mac.launchctl
    refuse = {"on": True}

    def launchctl(argv, done):
        if argv[1] == "bootstrap" and refuse["on"]:
            return done(5, "Bootstrap failed: 5: Input/output error")
        return real(argv, done)

    mac.launchctl = launchctl
    code, report = go(["usage-watch"])
    assert code == 1 and detail(report, "usage-watch") == "Bootstrap failed: 5: Input/output error"
    refuse["on"] = False
    assert go(["usage-watch"])[0] == 0 and mac.loaded


def test_a_first_read_that_does_not_finish_says_what_it_printed(mac):
    mac.everything()
    mac.usage, mac.loaded = None, False
    real = mac.usage_watch
    mac.usage_watch = lambda argv, done: done(1, "usage-watch: /x/.cache/orchi is not a private folder") if "--now" in argv else real(argv, done)
    code, report = go(["usage-watch"])
    assert code == 1 and "is not a private folder" in detail(report, "usage-watch")
    assert not mac.program("launchctl", "bootstrap")


@pytest.mark.parametrize("answer", [{}, {"data": None}, {"data": {"teams": {"nodes": "x"}, "projects": {"nodes": []}}},
                                    {"errors": [{"message": "You must authenticate"}]},
                                    {"data": {"teams": {"nodes": []}, "projects": {}}}])
def test_an_answer_from_linear_that_is_not_what_was_asked_for_is_a_plain_error(mac, answer):
    mac.settings(sources=["legwork", "linear"])
    mac.keychain["orchi-linear"] = LINEAR_KEY
    mac.monkeypatch.setattr(linear, "post", lambda query, variables, key: answer)
    code, report = go(["Linear"])
    assert code == 1 and detail(report, "Linear") in ("Invalid Linear API key", "Linear gave an answer Orchi can't read")


def test_an_interactive_program_gets_the_terminal_to_itself_and_the_spinner_comes_back(mac, monkeypatch):
    mac.clt = True
    seen = []
    out = io.StringIO()
    screen_ = screen.Screen(out)
    screen_.live = True
    real_paused = screen_.paused

    @contextlib.contextmanager
    def paused():
        seen.append("paused")
        with real_paused():
            yield
        seen.append("resumed")

    screen_.paused = paused
    chosen = [s for s in steps.steps() if s.name == "Homebrew"]
    engine.run(chosen, fix=True, screen=screen_, store=store.Store())
    assert seen == ["paused", "resumed"]


# Findings from the adversarial review

def test_usage_watch_does_not_start_apples_python_stub_while_the_developer_tools_are_missing(mac):
    mac.answers = {"developer tools": "No"}
    code, report = go(["Developer tools", "usage-watch"])
    assert code == 1
    assert states(report)["Developer tools"] == "broken" and detail(report, "usage-watch") == "needs the developer tools"
    assert not mac.program("python3")


def test_a_private_window_with_no_profile_of_its_own_does_not_write_one(mac, home, monkeypatch):
    monkeypatch.setenv("HERDR_APP_HOME", str(home / ".config" / "hd" / "x"))
    code, report = go(["Claude profile", "Skills and commands", "Folder trust"])
    assert code == 0 and not Path(settings.path()).exists()
    assert not (home / ".claude").exists()
    code, report = go(["Claude profile", "Skills and commands", "Folder trust"])
    assert not (home / ".claude").exists()


def test_the_plugin_commands_change_profile_files_so_those_are_backed_up_first(mac, home):
    mac.everything()
    mac.installed_plugins = {"other@somewhere": [{"scope": "user"}]}
    mac.write_plugins()
    known = home / ".claude" / "plugins" / "known_marketplaces.json"
    known.write_text('{"mine": {}}')
    mac.settings(claude_dir="~/.claude")
    original = (home / ".claude" / "plugins" / "installed_plugins.json").read_text()
    code, report = go(["Planning skills"])
    assert code == 0 and report["backup"]
    saved = Path(report["backup"]) / str(home / ".claude" / "plugins" / "installed_plugins.json").lstrip("/")
    assert saved.read_text() == original
    assert (Path(report["backup"]) / str(known).lstrip("/")).read_text() == '{"mine": {}}'


def test_a_browser_download_that_failed_is_tried_again_on_the_next_run(mac):
    mac.everything()
    (mac.bin / "agent-browser").unlink()
    (store_dir() / "agent-browser-browser").unlink()
    mac.install_fails.add("browser-download")
    code, report = go(["agent-browser"])
    assert code == 1 and detail(report, "agent-browser") == "download failed"
    mac.install_fails.clear()
    mac.calls.clear()
    code, report = go(["agent-browser"])
    assert code == 0 and not mac.program("npm")
    assert any(c[0] == "agent-browser" and c[1:] == ("install",) for c in mac.calls)
    mac.calls.clear()
    assert go(["agent-browser"], fix=False)[0] == 0


def store_dir():
    return store.state_dir()


def test_a_layout_switch_that_fails_is_broken_and_tried_again_on_the_next_run(mac, home):
    mac.everything()
    mac.herdr_running = True
    mac.settings(sources=["legwork"], claude_dir="~/.claude")
    mac.install_fails.add("switch")
    code, report, _ = run_orchi()
    got = states(report)
    assert got["Themes"] == "fixed" and got["Herdr reload"] == "broken"
    assert detail(report, "Herdr reload") == "the window did not answer"
    mac.install_fails.clear()
    mac.calls.clear()
    code, report, _ = run_orchi()
    assert code == 0 and states(report)["Herdr reload"] == "fixed"
    assert mac.program("herdr-app", "do")
    mac.calls.clear()
    code, report, _ = run_orchi()
    assert code == 0 and states(report)["Herdr reload"] == "ok" and not mac.program("herdr-app", "do")


# The legwork house rule for orchi tickets sync

def snippet_in_the_docs():
    from conftest import ROOT
    block = (ROOT / "docs" / "legwork-sync.md").read_text().split("```")[1]
    return block.strip("\n")


def rules_set_up(mac, home, text=None, sources=("legwork", "linear")):
    legwork = home / "legwork"
    legwork.mkdir()
    if text is not None:
        (legwork / "house-rules.md").write_text(text)
    mac.settings(sources=list(sources), legwork_dir="~/legwork", claude_dir="~/.claude")
    return legwork / "house-rules.md"


def test_the_rule_setup_offers_is_the_one_the_docs_give():
    from orchi import sources
    assert sources.SYNC_RULE == snippet_in_the_docs()


def test_the_sync_rule_is_added_to_the_house_rules_after_a_yes_and_a_backup(mac, home):
    file = rules_set_up(mac, home, "# House rules\n\n- Be kind.\n")
    code, report = go(["House rules"])
    assert code == 0, report
    from orchi import sources
    assert file.read_text() == "# House rules\n\n- Be kind.\n\n" + sources.SYNC_RULE + "\n"
    assert any("house-rules.md" in q for q in mac.asked) and report["backup"]
    assert (Path(report["backup"]) / str(file).lstrip("/")).read_text() == "# House rules\n\n- Be kind.\n"
    assert go(["House rules"], fix=False)[0] == 0


def test_a_house_rules_file_that_is_not_there_is_made_after_a_yes(mac, home):
    file = rules_set_up(mac, home)
    assert go(["House rules"])[0] == 0 and file.read_text().startswith("- After `/wrap`")


def test_nothing_is_written_to_the_legwork_folder_on_a_no_and_the_question_is_not_asked_again(mac, home):
    file = rules_set_up(mac, home, "# House rules\n")
    mac.answers = {"house-rules": "No"}
    code, report = go(["House rules"])
    assert code == 0 and file.read_text() == "# House rules\n"
    mac.asked.clear()
    assert go(["House rules"])[0] == 0 and mac.asked == []


def test_the_rule_already_there_is_left_alone(mac, home):
    from orchi import sources
    file = rules_set_up(mac, home, "# Rules\n" + sources.SYNC_RULE + "\n")
    before = file.stat().st_mtime_ns
    code, report = go(["House rules"])
    assert code == 0 and states(report) == {"House rules": "ok"} and mac.asked == []
    assert file.stat().st_mtime_ns == before


def test_no_question_without_linear_or_without_a_legwork_folder(mac, home):
    rules_set_up(mac, home, "x\n", sources=("legwork",))
    assert go(["House rules"])[0] == 0 and mac.asked == []
    mac.settings(sources=["legwork", "linear"])
    assert go(["House rules"])[0] == 0 and mac.asked == []


def test_with_no_terminal_the_house_rules_step_is_broken_and_writes_nothing(mac, home):
    file = rules_set_up(mac, home, "x\n")
    mac.terminal = False
    code, report = go(["House rules"])
    assert code == 1 and "needs a terminal" in detail(report, "House rules") and file.read_text() == "x\n"


# Review of the pull request

def test_the_default_profile_keeps_its_trust_in_the_home_claude_json(mac, home):
    mac.settings(claude_dir="~/.claude", orchi_dir="~/orchi")
    (home / "orchi").mkdir()
    (home / ".claude.json").write_text(json.dumps({"numStartups": 2}))
    code, report = go(["Folder trust"])
    assert code == 0, report
    got = json.loads((home / ".claude.json").read_text())
    assert got["numStartups"] == 2 and got["projects"][str(home / "orchi")]["hasTrustDialogAccepted"] is True


def test_sessions_orchi_starts_under_the_default_profile_find_the_folders_trusted(mac, home):
    # Orchi starts every session with CLAUDE_CONFIG_DIR set to claude_dir, and Claude Code then keeps its state in
    # <claude_dir>/.claude.json, even when claude_dir is ~/.claude. The smoke test stopped at the trust question here.
    mac.settings(claude_dir="~/.claude", orchi_dir="~/orchi")
    (home / "orchi").mkdir()
    (home / ".claude").mkdir(exist_ok=True)
    (home / ".claude" / ".claude.json").write_text(json.dumps({"numStartups": 7}))
    code, report = go(["Folder trust"])
    assert code == 0, report
    got = json.loads((home / ".claude" / ".claude.json").read_text())
    assert got["numStartups"] == 7 and got["projects"][str(home / "orchi")]["hasTrustDialogAccepted"] is True
    assert json.loads((home / ".claude.json").read_text())["projects"][str(home / "orchi")]["hasTrustDialogAccepted"]
    assert go(["Folder trust"], fix=False)[0] == 0


def test_another_profile_keeps_its_trust_in_its_own_claude_json(mac, home):
    mac.settings(claude_dir="~/.claude-other", orchi_dir="~/orchi")
    (home / "orchi").mkdir()
    (home / ".claude-other").mkdir()
    code, _ = go(["Folder trust"])
    assert code == 0
    assert json.loads((home / ".claude-other" / ".claude.json").read_text())["projects"]
    assert not (home / ".claude.json").exists()


def test_linear_in_a_private_window_is_not_broken_by_a_key_it_may_not_move(mac, home, monkeypatch, tmp_path):
    private = tmp_path / "private-herdr"
    private.mkdir()
    (private / "linear.json").write_text(json.dumps({"apiKey": LINEAR_KEY}))
    monkeypatch.setenv("HERDR_APP_HOME", str(private))
    mac.settings(sources=["legwork", "linear"])
    code, report = go(["Linear key", "Linear"])
    assert code == 0, report
    assert mac.keychain == {} and mac.asked == []


def test_usage_watch_status_is_found_when_a_warning_is_printed_after_it(mac, home):
    mac.everything()
    mac.usage, mac.loaded = None, False
    real = mac.usage_watch

    def noisy(argv, done):
        found = real(argv, done)
        return done(found.returncode, found.stdout + "\nDeprecationWarning: said at exit") if "--now" in argv else found
    mac.usage_watch = noisy
    code, report = go(["usage-watch"])
    assert code == 0, report


def test_the_linear_key_check_is_the_keychains_own_rule(mac, monkeypatch):
    import re
    from orchi.tickets import keychain
    mac.settings(sources=["legwork", "linear"])
    monkeypatch.setattr(keychain, "SAFE", re.compile(r"[a-z_]+"))
    code, report = go(["Linear"])
    assert code == 1 and "letters, digits" in detail(report, "Linear")
    assert not mac.program("linear")


def test_usage_watch_report_is_read_past_a_trailing_warning(mac, home):
    mac.everything()
    mac.usage, mac.loaded = None, False
    assert go(["usage-watch"])[0] == 0
    real = mac.usage_watch

    def noisy(argv, done):
        found = real(argv, done)
        return done(found.returncode, found.stdout + "\nDeprecationWarning: said at exit") if "--status" in argv else found
    mac.usage_watch = noisy
    code, report = go(["usage-watch"], fix=False)
    assert code == 0, report


def test_the_undo_line_is_one_command_line_that_can_be_pasted(mac, home):
    from test_migration import put
    put(home)
    _, report = go(["Linear key"])
    (undo,) = [line for line in report["summary"].splitlines() if line.startswith("Undo: ")]
    assert " and " not in undo and "&&" in undo


# Review of the pull request, round 3

def test_herdr_status_is_read_past_a_trailing_warning(mac, home):
    mac.everything()
    mac.herdr_running, mac.herdr_errors = True, ["mods/x: bad"]
    real = mac.herdr_app

    def noisy(argv, done):
        found = real(argv, done)
        return done(found.returncode, found.stdout + "\nwarning: said at exit") if argv[1] == "status" else found
    mac.herdr_app = noisy
    _, report = go(["Herdr reload"], fix=False)
    assert "mods/x: bad" in detail(report, "Herdr reload")


def test_a_linked_claude_json_stays_a_link_when_folders_are_trusted(mac, home, tmp_path):
    mac.settings(claude_dir="~/.claude", orchi_dir="~/orchi")
    (home / "orchi").mkdir()
    target = tmp_path / "dotfiles" / "claude.json"
    target.parent.mkdir()
    target.write_text(json.dumps({"numStartups": 2}))
    (home / ".claude.json").symlink_to(target)
    code, _ = go(["Folder trust"])
    assert code == 0 and (home / ".claude.json").is_symlink()
    assert json.loads(target.read_text())["projects"][str(home / "orchi")]["hasTrustDialogAccepted"] is True


def test_the_default_profile_runs_the_plugin_commands_without_naming_its_folder(mac, home):
    mac.settings(claude_dir="~/.claude")
    mac.executable(mac.tools_dir / "claude")
    code, report = go(["Planning skills"])
    assert code == 0, report
    envs = [env for call, env in mac.envs if call[:3] == ("claude", "plugin", "install")]
    assert envs and all("CLAUDE_CONFIG_DIR" not in (env or {}) for env in envs)


def test_another_profile_runs_the_plugin_commands_with_its_folder(mac, home):
    mac.settings(claude_dir="~/.claude-other")
    mac.executable(mac.tools_dir / "claude")
    code, report = go(["Planning skills"])
    assert code == 0, report
    envs = [env for call, env in mac.envs if call[:3] == ("claude", "plugin", "install")]
    assert envs and all(env["CLAUDE_CONFIG_DIR"] == str(home / ".claude-other") for env in envs)


def test_the_launch_agent_is_booted_out_for_good_before_it_is_loaded_again(mac, home):
    mac.everything()
    mac.usage, mac.loaded = None, False
    go(["usage-watch"])
    plist = home / "Library" / "LaunchAgents" / "orchi.usage-watch.plist"
    plist.write_text(plist.read_text().replace(str(paths.data_dir()), "/old/place"))
    unloading = [0]
    real = mac.launchctl

    def slow(argv, done):
        if argv[1] == "bootout":
            unloading[0] = 2
            return real(argv, done)
        if argv[1] == "print" and unloading[0]:
            unloading[0] -= 1
            return done(0)
        if argv[1] == "bootstrap" and unloading[0]:
            return done(5, "Bootstrap failed: 5: Input/output error")
        return real(argv, done)
    mac.launchctl = slow
    code, report = go(["usage-watch"])
    assert code == 0, report


def test_a_no_to_the_house_rules_is_for_that_file_only(mac, home):
    file = rules_set_up(mac, home, "# House rules\n")
    mac.answers = {"house-rules": "No"}
    go(["House rules"])
    other = home / "elsewhere"
    other.mkdir()
    (other / "house-rules.md").write_text("# Other\n")
    mac.settings(sources=["legwork", "linear"], legwork_dir="~/elsewhere", claude_dir="~/.claude")
    mac.answers = {}
    code, report = go(["House rules"])
    assert code == 0 and "House rules" in [s["name"] for s in report["steps"]]
    assert (other / "house-rules.md").read_text().endswith("\n") and "orchi tickets sync" in (other / "house-rules.md").read_text()
    assert file.read_text() == "# House rules\n"


def test_a_broken_claude_json_is_named_by_its_path(mac, home):
    # From the review: the default profile has two of them, so the error has to say which one.
    mac.settings(claude_dir="~/.claude", orchi_dir="~/orchi")
    (home / "orchi").mkdir()
    (home / ".claude").mkdir(exist_ok=True)
    (home / ".claude" / ".claude.json").write_text("{not json")
    code, report = go(["Folder trust"], fix=False)
    assert code == 1 and "~/.claude/.claude.json is not valid JSON" in detail(report, "Folder trust")


def test_the_default_profile_gets_no_inner_claude_json_it_did_not_have(mac, home):
    # From the review: a stub with only projects in it would stand in for the state Claude Code keeps there.
    mac.settings(claude_dir="~/.claude", orchi_dir="~/orchi")
    (home / "orchi").mkdir()
    code, _ = go(["Folder trust"])
    assert code == 0
    assert json.loads((home / ".claude.json").read_text())["projects"][str(home / "orchi")]["hasTrustDialogAccepted"]
    assert not (home / ".claude" / ".claude.json").exists()


def test_a_broken_home_claude_json_still_lets_the_sessions_file_be_trusted(mac, home):
    # From the review: one bad file blocked the other, so Orchi's sessions still stopped at the question.
    mac.settings(claude_dir="~/.claude", orchi_dir="~/orchi")
    (home / "orchi").mkdir()
    (home / ".claude").mkdir(exist_ok=True)
    (home / ".claude" / ".claude.json").write_text(json.dumps({"numStartups": 1}))
    (home / ".claude.json").write_text("{not json")
    code, report = go(["Folder trust"])
    assert code == 1 and "~/.claude.json is not valid JSON" in detail(report, "Folder trust")
    got = json.loads((home / ".claude" / ".claude.json").read_text())
    assert got["projects"][str(home / "orchi")]["hasTrustDialogAccepted"] is True
    assert (home / ".claude.json").read_text() == "{not json"


def test_a_dangling_inner_claude_json_link_is_left_alone(mac, home, tmp_path):
    # From the review: a link to a file that has gone broke the step on every run.
    mac.settings(claude_dir="~/.claude", orchi_dir="~/orchi")
    (home / "orchi").mkdir()
    (home / ".claude").mkdir(exist_ok=True)
    (home / ".claude" / ".claude.json").symlink_to(tmp_path / "gone.json")
    code, report = go(["Folder trust"])
    assert code == 0, report
    assert json.loads((home / ".claude.json").read_text())["projects"][str(home / "orchi")]["hasTrustDialogAccepted"]
    assert not (tmp_path / "gone.json").exists()
