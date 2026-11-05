"""A real `uv tool install` of the checkout, into scratch directories, then the installed command runs."""
import os
import subprocess
from pathlib import Path

from conftest import DATA_FOLDERS, ROOT, scratch_env


def test_uv_tool_install_gives_a_working_orchi(uv, tmp_path):
    env = scratch_env(tmp_path)
    # The Herdr steps want node and agent-browser, and a Herdr home of the usual place under this scratch home.
    tools = tmp_path / "tools"
    tools.mkdir()
    for name, text in (("node", "#!/bin/sh\necho 22\n"), ("agent-browser", "#!/bin/sh\nexit 0\n")):
        (tools / name).write_text(text)
        (tools / name).chmod(0o755)
    env["PATH"] = f"{tools}{os.pathsep}{env['PATH']}"
    env["HERDR_APP_HOME"] = str(Path(env["HOME"]) / ".config" / "herdr-app")
    env["ORCHI_STATE"] = str(tmp_path / "state")

    done = subprocess.run(
        [uv, "tool", "install", "--force", str(ROOT)],
        env=env, capture_output=True, text=True, cwd=str(tmp_path),
    )
    assert done.returncode == 0, done.stdout + done.stderr

    exe = Path(env["UV_TOOL_BIN_DIR"]) / "orchi"
    assert exe.exists()

    ran = subprocess.run([str(exe), "--version"], env=env, capture_output=True, text=True, cwd=str(tmp_path))
    assert ran.returncode == 0, ran.stderr
    assert ran.stdout == "orchi 0.1.3\n"

    # The installed copy runs its Herdr steps, and finds its own files. Bare `orchi` would start real installers, so
    # this runs the settings and Herdr steps through the installed package's own interpreter.
    python = Path(env["UV_TOOL_DIR"]) / "orchi" / "bin" / "python"
    code = ("import sys; from orchi import cli, herdr, steps, system; system.platform = lambda: 'darwin'; "
            "steps.steps = lambda: steps.core() + herdr.steps(); "
            "sys.exit(cli.main(sys.argv[1:]))")
    doctor = subprocess.run([str(python), "-c", code, "doctor"], env=env, capture_output=True, text=True, cwd=str(tmp_path))
    assert doctor.stdout.splitlines()[0] == "✓  Orchi files", doctor.stdout + doctor.stderr
    bare = subprocess.run([str(python), "-c", code], env=env, capture_output=True, text=True, cwd=str(tmp_path))
    assert bare.returncode == 0, bare.stdout + bare.stderr
    # The wheel's content reaches the Herdr home as copies, with nothing linked into the tool's folder.
    app = Path(env["HERDR_APP_HOME"])
    assert (app / "mods" / "herd" / "mod.json").is_file() and (app / "themes" / "orchi-dark.json").is_file()
    assert not [p for p in app.rglob("*") if p.is_symlink()]
    again = subprocess.run([str(python), "-c", code], env=env, capture_output=True, text=True, cwd=str(tmp_path))
    assert again.returncode == 0 and again.stdout.splitlines()[-1] == "All set.", again.stdout

    # The installed copy finds its content inside the package, not in a checkout.
    where = subprocess.run(
        [str(python), "-c", "from orchi.paths import data_dir; print(data_dir())"],
        env=env, capture_output=True, text=True, cwd=str(tmp_path),
    )
    assert where.returncode == 0, where.stderr
    data = Path(where.stdout.strip())
    assert str(ROOT) not in str(data)
    assert data.name == "data" and data.parent.name == "orchi"
    for name in DATA_FOLDERS:
        assert (data / name).is_dir(), name
    # The launcher Orchi writes runs this, so it has to keep its execute bit through the wheel.
    assert os.access(data / "bin" / "herdr", os.X_OK)
