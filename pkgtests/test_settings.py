"""orchi.settings: one schema, one Python reader, and the mods' JS reader agreeing with it on every fixture."""
import json
import shutil
import subprocess

import pytest

from conftest import ROOT
from orchi import settings as st

FIXTURES = json.loads((ROOT / "tests" / "settings" / "fixtures.json").read_text())
HOME = FIXTURES["home"]
CASES = FIXTURES["cases"]
SCHEMA = json.loads((ROOT / "src" / "orchi" / "settings.schema.json").read_text())


def text(v):
    return None if v is None else v if isinstance(v, str) else json.dumps(v)


def resolved(case):
    files = case["files"]
    return st.resolve(text(files.get("settings")), text(files.get("orchi")), text(files.get("linear")),
                      home=case.get("home", HOME))


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_fixture(case):
    got = resolved(case)
    assert got == {**FIXTURES["defaults"], **case["expected"]}
    assert "fixture-key" not in json.dumps(got)


NODE_READER = """
import { readFileSync } from "node:fs";
import { resolveSettings } from %s;
const { home, cases } = JSON.parse(readFileSync(process.argv[1], "utf8"));
const text = (v) => (v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v));
const out = cases.map((c) => resolveSettings({ settings: text(c.files.settings), orchi: text(c.files.orchi), linear: text(c.files.linear) }, c.home ?? home));
process.stdout.write(JSON.stringify(out));
"""


