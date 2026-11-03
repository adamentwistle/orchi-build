import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A mod can't import from outside its own folder, so orchi carries its own copy of the shared drawing.
test("orchi's ui.js is the same file as linear's", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  assert.equal(read("../../mods/orchi/ui.js"), read("../../mods/linear/ui.js"));
});

for (const file of ["launch.js", "parse.js", "switchboard.js", "sessions.js"]) {
  test(`the two panels share one ${file}`, () => {
    assert.equal(readFileSync(new URL(`../../mods/orchi/${file}`, import.meta.url), "utf8"), readFileSync(new URL(`../../mods/linear/${file}`, import.meta.url), "utf8"));
  });
}

for (const mod of ["linear", "claude-chat"]) {
  test(`${mod} carries orchi's draft.js`, () => {
    assert.equal(readFileSync(new URL(`../../mods/${mod}/draft.js`, import.meta.url), "utf8"), readFileSync(new URL("../../mods/orchi/draft.js", import.meta.url), "utf8"));
  });
}

test("the Linear panel's task.js is the linear-agent one", () => {
  assert.equal(readFileSync(new URL("../../mods/linear/task.js", import.meta.url), "utf8"), readFileSync(new URL("../../mods/linear-agent/task.js", import.meta.url), "utf8"));
});

test("the progress pane carries orchi's update-text.js", () => {
  assert.equal(readFileSync(new URL("../../mods/orch-pane/update-text.js", import.meta.url), "utf8"), readFileSync(new URL("../../mods/orchi/update-text.js", import.meta.url), "utf8"));
});
