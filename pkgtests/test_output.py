"""What `orchi` shows: in a terminal, under NO_COLOR, piped and with --json, and its questions under `curl | sh`."""
import io
import json
import os
import re
import subprocess
import sys

from engine_help import DRIVER, child_env, home, in_terminal, tools  # noqa: F401
from orchi import engine, screen, store

SGR = re.compile(r"\x1b\[([0-9;]*)m")
SPINNER = set("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")
# The sixteen colours Orchi's themes set for the terminal, as foreground codes, and resets and dim.
THEME_CODES = {"", "0", "1", "2", "22", "39"} | {str(n) for n in range(30, 38)} | {str(n) for n in range(90, 98)}


def visible(text):
    """What a terminal ends up showing: colours dropped, and each line as it was last redrawn."""
    text = SGR.sub("", text).replace("\x1b[2K", "")
    return [line.split("\r")[-1] for line in text.split("\n")]


def lines_of(text):
    return [line for line in visible(text) if line.strip()]


# Lines

def test_each_step_is_a_mark_and_its_name_in_aligned_columns(home):
    out = io.StringIO()
    s = screen.Screen(out)
    s.begin(["Short", "A much longer name"])
    s.result("Short", "needs-fix", "missing")
    s.result("A much longer name", "broken", "no disk")
    first, second = out.getvalue().splitlines()
    assert first.startswith("!  Short") and second.startswith("✗  A much longer name")
    assert first.index("missing") == second.index("no disk")


def test_a_line_with_nothing_to_say_has_no_trailing_space():
    out = io.StringIO()
    s = screen.Screen(out)
    s.begin(["Fine", "Longer name"])
    s.result("Fine", "ok", "")
    assert out.getvalue() == "✓  Fine\n"


def test_output_has_no_em_dash(home):
    out = io.StringIO()

    class Bad(engine.Step):
        name = "Bad"

        def check(self):
            return engine.broken("no disk")

    engine.run([Bad()], fix=True, screen=screen.Screen(out), store=store.Store())
    assert "\u2014" not in out.getvalue()


# In a terminal

def test_in_a_terminal_it_is_coloured_from_the_theme_and_the_running_step_spins(home, tmp_path):
    code, shown = in_terminal([str(DRIVER), "slow"], child_env(DRIVE_DIR=str(tmp_path)))
    assert code == 0, shown
    assert SPINNER & set(shown)
    codes = {part for match in SGR.findall(shown) for part in match.split(";")}
    assert codes <= THEME_CODES, codes
    assert "32" in codes
    assert lines_of(shown) == ["✓  Slow", "✓  First file   fixed", "✓  Second file  fixed",
                               "Changed: First file, Second file."]


def test_no_color_in_a_terminal_is_plain_text(home, tmp_path):
    code, shown = in_terminal([str(DRIVER), "slow"], child_env(DRIVE_DIR=str(tmp_path), NO_COLOR="1"))
    assert code == 0, shown
    assert "\x1b" not in shown and "\r" not in shown
    assert not SPINNER & set(shown)
    assert shown.splitlines() == ["✓  Slow", "✓  First file   fixed", "✓  Second file  fixed", "",
                                  "Changed: First file, Second file."]


def test_a_dumb_terminal_is_plain_text(home, tmp_path):
    code, shown = in_terminal([str(DRIVER), "files"], child_env(DRIVE_DIR=str(tmp_path), TERM="dumb"))
    assert code == 0, shown
    assert "\x1b" not in shown and "\r" not in shown


def test_piped_output_is_plain_text(home, tmp_path):
    done = subprocess.run([sys.executable, str(DRIVER), "slow"], env=child_env(DRIVE_DIR=str(tmp_path)),
                          capture_output=True, text=True, timeout=30)
    assert done.returncode == 0, done.stderr
    assert "\x1b" not in done.stdout and "\r" not in done.stdout
    assert done.stdout.splitlines() == ["✓  Slow", "✓  First file   fixed", "✓  Second file  fixed", "",
                                        "Changed: First file, Second file."]


