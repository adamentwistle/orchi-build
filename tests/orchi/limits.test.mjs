import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WORKER_LIMIT, liveWorkers, overrideUntil, parseSettings, startHolds, usageHold, usageHolds } from "../../mods/orchi/limits.js";
import { usageMeter } from "../../mods/orchi/usage.js";

test("the worker limit comes from orchi.json, and a missing or odd value keeps the default", () => {
  assert.equal(DEFAULT_WORKER_LIMIT, 6);
  assert.deepEqual(parseSettings('{"workerLimit": 9}'), { workerLimit: 9 });
  for (const text of [null, "", "not json", '{"workerLimit": 0}', '{"workerLimit": 2.5}', '{"workerLimit": "8"}', '{"workerLimit": 500}', "[]"]) {
    assert.equal(parseSettings(text).workerLimit, DEFAULT_WORKER_LIMIT, String(text));
  }
});

test("workers are counted across every run", () => {
  assert.equal(liveWorkers([{ running: [1, 2] }, { running: [3] }, {}]), 3);
});

const HOUR = 3600 * 1000;
const NOW = Date.parse("2026-11-03T12:00:00Z");
// A 5-hour window that started `hoursIn` ago, at `used` percent.
const session = (used, hoursIn) => usageMeter("5-hour", used, new Date(NOW + (5 - hoursIn) * HOUR).toISOString(), 5 * 3600, NOW, "session");

test("the 5-hour meter holds Start when it's nearly used or heading past its limit", () => {
  assert.equal(usageHold([session(40, 4)], undefined, NOW), null);
  assert.match(usageHold([session(80, 2.5)], undefined, NOW), /^The 5-hour limit is at 80% and heading for 160%, so Start waits until it resets in 2h 30m$/);
  assert.match(usageHold([session(96, 4.5)], undefined, NOW), /^The 5-hour limit is at 96%, so Start waits/);
  // Early in a window the pace swings on very little.
  assert.equal(usageHold([session(10, 0.25)], undefined, NOW), null);
  assert.equal(usageHold([], undefined, NOW), null);
});

test("Start's holds name the worker limit and the usage meter, each with its reason", () => {
  const orchestrators = [{ running: [1, 2, 3] }, { running: [4, 5, 6] }];
  assert.deepEqual(startHolds({ usage: [], orchestrators, limit: 6 }), ["6 workers are running, and the limit across all runs is 6"]);
  assert.deepEqual(startHolds({ usage: [], orchestrators, limit: 7 }), []);
  assert.equal(startHolds({ usage: [session(80, 2.5)], orchestrators: [{ running: [1] }], limit: 1, now: NOW }).length, 2);
});

// A week that started `daysIn` ago, at `used` percent.
const week = (label, used, daysIn) => usageMeter(label, used, new Date(NOW + (7 - daysIn) * 24 * HOUR).toISOString(), 168 * 3600, NOW, "weekly");

test("the weekly meters hold Start too, so an account with no 5-hour limit is still held", () => {
  assert.match(usageHold([week("Fable", 96, 6)], undefined, NOW), /^The Fable weekly limit is at 96%, so Start waits until it resets in 1d 0h$/);
  assert.match(usageHold([week("All", 60, 3.5)], undefined, NOW), /^The all-models weekly limit is at 60% and heading for 120%/);
  assert.equal(usageHold([week("All", 20, 1)], undefined, NOW), null, "under 25% the pace doesn't count");
  assert.equal(usageHold([week("Fable", 50, 6)], undefined, NOW), null);
  assert.deepEqual(usageHolds([week("Fable", 96, 6), week("All", 97, 6)], undefined, NOW).map((h) => h.label), ["Fable", "All"]);
});

test("Start anyway lets a held meter go until it resets, and the worker limit still holds", () => {
  const usage = [week("Fable", 96, 6), session(97, 4)];
  const until = overrideUntil(usage, usageHolds(usage, undefined, NOW), NOW);
  assert.equal(until.get("Fable"), NOW + 24 * HOUR);
  assert.equal(until.get("5-hour"), NOW + HOUR);
  assert.deepEqual(usageHolds(usage, new Set(["Fable"]), NOW).map((h) => h.label), ["5-hour"]);
  assert.deepEqual(startHolds({ usage, orchestrators: [{ running: [1] }], limit: 1, overrides: new Set(["Fable", "5-hour"]), now: NOW }), ["1 worker is running, and the limit across all runs is 1"]);
});

test("a meter past its reset time holds nothing, since the cache still has the old window's figure", () => {
  const usage = [week("All", 97, 6)];
  assert.equal(usageHold(usage, undefined, NOW), usageHolds(usage, undefined, NOW)[0].text);
  assert.equal(usageHold(usage, undefined, NOW + 25 * HOUR), null);
  assert.deepEqual(startHolds({ usage, orchestrators: [], limit: 6, now: NOW + 25 * HOUR }), []);
});

test("a meter with no reset time is let go for 5 hours", () => {
  const until = overrideUntil([{ label: "All", used: 99, projected: null, resetIn: "-" }], [{ label: "All" }], NOW);
  assert.equal(until.get("All"), NOW + 5 * HOUR);
});
