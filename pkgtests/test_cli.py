"""The orchi command: --version and --help work, everything else says it is not built yet and exits 2."""
import subprocess
import sys

import pytest

from conftest import SRC, scratch_env
from orchi import cli


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


@pytest.mark.parametrize("argv", [[], ["doctor"]])
def test_unbuilt_commands_print_one_plain_line_and_exit_2(argv, capsys):
    assert cli.main(argv) == 2
    captured = capsys.readouterr()
    assert captured.out == ""
    lines = captured.err.splitlines()
    assert len(lines) == 1
    assert "not built yet" in lines[0]
    assert "—" not in lines[0]


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
