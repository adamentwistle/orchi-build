"""pr-drafter and ux-test are Orchi's own: no person, no employer, no work rule, no path outside the skill.

The voice sweep and the ux-test scripts run from a copy of their folder in a temporary directory, with a bare PATH, so
anything they reached for outside the folder would fail here.
"""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from bundled_names import NAMES

ROOT = Path(__file__).resolve().parent.parent.parent
SKILLS = ROOT / "skills"
PIECES = ("pr-drafter", "ux-test")


def files(piece):
    return sorted(p for p in (SKILLS / piece).rglob("*") if p.is_file() and p.name != ".DS_Store")


@pytest.mark.parametrize("piece", PIECES)
def test_no_name_work_rule_or_outside_path(piece):
    hits = []
    for path in files(piece):
        for n, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
            if NAMES.search(line):
                hits.append((str(path.relative_to(SKILLS)), n, line.strip()[:80]))
    assert hits == []


@pytest.mark.parametrize("piece", PIECES)
def test_every_line_is_plain_ascii(piece):
    bad = [str(p.relative_to(SKILLS)) for p in files(piece) if re.search(r"[^\x00-\x7f]", p.read_text(errors="replace"))]
    assert bad == []


def test_the_user_is_you_or_the_user_not_a_name():
    text = (SKILLS / "pr-drafter" / "SKILL.md").read_text()
    assert "goes out under the user's name" in text
    assert "The author is the user and nobody else" in text


# pr-drafter

def draft():
    return (SKILLS / "pr-drafter" / "SKILL.md").read_text()


def test_pr_drafter_keeps_its_tldr_and_the_three_marks():
    text = draft()
    assert "**TL;DR.**" in text
    for mark in ("OBSERVED", "STALE", "NOT RUN"):
        assert f"**{mark}**" in text
    for section in ("Summary", "What this looked like to a user", "Root cause", "Verification", "Risk"):
        assert f"**{section}.**" in text


def test_pr_drafter_keeps_its_standing_rules():
    text = draft()
    assert "No trailers of any kind" in text
    assert "Every authored line is pure ASCII" in text
    assert "Never approve" in text


def sweep(folder, *args, text=None, tmp):
    target = []
    if text is not None:
        file = tmp / "draft.md"
        file.write_bytes(text)
        target = [str(file)]
    env = {"PATH": "/usr/bin:/bin", "HOME": str(tmp)}
    return subprocess.run(["sh", str(folder / "voice-sweep.sh"), *args, *target], cwd=tmp, env=env,
                          capture_output=True, text=True, timeout=60)


@pytest.fixture
def copy(tmp_path):
    folder = tmp_path / "somewhere" / "else" / "pr-drafter"
    shutil.copytree(SKILLS / "pr-drafter", folder)
    work = tmp_path / "work"
    work.mkdir()
    return folder, work


def test_the_sweep_runs_from_a_copy_with_no_path_outside_the_skill(copy):
    folder, work = copy
    done = sweep(folder, "--self-test", tmp=work)
    assert done.returncode == 0, done.stdout + done.stderr
    assert re.search(r"\b(\d+)/\1 checks pass", done.stdout)


def test_the_sweep_passes_clean_text_and_blocks_the_rest(copy):
    folder, work = copy
    assert sweep(folder, text=b"## TL;DR\n\nA cancelled request now stops.\n", tmp=work).returncode == 0
    for dirty in (b"A dash \xe2\x80\x94 here\n", b"Done.\n\nCo-Authored-By: someone <a@example.com>\n",
                  b"Written with Claude Code\n"):
        done = sweep(folder, text=dirty, tmp=work)
        assert done.returncode == 1, dirty
        assert "BLOCK" in done.stdout


def test_the_sweep_names_nobody_in_what_it_prints(copy):
    folder, work = copy
    done = sweep(folder, text=b"Written with Claude Code\n", tmp=work)
    assert "the author is the user and nobody else" in done.stdout
    assert "Adam" not in done.stdout


def test_the_sweep_points_at_the_skill_beside_it_not_a_path_in_a_checkout():
    text = (SKILLS / "pr-drafter" / "voice-sweep.sh").read_text()
    assert "skills/" not in text
    assert "SKILL.md" in text


# ux-test

def ux_copy(tmp_path):
    folder = tmp_path / "elsewhere" / "ux-test"
    shutil.copytree(SKILLS / "ux-test", folder)
    return folder


def need_node():
    if shutil.which("node"):
        return
    if os.environ.get("CI"):
        pytest.fail("node is not installed, so the ux-test scripts cannot run", pytrace=False)
    pytest.skip("node is not installed")


def doctor(folder, target, tmp):
    tools = tmp / "tools"
    tools.mkdir(exist_ok=True)
    if not (tools / "node").exists():
        (tools / "node").symlink_to(shutil.which("node"))
    env = {"PATH": f"{tools}:/usr/bin:/bin", "HOME": str(tmp)}
    return subprocess.run(["bash", str(folder / "scripts" / "doctor.sh"), "--json", str(target)], cwd=tmp, env=env,
                          capture_output=True, text=True, timeout=120)


