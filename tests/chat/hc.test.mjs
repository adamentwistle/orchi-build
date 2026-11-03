import test from "node:test";
import assert from "node:assert/strict";
import { hcFrom } from "../../mods/claude-chat/hc.js";

const recorder = (reply = {}) => {
  const calls = [];
  return { calls, run: async (args) => { calls.push(args); return { code: 0, stdout: "", stderr: "", ...(reply[args[0]] ?? {}) }; } };
};

test("each call becomes the hc command it names", async () => {
  const { calls, run } = recorder();
  const hc = hcFrom(run);
  await hc.read("t3");
  await hc.keys("t3", ["up", "right", "s"]);
  await hc.send("t3", "/model");
  await hc.waitOutput("t3", "Select model", 2);
  assert.deepEqual(calls, [["read", "t3"], ["keys", "t3", "up", "right", "s"], ["send", "t3", "/model"], ["wait", "t3", "--output", "Select model", "--timeout", "2"]]);
});

test("the screen text comes back, and a failed command throws with hc's own words", async () => {
  const { run } = recorder({ read: { stdout: "screen" } });
  assert.equal(await hcFrom(run).read("t1"), "screen");
  await assert.rejects(hcFrom(recorder({ keys: { code: 1, stderr: "no such terminal" } }).run).keys("t9", ["esc"]), /no such terminal/);
});

test("a wait that times out is not an error", async () => {
  const hc = hcFrom(recorder({ wait: { code: 1, stdout: '{"reason":"timeout"}' } }).run);
  await assert.doesNotReject(hc.waitOutput("t1", "x", 1));
});

test("status is the terminal's state, or null when it can't be read", async () => {
  assert.equal(await hcFrom(recorder({ get: { stdout: '{"status":{"app":"claude-code","state":"idle"}}' } }).run).status("t1"), "idle");
  assert.equal(await hcFrom(recorder({ get: { stdout: "not json" } }).run).status("t1"), null);
  assert.equal(await hcFrom(recorder({ get: { code: 1 } }).run).status("t1"), null);
  assert.equal(await hcFrom(recorder({ get: { stdout: "{}" } }).run).status("t1"), null);
});
