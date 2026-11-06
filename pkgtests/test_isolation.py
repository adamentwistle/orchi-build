"""The suite never reaches the caller's own tracker: a LEGWORK_DIR in the shell that runs pytest is gone inside every
test, and from the environment a test hands to a child process."""
import os
import subprocess
import sys

from conftest import ROOT

INNER = """import importlib.util, os
spec = importlib.util.spec_from_file_location("pkg_conftest", os.environ["PKG_CONFTEST"])
pkg_conftest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pkg_conftest)
scratch_env = pkg_conftest.scratch_env

def test_no_tracker_from_the_caller(tmp_path):
    # By value, never the whole environment, which would print the caller's secrets.
    assert os.environ.get("LEGWORK_DIR") is None
    assert scratch_env(tmp_path).get("LEGWORK_DIR") is None
"""


def test_a_callers_legwork_dir_never_reaches_a_test(tmp_path):
    # The suite's own top conftest.py, beside a test of its own, run with a tracker named in its environment.
    (tmp_path / "conftest.py").write_text((ROOT / "conftest.py").read_text())
    (tmp_path / "test_inner.py").write_text(INNER)
    env = dict(os.environ, LEGWORK_DIR=str(tmp_path / "callers-tracker"),
               PKG_CONFTEST=str(ROOT / "pkgtests" / "conftest.py"))
    r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "--rootdir", str(tmp_path),
                        "-c", os.devnull, str(tmp_path / "test_inner.py")],
                       cwd=tmp_path, env=env, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout + r.stderr
