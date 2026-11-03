import test from "node:test";
import assert from "node:assert/strict";
import { CONTEXT_WARN, bigModels, contextHigh, contextPercent, contextWindow, turnLine, turnTime } from "../../mods/herd/usage.js";

test("the window follows the sidebar's rule: 1M from generation 5, for [1m], or once past 200k, else 200k", () => {
  assert.equal(contextWindow(10, "claude-opus-5-5"), 1000000);
  assert.equal(contextWindow(10, "claude-haiku-5-5"), 1000000);
  assert.equal(contextWindow(10, "claude-opus-4-6"), 200000);
  assert.equal(contextWindow(10, "claude-opus-4-6[1m]"), 1000000);
  assert.equal(contextWindow(250000, "claude-opus-4-6"), 1000000);
  assert.equal(contextWindow(10, "claude-opus-4-6", new Set(["claude-opus-4-6"])), 1000000);
  assert.equal(contextWindow(10, null), 200000);
});

test("73,893 tokens on a 1M window reads 9%, the status line's 9.2% rounded, as the sidebar shows it", () => {
  assert.equal(Math.round((73893 / (1000000 * 0.8)) * 1000) / 10, 9.2);
  assert.equal(contextPercent({ tokens: 73893, model: "claude-haiku-5-5" }), 9);
  assert.equal(contextPercent({ tokens: 154642, model: "claude-opus-5-5" }), 19);
  assert.equal(contextPercent({ tokens: 130000, model: "claude-opus-4-6" }), 81);
  assert.equal(contextPercent({ tokens: 900000, model: "claude-opus-5-5" }), 100);
  assert.equal(contextPercent({ tokens: 0, model: "claude-opus-5-5" }), null);
  assert.equal(contextPercent(null), null);
  assert.equal(contextPercent({ tokens: "lots", model: "x" }), null);
});

test("a model seen past 200k anywhere counts as large", () => {
  assert.deepEqual([...bigModels([{ tokens: 250000, model: "claude-opus-4-6" }, { tokens: 10, model: "x" }, null])], ["claude-opus-4-6"]);
});

test("the warning starts at 60%", () => {
  assert.equal(CONTEXT_WARN, 60);
  assert.equal(contextHigh(59), false);
  assert.equal(contextHigh(60), true);
  assert.equal(contextHigh(null), false);
});

test("a turn reads as its time, its tools and any that failed", () => {
  assert.equal(turnTime(42000), "42s");
  assert.equal(turnTime(250000), "4m 10s");
  assert.equal(turnTime(3900000), "1h 05m");
  assert.equal(turnLine({ ms: 250000, tools: 12, failed: 1 }), "4m 10s, 12 tools, 1 failed");
  assert.equal(turnLine({ ms: 5000, tools: 1, failed: 0 }), "5s, 1 tool");
  assert.equal(turnLine({ ms: 5000, tools: 0, failed: 0 }), "5s, no tools");
  assert.equal(turnLine(null), null);
});
