"""orchi.refs: the one ticket reference parser, and the mods' JS copy agreeing with it on every fixture."""
import json
import shutil
import subprocess

import pytest

from conftest import ROOT
from orchi import refs

CASES = json.loads((ROOT / "tests" / "tickets" / "refs.json").read_text())["cases"]


def outcome(text):
    try:
        return refs.parse(text)
    except refs.RefError as e:
        return {"error": str(e)}


@pytest.mark.parametrize("case", CASES, ids=[json.dumps(c["text"]) for c in CASES])
def test_fixture(case):
    assert outcome(case["text"]) == case.get("expected", {"error": case.get("error")})


def test_a_bad_reference_is_a_value_error_with_a_plain_message():
    with pytest.raises(ValueError) as caught:
        refs.parse("jira:ENG-1")
    assert str(caught.value) == "jira is not a ticket source: use linear, gh, legwork or md"
    assert "—" not in str(caught.value)


def test_none_is_an_empty_reference():
    with pytest.raises(refs.RefError, match="can't be empty"):
        refs.parse(None)


NODE_PARSER = """
import { readFileSync } from "node:fs";
import { parseRef } from %s;
const { cases } = JSON.parse(readFileSync(process.argv[1], "utf8"));
process.stdout.write(JSON.stringify(cases.map((c) => parseRef(c.text))));
"""


def test_the_js_parser_gives_the_same_answer_for_every_fixture():
    node = shutil.which("node")
    assert node, "node is needed to run the mods' parser"
    module = json.dumps((ROOT / "mods" / "orchi" / "refs.js").as_uri())
    done = subprocess.run([node, "--input-type=module", "-e", NODE_PARSER % module,
                           str(ROOT / "tests" / "tickets" / "refs.json")],
                          capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    from_js = json.loads(done.stdout)
    assert len(from_js) == len(CASES)
    for case, js in zip(CASES, from_js):
        assert js == outcome(case["text"]), case["text"]