def test_json_in_a_terminal_is_only_json(home, tmp_path):
    code, shown = in_terminal([str(DRIVER), "slow", "--json"], child_env(DRIVE_DIR=str(tmp_path)))
    assert code == 0, shown
    data = json.loads(shown)
    assert [s["status"] for s in data["steps"]] == ["ok", "fixed", "fixed"]


# Questions

def test_a_question_reads_the_terminal_even_when_stdin_is_a_pipe(home, tmp_path):
    code, shown = in_terminal([str(DRIVER), "ask"], child_env(DRIVE_DIR=str(tmp_path)), pipe_stdin=True,
                              answers=[("Light", "2\n")])
    assert code == 0, shown
    assert (tmp_path / "theme").read_text() == "Light"
    assert "Which theme" in shown
    assert lines_of(shown)[-1] == "Changed: Theme."


def test_a_question_with_no_terminal_fails_the_step_instead_of_waiting(home, tmp_path):
    done = subprocess.run([sys.executable, str(DRIVER), "ask"], env=child_env(DRIVE_DIR=str(tmp_path)),
                          stdin=subprocess.PIPE, capture_output=True, text=True, timeout=20, start_new_session=True)
    assert done.returncode == 1
    assert done.stdout.splitlines() == ["✗  Theme  needs a terminal to answer: Which theme", "",
                                         "Needs you: Theme."]


# The closing lines

def test_the_closing_line_stands_apart_from_the_steps(home):
    out = io.StringIO()

    class Bad(engine.Step):
        name = "Bad"

        def check(self):
            return engine.broken("no disk")

    engine.run([Bad()], fix=True, screen=screen.Screen(out), store=store.Store())
    assert out.getvalue().splitlines() == ["✗  Bad  no disk", "", "Needs you: Bad."]


def test_the_backup_and_each_note_have_a_line_of_their_own():
    summary = engine._summary(["Themes"], [], [], False, "/b/1", notes=["Undo: cp a b", "Delete the backup."])
    assert summary.splitlines() == ["Changed: Themes.", "Backup: /b/1", "Undo: cp a b", "Delete the backup."]


def test_a_closing_line_with_no_steps_above_it_has_no_gap():
    out = io.StringIO()
    screen.Screen(out).finish({"summary": "Nothing to remove."})
    assert out.getvalue() == "Nothing to remove.\n"


# The real command

def orchi(*argv):
    """Python's arguments for `orchi argv`, with the settings and Herdr steps only: a whole run would start installers,
    which these tests are not about and which must never run for real."""
    return [str(DRIVER.with_name("orchi_driver.py")), *argv]


def run_orchi(*argv):
    """`orchi argv` with its output piped."""
    return subprocess.run([sys.executable, *orchi(*argv)], env=child_env(), capture_output=True, text=True,
                          timeout=30)


def test_bare_orchi_in_a_terminal(home, tools):
    code, shown = in_terminal(orchi(), child_env())
    assert code == 0, shown
    lines = lines_of(shown)
    assert lines[:3] == ["✓  Orchi files", "✓  Settings folder  created", "✓  Settings"]
    assert [line.split()[1] for line in lines[3:-1]] == ["Themes", "Mods", "Layout", "Keys", "Sounds", "App",
                                                         "Launcher", "Browser"]
    assert lines[-1] == ("Changed: Settings folder, Themes, Mods, Layout, Keys, Sounds, App settings, Launcher, "
                         "Browser pane.")