def test_doctor_runs_from_a_copy_and_reads_the_pins_beside_it(tmp_path):
    need_node()
    folder = ux_copy(tmp_path)
    target = tmp_path / "app"
    target.mkdir()
    (target / "package.json").write_text(json.dumps({"dependencies": {"next": "15.0.0"}}))
    (target / "package-lock.json").write_text("{}")
    done = doctor(folder, target, tmp_path)
    report = json.loads(done.stdout)
    assert done.returncode == 1 and report["exit"] == 1
    assert report["kind"] == "next"
    ab = next(c for c in report["checks"] if c["check"] == "agent-browser")
    pin = json.loads((SKILLS / "ux-test" / "versions.json").read_text())["global"]["agent-browser"]
    assert ab["status"] in ("MISSING", "OK", "DRIFT")
    if ab["status"] == "MISSING":
        assert f"npm install -g agent-browser@{pin}" in ab["fix"]


def test_doctor_says_so_for_a_target_of_an_unsupported_kind(tmp_path):
    need_node()
    target = tmp_path / "plain"
    target.mkdir()
    done = doctor(ux_copy(tmp_path), target, tmp_path)
    assert done.returncode == 0
    assert json.loads(done.stdout)["checks"][-1]["status"] == "UNSUPPORTED"


def test_the_install_steps_are_the_ones_setup_does():
    text = (SKILLS / "ux-test" / "SKILL.md").read_text()
    pin = json.loads((SKILLS / "ux-test" / "versions.json").read_text())["global"]["agent-browser"]
    # Setup links the skill into the profile and installs agent-browser at the pin; the skill says exactly that.
    assert "Setup links this folder into `<claude_dir>/skills`" in text
    assert "npm install -g agent-browser@<pin>" in text and pin in text
    assert "agent-browser install" in text
    setup = (ROOT / "docs" / "setup.md").read_text()
    assert re.search(r"^for s in .*\bux-test\b.*\$C/skills/\$s", setup, re.M)
    assert not re.search(r"The profile's copy is a link", text)



def test_the_name_pattern_catches_every_spelling_of_the_employer():
    for spelling in ("Quick" + "node", "Quick" + "Node", "quick" + "node", "QUICK" + "NODE"):
        assert NAMES.search(f"built at {spelling} for") is not None, spelling


def test_the_new_test_files_are_plain_ascii():
    for path in (Path(__file__), ROOT / "pkgtests" / "test_bundled.py"):
        assert not re.search(r"[^\x00-\x7f]", path.read_text(encoding="utf-8")), path.name


def test_pr_drafter_says_what_summons_a_review_bot():
    text = " ".join(draft().split())
    assert "no comment that summons an automated reviewer" in text
    assert "@" in text.split("no comment that summons an automated reviewer")[1][:200]


def test_pr_drafter_does_not_read_as_forbidding_checks():
    text = " ".join(draft().split())
    assert "nothing may run when the pull request opens" not in text
    assert "a repo may run no checks when the pull request opens" in text


def test_the_sweep_comment_has_no_dangling_comma():
    assert "Both severities exit 1,\n" not in (SKILLS / "pr-drafter" / "voice-sweep.sh").read_text()


def test_both_test_folders_share_one_name_pattern():
    assert (ROOT / "bundled_names.py").is_file()
    for path in (Path(__file__), ROOT / "pkgtests" / "test_bundled.py"):
        text = path.read_text()
        assert "from bundled_names import NAMES" in text, path.name
        assert "NAMES = " "re.compile" not in text, path.name


def test_the_adr_and_the_script_name_every_reason_a_cache_is_skipped():
    adr = " ".join((ROOT / "docs" / "adr" / "0004-usage-guard-reads-the-usage-cache.md").read_text().split())
    script = " ".join((ROOT / "bin" / "usage-guard").read_text().split())
    for text in (adr, script):
        assert "no window left to judge" in text


def test_ux_test_does_not_claim_setup_installs_agent_browser():
    text = " ".join((SKILLS / "ux-test" / "SKILL.md").read_text().split())
    assert "Setup installs" not in text and "and installs agent-browser" not in text
    assert "Install agent-browser at the pin" in text
    assert "MISSING until then" in text


def test_the_usage_adr_does_not_claim_a_change_main_already_had():
    adr = (ROOT / "docs" / "adr" / "0004-usage-guard-reads-the-usage-cache.md").read_text()
    assert "97" not in adr
    assert "0002" in adr


def test_pr_drafter_asks_for_the_command_as_it_was_run():
    text = " ".join(draft().split())
    assert "with the real path" in text


@pytest.mark.parametrize("script", ["usage-guard", "pane-notify"])
def test_the_bundled_scripts_name_nobody_either(script):
    text = (ROOT / "bin" / script).read_text()
    assert [l for l in text.splitlines() if NAMES.search(l)] == []


def test_the_setup_notes_say_where_an_osascript_banner_comes_from():
    text = " ".join((ROOT / "docs" / "setup.md").read_text().split())
    assert "Script Editor" in text
