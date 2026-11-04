// What the panel does with answers that come back late or out of order, found in review: each is a pure rule that
// main.js follows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withState } from "../../mods/tickets/tickets.js";
import { limitFor, listArgv, moveArgv, showArgv } from "../../mods/tickets/data.js";
import { changedSince } from "../../mods/tickets/tickets.js";
import { Latest } from "../../mods/tickets/data.js";

const list = [{ ref: "linear:ENG-12", state: "Todo" }, { ref: "linear:ENG-13", state: "Todo" }];

test("the state orchi tickets states reads now replaces the one from the last list, so Status never starts from an old state", () => {
  assert.deepEqual(withState(list, "linear:ENG-12", "Done").map((t) => t.state), ["Done", "Todo"]);
  assert.equal(withState(list, "linear:ENG-12", ""), list);
  assert.equal(withState(list, "linear:ENG-12", "Todo"), list);
});

test("a move has no time limit: it can't be cut off and pressed again while the first is still writing", () => {
  assert.equal(limitFor(moveArgv("/h", "linear:ENG-12", "Done")), null);
  assert.equal(limitFor(listArgv("/h")), 60000);
  assert.equal(limitFor(showArgv("/h", "linear:ENG-12")), 60000);
});

test("a ticket open while a refresh shows it changed is read again", () => {
  assert.equal(changedSince({ updated: "2026-11-01" }, { updated: "2026-11-02" }), true);
  assert.equal(changedSince({ updated: "2026-11-02" }, { updated: "2026-11-02" }), false);
  assert.equal(changedSince(undefined, { updated: "2026-11-02" }), true);
});

test("only the last read asked for a ticket counts, so an older answer coming back late is dropped", () => {
  const latest = new Latest();
  const first = latest.begin("body linear:ENG-12"), second = latest.begin("body linear:ENG-12");
  const other = latest.begin("states linear:ENG-12");
  assert.equal(latest.current("body linear:ENG-12", first), false);
  assert.equal(latest.current("body linear:ENG-12", second), true);
  assert.equal(latest.current("states linear:ENG-12", other), true);
});

test("a move that Linear refused says why, from the change that failed", async () => {
  const { moveFailure } = await import("../../mods/tickets/data.js");
  const failed = JSON.stringify({ changes: [{ ref: "linear:ENG-12", do: "state", status: "failed", error: "Linear refused the issueUpdate" }], problems: [], written: true });
  assert.equal(moveFailure({ code: 1, stdout: failed, stderr: "" }), "Linear refused the issueUpdate");
  assert.equal(moveFailure({ code: 1, stdout: JSON.stringify({ changes: [], problems: ["linear:ENG-12: Shipped is not a state of ENG"] }), stderr: "" }), "linear:ENG-12: Shipped is not a state of ENG");
  assert.equal(moveFailure({ code: 127, stdout: "", stderr: "env: orchi: No such file or directory" }), "orchi isn't installed");
});

test("a source that failed this time, with nothing listed, keeps the tickets it listed last time", async () => {
  const { keepFailed } = await import("../../mods/tickets/tickets.js");
  const before = [{ ref: "linear:ENG-12", source: "linear" }, { ref: "gh:acme/app#7", source: "github" }];
  const now = [{ ref: "gh:acme/app#8", source: "github" }];
  assert.deepEqual(keepFailed(before, now, ["linear"]).map((t) => t.ref), ["gh:acme/app#8", "linear:ENG-12"]);
  assert.deepEqual(keepFailed(before, now, []).map((t) => t.ref), ["gh:acme/app#8"]);
  const capped = [{ ref: "linear:ENG-13", source: "linear" }];
  assert.deepEqual(keepFailed(before, capped, ["linear"]).map((t) => t.ref), ["linear:ENG-13"]);
});

test("the list names the sources that had a problem", async () => {
  const { parseList } = await import("../../mods/tickets/data.js");
  const got = parseList(JSON.stringify({ tickets: [], problems: [{ source: "linear", message: "Linear can't be reached" }], sources: ["legwork", "linear"] }));
  assert.deepEqual(got.failed, ["linear"]);
});
