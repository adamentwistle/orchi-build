import test from "node:test";
import assert from "node:assert/strict";
import * as herd from "../../mods/herd/poll.js";
import * as orch from "../../mods/orch-pane/poll.js";

const MIN = 60000;
const resolved = () => Promise.resolve();
const never = () => new Promise(() => {});

// The progress pane keeps its own copy, so both copies are held to the same behaviour.
for (const [name, poll] of [["herd", herd], ["orch-pane", orch]]) {
  test(`${name}: a call that never answers is given up on, and one that answers wins`, async () => {
    await assert.rejects(poll.timed(never(), 8000, "hc ls", resolved), /hc ls didn't answer within 8 s/);
    assert.equal(await poll.timed(Promise.resolve(4), 8000, "hc ls", never), 4);
  });

  test(`${name}: a helper's crash and bad output are named, not passed off as nothing`, () => {
    assert.deepEqual(poll.helperReply({ code: 0, stdout: '{"agents":[1]}', stderr: "" }, "agents.py", "agents"), { value: [1], error: null });
    assert.deepEqual(poll.helperReply({ code: 1, stdout: "", stderr: "Traceback\nKeyError: 'x'\n" }, "agents.py", "agents"), { value: null, error: "agents.py stopped with code 1: KeyError: 'x'" });
    assert.equal(poll.helperReply({ code: 0, stdout: "oops", stderr: "" }, "herd.py", "sessions").error, "herd.py printed something that isn't JSON");
    assert.equal(poll.helperFailure(new Error("No such file or directory"), "herd.py"), "python3 couldn't start herd.py: No such file or directory");
    assert.equal(poll.helperFailure(new Error("herd.py didn't answer within 20 s"), "herd.py"), "herd.py didn't answer within 20 s");
  });

  test(`${name}: a terminal has to be missing a few reads in a row before it counts as gone`, () => {
    let state = { count: 0 };
    const seen = [];
    for (const found of [false, false, true, false, false, false]) { state = poll.missed(state.count, found); seen.push(state.gone); }
    assert.deepEqual(seen, [false, false, false, false, false, true]);
  });

  test(`${name}: a tick far later than a second is a sleep, and its time is left out`, () => {
    let gaps = poll.noteGap([], null, 1000);
    gaps = poll.noteGap(gaps, 1000, 2000);
    assert.deepEqual(gaps, []);
    gaps = poll.noteGap(gaps, 2000, 2000 + 60 * MIN);
    assert.deepEqual(gaps, [[2000, 2000 + 60 * MIN]]);
    assert.equal(poll.awake(0, 70 * MIN, [[5 * MIN, 65 * MIN]]), 10 * MIN);
    assert.equal(poll.awake(10 * MIN, 20 * MIN, [[0, 15 * MIN]]), 5 * MIN);
    assert.equal(poll.awake(0, 5 * MIN, [[10 * MIN, 20 * MIN]]), 5 * MIN);
    assert.equal(poll.awake(0, 5 * MIN), 5 * MIN);
    const many = Array.from({ length: 50 }, (_, i) => [i, i + 1]);
    assert.equal(poll.noteGap(many, 0, 10 * MIN).length, 40);
  });
}

test("the progress pane reads only while its tab is in view and nothing else there is zoomed", () => {
  const orchestrator = { pane: "a", tab: "T", terminal: "t1", zoomed: false }, pane = { pane: "b", tab: "T", terminal: null, mod: "orch-pane", zoomed: false };
  const chat = { pane: "c", tab: "T", terminal: null, mod: "claude-chat", zoomed: false };
  assert.equal(orch.paneShowing([orchestrator, pane], { tab: "T" }, "t1"), true);
  assert.equal(orch.paneShowing([orchestrator, pane], { tab: "U" }, "t1"), false);
  assert.equal(orch.paneShowing([orchestrator, pane, { ...chat, zoomed: true }], { tab: "T" }, "t1"), false);
  assert.equal(orch.paneShowing([orchestrator, { ...pane, zoomed: true }, chat], { tab: "T" }, "t1"), true);
  assert.equal(orch.paneShowing([pane], { tab: "T" }, "t1"), true);
  assert.equal(orch.paneShowing([orchestrator, pane], null, "t1"), true);
});
