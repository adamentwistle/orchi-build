import test from "node:test";
import assert from "node:assert/strict";
import { ThreadMotion, isShowing, jumpFor, linesOf, listHeight, sweepOf, panelHold } from "../../mods/claude-chat/reveal.js";
import { FRAME_MS } from "../../mods/claude-chat/motion.js";

const text = (id, height, block = "b1", top = 10) => ({ key: id, type: "text", top, row: { id, block, kind: "text" }, height });
const heights = (items) => Object.fromEntries(items.map((i) => [i.key, i.height]));

// A motion with a clock we step by hand.
function rig() {
  const log = [], timers = [];
  let notified = 0;
  const motion = new ThreadMotion({
    notify: () => { notified += 1; },
    after: (ms, f) => timers.push({ ms, f }),
    bottom: () => log.push("bottom"),
    overscan: 480,
  });
  const fire = () => timers.shift().f();
  const frame = () => { motion.drawn(); timers.pop().f(); };
  return { motion, log, timers, fire, frame, notified: () => notified };
}

test("lines come from the height, at least one, and a code card takes three between its two items", () => {
  assert.equal(linesOf("text", 70, 23.33), 3);
  assert.equal(linesOf("text", 5, 23.33), 1);
  assert.equal(linesOf("code-head", 33, 23.33) + linesOf("code-body", 300, 23.33), 3);
});

test("every part of a short block is covered, numbered in order", () => {
  const { plan, lines } = sweepOf([{ key: "a", type: "text", height: 46 }, { key: "b", type: "text", height: 23 }], { lineHeight: 23, reach: 1000 });
  assert.equal(plan.count, 3);
  assert.deepEqual(lines, { a: { first: 0, n: 2, height: 23 }, b: { first: 2, n: 1, height: 23 } });
});

test("a band is the part's height over its lines, so it fits a part that isn't a whole number of lines", () => {
  const { lines } = sweepOf([{ key: "a", type: "text", height: 70 }], { lineHeight: 23.33, reach: 1000 });
  assert.equal(lines.a.n, 3);
  assert.ok(Math.abs(lines.a.height - 70 / 3) < 1e-9);
});

test("only the end of a block taller than the view is covered, and its timing starts there", () => {
  const parts = Array.from({ length: 50 }, (_, i) => ({ key: `p${i}`, type: "text", height: 70 }));
  const { plan, lines } = sweepOf(parts, { lineHeight: 23.33, reach: 200 });
  assert.equal(Object.values(lines).filter((l) => l.n).length, 3);
  assert.equal(lines.p46.n, 0);
  assert.equal(lines.p47.first, 0);
  assert.equal(plan.count, 9);
});

test("a list moves by what no longer fits", () => {
  assert.equal(jumpFor(100, 200, 500), 0, "both fit");
  assert.equal(jumpFor(450, 550, 500), 50, "it starts to overflow");
  assert.equal(jumpFor(700, 800, 500), 100, "already overflowing");
  assert.equal(jumpFor(800, 700, 500), -100, "shrinking");
});

test("a list's height is its rows and the bottom gap", () => {
  const item = { type: "worked", top: 14, row: {} };
  assert.equal(listHeight([item], {}), 14 + 20 + 18);
  assert.equal(listHeight([], {}), 0);
});

test("a pane shows when its tab is shown in the shown space and nothing else there is zoomed", () => {
  const space = (active, tabActive) => [{ active, tabs: [{ id: "a", active: tabActive }] }];
  const me = { pane: "p2", tab: "a", zoomed: true }, other = { pane: "p1", tab: "a", zoomed: false };
  assert.equal(isShowing("p2", [other, me], space(true, true)), true);
  assert.equal(isShowing("p2", [other, me], space(false, true)), false);
  assert.equal(isShowing("p2", [other, me], space(true, false)), false);
  assert.equal(isShowing("p2", [{ ...other, zoomed: true }, { ...me, zoomed: false }], space(true, true)), false);
  assert.equal(isShowing("p9", [other, me], space(true, true)), false);
});

test("two panes side by side both show", () => {
  assert.equal(isShowing("p2", [{ pane: "p1", tab: "a", zoomed: false }, { pane: "p2", tab: "a", zoomed: false }], [{ active: true, tabs: [{ id: "a", active: true }] }]), true);
});

