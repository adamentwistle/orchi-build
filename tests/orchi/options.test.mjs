import test from "node:test";
import assert from "node:assert/strict";
import { PR_HINT, pickEffort, pickModel, runRules, startOptions } from "../../mods/orchi/options.js";

test("with nothing saved, Start offers what the review screen does", () => {
  assert.deepEqual(startOptions(null), {
    switchboard: { model: "Opus", effort: "High" }, orchestrator: { model: "Opus", effort: "High" },
    workers: { model: "Auto", effort: "Auto" }, prs: "", extra: "",
  });
});

test("a brief's choices seed the sheet", () => {
  const o = startOptions({ orchestrator: { model: "Sonnet", effort: "Xhigh" }, workers: { model: "Haiku", effort: "High" }, prs: "Merge when clear", extra: " Skip the docs " });
  assert.deepEqual(o.orchestrator, { model: "Sonnet", effort: "Xhigh" });
  assert.deepEqual(o.workers, { model: "Haiku", effort: "High" });
  assert.equal(o.prs, "Merge when clear");
  assert.equal(o.extra, "Skip the docs");
});

test("a saved value that isn't one the switchboard takes falls back", () => {
  const o = startOptions({ orchestrator: { model: "gpt", effort: "High; rm -rf" }, workers: { model: "Opus", effort: "Auto" }, prs: 7 });
  assert.deepEqual(o.orchestrator, { model: "Opus", effort: "High" });
  assert.deepEqual(o.workers, { model: "Auto", effort: "Auto" });
  assert.equal(o.prs, "");
});

test("the placeholder saved by an older brief is treated as empty", () => {
  assert.equal(startOptions({ prs: PR_HINT }).prs, "");
});

test("picking moves the model and effort together", () => {
  assert.deepEqual(pickModel({ model: "Auto", effort: "Auto" }, "Sonnet"), { model: "Sonnet", effort: "High" });
  assert.deepEqual(pickModel({ model: "Sonnet", effort: "Max" }, "Auto"), { model: "Auto", effort: "Auto" });
  assert.deepEqual(pickEffort({ model: "Auto", effort: "Auto" }, "Max"), { model: "Auto", effort: "Auto" });
  assert.deepEqual(pickEffort({ model: "Opus", effort: "High" }, "Low"), { model: "Opus", effort: "Low" });
});

test("the file holds only what the switchboard reads", () => {
  const rules = runRules({ ...startOptions(null), prs: " merge when clear ", extra: "" });
  assert.deepEqual(Object.keys(rules), ["orchestrator", "workers", "prs", "extra"]);
  assert.equal(rules.prs, "merge when clear");
});
