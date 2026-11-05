"""The wheel holds the content folders under orchi/data and none of the files that must stay out."""
import shutil
import subprocess
import zipfile

import pytest

from conftest import DATA_FOLDERS, ROOT, is_excluded, scratch_env


STRAYS = (
    "mods/herd/gpui-kit.d.ts",
    "mods/herd/jsconfig.json",
    "mods/herd/__pycache__/stray.cpython-313.pyc",
    "skills/herdr/.DS_Store",
    "bin/tests/stray_test.py",
    "scripts/tests/stray.py",
)


def copy_of_the_checkout(dest):
    """The tracked files a wheel is built from, without .git or .gitignore, plus files that must never ship.

    Only tracked files are copied, so stray local files cannot change the result. Leaving .gitignore
    out means the build's own exclusions are what keep the strays out.
    """
    listed = subprocess.run(
        ["git", "ls-files", "-z", "--", "pyproject.toml", "README.md", "LICENSE", "NOTICE.md",
         "LICENSES", "src", *DATA_FOLDERS],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.split("\0")
    for name in filter(None, listed):
        target = dest / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, target, follow_symlinks=False)
    for stray in STRAYS:
        target = dest / stray
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("stray")


@pytest.fixture(scope="module")
def wheel(uv, tmp_path_factory):
    base = tmp_path_factory.mktemp("wheel")
    source = base / "source"
    source.mkdir()
    copy_of_the_checkout(source)
    out = base / "out"
    done = subprocess.run(
        [uv, "build", "--wheel", "--out-dir", str(out), str(source)],
        env=scratch_env(base), capture_output=True, text=True,
    )
    assert done.returncode == 0, done.stdout + done.stderr
    built = list(out.glob("orchi-*.whl"))
    assert len(built) == 1, built
    return built[0]


@pytest.fixture(scope="module")
def entries(wheel):
    with zipfile.ZipFile(wheel) as z:
        return {info.filename: info for info in z.infolist()}


def tracked_content():
    listed = subprocess.run(
        ["git", "ls-files", "-z", "--", *DATA_FOLDERS],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.split("\0")
    return {p for p in listed if p and not is_excluded(p)}


def test_the_wheel_is_named_for_the_version(wheel):
    assert wheel.name.startswith("orchi-0.1.3-")


def test_the_code_is_in_the_wheel(entries):
    for name in ("orchi/__init__.py", "orchi/__main__.py", "orchi/cli.py", "orchi/paths.py", "orchi/settings.py",
                 "orchi/settings.schema.json"):
        assert name in entries, name


@pytest.mark.parametrize("folder", DATA_FOLDERS)
def test_each_content_folder_ships(entries, folder):
    assert any(n.startswith(f"orchi/data/{folder}/") for n in entries), folder


def test_the_wheel_holds_exactly_the_tracked_content(entries):
    shipped = {n[len("orchi/data/"):] for n in entries if n.startswith("orchi/data/")}
    assert shipped == tracked_content()


def test_none_of_the_excluded_files_ship(entries):
    bad = [n for n in entries if n.startswith("orchi/data/") and is_excluded(n[len("orchi/data/"):])]
    assert bad == []
    assert not [n for n in entries if n.endswith("gpui-kit.d.ts") or n.endswith("jsconfig.json")]
    assert not [n for n in entries if "/tests/" in n or "__pycache__" in n or n.endswith(".DS_Store")]


def test_scripts_stay_executable(entries):
    mode = (entries["orchi/data/bin/herdr"].external_attr >> 16) & 0o777
    assert mode & 0o111, oct(mode)


def test_there_are_no_runtime_dependencies(wheel):
    with zipfile.ZipFile(wheel) as z:
        meta = next(n for n in z.namelist() if n.endswith(".dist-info/METADATA"))
        text = z.read(meta).decode()
    assert "Requires-Dist" not in text
    assert "Requires-Python" in text


def test_the_licences_ship_with_the_files_they_cover(wheel):
    with zipfile.ZipFile(wheel) as z:
        names = z.namelist()
        meta = z.read(next(n for n in names if n.endswith(".dist-info/METADATA"))).decode()
    licences = [n for n in names if "/licenses/" in n]
    assert any(n.endswith("licenses/LICENSE") for n in licences)
    assert any(n.endswith("licenses/NOTICE.md") for n in licences)
    assert any(n.endswith("licenses/LICENSES/Apache-2.0.txt") for n in licences)
    assert "Apache-2.0" in meta
