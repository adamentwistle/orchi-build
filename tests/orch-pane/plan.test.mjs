import test from "node:test";
import assert from "node:assert/strict";
import { aboutLeft, ageText, agentActive, buildRows, duration, latestUpdate, parseFanout, planPhase, progressOf, rowEstimate, runEstimate, sortRows, typicalMs } from "../../mods/orch-pane/plan.js";

const MIN = 60000;
const FANOUT = `# fanout-state: atlas, Roadmap 13 (started 2026-10-31 14:56, orchestrator t5s, measurement only)

Progress: 2/4

| slug | route | model | state | PR |
|---|---|---|---|---|
| r13-login-form (item 0) | subagent | opus high | done, report written | - |
| r13-search (item 4) | subagent | sonnet high | running | - |
| r13-export (item 2) | subagent | sonnet high | queued | - |
| r13-settings (item 1) | subagent | opus high | open, Bugbot CLEAR on a1b2c3d4, no reviewer | 42 |
`;

test("the fanout state gives the run, its count and its rows", () => {
  const plan = parseFanout(FANOUT);
  assert.equal(plan.title, "Roadmap 13");
  assert.equal(plan.started, new Date("2026-10-31T14:56").getTime());
  assert.deepEqual(plan.progress, { done: 2, total: 4 });
  assert.equal(plan.items.length, 4);
  assert.deepEqual(plan.items[3], { slug: "r13-settings (item 1)", name: "r13-settings", item: "1", route: "subagent", model: "Opus", effort: "high", state: "open, Bugbot CLEAR on a1b2c3d4, no reviewer", pr: "42" });
});

test("no fanout state is an empty plan, not a failure", () => {
  assert.deepEqual(parseFanout(""), { title: null, started: null, progress: null, items: [] });
});

test("state text running counts as active, which a subagent row needs", () => {
  assert.equal(planPhase({ route: "subagent", state: "running" }), "active");
  assert.equal(planPhase({ route: "subagent", state: "queued" }), "waiting");
  assert.equal(planPhase({ route: "subagent", state: "open, Bugbot CLEAR", pr: "42" }), "done");
  assert.equal(planPhase({ route: "pane closed", state: "x" }), "done");
  assert.equal(planPhase({ route: "pane w1:p2", state: "building" }), "active");
  assert.equal(planPhase({ route: "pane w1:p2 kept", state: "x" }), "done");
  assert.equal(planPhase({ route: "subagent", state: "merged" }, true), "active");
});

test("the newest update wins, and joins its lines", () => {
  const board = "## atlas-1 UPDATE 2026-10-31 14:00\nOld.\n\n## atlas-2 DECIDED 2026-10-31 14:10\nNot this.\n\n## atlas-3 UPDATE 2026-10-31 15:00\nFirst.\nSecond.\n\n## atlas-4 DECIDED 2026-10-31 15:10\nNor this.\n";
  assert.deepEqual(latestUpdate(board), { time: new Date("2026-10-31T15:00").getTime(), text: "First. Second." });
  assert.equal(latestUpdate(""), null);
});

const agent = (over) => ({ id: "a", task: "Item 0 timer screen read", type: "long-runner", model: "opus", effort: "high", started: 1000, last: 2000, finished: true, current: true, ...over });

test("a subagent with no finished line runs only while its session is the live one", () => {
  assert.equal(agentActive(agent({ finished: false })), true);
  assert.equal(agentActive(agent({ finished: false, current: false })), false);
  assert.equal(agentActive(agent({ finished: true })), false);
  assert.equal(agentActive(agent({ finished: true }), { a: { state: "working" } }), true);
});

test("a plan row takes the times and task of the subagent that names its item", () => {
  const [row] = buildRows({ items: parseFanout(FANOUT).items.slice(0, 1), agents: [agent({})], workers: [] });
  assert.equal(row.title, "Item 0 timer screen read");
  assert.equal(row.phase, "done");
  assert.deepEqual([row.started, row.ended, row.model, row.via], [1000, 2000, "Opus", "subagent"]);
});

test("a helper the plan doesn't name still gets its own row", () => {
  const rows = buildRows({ items: parseFanout(FANOUT).items, agents: [agent({ id: "b", task: "Verify counter findings", finished: false, model: "sonnet" })], workers: [] });
  const helper = rows.find((r) => r.key === "agent:b");
  assert.equal(helper.phase, "active");
  assert.equal(helper.model, "Sonnet");
  assert.equal(helper.planned, false);
});

test("a codex subagent reads Codex, and inherit shows no model", () => {
  const rows = buildRows({ items: [], agents: [agent({ id: "c", type: "codex", model: "inherit", task: "Review" }), agent({ id: "d", model: "inherit", task: "Other" })], workers: [] });
  assert.deepEqual(rows.map((r) => r.model), ["Codex", null]);
});

test("a live pane worker joins its plan row and can be focused", () => {
  const items = [{ slug: "fix-a", name: "fix-a", item: null, route: "pane t9", model: null, effort: null, state: "building", pr: null }];
  const [row] = buildRows({ items, agents: [], workers: [{ slug: "fix-a", address: "t9", started: 5, ended: 9, live: true }] });
  assert.deepEqual([row.phase, row.via, row.address, row.started, row.ended], ["active", "pane", "t9", 5, null]);
});

test("a pane worker that has gone keeps the times it was seen with", () => {
  const items = [{ slug: "fix-a", name: "fix-a", item: null, route: "pane closed", model: null, effort: null, state: "merged", pr: "4" }];
  const [row] = buildRows({ items, agents: [], workers: [{ slug: "fix-a", address: null, started: 5, ended: 9, live: false }] });
  assert.deepEqual([row.phase, row.started, row.ended], ["done", 5, 9]);
});

