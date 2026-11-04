"""The steps that put Orchi's look and panels into the Herdr app: themes, mods, layout, keys, sounds, settings, the
launcher and the browser pane. Every test runs in a scratch home (HOME, HERDR_APP_HOME, ORCHI_STATE and
ORCHI_SETTINGS inside the test's own folder), with a stand-in node and agent-browser on PATH, so nothing real is read
or written."""
import json
import os
import shutil
import stat
from pathlib import Path

import pytest

from engine_help import home, snapshot  # noqa: F401
from orchi import cli, engine, paths, screen, steps, store

HERDR_STEPS = ["Themes", "Mods", "Layout", "Keys", "Sounds", "App settings", "Launcher", "Browser pane"]
NOT_SHIPPED = {"gpui-kit.d.ts", "jsconfig.json", ".DS_Store"}
OLD_SCRIPTS = ("scripts/" + "install.sh", "install" + "-browser.sh")


class Box:
    def __init__(self, home, bin):
        self.home, self.bin = home, bin
        self.app = home / ".config" / "herdr-app"
        self.command = home / ".local" / "bin" / "herdr-browser"
        self.libexec = home / ".local" / "libexec"
        self.skill = home / ".claude" / "skills" / "herdr-browser" / "SKILL.md"

    def tool(self, name, text):
        path = self.bin / name
        path.write_text(text)
        path.chmod(0o755)


@pytest.fixture
def box(home, tmp_path, monkeypatch):
    bin = tmp_path / "fake-bin"
    bin.mkdir()
    made = Box(home, bin)
    made.tool("node", "#!/bin/sh\necho 22\n")
    made.tool("agent-browser", "#!/bin/sh\nexit 0\n")
    monkeypatch.setenv("PATH", str(bin))
    return made


@pytest.fixture
def run(capsys):
    def go(*args):
        code = cli.main(["--json", *args])
        return code, json.loads(capsys.readouterr().out)

    return go


@pytest.fixture
def no_terminal(monkeypatch):
    def none():
        raise OSError("no terminal")

    monkeypatch.setattr(screen, "open_tty", none)


def answering(monkeypatch, choice):
    asked = []

    def ask(self, question, choices):
        asked.append(question)
        return next(c for c in choices if c.startswith(choice))

    monkeypatch.setattr(screen.Screen, "ask", ask)
    return asked


def by_step(report):
    return {s["name"]: s for s in report["steps"]}


def shipped(folder):
    root = paths.data_dir() / folder
    for path in sorted(root.rglob("*")):
        parts = path.relative_to(root).parts
        if (path.is_file() and path.name not in NOT_SHIPPED and not path.name.endswith((".pyc", ".error"))
                and not {"tests", "__pycache__"} & set(parts)):
            yield path.relative_to(root), path


def installed(box):
    """The first run really put things there, so a later 'nothing to do' means something."""
    assert (box.app / "mods" / "herd" / "mod.json").is_file()
    assert (box.app / "themes" / "orchi-dark.json").is_file()
    assert box.command.is_file() and box.skill.is_file()


def herdr_tree(box):
    return {"app": snapshot(box.app), "bin": snapshot(box.home / ".local" / "bin"),
            "libexec": snapshot(box.libexec), "claude": snapshot(box.home / ".claude")}


def moved_copy(tmp_path, monkeypatch, drop=()):
    """The content folders copied somewhere else, standing in for a package data folder that has moved or changed."""
    copy = tmp_path / "data-copy"
    for name in ("mods", "themes", "sounds", "skills", "bin", "config", "layouts", "keys", "browser"):
        shutil.copytree(paths.data_dir() / name, copy / name, ignore=shutil.ignore_patterns("__pycache__"))
    for gone in drop:
        (copy / gone).unlink()
    monkeypatch.setattr(paths, "data_dir", lambda: copy)
    return copy


def test_the_herdr_steps_come_after_the_settings_steps():
    assert [s.name for s in steps.steps()][3:] == HERDR_STEPS


def test_every_herdr_step_can_be_fixed():
    fixable = [s.name for s in steps.steps() if s.can_fix()]
    assert [n for n in fixable if n in HERDR_STEPS] == HERDR_STEPS


