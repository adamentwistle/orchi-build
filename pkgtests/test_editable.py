"""An editable install of the checkout works, and finds its content in the checkout."""
import subprocess
from pathlib import Path

from conftest import DATA_FOLDERS, ROOT, scratch_env


def test_uv_tool_install_editable_runs_and_finds_the_checkout(uv, tmp_path):
    env = scratch_env(tmp_path)
    done = subprocess.run(
        [uv, "tool", "install", "--force", "--editable", str(ROOT)],
        env=env, capture_output=True, text=True, cwd=str(tmp_path),
    )
    assert done.returncode == 0, done.stdout + done.stderr

    exe = Path(env["UV_TOOL_BIN_DIR"]) / "orchi"
    ran = subprocess.run([str(exe), "--version"], env=env, capture_output=True, text=True, cwd=str(tmp_path))
    assert ran.returncode == 0, ran.stderr
    assert ran.stdout == "orchi 0.1.3\n"

    python = Path(env["UV_TOOL_DIR"]) / "orchi" / "bin" / "python"
    where = subprocess.run(
        [str(python), "-c", "from orchi.paths import data_dir; print(data_dir())"],
        env=env, capture_output=True, text=True, cwd=str(tmp_path),
    )
    assert where.returncode == 0, where.stderr
    data = Path(where.stdout.strip()).resolve()
    assert data == ROOT.resolve()
    for name in DATA_FOLDERS:
        assert (data / name).is_dir(), name
