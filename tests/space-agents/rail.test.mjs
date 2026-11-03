import test from "node:test";
import assert from "node:assert/strict";
import { initials, railStatus, railTip } from "../../mods/space-agents/rail.js";

test("a space's mark is two letters from its name", () => {
  assert.equal(initials("orchi-build"), "OB");
  assert.equal(initials("memory research"), "MR");
  assert.equal(initials("Tests"), "Te");
  assert.equal(initials("Q"), "Q");
  assert.equal(initials("~"), "~");
  assert.equal(initials(""), "?");
});

test("a tile shows blocked over done over working, and nothing when all is idle", () => {
  const a = (status) => ({ status });
  assert.equal(railStatus([a("working"), a("blocked"), a("done")]), "blocked");
  assert.equal(railStatus([a("working"), a("done")]), "done");
  assert.equal(railStatus([a("idle"), a("working")]), "working");
  assert.equal(railStatus([a("idle")], true), "working");
  assert.equal(railStatus([a("idle")]), null);
  assert.equal(railStatus([]), null);
});

test("a tile's tooltip names the space and its key, for the first nine", () => {
  assert.equal(railTip("Tests", 0, "Alt"), "Tests  ·  Alt+1");
  assert.equal(railTip("Late", 9, "Alt"), "Late");
});