def test_a_first_run_puts_everything_in_place(box, run):
    code, report = run()
    assert code == 0, report["summary"]
    assert {n: by_step(report)[n]["status"] for n in HERDR_STEPS} == {n: "fixed" for n in HERDR_STEPS}
    for name, ending in (("themes", ".json"), ("sounds", ".mp3"), ("layouts", ".json")):
        for rel, path in shipped(name):
            if rel.suffix == ending:
                assert (box.app / name / rel).read_bytes() == path.read_bytes(), rel
    assert not (box.app / "sounds" / "README.md").exists()
    mods = {p.name for p in (paths.data_dir() / "mods").iterdir() if p.is_dir()}
    assert {p.name for p in (box.app / "mods").iterdir()} == mods
    for rel, path in shipped("mods"):
        assert (box.app / "mods" / rel).read_bytes() == path.read_bytes(), rel
    assert not list((box.app / "mods").rglob("gpui-kit.d.ts"))
    keys = json.loads((box.app / "keys.json").read_text())
    assert keys["global"]["cmd-shift-u"] == "space-agents.oldest-blocked"
    assert keys["global"]["ctrl-shift-y"] == "mod.open:tickets"
    assert keys["global"]["ctrl-shift-j"] == "panel-buttons.swap"
    assert json.loads((box.app / "settings.json").read_text()) == json.loads(
        (paths.data_dir() / "config" / "settings.json").read_text())
    launcher = box.libexec / "orchi-app" / "herdr"
    assert os.access(launcher, os.X_OK)
    assert str(paths.data_dir() / "bin" / "herdr") in launcher.read_text()
    assert os.access(box.command, os.X_OK)
    wrapper = box.command.read_text()
    assert f'AGENT_BROWSER_BIN="{box.bin / "agent-browser"}"' in wrapper
    assert f'exec "{box.bin / "node"}" "{box.libexec / "herdr-browser"}/herdr-browser.mjs"' in wrapper
    for rel, path in shipped("browser"):
        assert (box.libexec / "herdr-browser" / rel).read_bytes() == path.read_bytes()
    assert box.skill.read_bytes() == (paths.data_dir() / "skills" / "herdr-browser" / "SKILL.md").read_bytes()
    programs = json.loads((box.app / "programs.json").read_text())["programs"]
    assert programs["herdr-browser"]["run"] == [str(box.command), "pane"]


def test_nothing_is_a_link_so_a_moved_data_folder_leaves_the_install_working(box, run, tmp_path, monkeypatch):
    moved_copy(tmp_path, monkeypatch)
    assert run()[0] == 0
    links = [p for root in (box.app, box.libexec) for p in root.rglob("*") if p.is_symlink()]
    assert links == []
    shutil.rmtree(tmp_path / "data-copy")
    assert (box.app / "mods" / "herd" / "mod.json").is_file()
    assert (box.app / "themes" / "orchi-dark.json").is_file()


def test_a_second_run_finds_nothing_to_do_and_changes_nothing(box, run):
    assert run()[0] == 0
    installed(box)
    before = herdr_tree(box)
    code, report = run()
    assert code == 0
    assert {s["status"] for s in report["steps"]} == {"ok"}
    assert report["changed"] == [] and report["backup"] is None
    assert report["summary"] == "All set."
    assert herdr_tree(box) == before


def test_doctor_after_a_run_has_nothing_to_report(box, run):
    run()
    installed(box)
    code, report = run("doctor")
    assert code == 0 and report["summary"] == "All set."


def test_everything_put_there_is_recorded_as_orchis(box, run):
    run()
    owned = {r["path"] for r in store.Store().owned()}
    for rel, _ in shipped("mods"):
        assert str(box.app / "mods" / rel) in owned
    for path in (box.command, box.libexec / "orchi-app" / "herdr", box.skill, box.app / "keys.json",
                 box.app / "settings.json", box.app / "programs.json", box.app / "layouts" / "main-linear.json",
                 box.app / "themes" / "orchi-dark.json", box.app / "sounds" / "done.mp3"):
        assert str(path) in owned, path


def test_a_file_edited_by_the_user_is_named_by_doctor_and_backed_up_before_it_is_replaced(box, run):
    run()
    edited = box.app / "mods" / "herd" / "main.js"
    original = edited.read_bytes()
    edited.write_text("// mine\n")
    code, report = run("doctor")
    assert code == 1
    assert by_step(report)["Mods"]["status"] == "needs-fix"
    assert "herd/main.js" in by_step(report)["Mods"]["detail"]
    assert edited.read_text() == "// mine\n"
    code, report = run()
    assert code == 0 and report["changed"] == ["Mods"]
    assert edited.read_bytes() == original
    assert (Path(report["backup"]) / str(edited).lstrip("/")).read_text() == "// mine\n"


def test_a_file_another_tool_put_in_orchis_place_is_backed_up_not_lost(box, run):
    (box.app / "themes").mkdir(parents=True)
    (box.app / "themes" / "orchi-dark.json").write_text('{"theirs": true}')
    code, report = run()
    assert code == 0
    assert (box.app / "themes" / "orchi-dark.json").read_bytes() == (
        paths.data_dir() / "themes" / "orchi-dark.json").read_bytes()
    assert (Path(report["backup"]) / str(box.app / "themes" / "orchi-dark.json").lstrip("/")).read_text() == (
        '{"theirs": true}')


