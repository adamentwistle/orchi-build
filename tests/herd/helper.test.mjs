import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HELPER = new URL("../../mods/herd/herd.py", import.meta.url).pathname;
const LIVE = "11111111-1111-1111-1111-111111111111", OLD = "22222222-2222-2222-2222-222222222222", FAR = "33333333-3333-3333-3333-333333333333";
const at = (s) => new Date(Date.UTC(2026, 10, 1, 1, 0, s)).toISOString();
const ms = (s) => Date.UTC(2026, 10, 1, 1, 0, s);
const use = (s, id, name, input = {}) => JSON.stringify({ type: "assistant", timestamp: at(s), message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input }] } });
const result = (s, id) => JSON.stringify({ type: "user", timestamp: at(s), message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

function run(root, session, since = 0, from = 0) {
  const out = execFileSync("python3", ["-I", "-S", HELPER, "--since", String(since), "--session", JSON.stringify({ key: "t", dir: root, id: session, from })], { encoding: "utf8" });
  return JSON.parse(out).sessions.t;
}

function project() {
  const root = mkdtempSync(join(tmpdir(), "herd-")), dir = join(root, "projects", "-repo");
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}

function subagent(dir, session, id, meta, lines) {
  const folder = join(dir, session, "subagents");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `agent-${id}.meta.json`), JSON.stringify(meta));
  writeFileSync(join(folder, `agent-${id}.jsonl`), lines.join("\n") + "\n");
}

test("tool calls pair with their results, and one with no result is still running", () => {
  const { root, dir } = project();
  writeFileSync(join(dir, `${LIVE}.jsonl`), ["not json", use(1, "a", "Read"), result(3, "a"), use(4, "b", "Bash"), use(5, "c", "Write"), result(6, "c"), use(7, "d", "Mystery")].join("\n") + "\n");
  const s = run(root, LIVE);
  assert.deepEqual(s.events, [[ms(1), "r", 2000, "Read"], [ms(4), "b", null, "Bash"], [ms(5), "w", 1000, "Write"], [ms(7), "o", null, "Mystery"]]);
  assert.equal(s.model, "claude-opus-5-5");
  assert.equal(s.first, ms(1));
});

test("a shell command that only waits counts as waiting", () => {
  const { root, dir } = project();
  const calls = ["hc wait --children any", "cd x && bugbot-wait 12", "sleep 30", "git push", "echo sleeping"];
  writeFileSync(join(dir, `${LIVE}.jsonl`), calls.map((command, i) => use(i, `c${i}`, "Bash", { command })).join("\n") + "\n");
  assert.deepEqual(run(root, LIVE).events.map((e) => e[1]), ["h", "h", "h", "b", "b"]);
});

test("calls before --since aren't returned", () => {
  const { root, dir } = project();
  writeFileSync(join(dir, `${LIVE}.jsonl`), [use(1, "a", "Read"), use(9, "b", "Bash")].join("\n") + "\n");
  assert.deepEqual(run(root, LIVE, ms(5)).events, [[ms(9), "b", null, "Bash"]]);
});

test("only the end of a huge transcript is read, and a cut line is skipped", () => {
  const { root, dir } = project();
  const padding = "x".repeat(4 * 1024 * 1024);
  writeFileSync(join(dir, `${LIVE}.jsonl`), [use(1, "a", "Read"), `{"pad":"${padding}"}`, use(9, "b", "Bash")].join("\n") + "\n");
  assert.deepEqual(run(root, LIVE).events.map((e) => e[1]), ["b"]);
});

test("a running subagent has its calls, and a finished one doesn't", () => {
  const { root, dir } = project();
  writeFileSync(join(dir, `${LIVE}.jsonl`), use(1, "a", "Read") + "\n");
  subagent(dir, LIVE, "r1", { description: "Going\u0007now", agentType: "general-purpose", model: "sonnet" }, [use(2, "x", "Grep")]);
  subagent(dir, LIVE, "f1", { description: "Ended", finished: true }, [use(2, "y", "Grep")]);
  const agents = run(root, LIVE).agents, going = agents.find((a) => a.id === "r1"), ended = agents.find((a) => a.id === "f1");
  assert.equal(going.task, "Going now");
  assert.deepEqual(going.events, [[ms(2), "r", null, "Grep"]]);
  assert.equal(ended.finished, true);
  assert.deepEqual(ended.events, []);
});

test("a session cleared part way keeps the subagents of the transcript it follows, back as far as the terminal's start", () => {
  const { root, dir } = project();
  writeFileSync(join(dir, `${LIVE}.jsonl`), use(30, "a", "Read") + "\n");
  writeFileSync(join(dir, `${OLD}.jsonl`), use(1, "b", "Read") + "\n");
  writeFileSync(join(dir, `${FAR}.jsonl`), use(1, "c", "Read") + "\n");
  subagent(dir, OLD, "o1", { description: "Before the clear", finished: true }, [use(2, "x", "Grep")]);
  subagent(dir, FAR, "f1", { description: "Another session", finished: true }, [use(2, "x", "Grep")]);
  const when = (s) => new Date(ms(s));
  utimesSync(join(dir, `${OLD}.jsonl`), when(20), when(20));
  utimesSync(join(dir, `${FAR}.jsonl`), when(-300), when(-300));
  const near = join(dir, OLD, "subagents", "agent-o1.jsonl");
  utimesSync(near, when(19), when(19));
  const agents = run(root, LIVE, 0, ms(-100)).agents;
  assert.deepEqual(agents.map((a) => [a.id, a.current]), [["o1", false]]);
  assert.deepEqual(run(root, LIVE, 0, ms(25)).agents, []);
});

