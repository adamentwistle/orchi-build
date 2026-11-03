import test from "node:test";
import assert from "node:assert/strict";
import { usageMeter, formatLeft } from "../../mods/orchi/usage.js";

const now = Date.parse("2026-10-30T12:20:00Z");
const hour = 3600;

test("projected is used over the share of the window gone", () => {
  const m = usageMeter("5-hour", 5, "2026-10-30T15:40:00Z", 5 * hour, now, "session");
  assert.equal(Math.round(m.projected), 15);
});

test("no projection under 2 percent of the window", () => {
  const m = usageMeter("5-hour", 1, "2026-10-30T17:19:00Z", 5 * hour, now, "session");
  assert.equal(m.projected, null);
});

test("the 5-hour tone follows current use", () => {
  const tone = (used) => usageMeter("5-hour", used, "2026-10-30T15:40:00Z", 5 * hour, now, "session").tone;
  assert.deepEqual([tone(49), tone(50), tone(80)], ["done", "ansi3", "blocked"]);
});

test("the weekly tone follows projected use", () => {
  const reset = "2026-11-02T04:00:00Z";
  const tone = (used) => usageMeter("All models", used, reset, 168 * hour, now, "weekly").tone;
  assert.deepEqual([tone(40), tone(55), tone(70)], ["done", "ansi3", "blocked"]);
});

test("time left reads like the status line", () => {
  assert.equal(formatLeft(3 * hour + 19 * 60), "3h 19m");
  assert.equal(formatLeft(63 * hour), "2d 15h");
  assert.equal(formatLeft(30 * 60), "30m");
});

import { meterTicks, meterCells } from "../../mods/orchi/usage.js";

test("the tick count is the most the meter width holds at a 5.5px pitch", () => {
  // Two meters in a 368px panel: 368 less border, padding and gap, halved.
  assert.equal(meterTicks(368, 2), 30);
  assert.equal(meterTicks(320, 2), 26);
  assert.equal(meterTicks(undefined, 2), 26);
  assert.equal(meterTicks(100, 2), 6);
  for (const w of [320, 368, 500]) {
    const n = meterTicks(w, 2), each = (w - 2 - 24 - 16) / 2;
    assert.ok(n * 5.5 - 4 <= each, `${n} ticks fit ${each}px`);
  }
});

test("the fill is round(count times value), then what's projected, and nothing marks the time", () => {
  const cells = meterCells({ used: 50, projected: 80 }, 10);
  assert.equal(cells.length, 10);
  assert.equal(cells.filter((c) => c.part === "used").length, 5);
  assert.equal(cells.filter((c) => c.part === "ahead").length, 3);
  assert.ok(cells.every((c) => "part" in c));
});

test("Orchi's meters leave out a limit the account doesn't have, and add Fable", async () => {
  const { metersFrom } = await import("../../mods/orchi/usage.js");
  const meters = metersFrom({ sessionUsage: 0, fableUsage: 3, fableResetAt: "2026-11-02T04:00:00Z", weeklyUsage: 1, weeklyResetAt: "2026-11-02T04:00:00Z" }, now);
  assert.deepEqual(meters.map((m) => m.label), ["Fable", "All"]);
});