def test_an_older_install_that_linked_the_themes_is_replaced_by_copies_and_the_links_are_kept(box, run):
    (box.app / "themes").mkdir(parents=True)
    link = box.app / "themes" / "orchi-light.json"
    link.symlink_to(paths.data_dir() / "themes" / "orchi-light.json")
    code, report = run()
    assert code == 0 and not link.is_symlink() and link.is_file()
    kept = Path(report["backup"]) / str(link).lstrip("/")
    assert kept.is_symlink() and os.readlink(kept) == str(paths.data_dir() / "themes" / "orchi-light.json")


def test_files_orchi_did_not_put_there_are_never_deleted(box, run):
    run()
    installed(box)
    strays = {
        box.app / "mods" / "panel-buttons" / "stray.svg": "<svg/>",
        box.app / "mods" / "panel-buttons" / "main.js.error": "kept by the app",
        box.app / "mods" / "herd" / "gpui-kit.d.ts": "generated",
        box.app / "mods" / "other-tool" / "mod.json": "{}",
        box.app / "themes" / "mine.json": "{}",
        box.app / "sounds" / "mine.mp3": "x",
        box.app / "layouts" / "mine.json": "{}",
        box.libexec / "herdr-browser" / "extra.mjs": "x",
    }
    for path, text in strays.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    for _ in range(2):
        code, report = run()
        assert code == 0 and report["changed"] == []
    assert run("doctor")[0] == 0
    for path, text in strays.items():
        assert path.read_text() == text, path


def test_a_file_orchi_made_that_the_data_folder_dropped_goes_but_an_edited_one_stays(box, run, tmp_path, monkeypatch):
    copy = moved_copy(tmp_path, monkeypatch)
    assert run()[0] == 0
    dropped, edited = box.app / "mods" / "herd" / "herd.svg", box.app / "mods" / "herd" / "tone-read.svg"
    edited.write_text("mine")
    (copy / "mods" / "herd" / "herd.svg").unlink()
    (copy / "mods" / "herd" / "tone-read.svg").unlink()
    code, report = run("doctor")
    assert code == 1 and "herd/herd.svg" in by_step(report)["Mods"]["detail"]
    assert "herd/tone-read.svg" not in by_step(report)["Mods"]["detail"]
    assert dropped.exists()
    code, report = run()
    assert code == 0 and not dropped.exists()
    assert edited.read_text() == "mine"
    assert run("doctor")[0] == 0


def test_doctor_names_each_drift_and_changes_nothing(box, run):
    run()
    (box.app / "sounds" / "done.mp3").unlink()
    (box.app / "themes" / "orchi-dark.json").write_text("{}")
    keys = json.loads((box.app / "keys.json").read_text())
    del keys["global"]["cmd-shift-u"]
    (box.app / "keys.json").write_text(json.dumps(keys))
    settings = json.loads((box.app / "settings.json").read_text())
    del settings["sounds"]["done"]
    (box.app / "settings.json").write_text(json.dumps(settings))
    box.command.unlink()
    shutil.rmtree(box.app / "mods" / "plan-view")
    before = {"tree": herdr_tree(box), "state": snapshot(os.environ["ORCHI_STATE"])}
    code, report = run("doctor")
    assert code == 1
    found = by_step(report)
    assert {n for n in HERDR_STEPS if found[n]["status"] == "needs-fix"} == {
        "Themes", "Mods", "Keys", "Sounds", "App settings", "Browser pane"}
    assert "done.mp3" in found["Sounds"]["detail"]
    assert "orchi-dark.json" in found["Themes"]["detail"]
    assert "plan-view/mod.json" in found["Mods"]["detail"]
    assert "herdr-browser" in found["Browser pane"]["detail"]
    assert report["to_fix"] == ["Themes", "Mods", "Keys", "Sounds", "App settings", "Browser pane"]
    assert {"tree": herdr_tree(box), "state": snapshot(os.environ["ORCHI_STATE"])} == before
    code, report = run()
    assert code == 0 and run("doctor")[0] == 0


def test_a_mod_folder_that_is_a_link_is_left_alone_and_named(box, run, tmp_path):
    (box.app / "mods").mkdir(parents=True)
    target = tmp_path / "dev-mod"
    target.mkdir()
    (box.app / "mods" / "herd").symlink_to(target)
    code, report = run()
    assert code == 1
    assert by_step(report)["Mods"]["status"] == "broken"
    assert "herd" in by_step(report)["Mods"]["detail"] and "link" in by_step(report)["Mods"]["detail"]
    assert (box.app / "mods" / "herd").is_symlink() and list(target.iterdir()) == []
    assert by_step(report)["Sounds"]["status"] == "fixed"


