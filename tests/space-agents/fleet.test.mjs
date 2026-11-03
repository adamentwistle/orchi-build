import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTEXT_WARN, RANK, agentTree, blockedReason, changedPaths, contextShare, dropTarget, fleetCounts, foldKey, foldPressed, inbox, kidStatus, pruneFolds,
  sharedEdits, subtree, unseenCount, urgencyOf,
} from "../../mods/space-agents/tree.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const agent = (address, status, extra = {}) => ({ address, status, pane: `p-${address}`, tab: "tab1", space: "s1", seq: 0, ...extra });
const term = (address, status, extra = {}) => ({ address, status, state: "live", parent: null, ...extra });

test("a remote space's folds stay while its machine isn't ready, and go once it is and the space is gone", () => {
  const folds = ["s1", "win/s9", foldKey.status("win/s9", "idle"), "win/s2", "mac/s3"];
  assert.deepEqual(pruneFolds(folds, ["s1", "win/s2"]), folds);
  assert.deepEqual(pruneFolds(folds, ["s1", "win/s2"], ["win"]), ["s1", "win/s2", "mac/s3"]);
});

test("a press just after a chevron's is the chevron's, and a later one is the row's", () => {
  assert.equal(foldPressed(1000, 1100), true);
  assert.equal(foldPressed(1000, 2000), false);
  assert.equal(foldPressed(null, 5), false);
});

test("a drop moves the dragged space by id, and does nothing when either space has gone", () => {
  assert.deepEqual(dropTarget(["a", "b", "c"], "a", "c"), { id: "a", index: 3 });
  assert.deepEqual(dropTarget(["a", "b", "c"], "c", "a"), { id: "c", index: 1 });
  assert.equal(dropTarget(["a", "c"], "b", "c"), null, "the dragged space closed");
  assert.equal(dropTarget(["a", "b"], "a", "gone"), null);
  assert.equal(dropTarget(["a", "b"], "a", "a"), null);
});

test("a blocked reason is the report's message, else its kind, else nothing", () => {
  assert.equal(blockedReason(term("t1", "blocked", { report: { state: "blocked", kind: "permission", msg: "approve Bash: npm test" } })), "approve Bash: npm test");
  assert.equal(blockedReason(term("t1", "blocked", { report: { state: "blocked", kind: "question" } })), "has a question");
  assert.equal(blockedReason(term("t1", "blocked", { report: "approve Edit" })), "approve Edit");
  assert.equal(blockedReason(term("t1", "blocked", { report: { state: "blocked" } })), null);
  assert.equal(blockedReason(undefined), null);
});

test("the inbox holds every blocked agent and sub-agent, oldest first, with its reason", () => {
  const list = [agent("t1", "blocked"), agent("t2", "working"), agent("t3", "blocked"), agent("win/t4", "blocked", { space: "win/s2" })];
  const all = [
    term("t1", "blocked", { status_ms: 3000, report: { msg: "approve Bash: ls" } }),
    term("t2", "working"),
    term("t3", "blocked", { status_ms: 1000, report: { kind: "question" } }),
    term("win/t4", "blocked"),
    term("t5", "blocked", { parent: "t2", status_ms: 2000, report: { msg: "approve Write" } }),
    term("t6", "error", { parent: "t2", status_ms: 500 }),
    term("t7", "blocked", { parent: "t2", state: "finished", status_ms: 1 }),
  ];
  const since = (a) => (a.address === "win/t4" ? 2500 : 0);
  const got = inbox(list, all, since);
  assert.deepEqual(got.map((e) => [e.address, e.reason, e.sub]), [
    ["t6", "stopped on an error", true],
    ["t3", "has a question", false],
    ["t5", "approve Write", true],
    ["win/t4", null, false],
    ["t1", "approve Bash: ls", false],
  ]);
  assert.equal(got.find((e) => e.address === "t1").pane, "p-t1");
  assert.equal(got.find((e) => e.address === "t5").pane, null, "a sub-agent is focused by terminal");
});

test("an agent with no time at all goes last in the inbox", () => {
  const got = inbox([agent("t1", "blocked"), agent("t2", "blocked")], [term("t1", "blocked"), term("t2", "blocked", { status_ms: 9 })], () => 0);
  assert.deepEqual(got.map((e) => e.address), ["t2", "t1"]);
});

