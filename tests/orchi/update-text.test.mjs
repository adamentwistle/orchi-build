import test from "node:test";
import assert from "node:assert/strict";
import { splitUpdate } from "../../mods/orchi/update-text.js";

test("what comes before the colon is the headline, and each sentence is a point", () => {
  assert.deepEqual(splitUpdate("Item 1 round 1 fixed at 9517a18f: 66 local commits, gates pass. Second cross-model pass running on the 23 fix commits."), {
    headline: "Item 1 round 1 fixed at 9517a18f",
    points: ["66 local commits, gates pass", "Second cross-model pass running on the 23 fix commits"],
  });
});

test("with no early colon the first sentence is the headline", () => {
  assert.deepEqual(splitUpdate("Conflict fixes pushed to 387, 388, 389. Full number order merges cleanly in a local trial; approvals held."), {
    headline: "Conflict fixes pushed to 387, 388, 389",
    points: ["Full number order merges cleanly in a local trial; approvals held"],
  });
});

test("a colon far into a long sentence stays in it", () => {
  const long = `${"word ".repeat(16)}end: detail`;
  assert.equal(splitUpdate(long).headline, long);
});

test("the detail after a colon starts with a capital", () => {
  assert.equal(splitUpdate("Signed-in run done: one launch, clean quit.").points[0], "One launch, clean quit");
});

test("a dot inside a figure or a file name doesn't split a sentence", () => {
  const { headline, points } = splitUpdate("Saved snapshots/2026-10-31-baseline-0.57.0.json. Tool failure rate is 9.19%, not 7.0%.");
  assert.equal(headline, "Saved snapshots/2026-10-31-baseline-0.57.0.json");
  assert.deepEqual(points, ["Tool failure rate is 9.19%, not 7.0%"]);
});

test("a one-sentence update has nothing to open", () => {
  assert.deepEqual(splitUpdate("Paused."), { headline: "Paused", points: [] });
  assert.deepEqual(splitUpdate(""), { headline: "", points: [] });
  assert.deepEqual(splitUpdate(null), { headline: "", points: [] });
});