def test_a_new_mod_gets_its_mod_json_before_anything_else(box, monkeypatch):
    written = []
    real = engine.Context.write

    def spy(self, path, data, mode=None):
        written.append(Path(path))
        return real(self, path, data, mode)

    monkeypatch.setattr(engine.Context, "write", spy)
    cli.main([])
    mods = [p for p in written if box.app / "mods" in p.parents]
    assert len(mods) > 50
    seen = set()
    for path in mods:
        folder = path.parent
        if folder not in seen:
            assert path.name == "mod.json", path
            seen.add(folder)


# The layout

def stray_layout(extra="browser-pane"):
    layout = json.loads((paths.data_dir() / "layouts" / "main-linear.json").read_text())
    layout["children"].append({"id": "extra", "type": "block", "content": {"mod": extra}})
    return json.dumps(layout)


def test_a_layout_holding_a_mod_orchi_lacks_is_not_replaced_when_there_is_no_one_to_ask(box, run, no_terminal):
    path = box.app / "layouts" / "main-linear.json"
    path.parent.mkdir(parents=True)
    path.write_text(stray_layout())
    code, report = run()
    assert code == 1
    layout = by_step(report)["Layout"]
    assert layout["status"] == "broken" and "browser-pane" in layout["detail"]
    assert path.read_text() == stray_layout()
    assert by_step(report)["Keys"]["status"] == "fixed"
    assert "browser-pane" in by_step(run("doctor")[1])["Layout"]["detail"]


def test_a_layout_with_a_mod_orchi_lacks_is_replaced_with_a_backup_when_the_answer_is_yes(box, run, monkeypatch):
    path = box.app / "layouts" / "main-linear.json"
    path.parent.mkdir(parents=True)
    path.write_text(stray_layout())
    asked = answering(monkeypatch, "Replace")
    code, report = run()
    assert code == 0 and len(asked) == 1 and "browser-pane" in asked[0]
    assert path.read_bytes() == (paths.data_dir() / "layouts" / "main-linear.json").read_bytes()
    assert (Path(report["backup"]) / str(path).lstrip("/")).read_text() == stray_layout()


def test_a_layout_is_kept_when_the_answer_is_keep_and_asked_about_again_next_time(box, run, monkeypatch):
    path = box.app / "layouts" / "main-linear.json"
    path.parent.mkdir(parents=True)
    path.write_text(stray_layout())
    answering(monkeypatch, "Keep")
    code, report = run()
    assert code == 1 and by_step(report)["Layout"]["status"] == "broken"
    assert path.read_text() == stray_layout()
    asked = answering(monkeypatch, "Replace")
    assert run()[0] == 0 and len(asked) == 1


def test_an_edited_layout_that_loses_no_mod_is_replaced_without_asking(box, run, monkeypatch):
    run()
    path = box.app / "layouts" / "main-linear.json"
    layout = json.loads(path.read_text())
    layout["id"] = "mine"
    path.write_text(json.dumps(layout))
    asked = answering(monkeypatch, "Keep")
    code, report = run()
    assert code == 0 and asked == []
    assert path.read_bytes() == (paths.data_dir() / "layouts" / "main-linear.json").read_bytes()
    assert json.loads((Path(report["backup"]) / str(path).lstrip("/")).read_text())["id"] == "mine"


def test_a_layout_orchi_made_is_replaced_without_asking_when_a_new_version_drops_a_mod(box, run, tmp_path,
                                                                                          monkeypatch):
    current = (paths.data_dir() / "layouts" / "main-linear.json").read_text()
    copy = moved_copy(tmp_path, monkeypatch)
    (copy / "layouts" / "main-linear.json").write_text(stray_layout("old-mod"))
    assert run()[0] == 0
    (copy / "layouts" / "main-linear.json").write_text(current)
    asked = answering(monkeypatch, "Keep")
    code, _ = run()
    assert code == 0 and asked == []
    assert "old-mod" not in (box.app / "layouts" / "main-linear.json").read_text()


def test_a_layout_that_is_a_link_is_replaced_by_a_copy_and_the_link_kept(box, run, tmp_path):
    (box.app / "layouts").mkdir(parents=True)
    path = box.app / "layouts" / "main-linear.json"
    path.symlink_to(paths.data_dir() / "layouts" / "main-linear.json")
    code, report = run()
    assert code == 0 and not path.is_symlink()
    assert (Path(report["backup"]) / str(path).lstrip("/")).is_symlink()


# Keys and settings

