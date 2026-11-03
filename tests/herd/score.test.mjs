import test from "node:test";
import assert from "node:assert/strict";
import { WINDOW_MS, activityOf, arcPoints, arcSteps, capped, eventAt, freshEvents, geometry, groupNotes, labelSpot, moonPoint, nodeSize, notesOf, pressOffset, routeArcs, segments, shortTime, slotPoint, starField, toneOf } from "../../mods/herd/score.js";

const NOW = 10 * WINDOW_MS;

test("a note sits on the scale for as long as its call ran", () => {
  const [note] = notesOf([[NOW - WINDOW_MS / 2, "b", WINDOW_MS / 4]], NOW, 400);
  assert.equal(note.from, 200);
  assert.equal(note.to, 300);
  assert.equal(note.tone, "shell");
});

test("a call still running reaches now and sounds", () => {
  const [note] = notesOf([[NOW - WINDOW_MS / 2, "w", null]], NOW, 400);
  assert.equal(note.to, 400);
  assert.equal(note.sounding, true);
  assert.equal(note.tone, "write");
});

test("a call longer than the scale starts at its left edge, and an old one drops off", () => {
  assert.equal(notesOf([[NOW - 2 * WINDOW_MS, "b", null]], NOW, 400)[0].from, 0);
  assert.deepEqual(notesOf([[NOW - 2 * WINDOW_MS, "b", 1000]], NOW, 400), []);
});

test("an instant call still draws, and a skill is a mark", () => {
  const [read, skill] = notesOf([[NOW - 60000, "r", 0], [NOW - 50000, "s", 0]], NOW, 400);
  assert.ok(read.to - read.from >= 2);
  assert.equal(skill.tone, "mark");
  assert.equal(toneOf("h"), "wait");
});

test("notes that share a colour share a path", () => {
  const groups = groupNotes(notesOf([[NOW - 900000, "b", 0], [NOW - 800000, "b", 0], [NOW - 700000, "r", 0], [NOW - 1000, "b", 0]], NOW, 400));
  assert.deepEqual(groups.map((g) => [g.tone, g.sounding, g.notes.length]), [["shell", false, 2], ["read", false, 1], ["shell", true, 1]]);
});

test("times stay short", () => {
  assert.equal(shortTime(9000), "9s");
  assert.equal(shortTime(120000), "2m");
  assert.equal(shortTime(3 * 3600000 + 5 * 60000), "3h 05m");
  assert.equal(shortTime(-5), "0s");
});

test("the first slot is at twelve o'clock and they go clockwise", () => {
  const geo = geometry(300), top = slotPoint(0, 4, geo), right = slotPoint(1, 4, geo);
  assert.equal(Math.round(top.x), 150);
  assert.ok(top.y < 50);
  assert.ok(right.x > 250);
});

test("a node grows with its transcript, within limits", () => {
  assert.equal(nodeSize(0), 20);
  assert.ok(nodeSize(2 * 1024 * 1024) > nodeSize(1024 * 1024));
  assert.equal(nodeSize(1e12), 30);
});

test("a label stays on the map and clears its node", () => {
  const geo = geometry(300);
  for (let i = 0; i < 11; i++) {
    const p = slotPoint(i, 11, geo), at = labelSpot(p, 20, geo);
    assert.ok(at.left >= 0 && at.left + at.width <= 300);
    assert.ok(at.top + 14 <= p.y - 10 || at.top >= p.y + 10);
  }
});

test("moons stay a radius from their parent and spread out", () => {
  const a = moonPoint({ x: 0, y: 0 }, 20, 0, 2, 1000), b = moonPoint({ x: 0, y: 0 }, 20, 1, 2, 1000);
  assert.ok(Math.abs(Math.hypot(a.x, a.y) - 20) < 1e-9);
  assert.ok(Math.abs(a.x + b.x) < 1e-9);
});

test("each segment of the ring points at its slot", () => {
  const geo = geometry(300), arcs = segments(11, 0.2);
  assert.equal(arcs.length, 11);
  arcs.forEach(([from, to], i) => assert.ok(Math.abs((from + to) / 2 - slotPoint(i, 11, geo).angle) < 1e-9));
});

test("the route stops short of the nodes on both sides", () => {
  const geo = geometry(300), arcs = routeArcs(4, geo);
  arcs.forEach(([from, to], i) => { assert.ok(from > slotPoint(i, 4, geo).angle); assert.ok(to < slotPoint(i, 4, geo).angle + Math.PI / 2); });
});

test("an arc's points sit on its circle, end to end", () => {
  const points = arcPoints(10, 10, 5, 0, Math.PI, 4);
  assert.equal(points.length, 5);
  points.forEach(([x, y]) => assert.ok(Math.abs(Math.hypot(x - 10, y - 10) - 5) < 1e-9));
});

test("the sky is the same every time and stays on the map", () => {
  assert.deepEqual(starField(300, 20), starField(300, 20));
  assert.ok(starField(300, 20).every((s) => s.x >= 0 && s.x <= 300 && s.y >= 0 && s.y <= 300));
});

test("an agent says what it's doing, for how long", () => {
  const say = (row) => { const a = activityOf(row, NOW); return [a.word, a.tone, a.since]; };
  assert.deepEqual(say({ state: "blocked", events: [] }), ["Needs you", "blocked", null]);
  assert.deepEqual(say({ state: "working", events: [[NOW - 5000, "w", null]] }), ["Writing", "write", 5000]);
  assert.deepEqual(say({ state: "working", events: [[NOW - 9000, "h", null]] }), ["Waiting", "wait", 9000]);
  assert.deepEqual(say({ state: "working", events: [[NOW - 9000, "b", 4000]] }), ["Thinking", "think", 5000]);
  assert.deepEqual(say({ state: "working", quiet: 200000, events: [[NOW - 900000, "b", 1000]] }), ["Quiet", "quiet", 200000]);
  assert.deepEqual(say({ state: "idle", last: NOW - 1000, events: [] }), ["Idle", "idle", 1000]);
  assert.deepEqual(say({ state: "running", kind: "process", started: NOW - 60000 }), ["Running", "running", 60000]);
});

