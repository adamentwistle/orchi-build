import test from "node:test";
import assert from "node:assert/strict";
import { FRAME_MS, MOTION, SNAP, Stages, ease, glideFrom, snap, spring, springPolicy, sweepPlan, sweepTravel, transitionPolicy } from "../../mods/claude-chat/motion.js";

// An element that records what it was asked to do.
const element = () => {
  const calls = [];
  const el = {};
  for (const name of ["opacity", "w", "h", "left", "top", "transition", "spring"]) el[name] = (...args) => { calls.push([name, ...args]); return el; };
  return { el, calls };
};

test("every eased motion is ease-out, and its duration is a whole number of tens", () => {
  for (const [name, m] of Object.entries(MOTION)) {
    if (m.duration == null) continue;
    assert.equal(m.easing, "ease-out", name);
    assert.equal(m.duration % 10, 0, name);
  }
});

test("eased durations are the mockup's, stretched for Herdr's steeper curve", () => {
  assert.equal(MOTION.fade.duration, 270);
  assert.equal(MOTION.quick.duration, 180);
  assert.equal(MOTION.rise.duration, 330);
});

test("springs stay as the mockup has them, because Herdr's spring matches its sum", () => {
  assert.deepEqual(MOTION.panel, { response: 340, damping: 0.9 });
  assert.deepEqual(MOTION.glide, { response: 360, damping: 1 });
});

test("ease sets the value and the transition for the same property", () => {
  const { el, calls } = element();
  assert.equal(ease(el, "opacity", 0, "fade"), el);
  assert.deepEqual(calls, [["opacity", 0], ["transition", "opacity", { duration: 270, easing: "ease-out" }]]);
});

test("height and width go through the style methods h and w", () => {
  const { el, calls } = element();
  ease(el, "height", 10, "fade");
  spring(el, "width", 20, "panel");
  assert.deepEqual(calls.map((c) => c[0]), ["h", "transition", "w", "spring"]);
  assert.equal(calls[1][1], "height");
  assert.equal(calls[3][1], "width");
});

test("a property Herdr can't animate is refused", () => {
  const { el } = element();
  assert.throws(() => ease(el, "scale", 1, "fade"), /can't animate scale/);
  assert.throws(() => spring(el, "color", 1, "panel"), /can't animate color/);
});

test("slow stretches time and leaves everything else alone", () => {
  assert.deepEqual(transitionPolicy("fade", { delay: 10, slow: 10 }), { duration: 2700, easing: "ease-out", delay: 100 });
  assert.deepEqual(springPolicy("panel", { slow: 4 }), { response: 1360, damping: 0.9 });
});

test("snap keeps a spring on the element, with one too short to see", () => {
  const { el, calls } = element();
  snap(el, "top", 30);
  assert.deepEqual(calls, [["top", 30], ["spring", "top", SNAP]]);
});

test("a short block keeps the agreed gap", () => {
  assert.deepEqual(sweepPlan(3), { count: 3, line: 300, gap: 120, ms: 540 });
});

test("the gap holds until the block would run past the limit", () => {
  assert.equal(sweepPlan(8).gap, 120);
  assert.equal(sweepPlan(8).ms, 1140);
  assert.ok(sweepPlan(9).gap < 120);
  assert.equal(sweepPlan(9).ms, 1200);
});

test("a long block ends on the limit", () => {
  assert.equal(sweepPlan(13).gap, 75);
  assert.equal(sweepPlan(13).ms, 1200);
  assert.ok(Math.abs(sweepPlan(150).ms - 1200) < 1e-9);
});

test("one line has no gap, and no lines still makes a plan", () => {
  assert.equal(sweepPlan(1).gap, 0);
  assert.equal(sweepPlan(1).ms, 300);
  assert.equal(sweepPlan(0).count, 1);
  assert.equal(sweepPlan(2.9).count, 2);
});

test("a cover starts with its edge off the left and ends past the right", () => {
  assert.deepEqual(sweepTravel(700), { from: -60, to: 704, width: 760 });
});

test("the glide is the jump, up to the rows held above the view", () => {
  assert.equal(glideFrom(120, 480), 120);
  assert.equal(glideFrom(900, 480), 480);
  assert.equal(glideFrom(-5, 480), 0);
});

test("Stages runs one step per drawn frame, even when timers fall due together", () => {
  const log = [];
  let notified = 0;
  const stages = new Stages(() => { notified += 1; });
  const timers = [];
  const after = (ms, f) => timers.push([ms, f]);
  stages.next(() => log.push("first"));
  stages.next(() => log.push("second"));
  stages.drawn(after);
  stages.drawn(after);
  assert.equal(timers.length, 1, "a second render during the wait starts no second timer");
  assert.equal(timers[0][0], FRAME_MS);
  timers.shift()[1]();
  assert.deepEqual(log, ["first"]);
  stages.drawn(after);
  timers.shift()[1]();
  assert.deepEqual(log, ["first", "second"]);
  stages.drawn(after);
  assert.equal(timers.length, 0);
  assert.equal(notified, 4, "each next and each step asks for a render");
});
