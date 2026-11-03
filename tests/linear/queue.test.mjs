import test from "node:test";
import assert from "node:assert/strict";
import { bucketOf, counts, toggleTick, dotFor, ticketGroups, staleNote } from "../../mods/linear/queue.js";

const issue = (state, stateType) => ({ state, stateType, identifier: "ENG-1", project: "Atlas" });

test("review states land in review, by name, whatever their type", () => {
  assert.equal(bucketOf(issue("In Review", "started")), "review");
  assert.equal(bucketOf(issue("Code review", "started")), "review");
});

test("started and unstarted are active, backlog and triage are backlog", () => {
  assert.equal(bucketOf(issue("In Progress", "started")), "active");
  assert.equal(bucketOf(issue("Todo", "unstarted")), "active");
  assert.equal(bucketOf(issue("Backlog", "backlog")), "backlog");
  assert.equal(bucketOf(issue("Triage", "triage")), "backlog");
});

test("counts adds up each bucket", () => {
  const list = [issue("In Review", "started"), issue("Todo", "unstarted"), issue("Backlog", "backlog")];
  assert.deepEqual(counts(list), { all: 3, active: 1, backlog: 1, review: 1 });
});

test("toggleTick returns a new set", () => {
  const first = new Set(["a"]);
  const second = toggleTick(first, "b");
  assert.deepEqual([...first], ["a"]);
  assert.deepEqual([...second].sort(), ["a", "b"]);
  assert.deepEqual([...toggleTick(second, "a")], ["b"]);
});

test("the status dot follows the bucket, never Linear's colour", () => {
  assert.equal(dotFor(issue("In Progress", "started")), "working");
  assert.equal(dotFor(issue("In Review", "started")), "done");
  assert.equal(dotFor(issue("Todo", "unstarted")), "dim");
});

test("ticketGroups keeps one bucket, grouped by project then status with a dot", () => {
  const a = { ...issue("In Progress", "started"), id: "1" };
  const b = { ...issue("In Review", "started"), id: "2" };
  const groups = ticketGroups([a, b], "active", (i) => i.project);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "Atlas");
  assert.equal(groups[0].count, 1);
  assert.deepEqual(groups[0].groups.map((g) => [g.label, g.dot]), [["In Progress", "working"]]);
});

test("the all filter keeps every ticket, the others keep their own", () => {
  const list = [issue("In Review", "started"), issue("Todo", "unstarted"), issue("Backlog", "backlog")];
  const size = (bucket) => ticketGroups(list, bucket, (i) => i.project).reduce((sum, g) => sum + g.count, 0);
  assert.equal(size("all"), 3);
  assert.equal(size("review"), 1);
});

test("an error over a kept list reads Out of date with the reason, and with no list it isn't a note", () => {
  assert.equal(staleNote("Linear answered 500", 146), "Out of date. Linear answered 500");
  assert.equal(staleNote("Linear answered 500", 0), null);
  assert.equal(staleNote(null, 146), null);
  assert.equal(staleNote(null, 2000, true), "Showing the first 2000 open tickets. Older ones aren't listed.");
  assert.equal(staleNote("Timed out", 2000, true), "Out of date. Timed out");
});
