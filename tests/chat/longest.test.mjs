import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { buildStats, longestRanges, parseStatsCache, statsFigures, withLongest, duration } from "../../mods/claude-chat/usage-data.js";
import { fileURLToPath } from "node:url";

// Windows has no python3: that name is the Microsoft Store stand-in.
const PYTHON = process.platform === "win32" ? "python" : "python3";

const HELPER = fileURLToPath(new URL("../../mods/claude-chat/longest.py", import.meta.url));
const END = "2026-10-30";
const cache = parseStatsCache(readFileSync(new URL("./fixtures/stats-cache.json", import.meta.url), "utf8"));

// The cache holds one longest session, the all-time one from 2026-07-29. For Last 7 and Last 30 days there is nothing in
// it, which is why those two figures were empty. /stats reads the transcripts for them.
test("the cache has a longest session for All time only", () => {
  assert.equal(cache.longestSession.timestamp.slice(0, 10), "2026-07-29");
  assert.equal(statsFigures(cache, "all").longest, 391_522_310);
  assert.equal(statsFigures(cache, "d7").longest, undefined);
  assert.equal(statsFigures(cache, "d30").longest, undefined);
});

// ---- the helper, on transcripts in the shape Claude Code writes ----

const line = (type, ts, extra = {}) => JSON.stringify({ type, timestamp: ts, uuid: "u", message: { role: type, content: "x" }, ...extra });
// A real transcript opens with bookkeeping lines, and its first message can be an attachment.
const bookkeeping = [
  JSON.stringify({ type: "mode", mode: "normal", sessionId: "s" }),
  JSON.stringify({ type: "file-history-snapshot", messageId: "m", snapshot: {} }),
];

function projects(files) {
  const root = mkdtempSync(join(tmpdir(), "longest-"));
  for (const [path, lines, mtime] of files) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, [...bookkeeping, ...lines].join("\n") + "\n");
    if (mtime) utimesSync(full, mtime, mtime);
  }
  return root;
}
const run = (root, end = END) => JSON.parse(execFileSync(PYTHON, ["-I", "-S", HELPER, root, end]));
const H = 3600e3;

test("a session is first message to last, counted for each range it started in", () => {
  const root = projects([
    ["-a/short.jsonl", [line("user", "2026-10-29T10:00:00.000Z"), line("assistant", "2026-10-29T10:30:00.000Z")]],
    // Started 20 days before the end: in Last 30 days, not Last 7.
    ["-a/long.jsonl", [line("attachment", "2026-10-10T08:00:00.000Z"), line("user", "2026-10-10T08:01:00.000Z"), line("assistant", "2026-10-12T08:00:00.000Z")]],
    // Started 3 days before the end: in both, and shorter than long.jsonl.
    ["-b/mid.jsonl", [line("user", "2026-10-27T00:00:00.000Z"), line("assistant", "2026-10-27T05:00:00.000Z")]],
  ]);
  assert.deepEqual(run(root), { d7: 5 * H, d30: 48 * H });
});

test("a session's own subagents and its sidechain messages don't count", () => {
  const root = projects([
    ["-a/main.jsonl", [line("user", "2026-10-29T10:00:00.000Z"), line("assistant", "2026-10-29T10:10:00.000Z"), line("assistant", "2026-10-30T10:00:00.000Z", { isSidechain: true })]],
    ["-a/main/subagents/agent-1.jsonl", [line("user", "2026-10-26T00:00:00.000Z"), line("assistant", "2026-10-29T00:00:00.000Z")]],
  ]);
  assert.deepEqual(run(root), { d7: 10 * 60e3, d30: 10 * 60e3 });
});

test("a session that started after the cache's last day, or before the range, is left out", () => {
  const root = projects([
    ["-a/after.jsonl", [line("user", "2026-10-31T00:00:00.000Z"), line("assistant", "2026-10-31T09:00:00.000Z")]],
    ["-a/before.jsonl", [line("user", "2026-09-01T00:00:00.000Z"), line("assistant", "2026-10-29T00:00:00.000Z")]],
  ]);
  assert.deepEqual(run(root), { d7: null, d30: null });
});

test("a file last changed before the range began is skipped, as /stats does", () => {
  const old = new Date("2026-09-15T00:00:00Z");
  const root = projects([["-a/old.jsonl", [line("user", "2026-10-29T00:00:00.000Z"), line("assistant", "2026-10-29T04:00:00.000Z")], old]]);
  assert.deepEqual(run(root), { d7: null, d30: null });
});

test("an empty folder gives null for both, not an error", () => {
  assert.deepEqual(run(mkdtempSync(join(tmpdir(), "longest-"))), { d7: null, d30: null });
});

test("the last line can sit past a message longer than the first look at the tail", () => {
  const big = line("user", "2026-10-29T11:00:00.000Z", { message: { role: "user", content: "y".repeat(600_000) } });
  const root = projects([["-a/big.jsonl", [line("user", "2026-10-29T10:00:00.000Z"), big]]]);
  assert.deepEqual(run(root), { d7: H, d30: H });
});

// ---- the mod's side ----

const exec = (r) => async () => r;

test("longestRanges reads the helper's answer as the helper prints it", async () => {
  const out = await longestRanges({ exec: exec({ code: 0, stdout: '{"d7": 254116902, "d30": 1318440127}\n' }) }, "h.py", "/p", END);
  assert.deepEqual(out, { d7: 254_116_902, d30: 1_318_440_127 });
  assert.equal(duration(out.d7), "2d 22h");
  assert.equal(duration(out.d30), "15d 6h");
});

test("longestRanges keeps a null range and gives null when the helper didn't run or printed something else", async () => {
  assert.deepEqual(await longestRanges({ exec: exec({ code: 0, stdout: '{"d7": null, "d30": 5}' }) }, "h", "/p", END), { d7: null, d30: 5 });
  assert.equal(await longestRanges({ exec: exec({ code: 1, stdout: "" }) }, "h", "/p", END), null);
  assert.equal(await longestRanges({ exec: exec({ code: 0, stdout: "not json" }) }, "h", "/p", END), null);
  assert.equal(await longestRanges({ exec: exec({ code: 0, stdout: '{"d7": "9"}' }) }, "h", "/p", END), null);
  assert.equal(await longestRanges({ exec: async () => { throw new Error("no python"); } }, "h", "/p", END), null);
});

test("withLongest fills the two shorter ranges and leaves All time", async () => {
  const views = await buildStats(cache);
  const out = withLongest(views, { d7: 254_116_902, d30: null });
  assert.equal(out.d7.longest, 254_116_902);
  assert.equal(out.d30.longest, null);
  assert.equal(out.all.longest, 391_522_310);
  assert.equal(views.d7.longest, undefined, "the views it was given aren't changed");
  assert.equal(withLongest(views, null), views);
});