test("with no times, the agent whose state changed first leads the inbox", () => {
  const list = [agent("t1", "blocked", { seq: 9 }), agent("t2", "blocked", { seq: 4 })];
  const got = inbox(list, [term("t1", "blocked", { status_ms: null }), term("t2", "blocked", { status_ms: null })], () => 0);
  assert.deepEqual(got.map((e) => e.address), ["t2", "t1"]);
});

test("the header's counts agree with the inbox and the folds on a mixed tree", () => {
  const spaces = [{ id: "s1", tabs: [{ id: "tab1" }] }, { id: "s2", tabs: [{ id: "tab2" }] }];
  const list = [
    // Working, with a blocked sub-agent and a working worker: it sits in Needs you and the inbox has the sub-agent.
    agent("t3", "working"),
    // Idle, with a working worker under a worker that's blocked.
    agent("t1", "idle"),
    agent("t4", "working", { tab: "tab2", space: "s2" }),
    agent("t5", "done", { tab: "tab2", space: "s2" }),
    // Looked at after it finished: idle, but held in Done.
    agent("t6", "idle", { tab: "tab2", space: "s2", focused: true }),
    agent("t7", "blocked", { tab: "tab2", space: "s2" }),
    // A worker with a pane of its own, listed and under its parent too: it counts once.
    agent("t8", "working", { tab: "tab2", space: "s2" }),
  ];
  const all = [
    ...list.filter((a) => a.address !== "t8").map((a) => term(a.address, a.status)),
    term("t8", "working", { parent: "t4" }),
    term("k1", "blocked", { parent: "t3" }),
    term("k2", "working", { parent: "t3" }),
    term("k3", "done", { parent: "t3" }),
    term("k4", "blocked", { parent: "t1" }),
    term("k5", "working", { parent: "k4" }),
    term("k6", "error", { parent: "t4" }),
    term("k7", "working", { parent: "t4", state: "finished" }),
  ];
  const held = { address: "t6", rank: RANK.done };
  const listed = new Map(list.map((a) => [a.address, a.status]));
  const tree = agentTree(list, spaces, urgencyOf(list, all, held), () => 0);
  const waiting = inbox(list, all, () => 0);

  // What the list draws: each agent row by its own status, each sub-agent and worker row by kidStatus.
  const drawn = new Map();
  for (const groups of tree.values()) for (const g of groups) for (const a of g.members) {
    drawn.set(a.address, a.status);
    for (const s of subtree(all, a.address)) drawn.set(s.t.address, kidStatus(s.t, listed));
  }
  const rows = (status) => [...drawn.values()].filter((s) => s === status).length;
  const fold = (key) => [...tree.values()].flat().filter((g) => g.key === key).reduce((n, g) => n + g.members.length, 0);

  const n = fleetCounts(tree, waiting, all, listed);
  assert.equal(n.blocked, waiting.length, "waiting on you is the inbox");
  assert.equal(n.blocked, rows("blocked"), "and every row with a ! in the list");
  assert.deepEqual(waiting.map((e) => e.address).sort(), ["k1", "k4", "k6", "t7"]);
  assert.equal(n.done, fold("done"), "done is what the Done folds hold");
  assert.equal(n.working, rows("working"), "working is every row with a spinner");
  // Working: t3, k2, t4, t8 once, and k5 under a blocked worker. The old count, agents by their own status, said 3, 1, 1.
  assert.deepEqual(n, { working: 5, blocked: 4, done: 2 });
});

test("the header counts nothing with nothing listed", () => {
  assert.deepEqual(fleetCounts(new Map(), [], [], new Map()), { working: 0, blocked: 0, done: 0 });
});

test("unseen chat rows read whatever shape chat.unseen has, and nothing when it's absent", () => {
  assert.equal(unseenCount(undefined), 0);
  assert.equal(unseenCount(null), 0);
  assert.equal(unseenCount(4), 4);
  assert.equal(unseenCount(-1), 0);
  assert.equal(unseenCount(NaN), 0);
  assert.equal(unseenCount(["r1", "r2"]), 2);
  assert.equal(unseenCount({ count: 3 }), 3);
  assert.equal(unseenCount({ t1: 2, t2: 1, t3: ["x"] }), 4);
  assert.equal(unseenCount("lots"), 0);
});

