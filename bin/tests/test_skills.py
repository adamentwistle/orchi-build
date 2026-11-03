"""Tests that the skills and the docs keep to the contract the Orchi panel reads.

The skills are prose, so these check only what another program depends on: a skill
is linked the way the others are, and the fixed line formats appear exactly as the
panel in mods/orchi parses them.
"""
import importlib.machinery
import importlib.util
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
            "Repo: <absolute path>\nTickets: linear:ENG-1, linear:ENG-2\n"
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


ADAPTER = ROOT / "bin" / "herdr-adapter"


def orchi_texts():
    for path in sorted(SKILLS.iterdir()):
        if path.is_dir():
            yield f"skills/{path.name}", (path / "SKILL.md").read_text()
    for path in sorted((ROOT / "commands").glob("*.md")):
        yield f"commands/{path.name}", path.read_text()


def _adapter():
    loader = importlib.machinery.SourceFileLoader("herdr_adapter", str(ADAPTER))
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
    loader.exec_module(module)
    return module


_ADAPTER = _adapter()
MAPPED = set(_ADAPTER.HANDLERS)
ABOUT_HERDR = set(_ADAPTER.ABOUT_HERDR)  # the adapter hands these to the real herdr


CALL = re.compile(r"(?<![\w.<>-])herdr(?![\w-])((?:\s+[^\s`;|&)#]+){1,2})")


def unmapped(text):
    """The herdr calls in text's code spans and code blocks that bin/herdr-adapter has no mapping for."""
    blocks = re.findall(r"```.*?```", text, re.S)
    spans = re.findall(r"`([^`]+)`", re.sub(r"```.*?```", "", text, flags=re.S))
    found = []
    for code in blocks + spans:
        for args in CALL.findall(code):
            words = tuple(args.split())
            if words[0] not in ABOUT_HERDR and words[:2] not in MAPPED:
                found.append(words)
    return found


def test_every_herdr_call_in_a_skill_is_one_the_app_maps():
    # The app is the only Herdr (docs/adr/0002), and bin/herdr-adapter fails any call it has no mapping for.
    assert ("agent", "prompt") in MAPPED
    found = [(name, call) for name, text in orchi_texts() for call in unmapped(text)]
    assert found == []
    # agent start maps only Claude Code.
    assert [(name, kind) for name, text in orchi_texts() for kind in other_kinds(text)] == []


def other_kinds(text):
    """The kinds other than claude that text starts an agent with."""
    return [k for k in re.findall(r"herdr agent start [^`]*?--kind[= ]\"?(\w+)", text) if k != "claude"]


TERMINAL_HERDR = re.compile(r"terminal Herdr|\bw[0-9A-Za-z]+:p\d|<app\|terminal>|herdr --machine")


def test_any_call_the_adapter_refuses_is_caught():
    for text in ("Run `herdr status` first.", "`herdr foo bar`", "`herdr agent`", "```\nherdr --machine x agent list\n```",
                 "`herdr -v agent list`", "`herdr pane split --current`", "`<orchi_dir>/bin/herdr pane split --current`"):
        assert unmapped(text), text
    for text in ("`herdr agent list`", "`herdr --help`", "the Herdr app needs a herdr call", "the `herdr` skill",
                 "`herdr-browser open x`", "`<orchi_dir>/bin/herdr agent read t7`", "```\nherdr pane read t7 --lines 5\n```"):
        assert unmapped(text) == [], text


def test_no_skill_sends_anyone_to_terminal_herdr():
    for name, text in orchi_texts():
        assert not TERMINAL_HERDR.search(text), name


def test_terminal_ids_and_other_kinds_are_caught():
    for text in ("pane `wGZ:p1`", "a pane like `w1:p1`", "`w12:p3`"):
        assert TERMINAL_HERDR.search(text), text
    assert TERMINAL_HERDR.search("pane t7 in the app") is None
    assert other_kinds("```\nherdr agent start x --pane t3 \\\n  --kind codex\n```") == ["codex"]
    assert other_kinds("`herdr agent start x --kind claude --pane t3`") == []
    assert other_kinds("`herdr agent start x --kind=codex --pane t3`") == ["codex"]
    assert other_kinds("`herdr agent start x --pane t3\n  --kind codex`") == ["codex"]
    assert unmapped("`herdr pane split --cwd x\n  --no-focus`") == [("pane", "split")]
    assert unmapped("`herdr\n  pane split`") == [("pane", "split")]


def test_the_switchboard_takes_the_lock_with_its_terminal_alone():
    # switchboard-lock take TERMINAL; `terminal` after it exits 2.
    body = skill("switchboard")
    assert "`<orchi_dir>/bin/switchboard-lock take <your pane_id>`" in body


def test_the_protocol_reads_and_writes_tickets_with_orchi_tickets():
    linear = skill("switchboard-protocol").split("\n## Tickets\n")[1].split("\n## ")[0]
    assert "`orchi tickets`" in linear
    assert "`sources`" in linear
    assert not re.search(r"Linear MCP|mcp__|linear\.app/", linear)


def test_planning_names_grilling_and_domain_modeling_by_their_plugin():
    # Decision 5: they come from the mattpocock-skills plugin, never copied.
    for name in ("roadmap-planning", "switchboard-protocol"):
        assert "mattpocock-skills:grilling" in skill(name), name
    assert "mattpocock-skills:domain-modeling" in skill("roadmap-planning")
    for name, text in orchi_texts():
        assert "/grill-with-docs" not in text, name
