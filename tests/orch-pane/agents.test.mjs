import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Windows has no python3: that name is the Microsoft Store stand-in.
const PYTHON = process.platform === "win32" ? "python" : "python3";

const HELPER = fileURLToPath(new URL("../../mods/orch-pane/agents.py", import.meta.url));
const LIVE = "11111111-1111-1111-1111-111111111111", OLD = "22222222-2222-2222-2222-222222222222", OTHER = "33333333-3333-3333-3333-333333333333";
const STAMP = "2026-10-31T14:59:30.000Z";

function agent(root, session, id, meta) {
  const dir = join(root, "projects", "-repo", session, "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${id}.meta.json`), typeof meta === "string" ? meta : JSON.stringify(meta));
  writeFileSync(join(dir, `agent-${id}.jsonl`), `not json\n{"timestamp":"${STAMP}"}\n`);
}

const title = (root, session, name) => writeFileSync(join(root, "projects", "-repo", session, "custom-title.json"), JSON.stringify({ customTitle: name }));

function read(...args) {
  return JSON.parse(execFileSync(PYTHON, ["-I", "-S", HELPER, ...args], { encoding: "utf8" })).agents;
}

function tree() {
  const root = mkdtempSync(join(tmpdir(), "orch-pane-"));
  agent(root, LIVE, "a1", { description: "Item 0\u0007build", agentType: "long-runner", model: "opus", effort: "high" });
  agent(root, LIVE, "a2", { description: "Item 1", agentType: "codex", finished: true });
  agent(root, LIVE, "a3", "not json");
  agent(root, OLD, "b1", { description: "Before the clear", finished: true });
  agent(root, OTHER, "c1", { description: "Someone else's session", finished: true });
  title(root, LIVE, "orch-atlas"); title(root, OLD, "orch-atlas"); title(root, OTHER, "Side chat");
  return root;
}

test("a subagent with no finished line is reported as running, with its start from its own log", () => {
  const list = read("--config", tree(), "--session", LIVE);
  assert.deepEqual(list.map((a) => a.id).sort(), ["a1", "a2"]);
  const a = list.find((x) => x.id === "a1");
  assert.equal(a.finished, false);
  assert.equal(a.current, true);
  assert.equal(a.started, Date.parse(STAMP));
  assert.equal(a.task, "Item 0 build");
  assert.equal(list.find((x) => x.id === "a2").finished, true);
});

test("a run that was cleared keeps its earlier session, and nobody else's", () => {
  const list = read("--config", tree(), "--session", LIVE, "--title", "orch-atlas", "--since", "1000");
  assert.deepEqual(list.map((a) => a.id).sort(), ["a1", "a2", "b1"]);
  assert.equal(list.find((x) => x.id === "b1").current, false);
});

test("anything last touched before the run started is left out", () => {
  const root = tree(), log = join(root, "projects", "-repo", LIVE, "subagents", "agent-a2.jsonl");
  utimesSync(log, new Date(1000), new Date(1000));
  const since = Date.parse("2026-01-01T00:00:00Z");
  assert.deepEqual(read("--config", root, "--session", LIVE, "--title", "orch-atlas", "--since", String(since)).map((a) => a.id).sort(), ["a1", "b1"]);
});

test("an unknown or malformed session gives an empty list", () => {
  const root = tree();
  assert.deepEqual(read("--config", root, "--session", "44444444-4444-4444-4444-444444444444"), []);
  assert.deepEqual(read("--config", root, "--session", "../../etc"), []);
});