test("changed paths come from every kind of porcelain v2 line", () => {
  const out = [
    "# branch.head main",
    "1 .M N... 100644 100644 100644 aaa aaa mods/space-agents/main.js",
    "2 R. N... 100644 100644 100644 aaa aaa R100 new name.js\told.js",
    "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.js",
    "? notes/new.md",
    "! ignored.log",
  ].join("\n");
  assert.deepEqual(changedPaths(out), ["mods/space-agents/main.js", "new name.js", "conflict.js", "notes/new.md"]);
  assert.deepEqual(changedPaths(""), []);
});

test("spaces in two checkouts of one repo that change the same file are flagged, and only with each other", () => {
  const places = [
    { id: "main", repo: "r", top: "/r", files: ["a.js", "b.js"] },
    { id: "wt1", repo: "r", top: "/wt/1", files: ["a.js", "c.js"] },
    { id: "wt2", repo: "r", top: "/wt/2", files: ["c.js"] },
    { id: "same", repo: "r", top: "/r", files: ["b.js"] },
    { id: "other", repo: "atlas", top: "/atlas", files: ["a.js"] },
    { id: "none", repo: null, top: null, files: ["a.js"] },
  ];
  const got = sharedEdits(places);
  assert.deepEqual(Object.fromEntries(got), { main: ["a.js"], wt1: ["a.js", "c.js"], wt2: ["c.js"] });
});

test("context share matches the status line: of 80% of the window", () => {
  // The status line read 9.2% for this session at 73,893 tokens.
  assert.deepEqual(contextShare(73893, "claude-haiku-5-5"), { pct: 9, window: 1000000 });
  assert.deepEqual(contextShare(489651, "claude-opus-5-5"), { pct: 61, window: 1000000 });
  assert.ok(contextShare(489651, "claude-opus-5-5").pct >= CONTEXT_WARN);
});

test("context window: 200k for an older model until it's seen past that, then 1M", () => {
  assert.deepEqual(contextShare(100000, "claude-sonnet-4-5"), { pct: 63, window: 200000 });
  assert.deepEqual(contextShare(100000, "claude-sonnet-4-5", new Set(["claude-sonnet-4-5"])), { pct: 13, window: 1000000 });
  assert.equal(contextShare(250000, "claude-sonnet-4-5").window, 1000000);
  assert.equal(contextShare(10, "claude-sonnet-4-5[1m]").window, 1000000);
  assert.equal(contextShare(10, null).window, 200000);
  assert.equal(contextShare(0, "m"), null);
  assert.equal(contextShare(undefined, "m"), null);
});

test("the context helper reads the latest main-thread usage for a pid, and skips what it can't place", () => {
  const home = mkdtempSync(join(tmpdir(), "sa-ctx-"));
  const config = join(home, ".claude-alt");
  mkdirSync(join(config, "sessions"), { recursive: true });
  mkdirSync(join(config, "projects", "-Users-me-proj-x"), { recursive: true });
  writeFileSync(join(config, "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId: "abc-123", cwd: "/Users/me/proj.x" }));
  writeFileSync(join(config, "sessions", "77.json"), JSON.stringify({ pid: 77, sessionId: "../../etc", cwd: "/" }));
  const line = (o) => JSON.stringify(o);
  writeFileSync(join(config, "projects", "-Users-me-proj-x", "abc-123.jsonl"), [
    line({ type: "assistant", message: { model: "m1", usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 } } }),
    line({ type: "assistant", message: { model: "m1", usage: { input_tokens: 2, cache_read_input_tokens: 5000, cache_creation_input_tokens: 3 } } }),
    line({ type: "assistant", isSidechain: true, message: { model: "m1", usage: { input_tokens: 9, cache_read_input_tokens: 99999 } } }),
    "not json with \"usage\"",
    line({ type: "user", message: { content: "hi" } }),
  ].join("\n"));
  const r = spawnSync("python3", ["-I", "-S", join(repo, "mods", "space-agents", "context.py"), "4242", "77", "999", "x;y"], {
    encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin:/opt/homebrew/bin" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { 4242: { tokens: 5005, model: "m1" } });
});
