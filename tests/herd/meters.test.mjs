import test from "node:test";
import assert from "node:assert/strict";
import { metersFrom } from "../../mods/herd/meters.js";
import * as herd from "../../mods/herd/meters.js";
import * as orchi from "../../mods/orchi/usage.js";

const now = Date.parse("2026-11-03T12:00:00Z");

test("the usage file gives 5-hour, Fable and All, in that order", () => {
  const meters = metersFrom({ sessionUsage: 30, sessionResetAt: "2026-11-03T14:00:00Z", fableUsage: 40, fableResetAt: "2026-11-09T04:00:00Z", weeklyUsage: 10, weeklyResetAt: "2026-11-09T04:00:00Z" }, now);
  assert.deepEqual(meters.map((m) => [m.label, m.used]), [["5-hour", 30], ["Fable", 40], ["All", 10]]);
});

test("a limit with no reset time is one the account doesn't have, so it's left out, and a missing file gives none", () => {
  const meters = metersFrom({ sessionUsage: 0, weeklyUsage: 1, weeklyResetAt: "2026-11-09T04:00:00Z", fableUsage: 0, fableResetAt: "2026-11-09T04:00:00Z" }, now);
  assert.deepEqual(meters.map((m) => m.label), ["Fable", "All"]);
  assert.deepEqual(metersFrom(null, now), []);
});

test("the copy draws the same meters as Orchi's", () => {
  const args = ["5-hour", 42, "2026-11-03T14:00:00Z", 5 * 3600, now, "session"];
  assert.deepEqual(herd.usageMeter(...args), orchi.usageMeter(...args));
  assert.equal(herd.meterTicks(368, 3), orchi.meterTicks(368, 3));
});