def test_keys_gain_the_bindings_orchi_names_and_keep_the_rest(box, run):
    box.app.mkdir(parents=True)
    (box.app / "keys.json").write_text(json.dumps({
        "global": {"cmd-shift-u": "mine.other", "cmd-k": "mine.k"}, "terminal": {"cmd-t": "mine.t"}}))
    code, report = run()
    assert code == 0
    keys = json.loads((box.app / "keys.json").read_text())
    assert keys["global"]["cmd-shift-u"] == "space-agents.oldest-blocked"
    assert keys["global"]["cmd-k"] == "mine.k" and keys["terminal"] == {"cmd-t": "mine.t"}
    assert json.loads((Path(report["backup"]) / str(box.app / "keys.json").lstrip("/")).read_text())["global"][
        "cmd-shift-u"] == "mine.other"


def test_settings_only_gain_missing_keys_at_any_depth(box, run):
    box.app.mkdir(parents=True)
    (box.app / "settings.json").write_text(json.dumps(
        {"font": "Mine", "sounds": {"enabled": False, "done": "mine.mp3"}, "zoom": 1.2}))
    code, _ = run()
    assert code == 0
    settings = json.loads((box.app / "settings.json").read_text())
    assert settings["font"] == "Mine" and settings["zoom"] == 1.2
    assert settings["sounds"] == {"enabled": False, "done": "mine.mp3", "blocked": "sounds/needs-you.mp3"}
    assert settings["ui_font"] == "Geist"
    assert run()[1]["changed"] == []


@pytest.mark.parametrize("name,step", [("keys.json", "Keys"), ("settings.json", "App settings"),
                                       ("programs.json", "Browser pane")])
@pytest.mark.parametrize("text", ["{half", "[]"])
def test_a_json_file_orchi_cannot_read_is_named_and_left_as_it_is(box, run, name, step, text):
    box.app.mkdir(parents=True)
    (box.app / name).write_text(text)
    code, report = run()
    assert code == 1
    assert by_step(report)[step]["status"] == "broken" and name in by_step(report)[step]["detail"]
    assert (box.app / name).read_text() == text
    assert by_step(report)["Themes"]["status"] == "fixed"


# The browser pane

@pytest.mark.parametrize("fake,reason", [
    ({"node": None}, "node is not on PATH"),
    ({"agent-browser": None}, "agent-browser is not on PATH"),
    ({"node": "#!/bin/sh\necho 20\n"}, "is version 20"),
    ({"node": "#!/bin/sh\n"}, "could not read the version"),
    ({"node": "#!/bin/sh\necho 'v22.1.0 warning'\n"}, "could not read the version"),
])
def test_the_browser_pane_names_what_is_missing_and_the_rest_carries_on(box, run, fake, reason):
    for name, text in fake.items():
        if text is None:
            (box.bin / name).unlink()
        else:
            box.tool(name, text)
    code, report = run()
    assert code == 1
    pane = by_step(report)["Browser pane"]
    assert pane["status"] == "broken" and reason in pane["detail"]
    assert not box.command.exists() and not box.skill.exists()
    assert by_step(report)["Mods"]["status"] == "fixed"


def write_settings(home, claude_dir):
    file = home / ".config" / "orchi" / "settings.json"
    file.parent.mkdir(parents=True)
    file.write_text(json.dumps({"claude_dir": claude_dir}))


def test_the_skill_goes_to_every_claude_folder_that_exists_once(box, run, tmp_path, monkeypatch):
    (box.home / ".claude").mkdir()
    (box.home / ".claude-alt").mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    write_settings(box.home, "~/.claude-alt")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(elsewhere))
    assert run()[0] == 0
    for folder in (box.home / ".claude", box.home / ".claude-alt", elsewhere):
        assert (folder / "skills" / "herdr-browser" / "SKILL.md").is_file(), folder
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(box.home / ".claude-alt") + "/")
    assert run()[1]["changed"] == []


def test_a_folder_that_does_not_exist_gets_no_skill_and_with_none_at_all_it_goes_to_dot_claude(box, run, monkeypatch):
    write_settings(box.home, "~/.claude-alt")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(box.home / "nowhere"))
    assert run()[0] == 0
    assert box.skill.is_file()
    assert not (box.home / ".claude-alt").exists() and not (box.home / "nowhere").exists()
    assert run("doctor")[0] == 0


def test_a_broken_settings_file_is_no_settings_for_the_skill_folders(box, run):
    (box.home / ".claude-alt").mkdir()
    (box.home / ".config" / "orchi").mkdir(parents=True)
    (box.home / ".config" / "orchi" / "settings.json").write_text("{")
    code, report = run()
    assert by_step(report)["Browser pane"]["status"] == "fixed"
    assert box.skill.is_file() and not (box.home / ".claude-alt" / "skills").exists()


