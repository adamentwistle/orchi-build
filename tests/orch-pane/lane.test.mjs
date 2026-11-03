import test from "node:test";
import assert from "node:assert/strict";
import { axisOf, laneOf, ringShares, tickCount } from "../../mods/orch-pane/lane.js";

const axis = { from: 0, now: 80, to: 100 };

test("the scale runs from the start to now, or to the estimated end", () => {
  assert.deepEqual(axisOf(1000, 90000, 30000), { from: 1000, now: 90000, to: 120000 });
  assert.deepEqual(axisOf(1000, 90000, null), { from: 1000, now: 90000, to: 90000 });
  assert.deepEqual(axisOf(null, 90000, null), { from: 90000, now: 90000, to: 150000 });
  assert.deepEqual(axisOf(100000, 90000, 0), { from: 90000, now: 90000, to: 150000 });
});

test("a lane fits any width, and stays readable when narrow", () => {
  assert.equal(tickCount(300), 60);
  assert.equal(tickCount(10), 8);
});

test("an active lane runs to now, then the estimate", () => {
  assert.deepEqual(laneOf({ phase: "active", started: 20 }, axis, 100, 10), { lit: [20, 80], ghost: [81, 90], now: 80 });
});

test("a finished lane stops where it ended, with no estimate", () => {
  assert.deepEqual(laneOf({ phase: "done", started: 10, ended: 30 }, axis, 100, 0), { lit: [10, 30], ghost: null, now: 80 });
});

test("a task too short for a tick still shows one, and one with no times shows none", () => {
  assert.deepEqual(laneOf({ phase: "done", started: 50, ended: 50 }, axis, 100, 0).lit, [50, 50]);
  assert.equal(laneOf({ phase: "done" }, axis, 100, 0).lit, null);
});

test("a time at the end of the scale stays on it", () => {
  assert.deepEqual(laneOf({ phase: "active", started: 0 }, { from: 0, now: 100, to: 100 }, 20, 0).lit, [0, 19]);
});

test("the ring shares ticks between done and active, and a running task always shows", () => {
  assert.deepEqual(ringShares(2, 1, 4, 60), { done: 30, active: 15 });
  assert.deepEqual(ringShares(0, 1, 100, 60), { done: 0, active: 1 });
  assert.deepEqual(ringShares(4, 1, 4, 60), { done: 60, active: 0 });
  assert.deepEqual(ringShares(0, 0, 0, 60), { done: 0, active: 0 });
});