test("a block is held until every row has a height, then sweeps in order: bottom, then the covers move", () => {
  const { motion, log, frame, timers } = rig();
  const a = text("a", 46), b = text("b", 23);
  motion.land([a.row, b.row]);
  timers.length = 0;
  assert.equal(motion.held(a), true);
  motion.begin([a, b], [], { a: 46 }, 800);
  assert.equal(motion.held(a), true, "b has no height yet");
  motion.begin([a, b], [], heights([a, b]), 800);
  assert.equal(motion.held(a), false);
  assert.equal(motion.sweep.armed, false);
  assert.equal(motion.rows.get("a").phase, "start");
  frame();
  assert.deepEqual(log, ["bottom"]);
  assert.equal(motion.sweep.armed, false, "the covers have to be drawn in place first");
  frame();
  assert.equal(motion.sweep.armed, true);
  assert.equal(motion.rows.get("a").phase, "go");
  assert.equal(motion.counts.sweeps, 1);
});

test("the end of a sweep clears its rows, and the plan sets when", () => {
  const { motion, frame, timers, fire } = rig();
  const a = text("a", 46);
  motion.land([a.row]);
  timers.length = 0;
  motion.begin([a], [], { a: 46 }, 800);
  frame();
  frame();
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms >= motion.sweep.plan.ms + 330, "room for what comes after it to fade in");
  fire();
  assert.equal(motion.sweep, null);
  assert.equal(motion.rows.size, 0);
});

test("only the newest block in a read sweeps, and everything else fades", () => {
  const { motion } = rig();
  const a = text("a", 23, "old"), b = text("b", 23, "new");
  const tool = { key: "tool:x", type: "tool", top: 0, row: { id: "t", kind: "tool", tool: "x" } };
  motion.land([a.row, b.row, tool.row]);
  motion.begin([a, b, tool], [], { a: 23, b: 23 }, 800);
  assert.deepEqual(Object.keys(motion.sweep.lines), ["b"]);
  assert.equal(motion.counts.fades, 2);
});

test("a row after the block waits for the sweep, and a row before it doesn't", () => {
  const { motion } = rig();
  const before = { key: "u", type: "user", top: 26, row: { id: "u", kind: "user" } };
  const a = text("a", 23);
  const worked = { key: "w", type: "worked", top: 14, row: { id: "w", kind: "worked" } };
  motion.land([before.row, a.row, worked.row]);
  motion.begin([before, a, worked], [], { u: 40, a: 23 }, 800);
  assert.equal(motion.rows.get("u").delay, undefined);
  assert.equal(motion.rows.get("w").delay, motion.sweep.plan.ms);
});

test("a read with no text fades, with no sweep", () => {
  const { motion, frame } = rig();
  const user = { key: "u", type: "user", top: 26, row: { id: "u", kind: "user" } };
  motion.land([user.row]);
  motion.begin([user], [], { u: 40 }, 800);
  assert.equal(motion.sweep, null);
  frame();
  frame();
  assert.equal(motion.rows.get("u").phase, "go");
});

test("the glide starts from the jump, and spends it after the covers are in place", () => {
  const { motion, frame } = rig();
  const old = text("old", 790, "x"), a = text("a", 100);
  motion.land([a.row]);
  motion.begin([old, a], [old], { old: 790, a: 100 }, 800);
  frame();
  assert.deepEqual(motion.glide, { top: 110, on: false });
  frame();
  assert.deepEqual(motion.glide, { top: 0, on: true });
});

test("a short thread doesn't scroll, so nothing glides", () => {
  const { motion, frame } = rig();
  const a = text("a", 100);
  motion.land([a.row]);
  motion.begin([a], [], { a: 100 }, 800);
  frame();
  frame();
  assert.deepEqual(motion.glide, { top: 0, on: false });
});

test("the glide never passes the rows held above the view", () => {
  const { motion, frame } = rig();
  const old = text("old", 2000, "x"), a = text("a", 900);
  motion.land([a.row]);
  motion.begin([old, a], [old], { old: 2000, a: 900 }, 800);
  frame();
  assert.equal(motion.glide.top, 480);
});

test("rows that never get a height stop being held, so they aren't lost", () => {
  const { motion, timers } = rig();
  const a = text("a", 23);
  motion.land([a.row]);
  timers.shift().f();
  assert.equal(motion.held(a), false);
});