def test_the_menu_entry_keeps_the_other_programs(box, run):
    box.app.mkdir(parents=True)
    (box.app / "programs.json").write_text(json.dumps({"programs": {"other": {"name": "Other"}}}))
    assert run()[0] == 0
    programs = json.loads((box.app / "programs.json").read_text())["programs"]
    assert sorted(programs) == ["herdr-browser", "other"]


def test_a_new_command_path_updates_the_command_and_the_menu_entry(box, run, tmp_path, monkeypatch):
    run()
    newer = tmp_path / "newer-bin"
    newer.mkdir()
    (newer / "node").write_text("#!/bin/sh\necho 24\n")
    (newer / "node").chmod(0o755)
    monkeypatch.setenv("PATH", f"{newer}{os.pathsep}{box.bin}")
    code, report = run("doctor")
    assert code == 1 and "herdr-browser" in by_step(report)["Browser pane"]["detail"]
    assert run()[0] == 0
    assert f'exec "{newer / "node"}"' in box.command.read_text()
    assert run("doctor")[0] == 0


# A private window

@pytest.fixture
def private(box, tmp_path, monkeypatch):
    app = tmp_path / "private" / "app"
    monkeypatch.setenv("HERDR_APP_HOME", str(app))
    box.private = app
    return box


def test_a_private_window_gets_the_content_but_not_the_launcher_command_or_skill(private, run):
    code, report = run()
    found = by_step(report)
    assert code == 0, report["summary"]
    assert found["Launcher"]["status"] == "ok" and found["Browser pane"]["status"] == "ok"
    assert (private.private / "mods" / "herd" / "mod.json").is_file()
    assert (private.private / "themes" / "orchi-dark.json").is_file()
    assert not (private.home / ".local" / "libexec").exists() and not (private.home / ".local" / "bin").exists()
    assert not private.command.exists() and not private.skill.exists()
    assert not (private.private / "programs.json").exists()


def test_a_private_window_gets_the_menu_entry_when_the_command_is_already_on_this_mac(private, run):
    private.command.parent.mkdir(parents=True)
    private.command.write_text("#!/bin/sh\n")
    private.command.chmod(0o755)
    assert run()[0] == 0
    programs = json.loads((private.private / "programs.json").read_text())["programs"]
    assert programs["herdr-browser"]["run"] == [str(private.command), "pane"]
    assert not private.skill.exists() and not (private.libexec / "herdr-browser").exists()
    assert run()[1]["changed"] == []


# Stopped and started again

def test_a_run_that_stops_part_way_is_finished_by_the_next(box, run, monkeypatch):
    real = engine.Context.write
    calls = []

    def flaky(self, path, data, mode=None):
        calls.append(path)
        if len(calls) == 20:
            raise OSError("disk full")
        return real(self, path, data, mode)

    monkeypatch.setattr(engine.Context, "write", flaky)
    code, report = run()
    assert code == 1 and by_step(report)["Mods"]["status"] == "broken"
    monkeypatch.setattr(engine.Context, "write", real)
    code, report = run()
    assert code == 0
    assert run()[1]["changed"] == []
    for rel, path in shipped("mods"):
        assert (box.app / "mods" / rel).read_bytes() == path.read_bytes(), rel
    owned = {r["path"] for r in store.Store().owned()}
    assert all(str(box.app / "mods" / rel) in owned for rel, _ in shipped("mods"))


def test_the_launcher_follows_the_data_folder_when_it_moves(box, run, tmp_path, monkeypatch):
    run()
    copy = moved_copy(tmp_path, monkeypatch)
    code, report = run("doctor")
    assert code == 1 and by_step(report)["Launcher"]["status"] == "needs-fix"
    assert run()[0] == 0
    assert str(copy / "bin" / "herdr") in (box.libexec / "orchi-app" / "herdr").read_text()


def test_a_launcher_someone_else_wrote_is_backed_up_before_it_is_replaced(box, run):
    launcher = box.libexec / "orchi-app" / "herdr"
    launcher.parent.mkdir(parents=True)
    launcher.write_text("#!/bin/sh\nexec mine\n")
    code, report = run()
    assert code == 0
    assert (Path(report["backup"]) / str(launcher).lstrip("/")).read_text() == "#!/bin/sh\nexec mine\n"


# The engine's remove