def test_doctor_in_a_terminal_under_no_color_piped_and_with_json(home, tools):
    code, shown = in_terminal(orchi("doctor"), child_env())
    assert code == 1, shown
    lines = lines_of(shown)
    assert lines[:3] == ["✓  Orchi files", "!  Settings folder  missing", "✓  Settings"]
    assert lines[-1] == ("Run orchi to fix: Settings folder, Themes, Mods, Layout, Keys, Sounds, App settings, "
                         "Launcher, Browser pane.")

    code, shown = in_terminal(orchi("doctor"), child_env(NO_COLOR="1"))
    assert code == 1 and "\x1b" not in shown
    assert shown.splitlines()[-1].startswith("Run orchi to fix: Settings folder, Themes")

    done = run_orchi("doctor")
    assert done.returncode == 1 and "\x1b" not in done.stdout
    assert done.stdout.splitlines()[1] == "!  Settings folder  missing"

    done = run_orchi("--json", "doctor")
    assert done.returncode == 1
    data = json.loads(done.stdout)
    assert [(s["name"], s["status"]) for s in data["steps"]] == [
        ("Orchi files", "ok"), ("Settings folder", "needs-fix"), ("Settings", "ok"), ("Themes", "needs-fix"),
        ("Mods", "needs-fix"), ("Layout", "needs-fix"), ("Keys", "needs-fix"), ("Sounds", "needs-fix"),
        ("App settings", "needs-fix"), ("Launcher", "needs-fix"), ("Browser pane", "needs-fix")]


def test_bare_orchi_piped_and_with_json(home, tools):
    done = run_orchi("--json")
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout)["changed"] == [
        "Settings folder", "Themes", "Mods", "Layout", "Keys", "Sounds", "App settings", "Launcher", "Browser pane"]
    done = run_orchi()
    assert done.returncode == 0
    lines = done.stdout.splitlines()
    assert lines[:3] == ["✓  Orchi files", "✓  Settings folder", "✓  Settings"]
    assert lines[-2:] == ["", "All set."] and len(lines) == 13


def test_output_that_breaks_off_still_exits_with_the_run_code(home, tmp_path):
    read_end, write_end = os.pipe()
    os.close(read_end)
    done = subprocess.run([sys.executable, str(DRIVER), "files"], env=child_env(DRIVE_DIR=str(tmp_path)),
                          stdout=write_end, stderr=subprocess.PIPE, text=True, timeout=30)
    os.close(write_end)
    assert done.returncode == 0, done.stderr
    assert done.stderr == ""
    assert (tmp_path / "b").read_text() == "B"


def test_an_odd_answer_is_asked_again(home, monkeypatch):
    class Tty(io.StringIO):
        def write(self, text):
            return len(text)

    monkeypatch.setattr(screen, "open_tty", lambda: Tty("²\n2\n"))
    assert screen.Screen(io.StringIO()).ask("Which theme", ["Dark", "Light"]) == "Light"


def test_the_spinner_line_is_cleared_even_when_ctrl_c_lands_while_it_stops(monkeypatch):
    class Terminal(io.StringIO):
        def isatty(self):
            return True

    out = Terminal()
    s = screen.Screen(out, env={"TERM": "xterm-256color"})
    s.running("Step")
    real = screen.threading.Thread.join

    def interrupted(self, *args):
        real(self, *args)
        raise KeyboardInterrupt

    monkeypatch.setattr(screen.threading.Thread, "join", interrupted)
    try:
        s.result("Step", "ok")
    except KeyboardInterrupt:
        pass
    assert out.getvalue().endswith("\r\x1b[2K")


def test_the_child_runners_do_not_depend_on_the_machine_they_run_on(home, tools):
    """On a Linux runner the real command stops at once ("not ready"); the test runners must not."""
    code = ("import runpy, sys; sys.platform = 'linux'; sys.argv = ['driver', 'doctor']; "
            f"runpy.run_path({str(DRIVER.with_name('orchi_driver.py'))!r}, run_name='__main__')")
    done = subprocess.run([sys.executable, "-c", code], env=child_env(), capture_output=True, text=True, timeout=30)
    assert "not ready" not in done.stdout and done.stdout.splitlines()[0] == "✓  Orchi files", done.stdout + done.stderr
