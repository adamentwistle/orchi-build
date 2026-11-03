import { test } from "node:test";
import assert from "node:assert/strict";
import { paletteKey, planEditors, syntaxColours } from "../../mods/claude-chat/editors.js";

const ids = (n) => Array.from({ length: n }, (_, i) => `c${i}`);

test("below the cap every code row gets an editor, newest first", () => {
  assert.deepEqual(planEditors({ codeIds: ids(3), have: new Set(), max: 64 }), { make: ["c2", "c1", "c0"], drop: [] });
});

test("at the cap the newest rows take the oldest editors off screen", () => {
  const have = new Set(ids(4));
  const plan = planEditors({ codeIds: ids(6), have, visible: new Set(), max: 4 });
  assert.deepEqual(plan, { make: ["c5", "c4"], drop: ["c0", "c1"] });
});

test("an editor on screen is never taken, so the next oldest goes", () => {
  const plan = planEditors({ codeIds: ids(6), have: new Set(ids(4)), visible: new Set(["c0"]), max: 4 });
  assert.deepEqual(plan, { make: ["c5", "c4"], drop: ["c1", "c2"] });
});

test("with every editor on screen a new row waits as plain text", () => {
  const plan = planEditors({ codeIds: ids(3), have: new Set(["c0", "c1"]), visible: new Set(["c0", "c1"]), max: 2 });
  assert.deepEqual(plan, { make: [], drop: [] });
});

test("an older row never takes a newer row's editor", () => {
  // c0 has no editor and the newer c1 and c2 have them: c0 stays plain.
  const plan = planEditors({ codeIds: ids(3), have: new Set(["c1", "c2"]), visible: new Set(), max: 2 });
  assert.deepEqual(plan, { make: [], drop: [] });
});

test("an editor for a row no longer in the thread always goes", () => {
  const plan = planEditors({ codeIds: ["c1"], have: new Set(["gone", "c1"]), max: 64 });
  assert.deepEqual(plan, { make: [], drop: ["gone"] });
});

test("65 code rows end with the newest 64 holding editors", () => {
  let have = new Set();
  for (let n = 1; n <= 65; n++) {
    const { make, drop } = planEditors({ codeIds: ids(n), have, visible: new Set([`c${n - 1}`]), max: 64 });
    have = new Set([...have].filter((id) => !drop.includes(id)).concat(make));
  }
  assert.equal(have.size, 64);
  assert.equal(have.has("c0"), false);
  assert.equal(have.has("c64"), true);
});

test("the palette key follows the theme's code colours", () => {
  const dark = { ansi4: "#1", accent: "#2", dim: "#3", foreground: "#4", ansi13: "#5", muted: "#6" };
  const light = { ...dark, foreground: "#000" };
  assert.notEqual(paletteKey(dark), paletteKey(light));
  assert.equal(paletteKey(dark), paletteKey({ ...dark, canvas: "#fff" }));
  assert.equal(syntaxColours(dark).keyword, "#1");
  assert.equal(typeof paletteKey(undefined), "string");
});