def test_remove_takes_away_only_what_orchi_made_and_still_owns(home, tmp_path):
    class Probe(engine.Step):
        name = "Probe"

        def __init__(self, files):
            self.files, self.results = files, []

        def check(self):
            return engine.needs_fix("x")

        def fix(self, ctx):
            ctx.write(self.files[0], "mine")
            self.results = [ctx.remove(p) for p in (*self.files, tmp_path / "nothing")]

    made, theirs, edited, folder = (tmp_path / n for n in ("made", "theirs", "edited", "folder"))
    theirs.write_text("theirs")
    folder.mkdir()
    first = Probe([made])
    engine.run([first], fix=True, screen=screen.Screen(open(os.devnull, "w")), store=store.Store())
    assert first.results == [True, False] and not made.exists()
    edited.write_text("orchi")
    st = store.Store()
    st.own(edited, "file", "Probe")
    edited.write_text("edited by someone, longer")
    second = Probe([edited])
    second.fix = lambda ctx: setattr(second, "results", [ctx.remove(edited), ctx.remove(theirs), ctx.remove(folder)])
    engine.run([second], fix=True, screen=screen.Screen(open(os.devnull, "w")), store=store.Store())
    assert second.results == [False, False, False]
    assert edited.exists() and theirs.exists() and folder.is_dir()


# The old scripts are gone

def test_no_file_still_points_at_the_old_install_scripts():
    root = Path(__file__).resolve().parent.parent
    assert not (root / "scripts" / "install.sh").exists()
    assert not (root / "scripts" / "install-browser.sh").exists()
    found = []
    for here, folders, files in os.walk(root):
        folders[:] = [f for f in folders if f not in {".git", "node_modules", "__pycache__", ".pytest_cache", "dist"}]
        for name in files:
            path = Path(here) / name
            if path == Path(__file__):
                continue
            try:
                text = path.read_text()
            except (UnicodeDecodeError, OSError):
                continue
            if any(old in text for old in OLD_SCRIPTS):
                found.append(str(path.relative_to(root)))
    assert found == []


def test_the_scratch_environment_for_a_real_install_has_no_claude_profile_of_the_developers(tmp_path, monkeypatch):
    from conftest import scratch_env
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "real-profile"))
    assert "CLAUDE_CONFIG_DIR" not in scratch_env(tmp_path / "scratch")


def test_a_change_made_to_programs_json_while_the_run_is_going_is_kept(box, run, monkeypatch):
    box.app.mkdir(parents=True)
    programs = box.app / "programs.json"
    programs.write_text(json.dumps({"programs": {}}))
    real = engine.Context.write

    def late(self, path, data, mode=None):
        if Path(path).name == "SKILL.md":
            programs.write_text(json.dumps({"programs": {"added-meanwhile": {"name": "Late"}}}))
        return real(self, path, data, mode)

    monkeypatch.setattr(engine.Context, "write", late)
    assert run()[0] == 0
    assert sorted(json.loads(programs.read_text())["programs"]) == ["added-meanwhile", "herdr-browser"]


def test_a_content_folder_that_has_gone_does_not_empty_the_install(box, run, tmp_path, monkeypatch):
    copy = moved_copy(tmp_path, monkeypatch)
    assert run()[0] == 0
    shutil.rmtree(copy / "themes")
    code, report = run()
    assert code == 1 and by_step(report)["Themes"]["status"] == "broken"
    assert (box.app / "themes" / "orchi-dark.json").is_file()
    assert (box.app / "themes" / "orchi-light.json").is_file()


def test_a_linked_keys_file_is_written_through_and_stays_a_link(box, run, tmp_path):
    target = tmp_path / "dotfiles" / "keys.json"
    target.parent.mkdir()
    target.write_text(json.dumps({"global": {"cmd-k": "mine.k"}}))
    box.app.mkdir(parents=True)
    (box.app / "keys.json").symlink_to(target)
    code, _ = run()
    assert code == 0
    assert (box.app / "keys.json").is_symlink()
    keys = json.loads(target.read_text())
    assert keys["global"]["cmd-k"] == "mine.k" and keys["global"]["cmd-shift-u"] == "space-agents.oldest-blocked"
    assert run()[1]["changed"] == []


def test_a_value_of_the_wrong_type_is_corrected_even_when_it_compares_equal(box, run):
    run()
    path = box.app / "programs.json"
    path.write_text(path.read_text().replace('"tint": true', '"tint": 1'))
    code, report = run("doctor")
    assert code == 1 and by_step(report)["Browser pane"]["status"] == "needs-fix"
    assert run()[0] == 0
    assert '"tint": true' in path.read_text()


def test_a_mod_the_package_dropped_goes_whole_when_nothing_else_is_in_its_folder(box, run, tmp_path, monkeypatch):
    copy = moved_copy(tmp_path, monkeypatch)
    assert run()[0] == 0
    shutil.rmtree(copy / "mods" / "plan-view")
    code, report = run("doctor")
    assert code == 1 and "plan-view" in by_step(report)["Mods"]["detail"]
    assert run()[0] == 0
    assert not (box.app / "mods" / "plan-view").exists()
    assert run("doctor")[0] == 0
    assert str(box.app / "mods" / "plan-view") not in {r["path"] for r in store.Store().owned()}