def test_the_js_reader_gives_the_same_value_for_every_key_of_every_fixture():
    node = shutil.which("node")
    assert node, "node is needed to run the mods' reader"
    module = json.dumps((ROOT / "mods" / "orchi" / "settings.js").as_uri())
    done = subprocess.run([node, "--input-type=module", "-e", NODE_READER % module,
                           str(ROOT / "tests" / "settings" / "fixtures.json")],
                          capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    from_js = json.loads(done.stdout)
    assert len(from_js) == len(CASES)
    for case, js in zip(CASES, from_js):
        assert js == resolved(case), case["name"]


def test_the_bin_copy_is_the_same_file():
    assert (ROOT / "bin" / "orchi_settings.py").read_bytes() == (ROOT / "src" / "orchi" / "settings.py").read_bytes()


# Reading from disk


def files(tmp_path, monkeypatch, settings=None, orchi=None, linear=None):
    app = tmp_path / "herdr-app"
    app.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ORCHI_SETTINGS", str(tmp_path / "settings.json"))
    monkeypatch.setenv("HERDR_APP_HOME", str(app))
    for path, value in ((tmp_path / "settings.json", settings), (app / "orchi.json", orchi), (app / "linear.json", linear)):
        if value is not None:
            path.write_text(text(value))


def test_read_takes_the_files_from_the_environment(tmp_path, monkeypatch):
    files(tmp_path, monkeypatch, {"orchi_dir": "~/src/orchi"}, {"workerLimit": 9},
          {"apiKey": "fixture-key-0000", "teams": ["eng"]})
    s = st.read()
    assert s["orchi_dir"] == str(tmp_path / "src/orchi")
    assert s["worker_limit"] == 9
    assert s["linear"]["teams"] == ["ENG"]
    assert "fixture-key" not in json.dumps(s)


def test_read_with_no_files_is_the_defaults(tmp_path, monkeypatch):
    files(tmp_path, monkeypatch)
    assert st.read() == st.resolve(home=str(tmp_path))


def test_the_old_files_default_to_herdrs_own_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("HERDR_APP_HOME", raising=False)
    assert st.old_dir() == str(tmp_path / ".config/herdr-app")
    monkeypatch.setenv("HERDR_APP_HOME", "~/private")
    assert st.old_dir() == str(tmp_path / "private")


def test_a_file_that_is_not_utf8_reads_as_missing(tmp_path, monkeypatch):
    files(tmp_path, monkeypatch)
    (tmp_path / "settings.json").write_bytes(b'{"worker_limit": 7, "x": "\xff"}')
    assert st.read()["worker_limit"] == 6


# validate(): one plain line per bad value, naming the key


def lines(value):
    return st.validate(text(value))


def test_a_missing_file_has_nothing_to_say(tmp_path, monkeypatch):
    files(tmp_path, monkeypatch)
    assert st.validate() == []


def test_a_file_with_every_value_good_has_nothing_to_say():
    assert lines({
        "claude_dir": "~/.claude-alt", "orchi_dir": "~/orchi-build", "legwork_dir": "~/legwork",
        "worker_limit": 6, "usage_guard_percent": 95, "sources": ["legwork", "github", "linear", "markdown"],
        "github": {"own_owners": ["me"], "repos": ["me/dots"]},
        "linear": {"teams": ["ENG"], "projects": ["P-1"], "repos": {"ENG": "~/dev/app"}, "legwork_projects": {"P-1": "atlas"}},
        "markdown": {"paths": ["~/notes/tasks.md", "~/notes/todo"]},
    }) == []
    assert lines({}) == []
    assert lines({"worker_limit": 7.0}) == []


def test_validate_reads_the_settings_file_when_given_no_text(tmp_path, monkeypatch):
    files(tmp_path, monkeypatch, {"worker_limit": 0})
    assert st.validate() == ["worker_limit: 0 is not a whole number from 1 to 50"]


def test_a_broken_file_is_one_line_naming_the_file(tmp_path, monkeypatch):
    files(tmp_path, monkeypatch)
    where = str(tmp_path / "settings.json")
    (got,) = st.validate('{"worker_limit": 7,')
    assert got.startswith(f"{where}: not valid JSON")
    (got,) = st.validate('{"worker_limit": NaN}')
    assert got.startswith(f"{where}: not valid JSON")
    assert st.validate("[1]") == [f"{where}: not a JSON object"]
    assert st.validate("") != []


def test_every_wrong_type_is_named():
    assert lines({
        "claude_dir": 3, "orchi_dir": "", "legwork_dir": "   ", "worker_limit": "8", "usage_guard_percent": True,
        "sources": "linear", "github": [], "linear": "x", "markdown": {"paths": "a"},
    }) == [
        "claude_dir: 3 is not a folder path from / or ~/",
        "orchi_dir: \"\" is not a folder path from / or ~/",
        "legwork_dir: \"   \" is not a folder path from / or ~/",
        "worker_limit: \"8\" is not a whole number from 1 to 50",
        "usage_guard_percent: true is not a whole number from 1 to 100",
        "sources: \"linear\" is not a list",
        "github: [] is not an object",
        "linear: \"x\" is not an object",
        "markdown.paths: \"a\" is not a list",
    ]


def test_each_bad_item_is_its_own_line():
    assert lines({
        "sources": ["linear", "jira", 3],
        "github": {"own_owners": ["me", ""], "repos": ["me/dots", "nope", "a/b/c"]},
        "linear": {"teams": ["ENG", 4], "projects": [None], "repos": {"ENG": "~/a", "WEB": 3, " ": "/x"},
                   "legwork_projects": {"P-1": "atlas", "P-2": ""}},
        "markdown": {"paths": ["~/a", 5]},
    }) == [
        "sources: \"jira\" is not a ticket source: use legwork, github, linear or markdown",
        "sources: 3 is not a ticket source: use legwork, github, linear or markdown",
        "github.own_owners: \"\" is not a GitHub owner",
        "github.repos: \"nope\" is not owner/repo",
        "github.repos: \"a/b/c\" is not owner/repo",
        "linear.teams: 4 is not a team key",
        "linear.projects: null is not a project id",
        "linear.repos.WEB: 3 is not a folder path from / or ~/",
        "linear.repos: \" \" is not a team key",
        "linear.legwork_projects.P-2: \"\" is not a legwork project file",
        "markdown.paths: 5 is not a file or folder path from / or ~/",
    ]


def test_a_source_not_written_as_the_schema_lists_it_is_named():
    assert lines({"sources": ["Linear", " github ", "linear"]}) == [
        "sources: \"Linear\" is not a ticket source: use legwork, github, linear or markdown",
        "sources: \" github \" is not a ticket source: use legwork, github, linear or markdown",
    ]


def test_two_names_for_one_team_are_named():
    assert lines({"linear": {"repos": {" 1 ": "/a", "1": "/b", "eng": "/c", "ENG": "/d"}}}) == [
        "linear.repos: \" 1 \" is the same team as \"1\"",
        "linear.repos: \"ENG\" is the same team as \"eng\"",
    ]


def test_numbers_out_of_range_are_named():
    assert lines({"worker_limit": 51, "usage_guard_percent": 0}) == [
        "worker_limit: 51 is not a whole number from 1 to 50",
        "usage_guard_percent: 0 is not a whole number from 1 to 100",
    ]
    assert lines({"worker_limit": 2.5}) == ["worker_limit: 2.5 is not a whole number from 1 to 50"]


def test_a_number_too_long_for_pythons_int_is_named_as_out_of_range():
    assert st.validate('{"worker_limit": %s}' % ("9" * 5000)) == [
        "worker_limit: Infinity is not a whole number from 1 to 50"]


def test_null_is_named_too():
    assert lines({"claude_dir": None}) == ["claude_dir: null is not a folder path from / or ~/"]


def test_unknown_keys_are_named_at_any_depth():
    assert lines({"bugbot_owners": [], "github": {"bugbot_owners": ["x"]}, "markdown": {"folders": []}}) == [
        "bugbot_owners: Orchi has no such setting",
        "github.bugbot_owners: Orchi has no such setting",
        "markdown.folders: Orchi has no such setting",
    ]


def test_a_secret_is_never_a_setting():
    assert lines({"linear": {"api_key": "x"}, "apiKey": "y", "github": {"token": "z"}}) == [
        "apiKey: a secret never goes in settings; take it out",
        "github.token: a secret never goes in settings; take it out",
        "linear.api_key: a secret never goes in settings; take it out",
    ]


@pytest.mark.parametrize("name", ["keyboard_layout", "monkey", "keys_shown", "tokenizer", "turkey", "team_key", "key_file", "keyboard",
                                  "patience", "monkeys"])
def test_a_secret_word_inside_another_word_is_just_unknown(name):
    assert lines({name: 1}) == [f"{name}: Orchi has no such setting"]


@pytest.mark.parametrize("name", ["apiKey", "apikey", "API_KEY", "githubToken", "client_secret", "password", "key",
                                  "private_key", "ssh_key", "accessKey", "apiKeys", "tokens", "githubPAT"])
def test_a_name_with_a_secret_word_is_a_secret(name):
    assert lines({name: 1}) == [f"{name}: a secret never goes in settings; take it out"]


@pytest.mark.parametrize("data", [
    {"bad\nthing": 1},
    {"line\u2028break": 1},
    {"linear": {"repos": {"A\nB": 3}}},
    {"worker_limit": "a\u2028b"},
    {"claude_dir": "\r"},
    {"linear": {"legwork_projects": {"P\u00851": ""}}},
])
def test_each_problem_is_one_printable_line(data):
    (got,) = lines(data)
    assert got.splitlines() == [got] and got.isprintable(), repr(got)


def test_a_name_that_cant_be_printed_is_shown_quoted():
    assert lines({"bad\nthing": 1}) == ['"bad\\nthing": Orchi has no such setting']


def test_a_name_too_long_for_pythons_int_is_just_a_name():
    long = "9" * 5000
    s = st.resolve(json.dumps({"linear": {"repos": {long: "/a", "1": "/b"}}}), home=HOME)
    assert s["linear"]["repos"] == {long: "/a", "1": "/b"}
    assert lines({"linear": {"repos": {long: 3}}}) == [f"linear.repos.{long}: 3 is not a folder path from / or ~/"]


def test_a_long_value_is_cut_short():
    (got,) = lines({"worker_limit": "x" * 200})
    assert len(got) < 120 and got.endswith("is not a whole number from 1 to 50")


# The schema: the reader and validate() cover exactly its keys, with its defaults and ranges.


def leaves(schema, prefix=""):
    out = {}
    for key, sub in schema["properties"].items():
        path = f"{prefix}{key}"
        if "properties" in sub:
            out.update(leaves(sub, f"{path}."))
        else:
            out[path] = sub
    return out


def value_at(data, path):
    for part in path.split("."):
        data = data[part]
    return data


def resolved_leaves(data, prefix=""):
    out = set()
    for key, value in data.items():
        if isinstance(value, dict) and key in ("github", "linear", "markdown"):
            out |= resolved_leaves(value, f"{prefix}{key}.")
        else:
            out.add(f"{prefix}{key}")
    return out


LEAVES = leaves(SCHEMA)


def test_the_schema_is_a_draft_2020_12_schema_that_allows_nothing_else():
    assert SCHEMA["$schema"] == "https://json-schema.org/draft/2020-12/schema"

    def closed(schema, where="settings"):
        assert schema.get("additionalProperties") is False, where
        for key, sub in schema["properties"].items():
            if "properties" in sub:
                closed(sub, key)
    closed(SCHEMA)


def test_the_reader_returns_exactly_the_schemas_keys():
    assert resolved_leaves(st.resolve(home=HOME)) == set(LEAVES)


def test_the_schema_defaults_are_the_readers_defaults():
    defaults = st.resolve(home=HOME)
    for path, sub in LEAVES.items():
        if "default" in sub:
            want = sub["default"]
            if isinstance(want, str) and want.startswith("~/"):
                want = HOME + want[1:]
            assert value_at(defaults, path) == want, path
        else:
            assert value_at(defaults, path) is None, path


def test_the_schema_ranges_are_the_readers_ranges():
    for path in ("worker_limit", "usage_guard_percent"):
        sub = LEAVES[path]
        assert sub["type"] == "integer"
        low, high = sub["minimum"], sub["maximum"]
        assert lines({path: low}) == [] and lines({path: high}) == []
        assert lines({path: low - 1}) and lines({path: high + 1})
        assert st.resolve(json.dumps({path: high}), home=HOME)[path] == high
        assert st.resolve(json.dumps({path: high + 1}), home=HOME)[path] == sub["default"]
    assert LEAVES["usage_guard_percent"]["minimum"] == 1 and LEAVES["usage_guard_percent"]["maximum"] == 100


def test_the_schema_sources_are_the_readers_sources():
    assert LEAVES["sources"]["items"]["enum"] == list(st.SOURCES)
    every = st.resolve(json.dumps({"sources": list(reversed(st.SOURCES))}), home=HOME)["sources"]
    assert every == list(st.SOURCES)


def wrong(sub):
    """A value of the wrong type for a schema leaf."""
    return {"string": 7, "integer": "7", "array": "x", "object": "x"}[sub["type"]]


@pytest.mark.parametrize("path", sorted(LEAVES))
def test_validate_names_every_schema_key_given_the_wrong_type(path):
    data = {}
    cursor = data
    parts = path.split(".")
    for part in parts[:-1]:
        cursor = cursor.setdefault(part, {})
    cursor[parts[-1]] = wrong(LEAVES[path])
    got = lines(data)
    assert len(got) == 1 and got[0].startswith(f"{path}: "), got


def test_the_schema_has_no_place_for_a_secret():
    assert not [p for p in LEAVES if any(word in p.lower() for word in ("key", "token", "secret", "password"))]
    assert "apiKey" not in json.dumps(SCHEMA)