test("only new calls spark, oldest first, up to the limit", () => {
  const rows = [{ key: "a", events: [[10, "b", 0], [30, "r", 0]] }, { key: "b", events: [[20, "w", null]] }];
  assert.deepEqual(freshEvents(rows, 15, 5).map((e) => e.at), [20, 30]);
  assert.deepEqual(freshEvents(rows, 0, 2).map((e) => e.at), [20, 30]);
});

test("an open Agent call is waiting on subagents, not starting", () => {
  const say = (row) => { const a = activityOf(row, NOW); return [a.word, a.tone, a.since]; };
  assert.deepEqual(say({ state: "working", events: [[NOW - 720000, "a", null]] }), ["Waiting", "wait", 720000]);
  assert.equal(notesOf([[NOW - 720000, "a", null]], NOW, 400)[0].tone, "wait");
  assert.equal(notesOf([[NOW - 720000, "a", 300000]], NOW, 400)[0].tone, "wait");
  assert.equal(notesOf([[NOW - 720000, "a", 900]], NOW, 400)[0].tone, "mark");
});

test("time asleep isn't counted in how long an agent has been at something", () => {
  const gaps = [[NOW - 3600000, NOW - 600000]];
  assert.equal(activityOf({ state: "working", events: [[NOW - 4200000, "b", 0]] }, NOW, gaps).since, 4200000 - 3000000);
  assert.equal(activityOf({ state: "working", quiet: 200000, events: [] }, NOW, gaps).since, 200000);
});

test("a press on a ribbon finds the call under it, or the nearest within a few px", () => {
  const events = [[NOW - WINDOW_MS / 2, "b", WINDOW_MS / 4, "Bash git push"], [NOW - 60000, "r", 0, "Read a.js"]];
  assert.equal(eventAt(events, NOW, 250, 400).event[3], "Bash git push");
  assert.equal(eventAt(events, NOW, 302, 400).event[3], "Bash git push");
  assert.equal(eventAt(events, NOW, 150, 400), null);
  assert.equal(eventAt(events, NOW, 387, 400).index, 1);
  assert.equal(eventAt([[NOW - 2 * WINDOW_MS, "b", 1000]], NOW, 1, 400), null);
  assert.equal(eventAt(null, NOW, 1, 400), null);
});

test("a ribbon press reads the same spot at any zoom", () => {
  const events = [[NOW - WINDOW_MS / 2, "b", WINDOW_MS / 4, "Bash git push"]];
  for (const zoom of [1, 1.2, 1.5]) {
    // A press 210 of the app's own pixels into a 400 wide ribbon is 210 * zoom window pixels into bounds 400 * zoom wide.
    const x = pressOffset(210 * zoom, 400 * zoom, 400);
    assert.ok(Math.abs(x - 210) < 1e-9, `zoom ${zoom}`);
    assert.equal(eventAt(events, NOW, x, 400).event[3], "Bash git push", `zoom ${zoom}`);
    // Window pixels taken as the app's own land past the call once the zoom is over 1.
    if (zoom > 1.2) assert.equal(eventAt(events, NOW, 210 * zoom, 400), null, `zoom ${zoom}`);
  }
  // A real press at 1.2 in a private window on Herdr 0.1.12.
  assert.ok(Math.abs(pressOffset(100, 493, 411) - 100 / 1.2) < 0.1);
  assert.equal(pressOffset(-6, 480, 400), 0);
  assert.equal(pressOffset(600, 480, 400), 400);
  assert.equal(pressOffset(undefined, 480, 400), null);
  assert.equal(pressOffset(10, 0, 400), null);
  assert.equal(pressOffset(10, 480, 0), null);
});

test("a long list keeps its last place to say how many more there are", () => {
  assert.deepEqual(capped([1, 2, 3], 3), { shown: [1, 2, 3], more: 0 });
  assert.deepEqual(capped([1, 2, 3, 4, 5], 3), { shown: [1, 2], more: 3 });
});

// How far the middle of each straight step strays inside the true circle, at most.
const sag = (points, cx, cy, radius) => Math.max(...points.slice(1).map(([x, y], i) => {
  const [px, py] = points[i];
  return radius - Math.hypot((x + px) / 2 - cx, (y + py) / 2 - cy);
}));

test("a ring and its arcs read as round at any size, the middle's too", () => {
  const geo = geometry(340), ring = geo.hub / 2 + 7, kids = (geo.hub + 28) / 2 - 1;
  // The ring round the middle, a subagent's arc there when there are three, one round a node, and the route.
  for (const [radius, from, to] of [[ring, 0, 2 * Math.PI], [kids, ...segments(3, 0.3)[0]], [15, ...segments(13, 0.3)[0]], [geo.orbit, ...routeArcs(2, geo)[0]]]) {
    const points = arcPoints(170, 170, radius, from, to);
    assert.ok(sag(points, 170, 170, radius) <= 0.25, `radius ${radius} strays ${sag(points, 170, 170, radius).toFixed(2)} px`);
    assert.ok(points.length <= 64, `radius ${radius} takes ${points.length} points`);
  }
  assert.ok(arcSteps(15, 0, 0.1) >= 1);
  assert.equal(arcSteps(0, 0, 1), 1);
});
