"""A real `uv tool install` of the checkout, into scratch directories, then the installed command runs."""
import subprocess
from pathlib import Path

from conftest import DATA_FOLDERS, ROOT, scratch_env


def test_uv_tool_install_gives_a_working_orchi(uv, tmp_path):
    env = scratch_env(tmp_path)

    done = subprocess.run(
        [uv, "tool", "install", "--force", str(ROOT)],
        env=env, capture_output=True, text=True, cwd=str(tmp_path),
    )
    assert done.returncode == 0, done.stdout + done.stderr

    exe = Path(env["UV_TOOL_BIN_DIR"]) / "orchi"
    assert exe.exists()

    ran = subprocess.run([str(exe), "--version"], env=env, capture_output=True, text=True, cwd=str(tmp_path))
    assert ran.returncode == 0, ran.stderr
    assert ran.stdout == "orchi 0.1.0\n"

    # The installed copy runs its steps, and finds its own files.
    doctor = subprocess.run([str(exe), "doctor"], env=env, capture_output=True, text=True, cwd=str(tmp_path))
    assert doctor.stdout.splitlines()[0] == "✓  Orchi files", doctor.stdout + doctor.stderr
    bare = subprocess.run([str(exe)], env=env, capture_output=True, text=True, cwd=str(tmp_path))
    assert bare.returncode == 0, bare.stdout + bare.stderr

    # The installed copy finds its content inside the package, not in a checkout.
    python = Path(env["UV_TOOL_DIR"]) / "orchi" / "bin" / "python"
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
