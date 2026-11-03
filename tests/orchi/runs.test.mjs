import test from "node:test";
import assert from "node:assert/strict";
import { QUIET_MS, completeOffered, completeProblem, killFailures, liveWorkers, stopTargets } from "../../mods/orchi/runs.js";

const NOW = new Date(2026, 10, 3, 12, 0).getTime();
const card = (over = {}) => ({ status: "idle", waiting: false, paused: false, pending: undefined, started: "2026-11-03 09:00", activity: { lastAt: "2026-11-03 11:00" }, ...over });

test("Mark complete is offered only on a quiet run with nothing open for Adam", () => {
  assert.equal(completeOffered(card(), NOW), true);
  assert.equal(completeOffered(card({ status: "working" }), NOW), false);
  assert.equal(completeOffered(card({ status: "blocked" }), NOW), false);
  // Idle waiting for Adam's answer is the case the review found: one press ended a live run.
  assert.equal(completeOffered(card({ waiting: true }), NOW), false);
  assert.equal(completeOffered(card({ paused: true }), NOW), false);
  assert.equal(completeOffered(card({ pending: "pausing" }), NOW), false);
  assert.equal(completeOffered(card({ activity: { lastAt: "2026-11-03 11:50" } }), NOW), false);
  assert.equal(completeOffered(card({ activity: { lastAt: "2026-11-03 11:45" } }), NOW), true);
});

test("a run that wrote nothing counts from its start, and one with no times at all is offered", () => {
  assert.equal(completeOffered(card({ activity: { lastAt: null }, started: "2026-11-03 11:55" }), NOW), false);
  assert.equal(completeOffered(card({ activity: { lastAt: null }, started: "2026-11-03 09:00" }), NOW), true);
  assert.equal(completeOffered(card({ activity: { lastAt: null }, started: null }), NOW), true);
  assert.equal(QUIET_MS, 15 * 60000);
});

const QUIET_BOARD = "## atlas-1 UPDATE 2026-11-03 10:00\nstarted\n## atlas-2 DECIDED 2026-11-03 11:00\nchose A\n";

test("the press checks the board and status again, and says why it didn't go ahead", () => {
  assert.equal(completeProblem({ board: QUIET_BOARD, status: "idle", paused: false }, NOW), null);
  assert.match(completeProblem({ board: QUIET_BOARD, status: "working" }, NOW), /working again/);
  assert.match(completeProblem({ board: QUIET_BOARD, status: "idle", paused: true }, NOW), /paused/);
  assert.match(completeProblem({ board: `${QUIET_BOARD}## atlas-3 DECISION 2026-11-03 11:05\nUncertain: which?\n`, status: "idle" }, NOW), /A question is open on its board \(atlas-3\)/);
  assert.match(completeProblem({ board: `${QUIET_BOARD}## atlas-3 ACTION 2026-11-03 11:05\nDo: merge\n`, status: "idle" }, NOW), /An action is open/);
  assert.equal(completeProblem({ board: `${QUIET_BOARD}## atlas-3 ACTION 2026-11-03 11:05\nDo: merge\nANSWERED atlas-3: completed: done\n`, status: "idle" }, NOW), null);
  assert.match(completeProblem({ board: `${QUIET_BOARD}## atlas-3 UPDATE 2026-11-03 11:52\nstill going\n`, status: "idle" }, NOW), /wrote to its board 8m ago/);
  assert.equal(completeProblem({ board: "", status: "idle" }, NOW), null);
});

test("Stop's targets come from the terminals read at the press, by name", () => {
  const live = [
    { name: "orch-atlas", address: "t1", state: "live" },
    { labels: { "orchi.name": "fw-a" }, address: "t2", state: "live" },
    { name: "fw-b", address: "t3", state: "exited" },
    { name: "fw-other", address: "t4", state: "live" },
  ];
  assert.deepEqual(stopTargets(live, "orch-atlas", ["a", "b"]), [{ name: "fw-a", address: "t2" }, { name: "orch-atlas", address: "t1" }]);
  assert.deepEqual(stopTargets([], "orch-atlas", ["a"]), []);
});

test("a kill that failed is named with its reason, and all going is no message", () => {
  const target = (name, address) => ({ name, address });
  assert.equal(killFailures([{ target: target("orch-atlas", "t1"), reply: { code: 0 } }]), null);
  assert.equal(
    killFailures([
      { target: target("fw-a", "t2"), reply: { code: 1, stderr: "no such terminal\nmore" } },
      { target: target("orch-atlas", "t1"), error: new Error("hc not found") },
      { target: target("fw-b", "t3"), reply: { code: 0 } },
    ]),
    "Stop couldn't end 2 terminals. fw-a (t2): no such terminal; orch-atlas (t1): hc not found",
  );
  assert.equal(killFailures([{ target: target("fw-a", "t2"), reply: { code: 2 } }]), "Stop couldn't end a terminal. fw-a (t2): exit 2");
});

test("Mark complete isn't offered while any of the run's workers is live, however quiet its board", () => {
  // The case found on screen: an idle orchestrator, a still board, and two fw- terminals still running.
  assert.equal(completeOffered(card({ liveWorkers: ["fw-tst-2-beta", "fw-tst-3-gamma"] }), NOW), false);
  assert.equal(completeOffered(card({ liveWorkers: ["fw-a"] }), NOW), false);
  assert.equal(completeOffered(card({ liveWorkers: [] }), NOW), true);
});

test("a run's live workers are its own fw- terminals that are live, in the app or in terminal Herdr", () => {
  const live = [
    { name: "fw-a", address: "t1", state: "live" },
    { labels: { "orchi.name": "fw-b" }, address: "t2", state: "live" },
    { name: "fw-c", address: "t3", state: "exited" },
    { name: "fw-other", address: "t4", state: "live" },
    { name: "orch-atlas", address: "t5", state: "live" },
  ];
  assert.deepEqual(liveWorkers(live, [], ["a", "b", "c"]), ["fw-a", "fw-b"]);
  assert.deepEqual(liveWorkers([], [{ name: "fw-c" }], ["a", "c"]), ["fw-c"]);
  assert.deepEqual(liveWorkers(live, [], ["a", "a"]), ["fw-a"]);
  assert.deepEqual(liveWorkers(live, [], []), []);
});

test("the press refuses while a worker is live, and names it", () => {
  assert.equal(
    completeProblem({ board: QUIET_BOARD, status: "idle", paused: false, workers: ["fw-a"] }, NOW),
    "fw-a is still running, so it wasn't marked complete",
  );
  assert.equal(
    completeProblem({ board: QUIET_BOARD, status: "idle", paused: false, workers: ["fw-a", "fw-b"] }, NOW),
    "2 workers are still running (fw-a, fw-b), so it wasn't marked complete",
  );
  assert.equal(completeProblem({ board: QUIET_BOARD, status: "idle", paused: false, workers: [] }, NOW), null);
});