test("the end of one read's wait doesn't let go of a later read's rows", () => {
  const { motion, timers } = rig();
  const a = text("a", 23), b = text("b", 23);
  motion.land([a.row]);
  motion.land([b.row]);
  timers.shift().f();
  assert.equal(motion.held(a), false);
  assert.equal(motion.held(b), true);
});

test("a new transcript drops everything, and steps still queued find nothing", () => {
  const { motion, frame } = rig();
  const a = text("a", 23);
  motion.land([a.row]);
  motion.begin([a], [], { a: 23 }, 800);
  motion.clear();
  frame();
  frame();
  assert.equal(motion.sweep, null);
  assert.equal(motion.rows.size, 0);
});

test("a second block mid-sweep takes over, and the first one's end leaves it alone", () => {
  const { motion, frame, timers } = rig();
  const a = text("a", 23, "one"), b = text("b", 23, "two");
  motion.land([a.row]);
  timers.length = 0;
  motion.begin([a], [], { a: 23 }, 800);
  frame();
  frame();
  const firstEnd = timers.shift();
  motion.land([b.row]);
  timers.length = 0;
  motion.begin([a, b], [a], { a: 23, b: 23 }, 800);
  assert.deepEqual(Object.keys(motion.sweep.lines), ["b"]);
  firstEnd.f();
  assert.deepEqual(Object.keys(motion.sweep.lines), ["b"]);
  assert.equal(motion.rows.has("a"), false);
});

const tool = { key: "tool:x", type: "tool", top: 0 };
const below = { key: "below", type: "text", top: 10 };

const rows = (n) => Array.from({ length: n }, (_, i) => ({ key: `w${i}`, type: "worked", top: 0, row: { id: `w${i}` } }));

test("a growing tool line keeps its old slot, and moves in the next frame, carrying the rows below", () => {
  const { motion, frame, timers, log } = rig();
  motion.slideTool([tool, below], "tool:x", 38, 138, { below: 23 }, 800, false);
  assert.equal(motion.slide.armed, false);
  assert.deepEqual([...motion.slide.below], ["below"]);
  assert.equal(motion.sizes({ "tool:x": 138 })["tool:x"], 38);
  frame();
  assert.deepEqual(log, [], "scrolled up, so the list stays where it is");
  assert.equal(motion.slide.armed, true);
  timers.shift().f();
  assert.equal(motion.slide, null);
  assert.equal(motion.sizes({ "tool:x": 138 })["tool:x"], 138, "it takes the new size when the motion is over");
});

test("a shrinking tool line takes its new size at once", () => {
  const { motion } = rig();
  motion.slideTool([tool, below], "tool:x", 138, 38, { below: 23 }, 800, false);
  assert.equal(motion.sizes({ "tool:x": 38 })["tool:x"], 38);
});

test("growing at the bottom makes room, moves into it, then rises", () => {
  const { motion, frame, log } = rig();
  motion.slideTool([tool, ...rows(30)], "tool:x", 38, 138, {}, 100, true);
  assert.equal(motion.slide.tail, 100);
  assert.equal(motion.slide.armed, false);
  frame();
  assert.deepEqual(log, ["bottom"]);
  assert.deepEqual(motion.glide, { top: 100, on: false });
  assert.equal(motion.slide.armed, false, "the glide has to land before anything moves");
  frame();
  assert.equal(motion.slide.armed, true);
  assert.deepEqual(motion.glide, { top: 0, on: true, name: "tool" });
});

test("a short thread needs no room, because nothing scrolls", () => {
  const { motion, frame, log } = rig();
  motion.slideTool([tool], "tool:x", 38, 138, {}, 800, true);
  assert.equal(motion.slide.tail, 0);
  frame();
  assert.deepEqual(log, []);
  assert.equal(motion.slide.armed, true);
});

test("shrinking at the bottom holds the room, falls, and the room goes as the glide ends", () => {
  const { motion, frame, timers } = rig();
  motion.slideTool([tool, ...rows(30)], "tool:x", 138, 38, {}, 100, true);
  assert.equal(motion.slide.tail, 100);
  assert.deepEqual(motion.glide, { top: 0, on: false });
  frame();
  assert.deepEqual(motion.glide, { top: 100, on: true, name: "tool" });
  timers.shift().f();
  assert.equal(motion.slide, null);
  assert.deepEqual(motion.glide, { top: 0, on: false });
});

