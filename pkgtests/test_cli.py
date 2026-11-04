"""The orchi command: --version and --help, bare `orchi` and `doctor` on the engine, and the global --json."""
import subprocess
import sys

import pytest

from conftest import SRC, scratch_env
from orchi import cli, engine


def test_version_prints_name_and_number(capsys):
    with pytest.raises(SystemExit) as stop:
        cli.main(["--version"])
    assert stop.value.code == 0
    assert capsys.readouterr().out == "orchi 0.1.0\n"


def test_help_exits_zero_and_names_the_command(capsys):
    with pytest.raises(SystemExit) as stop:
        cli.main(["--help"])
    assert stop.value.code == 0
    out = capsys.readouterr().out
    assert "orchi" in out and "--version" in out


def test_help_says_what_each_command_does_and_nothing_else(capsys):
    with pytest.raises(SystemExit):
        cli.main(["--help"])
    out = capsys.readouterr().out
    assert "Set up or fix everything." in out
    assert "dresses Herdr" not in out and "keep what is yours" not in out and "run the steps" not in out
    assert "move to the newest release, then set up" in out


@pytest.mark.parametrize("argv, fix", [([], True), (["doctor"], False), (["--json"], True),
                                       (["--json", "doctor"], False)])
def test_bare_orchi_and_doctor_run_the_steps(argv, fix, monkeypatch):
    seen = {}

    def fake(fix, as_json):
        seen.update(fix=fix, as_json=as_json)
        return 7

    monkeypatch.setattr(engine, "main", fake)
    assert cli.main(argv) == 7
    assert seen == {"fix": fix, "as_json": "--json" in argv}


def test_an_unknown_command_is_a_usage_error():
    with pytest.raises(SystemExit) as stop:
        cli.main(["no-such-command"])
    assert stop.value.code == 2


def test_commands_are_a_table_later_work_can_add_to():
    assert "doctor" in cli.COMMANDS
    assert callable(cli.build_parser)


def test_python_dash_m_orchi_runs_the_same_cli(tmp_path):
    env = scratch_env(tmp_path)
    env["PYTHONPATH"] = str(SRC)
    done = subprocess.run(
        [sys.executable, "-m", "orchi", "--version"],
        env=env, capture_output=True, text=True, cwd=str(tmp_path),
    )
    assert done.returncode == 0, done.stderr
    assert done.stdout == "orchi 0.1.0\n"


@pytest.mark.parametrize("argv", [["--vers"], ["--he"], ["doc"]])
def test_abbreviations_are_not_accepted(argv):
    with pytest.raises(SystemExit) as stop:
        cli.main(argv)
    assert stop.value.code == 2


def test_importing_the_main_module_does_not_run_the_cli():
    import importlib
    importlib.import_module("orchi.__main__")


@pytest.mark.parametrize("argv, fix", [(["--json", "doctor"], False), (["doctor", "--json"], False),
                                       (["--json"], True), (["doctor"], False), ([], True)])
def test_json_works_before_or_after_doctor(argv, fix, monkeypatch):
    seen = {}
    monkeypatch.setattr(engine, "main", lambda fix, as_json: seen.update(fix=fix, as_json=as_json) or 0)
    assert cli.main(argv) == 0
    assert seen == {"fix": fix, "as_json": "--json" in argv}


@pytest.mark.parametrize("argv", [
    ["--json", "tickets"], ["tickets", "--json"],
    ["--json", "tickets", "show", "md:~/todo.md#ship"], ["tickets", "--json", "show", "md:~/todo.md#ship"],
    ["tickets", "show", "md:~/todo.md#ship", "--json"], ["tickets", "show", "--json", "md:~/todo.md#ship"],
])
def test_json_works_before_or_after_tickets_and_show(argv, tmp_path, monkeypatch, capsys):
    import json
    import os
    from pathlib import Path
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "todo.md").write_text("- [ ] Ship\n")
    Path(os.environ["ORCHI_SETTINGS"]).parent.mkdir(parents=True, exist_ok=True)
    Path(os.environ["ORCHI_SETTINGS"]).write_text(json.dumps({"sources": ["markdown"], "markdown": {"paths": ["~/todo.md"]}}))
    assert cli.main(argv) == 0
    got = json.loads(capsys.readouterr().out)
    assert (got["tickets"][0] if "show" not in argv else got)["ref"] == "md:~/todo.md#ship"


@pytest.mark.parametrize("argv", [["tickets"], ["tickets", "show", "md:~/todo.md#ship"]])
def test_without_json_tickets_print_plain_lines(argv, tmp_path, monkeypatch, capsys):
    import json
    import os
    from pathlib import Path
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "todo.md").write_text("- [ ] Ship\n")
    Path(os.environ["ORCHI_SETTINGS"]).parent.mkdir(parents=True, exist_ok=True)
    Path(os.environ["ORCHI_SETTINGS"]).write_text(json.dumps({"sources": ["markdown"], "markdown": {"paths": ["~/todo.md"]}}))
    assert cli.main(argv) == 0
    assert not capsys.readouterr().out.startswith("{")
