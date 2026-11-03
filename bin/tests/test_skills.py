"""Tests that the skills and the docs keep to the contract the Orchi panel reads.

The skills are prose, so these check only what another program depends on: a skill
is linked the way the others are, and the fixed line formats appear exactly as the
panel in mods/orchi parses them.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SKILLS = ROOT / "skills"
SETUP = ROOT / "docs" / "setup.md"


def skill(name):
    return (SKILLS / name / "SKILL.md").read_text()


def test_the_link_loop_names_every_skill_once():
    # herdr-browser is the one left out: scripts/install-browser.sh copies it into each profile.
    text = SETUP.read_text()
    loop = re.search(r"^for s in (.+); do .*\$O/skills/\$s", text, re.M).group(1).split()
    names = {p.name for p in SKILLS.iterdir() if p.is_dir()}
    assert len(loop) == len(set(loop))
    assert set(loop) == names - {"herdr-browser"}


def test_every_skill_has_a_name_and_a_description():
    for path in SKILLS.iterdir():
        head = (path / "SKILL.md").read_text().split("---")[1]
        assert f"name: {path.name}\n" in head
        assert "description: " in head


def test_fanout_writes_the_progress_line_the_panel_reads():
    # parseProgress in mods/orchi/parse.js
    assert re.search(r"^ *Progress: <done>/<total>$", skill("fanout"), re.M)


def test_fanout_table_has_the_columns_the_panel_reads():
    # parseItems in mods/orchi/parse.js
    row = re.search(r"^ *\| slug \|.*\|$", skill("fanout"), re.M).group(0)
    assert [c.strip() for c in row.strip().strip("|").split("|")] == [
        "slug", "route", "model", "state", "PR"]


def test_fanout_takes_workers():
    assert "[--workers <model>:<effort>]" in skill("fanout")
    assert "--workers" in (ROOT / "commands" / "fanout.md").read_text()


def test_protocol_action_has_the_fields_the_panel_reads():
    body = skill("switchboard-protocol")
    fields = re.search(r"^## <id> ACTION <time>\n((?:\w+: .*\n)+)", body, re.M).group(1)
    assert [l.split(":")[0] for l in fields.splitlines()] == [
        "Why", "Do", "Where", "Run", "Blocks", "Meanwhile"]


def test_ticket_session_board_formats_match_the_contract():
    body = skill("ticket-session")
    assert ("## <session>-p1 PLAN 2026-10-30 22:40\nProject: <legwork file>\n"
            "Repo: <absolute path>\nTickets: ENG-1, ENG-2\n"
            'Start: /fanout <project> --only "<items>" [--merge] [--workers <model>:<effort>]\n'
            "## <session>-ready READY 2026-10-30 22:41\n") in body
    assert "printf 'start %s\\n'" in body


def test_switchboard_names_all_four_request_verbs():
    body = skill("switchboard")
    for line in ("start <session>", "run <project>", "pause <project>", "resume <project>"):
        assert f"| `{line}` |" in body


def test_skills_tell_the_same_pause_words():
    for words in ("SWITCHBOARD PAUSE", "SWITCHBOARD RESUME", "`Paused.`"):
        assert words in skill("switchboard")
        assert words in skill("switchboard-protocol")


def test_run_rules_folder_matches_the_panel():
    # runRulesFile in mods/orchi/switchboard.js
    for name in ("switchboard", "switchboard-protocol"):
        assert "<claude_dir>/switchboard/run-rules/" in skill(name)