test("no change of height is no slide", () => {
  const { motion } = rig();
  motion.slideTool([tool], "tool:x", 38, 38, {}, 800, false);
  assert.equal(motion.slide, null);
  motion.slideTool([tool], "tool:gone", 38, 138, {}, 800, false);
  assert.equal(motion.slide, null);
});

test("a sent message rises rather than fades, and lets its row reach out of its slot", () => {
  const { motion, frame } = rig();
  const item = { key: "sent:1", type: "user", top: 26, row: { id: "sent:1", kind: "user" } };
  motion.land([{ id: "sent:1" }], { sent: true });
  assert.equal(motion.reaching, false, "held rows aren't in the list yet");
  motion.begin([item], [], { "sent:1": 40 }, 800);
  assert.equal(motion.rows.get("sent:1").sent, true);
  assert.equal(motion.reaching, true);
  assert.equal(motion.counts.fades, 1);
  frame();
  frame();
  assert.equal(motion.rows.get("sent:1").phase, "go");
});

test("the composer growing over a full list moves the list and leaves nothing to glide", () => {
  const { motion, frame, log } = rig();
  let springing = false;
  motion.footMoved(23, 2000, 800, true, () => { springing = true; }, () => {});
  assert.deepEqual(motion.glide, { top: -23, on: false }, "the box shrinks this frame, and this holds the rows still");
  frame();
  assert.deepEqual(log, ["bottom"]);
  assert.deepEqual(motion.glide, { top: 0, on: false });
  assert.equal(springing, false);
  frame();
  assert.equal(springing, true);
  assert.deepEqual(motion.glide, { top: 0, on: false });
});

test("the composer growing under a short list glides against its spring, so the rows stay", () => {
  const { motion, frame } = rig();
  motion.footMoved(23, 100, 800, true, () => {}, () => {});
  frame();
  assert.deepEqual(motion.glide, { top: -23, on: false });
  frame();
  assert.deepEqual(motion.glide, { top: 0, on: true, name: "composer" });
});

test("the composer shrinking moves in the next frame, and a full list has already landed", () => {
  const { motion, frame, log } = rig();
  motion.footMoved(-23, 2000, 800, true, () => {}, () => {});
  assert.deepEqual(motion.glide, { top: 0, on: false });
  frame();
  assert.deepEqual(log, []);
});

test("scrolled up, the list doesn't go to the bottom when the composer grows", () => {
  const { motion, frame, log } = rig();
  motion.footMoved(23, 2000, 800, false, () => {}, () => {});
  frame();
  assert.deepEqual(log, []);
  assert.deepEqual(motion.glide, { top: -23, on: false });
});

test("status text fades out, changes, then fades back, and lands on the latest", () => {
  const { motion, timers, fire } = rig();
  assert.deepEqual(motion.statusText("One"), { text: "One", opacity: 1 });
  assert.deepEqual(motion.statusText("Two"), { text: "One", opacity: 0 });
  assert.deepEqual(motion.statusText("Three"), { text: "One", opacity: 0 });
  assert.equal(timers.length, 1, "one fade at a time");
  fire();
  assert.deepEqual(motion.statusText("Three"), { text: "Three", opacity: 1 });
});

test("the first time a pane shows it doesn't fade, and coming back does", () => {
  const { motion, frame, timers, fire } = rig();
  motion.shown(true);
  assert.equal(motion.cover, null);
  motion.shown(false);
  motion.shown(true);
  assert.equal(motion.cover.armed, false);
  frame();
  assert.equal(motion.cover.armed, true);
  fire();
  assert.equal(motion.cover, null);
  assert.equal(timers.length, 0);
});

test("each swap's cover has its own id, so it starts solid", () => {
  const { motion } = rig();
  motion.shown(true);
  motion.shown(false);
  motion.shown(true);
  const first = motion.cover.id;
  motion.shown(false);
  motion.shown(true);
  assert.notEqual(motion.cover.id, first);
});

test("steps wait a frame", () => {
  const { motion, timers } = rig();
  motion.stages.next(() => {});
  motion.drawn();
  assert.equal(timers[0].ms, FRAME_MS);
});

test("rows too short to fill the thread stay where they are until a panel reaches them", () => {
  assert.equal(panelHold(300, 600, 100), 300);
  assert.equal(panelHold(300, 600, 400), 200);
  assert.equal(panelHold(300, 600, 900), 0);
  assert.equal(panelHold(0, 600, 100), 0);
});
