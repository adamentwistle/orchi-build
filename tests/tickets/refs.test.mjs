import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRef, linearKey, isLinearKey } from "../../mods/orchi/refs.js";

const COPIES = ["tickets", "orchi"];
const root = new URL("../../", import.meta.url);
const { cases } = JSON.parse(readFileSync(new URL("tests/tickets/refs.json", root), "utf8"));

test("every mod's copy of refs.js is the same file", () => {
  const read = (m) => readFileSync(new URL(`mods/${m}/refs.js`, root), "utf8");
  for (const m of COPIES) assert.equal(read(m), read("orchi"), m);
});

for (const c of cases) {
  test(`fixture: ${JSON.stringify(c.text)}`, () => {
    assert.deepStrictEqual(parseRef(c.text), c.expected ?? { error: c.error });
  });
}

test("a value that isn't text is an empty reference", () => {
  for (const v of [null, undefined, 12, {}]) assert.deepStrictEqual(parseRef(v), { error: "a ticket reference can't be empty" });
});

test("linearKey gives the bare key of a Linear reference, and null for anything else", () => {
  assert.equal(linearKey("ENG-12"), "ENG-12");
  assert.equal(linearKey("linear:ENG-12"), "ENG-12");
  assert.equal(linearKey(" ENG-12 "), "ENG-12");
  assert.equal(linearKey("gh:acme/app#12"), null);
  assert.equal(linearKey("legwork:birch"), null);
  assert.equal(linearKey("eng-12"), null);
  assert.equal(linearKey(undefined), null);
});

test("isLinearKey takes only a bare key, exactly as written", () => {
  assert.equal(isLinearKey("ENG-12"), true);
  assert.equal(isLinearKey("linear:ENG-12"), false);
  assert.equal(isLinearKey(" ENG-12"), false);
  assert.equal(isLinearKey("gh:acme/app#12"), false);
  assert.equal(isLinearKey(null), false);
});

test("no mod keeps its own copy of the old ID check", () => {
  for (const m of COPIES) {
    for (const f of ["sessions.js", "go.js", "review.js", "tickets.js", "data.js", "legwork.js"]) {
      let text;
      try { text = readFileSync(new URL(`mods/${m}/${f}`, root), "utf8"); } catch { continue; }
      assert.ok(!text.includes("ISSUE_ID"), `mods/${m}/${f}`);
      assert.ok(!text.includes("[A-Z][A-Z0-9]*-"), `mods/${m}/${f}`);
    }
  }
});

for (const m of COPIES) {
  test(`mods/${m}: a board or brief may name a Linear ticket by its key or its reference, and the panel holds the reference`, async () => {
    const { parseBoard, parseBrief } = await import(`../../mods/${m}/sessions.js`);
    const board = "## s1-p1 PLAN 2026-10-30 22:40\nProject: atlas\nRepo: /r/atlas\nTickets: linear:ENG-1, ENG-2, gh:acme/app#3, eng-4\nStart: /fanout atlas\n";
    assert.deepEqual(parseBoard(board).plans, [{ project: "atlas", repo: "/r/atlas", tickets: ["linear:ENG-1", "linear:ENG-2", "gh:acme/app#3"] }]);
    const brief = JSON.stringify({ session: "s1", created: "x", tickets: [
      { id: "linear:ENG-1", project: "atlas", repo: "/r/atlas" }, { ref: "ENG-2", project: "atlas", repo: "/r/atlas" }, { id: "nope", project: "atlas", repo: "/r/atlas" },
    ] });
    assert.deepEqual(parseBrief(brief, "s1").tickets.map((t) => t.ref), ["linear:ENG-1", "linear:ENG-2"]);
  });
}

for (const m of COPIES) {
  test(`mods/${m}: a ticket named twice, by reference and by key, is held once`, async () => {
    const { parseBoard, parseBrief } = await import(`../../mods/${m}/sessions.js`);
    const board = "## s1-p1 PLAN 2026-10-30 22:40\nProject: atlas\nRepo: /r/atlas\nTickets: linear:ENG-1, ENG-1, ENG-2\nStart: /fanout atlas\n";
    assert.deepEqual(parseBoard(board).plans[0].tickets, ["linear:ENG-1", "linear:ENG-2"]);
    const brief = JSON.stringify({ session: "s1", created: "x", tickets: [
      { ref: "linear:ENG-1", project: "atlas", repo: "/r/atlas" }, { id: "ENG-1", project: "atlas", repo: "/r/atlas" },
    ] });
    assert.deepEqual(parseBrief(brief, "s1").tickets.map((t) => t.ref), ["linear:ENG-1"]);
  });
}

test("isRef takes only a reference written out in full, as orchi tickets writes it", async () => {
  const { isRef } = await import("../../mods/orchi/refs.js");
  assert.equal(isRef("linear:ENG-12"), true);
  assert.equal(isRef("gh:acme/app#7"), true);
  for (const bad of ["ENG-12", "gh:Acme/App#7", " linear:ENG-12", "legwork:../x", null, 12]) assert.equal(isRef(bad), false, String(bad));
});