test("rows sort longest running first, then latest finished, then the plan's order", () => {
  const sorted = sortRows([
    { key: "1", phase: "done", ended: 10 }, { key: "2", phase: "active", started: 9 }, { key: "3", phase: "waiting" },
    { key: "4", phase: "done", ended: 20 }, { key: "5", phase: "active", started: 3 }, { key: "6", phase: "waiting" },
  ]);
  assert.deepEqual([sorted.active, sorted.done, sorted.waiting].map((l) => l.map((r) => r.key)), [["5", "2"], ["4", "1"], ["3", "6"]]);
});

test("progress is the plan's count, and with no plan every task seen", () => {
  const sorted = { active: [{ planned: true }, { planned: false }], done: [{}, {}, {}], waiting: [{}] };
  assert.deepEqual(progressOf({ progress: { done: 2, total: 4 } }, sorted), { done: 2, active: 1, total: 4 });
  assert.deepEqual(progressOf({ progress: null }, sorted), { done: 3, active: 2, total: 6 });
  assert.deepEqual(progressOf({ progress: { done: 4, total: 4 } }, sorted), { done: 4, active: 0, total: 4 });
});

const finished = (model, minutes) => ({ model, started: 0, ended: minutes * MIN, planned: true });

test("a typical time is the median on the same model, else on everything", () => {
  const done = [finished("Opus", 10), finished("Opus", 30), finished("Opus", 200), finished("Sonnet", 4)];
  assert.equal(typicalMs(done, "Opus"), 30 * MIN);
  assert.equal(typicalMs(done, "Sonnet"), 4 * MIN);
  assert.equal(typicalMs(done, "Haiku"), 20 * MIN);
  assert.equal(typicalMs([], "Opus"), null);
});

test("nothing finished means no estimate at all, not a guess", () => {
  const sorted = { active: [{ model: "Opus", started: 0 }], done: [], waiting: [{ model: "Opus" }] };
  assert.equal(rowEstimate(sorted.active[0], [], 5 * MIN), null);
  assert.equal(runEstimate(sorted, 5 * MIN), null);
  assert.equal(runEstimate({ active: [], done: [{ model: "Opus", started: null, ended: 9, planned: true }], waiting: [] }, 0), null);
});

test("a task well past the usual time says so, and one just past it reads as nearly done", () => {
  assert.deepEqual(rowEstimate({ model: "Opus", started: 0 }, [finished("Opus", 10)], 4 * MIN), { left: 6 * MIN, over: false });
  assert.deepEqual(rowEstimate({ model: "Opus", started: 0 }, [finished("Opus", 10)], 11 * MIN), { left: MIN, over: false });
  assert.deepEqual(rowEstimate({ model: "Opus", started: 0 }, [finished("Opus", 10)], 15 * MIN), { left: 0, over: true });
});

test("the run estimate is the slowest active task, plus waiting work shared between workers", () => {
  const sorted = {
    done: [finished("Opus", 10)],
    active: [{ model: "Opus", started: 0 }, { model: "Opus", started: 4 * MIN }],
    waiting: [{ model: "Opus" }, { model: "Opus" }],
  };
  assert.equal(runEstimate(sorted, 5 * MIN), 9 * MIN + (20 * MIN) / 2);
});

test("only plan tasks set the usual time, so a quick reviewer or Explore run doesn't pull it down", () => {
  const helper = { model: "Opus", started: 0, ended: MIN, planned: false };
  assert.equal(typicalMs([finished("Opus", 10), helper, helper], "Opus"), 10 * MIN);
  assert.equal(typicalMs([helper], "Opus"), null);
  assert.equal(runEstimate({ active: [{ model: "Opus", started: 0 }], done: [helper], waiting: [] }, 5 * MIN), null);
});

test("time the machine spent asleep counts neither in a finished task nor in one still running", () => {
  const gaps = [[5 * MIN, 65 * MIN]];
  const slept = { model: "Opus", started: 0, ended: 70 * MIN, planned: true };
  assert.equal(typicalMs([slept], "Opus", gaps), 10 * MIN);
  assert.equal(typicalMs([slept], "Opus"), 70 * MIN);
  assert.deepEqual(rowEstimate({ model: "Opus", started: 20 * MIN }, [finished("Opus", 10)], 79 * MIN, [[25 * MIN, 75 * MIN]]), { left: MIN, over: false });
  assert.deepEqual(rowEstimate({ model: "Opus", started: 20 * MIN }, [finished("Opus", 10)], 79 * MIN), { left: 0, over: true });
  assert.equal(runEstimate({ active: [{ model: "Opus", started: 0 }], done: [slept], waiting: [] }, 66 * MIN, gaps), 4 * MIN);
});

test("times read plainly and an estimate doesn't look exact", () => {
  assert.equal(duration(90 * MIN), "1h 30m");
  assert.equal(duration(12 * MIN), "12m");
  assert.equal(duration(20000), "<1m");
  assert.equal(duration(63 * 60 * MIN), "2d 15h");
  assert.equal(aboutLeft(20000), "about 1 min");
  assert.equal(aboutLeft(7 * MIN), "about 7 min");
  assert.equal(aboutLeft(13 * MIN), "about 15 min");
  assert.equal(aboutLeft(60 * MIN), "about 1 h");
  assert.equal(aboutLeft(83 * MIN), "about 1 h 25 min");
  assert.equal(ageText(1000), "just now");
  assert.equal(ageText(5 * MIN), "5m ago");
});