def test_a_dropped_mods_folder_stays_while_something_else_is_in_it(box, run, tmp_path, monkeypatch):
    copy = moved_copy(tmp_path, monkeypatch)
    assert run()[0] == 0
    (box.app / "mods" / "plan-view" / "mine.txt").write_text("mine")
    shutil.rmtree(copy / "mods" / "plan-view")
    assert run()[0] == 0
    assert [p.name for p in (box.app / "mods" / "plan-view").iterdir()] == ["mine.txt"]
    assert run("doctor")[0] == 0


def test_one_profile_folder_reached_two_ways_gets_the_skill_once(box, run, monkeypatch):
    (box.home / ".claude-alt").mkdir()
    (box.home / ".claude").symlink_to(box.home / ".claude-alt")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(box.home / ".claude-alt"))
    code, report = run()
    assert code == 0 and report["backup"] is None
    assert (box.home / ".claude-alt" / "skills" / "herdr-browser" / "SKILL.md").is_file()
    assert run()[1]["changed"] == []


def test_a_path_with_quotes_and_dollar_signs_still_runs_the_browser_command(box, run, tmp_path, monkeypatch):
    odd = tmp_path / 'we"ird $HOME `x` back\\slash'
    odd.mkdir()
    for name, text in (("node", "#!/bin/sh\necho 22\n"), ("agent-browser", "#!/bin/sh\nexit 0\n")):
        (odd / name).write_text(text)
        (odd / name).chmod(0o755)
    monkeypatch.setenv("PATH", str(odd))
    assert run()[0] == 0
    import subprocess
    done = subprocess.run(["/bin/sh", str(box.command)], capture_output=True, text=True, env={"PATH": "/usr/bin:/bin"})
    assert done.returncode == 0 and done.stdout == "22\n", done.stderr
    assert run()[1]["changed"] == []


@pytest.mark.parametrize("text,what", [("", None), ("  \n", None), ("{half", "not valid JSON"), ("[]", "not a JSON object")])
def test_an_empty_json_file_counts_as_empty_and_a_bad_one_says_what_is_wrong(box, run, text, what):
    box.app.mkdir(parents=True)
    (box.app / "keys.json").write_text(text)
    code, report = run()
    keys = by_step(report)["Keys"]
    if what is None:
        assert code == 0 and "cmd-shift-u" in (box.app / "keys.json").read_text()
    else:
        assert code == 1 and keys["status"] == "broken" and what in keys["detail"]


def test_an_unreadable_json_file_says_it_cannot_be_read(box, run):
    box.app.mkdir(parents=True)
    (box.app / "keys.json").symlink_to(box.app / "nowhere.json")
    code, report = run()
    assert code == 1 and "can't be read" in by_step(report)["Keys"]["detail"]


def test_an_install_from_before_the_tickets_panel_moves_to_it_with_no_question(box, run, tmp_path, monkeypatch):
    """An install with the Linear panel: its folder, its layout block and its key go to the tickets panel's."""
    real = paths.data_dir()
    layout = (real / "layouts" / "main-linear.json").read_text()
    keys = (real / "keys" / "tickets.json").read_text()
    copy = moved_copy(tmp_path, monkeypatch)
    shutil.copytree(copy / "mods" / "tickets", copy / "mods" / "linear")
    (copy / "layouts" / "main-linear.json").write_text(layout.replace('"tickets"', '"linear"'))
    (copy / "keys" / "tickets.json").unlink()
    (copy / "keys" / "linear.json").write_text(keys.replace("mod.open:tickets", "mod.open:linear"))
    shutil.rmtree(copy / "mods" / "tickets")
    assert run()[0] == 0
    assert (box.app / "mods" / "linear" / "main.js").exists()

    shutil.rmtree(copy / "mods" / "linear")
    shutil.copytree(real / "mods" / "tickets", copy / "mods" / "tickets", ignore=shutil.ignore_patterns("__pycache__"))
    (copy / "layouts" / "main-linear.json").write_text(layout)
    (copy / "keys" / "linear.json").unlink()
    (copy / "keys" / "tickets.json").write_text(keys)
    asked = answering(monkeypatch, "Keep")
    assert run()[0] == 0 and asked == []
    assert not (box.app / "mods" / "linear").exists()
    assert (box.app / "mods" / "tickets" / "main.js").exists()
    assert '"tickets"' in (box.app / "layouts" / "main-linear.json").read_text()
    assert '"linear"' not in (box.app / "layouts" / "main-linear.json").read_text()
    assert json.loads((box.app / "keys.json").read_text())["global"]["ctrl-shift-y"] == "mod.open:tickets"
    assert run("doctor")[0] == 0
