import test from "node:test";
import assert from "node:assert/strict";
import { herdBlocked, sessionOf } from "../../mods/panel-buttons/herd-badge.js";

// What `terminals()` gives: `status` as a plain word.
const list = [
  { address: "t1", parent: null, state: "live", status: "working" },
  { address: "t2", parent: "t1", state: "live", status: "blocked" },
  { address: "t3", parent: "t2", state: "live", status: "blocked" },
  { address: "t4", parent: "t1", state: "finished", status: "blocked" },
  { address: "t5", parent: "t1", state: "live", status: "idle" },
  { address: "t9", parent: null, state: "live", status: "blocked" },
];

test("the Herd button counts everyone blocked in the herd in view, from its top, and no one else", () => {
  assert.equal(herdBlocked(list, "t1"), 2);
  assert.equal(herdBlocked(list, "t3"), 2);
  assert.equal(herdBlocked(list, "t9"), 1);
  assert.equal(herdBlocked(list, "nobody"), 0);
  assert.equal(herdBlocked(list, null), 0);
});

test("a status given as an object still counts, and a loop in the parents can't hang it", () => {
  assert.equal(herdBlocked([{ address: "a", parent: null, state: "live", status: { state: "blocked" } }], "a"), 1);
  assert.equal(herdBlocked([{ address: "a", parent: "b", state: "live", status: "blocked" }, { address: "b", parent: "a", state: "live", status: "working" }], "a"), 1);
});

test("the badge follows the session in view, as the panel does", () => {
  const claude = { pane: "a", tab: "T", terminal: "t1", app: "claude-code" }, shell = { pane: "b", tab: "T", terminal: "t2", app: null };
  assert.equal(sessionOf([claude, { ...shell, focused: true }]), "t1");
  assert.equal(sessionOf([{ ...claude, terminal: "win/t1", focused: true }]), null);
  assert.equal(sessionOf([claude]), null);
});