test("a bad session id reads nothing", () => {
  const { root } = project();
  const out = execFileSync("python3", ["-I", "-S", HELPER, "--session", JSON.stringify({ key: "t", dir: root, id: "../../etc" }), "--session", "not json"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out).sessions, {});
});

const useIn = (s, id, name, input) => JSON.stringify({ type: "assistant", cwd: "/work/repo", timestamp: at(s), message: { content: [{ type: "tool_use", id, name, input }] } });

test("each call says what it was for: a path from the session's folder, a command's program, or a description", () => {
  const { root, dir } = project();
  const calls = [
    ["Read", { file_path: "/work/repo/mods/herd/view.js" }],
    ["Bash", { command: "cd /work/repo && GIT_PAGER=cat git push origin main" }],
    ["Bash", { command: 'SP=/tmp/x; "$SP/run.sh" --fast' }],
    ["Bash", { command: "if [ -f a ]; then node --test tests; fi" }],
    ["Grep", { pattern: "TODO" }],
    ["Agent", { description: "Find the bug", subagent_type: "Explore" }],
    ["Edit", { file_path: "/elsewhere/notes.md" }],
    ["mcp__linear__get_issue", { id: "X-1" }],
  ];
  writeFileSync(join(dir, `${LIVE}.jsonl`), calls.map(([name, input], i) => useIn(i, `c${i}`, name, input)).join("\n") + "\n");
  assert.deepEqual(run(root, LIVE).events.map((e) => e[3]), [
    "Read mods/herd/view.js", "Bash git push", "Bash run.sh", "Bash node", "Grep TODO", "Agent Find the bug", "Edit /elsewhere/notes.md", "get_issue",
  ]);
});

test("the last finished turn gives its length, its calls and how many failed", () => {
  const { root, dir } = project();
  const failed = (s, id) => JSON.stringify({ type: "user", timestamp: at(s), message: { content: [{ type: "tool_result", tool_use_id: id, content: "no", is_error: true }] } });
  const turn = (s, ms) => JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: ms, timestamp: at(s) });
  const lines = [use(1, "old", "Read"), result(2, "old"), turn(3, 3000), use(10, "a", "Bash"), failed(11, "a"), use(12, "b", "Read"), result(13, "b"), use(14, "c", "Grep"), result(15, "c"), turn(16, 7000)];
  writeFileSync(join(dir, `${LIVE}.jsonl`), lines.join("\n") + "\n");
  assert.deepEqual(run(root, LIVE).turn, { ended: ms(16), ms: 7000, tools: 3, failed: 1 });
});

test("a call that only mentions turn_duration is still a call, and no turn means none", () => {
  const { root, dir } = project();
  writeFileSync(join(dir, `${LIVE}.jsonl`), use(1, "a", "Grep", { pattern: "turn_duration" }) + "\n");
  const s = run(root, LIVE);
  assert.deepEqual(s.events.map((e) => e[3]), ["Grep turn_duration"]);
  assert.equal(s.turn, null);
});

test("the context is the tokens of the last reply that has usage, with its model", () => {
  const { root, dir } = project();
  const reply = (s, model, usage) => JSON.stringify({ type: "assistant", timestamp: at(s), message: { model, content: [{ type: "text", text: "hi" }], usage } });
  const lines = [reply(1, "claude-opus-5-5", { input_tokens: 5, cache_read_input_tokens: 100 }), reply(2, "claude-opus-5-5", { input_tokens: 2, cache_read_input_tokens: 150000, cache_creation_input_tokens: 1000, output_tokens: 99 }), reply(3, "<synthetic>", { input_tokens: 0 }), JSON.stringify({ type: "assistant", isSidechain: true, timestamp: at(4), message: { model: "claude-haiku-5-5", usage: { input_tokens: 9 } } })];
  writeFileSync(join(dir, `${LIVE}.jsonl`), lines.join("\n") + "\n");
  assert.deepEqual(run(root, LIVE).context, { tokens: 151002, model: "claude-opus-5-5" });
});

test("a subagent from before a /clear isn't read again, even with no finished line", () => {
  const { root, dir } = project();
  writeFileSync(join(dir, `${LIVE}.jsonl`), use(30, "a", "Read") + "\n");
  writeFileSync(join(dir, `${OLD}.jsonl`), use(1, "b", "Read") + "\n");
  subagent(dir, OLD, "o1", { description: "Stopped by the clear" }, [use(2, "x", "Grep")]);
  subagent(dir, LIVE, "n1", { description: "Going" }, [use(31, "y", "Grep")]);
  const when = (s) => new Date(ms(s));
  utimesSync(join(dir, `${OLD}.jsonl`), when(20), when(20));
  utimesSync(join(dir, OLD, "subagents", "agent-o1.jsonl"), when(19), when(19));
  const agents = run(root, LIVE, 0, ms(-100)).agents;
  const old = agents.find((a) => a.id === "o1"), going = agents.find((a) => a.id === "n1");
  assert.deepEqual([old.current, old.finished, old.events, old.context], [false, false, [], null]);
  assert.deepEqual(going.events.map((e) => e[3]), ["Grep"]);
});
