import test from "node:test";
import assert from "node:assert/strict";
import { argOf, buildHerd, modelName, parseFanout, quietFor, rootOf, sessionOf, slotsOf, subagentEnded, subtree } from "../../mods/herd/model.js";
import { activityOf, hangersOf, sparkPath } from "../../mods/herd/score.js";

const NOW = 2_000_000;
const list = [
  { address: "t1", parent: null, agent: "claude-code", state: "live" },
  { address: "t2", parent: "t1", name: "fw-3-relay", agent: "claude-code", state: "live" },
  { address: "t3", parent: "t2", name: "relay-bridge", agent: "python3", state: "finished" },
  { address: "t4", parent: "t2", name: "relay-bridge", agent: "env", state: "live" },
  { address: "t5", parent: "t1", labels: { "orchi.name": "fw-2-scenarios" }, agent: "claude-code", state: "live" },
  { address: "t9", parent: "t8", name: "someone-else", agent: "claude-code", state: "live" },
];

test("the tree comes from parents, not from names, and leaves other runs out", () => {
  const found = subtree(list, "t1");
  assert.deepEqual(found.map((n) => [n.address, n.depth]), [["t2", 1], ["t4", 2], ["t5", 1]]);
  assert.equal(found[1].agent, false);
  assert.equal(found[2].name, "fw-2-scenarios");
});

test("a live process beats an ended one of the same name, and the newest ended one wins", () => {
  assert.equal(subtree(list, "t1").find((n) => n.name === "relay-bridge").address, "t4");
  const ended = [{ address: "a", parent: "r", name: "x", state: "finished" }, { address: "b", parent: "r", name: "x", state: "finished" }];
  assert.equal(subtree(ended, "r")[0].address, "b");
});

test("a loop in the parents can't hang it", () => {
  assert.deepEqual(subtree([{ address: "a", parent: "b" }, { address: "b", parent: "a" }], "a").map((n) => n.address), ["b"]);
});

test("the panel follows the session in view", () => {
  const claude = { pane: "a", tab: "T", terminal: "t1", app: "claude-code" }, shell = { pane: "b", tab: "T", terminal: "t2", app: null };
  assert.equal(sessionOf([{ ...claude, focused: true }]), "t1");
  assert.equal(sessionOf([claude, { ...shell, focused: true }]), "t1");
  assert.equal(sessionOf([{ ...claude, terminal: "win/t1", focused: true }]), null);
  assert.equal(sessionOf([{ ...shell, focused: true }, { ...claude, tab: "U" }]), null);
  assert.equal(sessionOf([claude]), null);
});

test("a worker in view shows its whole herd from the top", () => {
  assert.equal(rootOf(list, "t4").address, "t1");
  assert.equal(rootOf(list, "t1").address, "t1");
  assert.equal(rootOf(list, "nobody"), null);
  assert.equal(rootOf([{ address: "a", parent: "b" }, { address: "b", parent: "a" }], "a").address !== undefined, true);
});

test("model names read as people say them", () => {
  assert.equal(modelName("claude-opus-5-5"), "Opus 5.5");
  assert.equal(modelName("sonnet"), "Sonnet");
  assert.equal(modelName(null), null);
  assert.equal(argOf(["claude", "--model", "opus"], "--model"), "opus");
  assert.equal(argOf(["claude"], "--model"), null);
});

const FANOUT = `Progress: 1/4

| slug | route | model | state | PR |
|---|---|---|---|---|
| 1-harness-v2 | closed | sonnet high | merged | 2 |
| 3-relay | hc fw-3-relay | opus high | running | - |
| 4-pilot | - | sonnet high | queued | - |
| r9-gate (item 9) | - | opus high | queued | - |
`;

test("the plan gives one slot per item, and a worker takes its item's slot", () => {
  const plan = parseFanout(FANOUT);
  assert.deepEqual(plan.progress, { done: 1, total: 4 });
  const worker = { key: "t2", name: "3-relay", depth: 1, kind: "worker", state: "working" };
  const stranger = { key: "t7", name: "spare", depth: 1, kind: "worker", state: "idle" };
  const slots = slotsOf(plan.items, [worker, stranger]);
  assert.deepEqual(slots.map((s) => [s.label, s.state]), [["harness v2", "finished"], ["relay", "working"], ["pilot", "queued"], ["r9 gate", "queued"], ["spare", "idle"]]);
  assert.equal(slots[1].row, worker);
});

test("a subagent takes the slot of the item its description names", () => {
  const slots = slotsOf(parseFanout(FANOUT).items, [{ key: "sub:a", name: "Gate build (item 9)", depth: 1, kind: "subagent", state: "working" }]);
  assert.equal(slots[3].key, "sub:a");
});

test("with no plan the workers still get slots, and a name with odd characters is safe", () => {
  assert.deepEqual(slotsOf([], [{ key: "t2", name: "a(b", depth: 1, kind: "worker", state: "working" }]).map((s) => s.label), ["a(b"]);
  assert.equal(slotsOf(parseFanout(FANOUT).items, [{ key: "t2", name: "a(b", depth: 1, kind: "worker", state: "working" }]).length, 5);
});

test("quiet means working, nothing running and no write for three minutes", () => {
  const row = { state: "working", last: NOW - 200000, events: [] };
  assert.equal(quietFor(row, NOW), 200000);
  assert.equal(quietFor({ ...row, last: NOW - 60000 }, NOW), 0);
  assert.equal(quietFor({ ...row, events: [[NOW - 200000, "b", null]] }, NOW), 0);
  assert.equal(quietFor({ ...row, state: "idle" }, NOW), 0);
});

const facts = {
  t1: { created_ms: 1, status: { state: "working", msg: "Orchestrating" }, foreground: { argv: ["claude"] } },
  t2: { created_ms: 5000, status: { state: "blocked", msg: "approve Bash: ls" }, foreground: { argv: ["claude", "--model", "opus", "--effort", "high"] } },
  t4: { created_ms: 6000, status: null, foreground: { argv: ["python3", "bridge.py"] } },
  t5: { created_ms: 7000, status: { state: "working", msg: "x" }, foreground: { argv: ["claude"] } },
};
const reply = {
  t1: { model: "claude-opus-5-5", first: 900, size: 10, last: NOW, events: [], agents: [
    { id: "a", task: "Read things", started: 10, last: 500, finished: true, events: [] },
    { id: "b", task: "Still going", started: 20, last: NOW, finished: false, events: [[NOW - 5, "r", null]] },
  ] },
};

test("a herd lists the session, then each worker with what hangs off it, and blocked comes first", () => {
  const nodes = subtree(list, "t1");
  const herd = buildHerd({ root: { address: "t1", name: "memory-research", live: true, agent: true }, nodes, facts, reply, fanout: parseFanout(""), now: NOW });
  assert.deepEqual(herd.rows.map((r) => r.key), ["t1", "t2", "t4", "sub:b", "t5"]);
  assert.equal(herd.started, 900);
  assert.equal(herd.rows[0].title, "Orchestrator");
  assert.equal(herd.rows[1].title, "3-relay");
  assert.equal(herd.rows[1].state, "blocked");
  assert.equal(herd.rows[1].effort, "high");
  assert.equal(herd.rows[2].kind, "process");
  assert.equal(herd.rows[2].command, "python3 bridge.py");
  assert.deepEqual(herd.finished.map((r) => r.key), ["sub:a"]);
});

test("each worker holds everything under it, ready to fold away", () => {
  const herd = buildHerd({ root: { address: "t1", name: "memory-research", live: true, agent: true }, nodes: subtree(list, "t1"), facts, reply, fanout: null, now: NOW });
  assert.deepEqual(herd.groups.map((g) => [g.row.key, g.kids.map((k) => k.key)]), [["t1", ["sub:b"]], ["t2", ["t4"]], ["t5", []]]);
});

test("someone with no worker above them stands alone", () => {
  const nodes = [{ address: "t2", name: "w", parent: "t1", depth: 1, live: false, agent: true }, { address: "t4", name: "p", parent: "t2", depth: 2, live: true, agent: false }];
  const herd = buildHerd({ root: { address: "t1", name: "r", live: true, agent: true }, nodes, facts: { t4: {} }, reply: {}, fanout: null, now: NOW });
  assert.deepEqual(herd.groups.map((g) => g.row.key), ["t1", "t4"]);
});

test("a terminal that ended badly is marked, and one that ended well isn't", () => {
  const nodes = [{ address: "a", name: "bad", parent: "t1", depth: 1, live: false }, { address: "b", name: "good", parent: "t1", depth: 1, live: false }];
  const herd = buildHerd({ root: { address: "t1", name: "r", live: true, agent: true }, nodes, facts: { a: { exit_code: 1, finished_ms: 2 }, b: { exit_code: 0, finished_ms: 1 } }, reply: {}, fanout: null, now: NOW });
  assert.deepEqual(herd.finished.map((r) => [r.name, r.failed]), [["bad", true], ["good", false]]);
});

test("a plan left by an old run doesn't count, until someone here is doing one of its items", () => {
  const root = { address: "t1", name: "session", live: true, agent: true }, fanout = parseFanout(FANOUT);
  const none = buildHerd({ root, nodes: [], facts: {}, reply: {}, fanout, now: NOW });
  assert.deepEqual([none.total, none.slots.length], [0, 0]);
  const nodes = [{ address: "t2", name: "fw-3-relay", parent: "t1", depth: 1, live: false, agent: true }];
  const used = buildHerd({ root, nodes, facts: {}, reply: {}, fanout, now: NOW });
  assert.deepEqual([used.done, used.total, used.slots.length], [1, 4, 4]);
  assert.equal(buildHerd({ root: { ...root, name: "orch-atlas" }, nodes: [], facts: {}, reply: {}, fanout, now: NOW }).total, 4);
});

test("a child whose parent has ended still shows", () => {
  const nodes = [{ address: "t2", name: "w", parent: "t1", depth: 1, live: false, agent: true }, { address: "t4", name: "p", parent: "t2", depth: 2, live: true, agent: false }];
  const herd = buildHerd({ root: { address: "t1", name: "r", live: true, agent: true }, nodes, facts: { t4: {} }, reply: {}, fanout: null, now: NOW });
  assert.deepEqual(herd.rows.map((r) => r.key), ["t1", "t4"]);
});

test("two unnamed sessions, and two live terminals that share a name, are each their own row", () => {
  const kids = [
    { address: "a", parent: "r", agent: "claude-code", state: "live" },
    { address: "b", parent: "r", agent: "claude-code", state: "live" },
    { address: "c", parent: "r", name: "fw-x", agent: "claude-code", state: "live" },
    { address: "d", parent: "r", name: "fw-x", agent: "claude-code", state: "live" },
    { address: "e", parent: "r", agent: "claude-code", state: "finished" },
  ];
  assert.deepEqual(subtree(kids, "r").map((n) => n.address), ["a", "b", "c", "d", "e"]);
  assert.equal(subtree(kids, "r")[0].name, "claude-code");
});

const sub = (over) => ({ id: "s", task: "Explore", started: 10, last: 500, finished: false, current: true, events: [[NOW - 5, "r", null]], ...over });

test("a subagent with no finished line has ended once its session isn't the current one", () => {
  assert.equal(subagentEnded(sub({})), false);
  assert.equal(subagentEnded(sub({ finished: true })), true);
  assert.equal(subagentEnded(sub({ current: false })), true);
  assert.equal(subagentEnded({ id: "old", finished: false }), false);
  const reply = { t1: { first: 1, agents: [sub({ id: "gone", current: false }), sub({ id: "going" })] } };
  const herd = buildHerd({ root: { address: "t1", name: "r", live: true, agent: true }, nodes: [], facts: {}, reply, fanout: null, now: NOW });
  const gone = herd.finished.find((r) => r.key === "sub:gone");
  assert.deepEqual([gone.state, gone.ended, gone.events], ["finished", 500, []]);
  assert.equal(herd.rows.filter((r) => r.kind === "subagent").map((r) => r.key).join(), "sub:going");
});

test("time asleep isn't quiet", () => {
  const row = { state: "working", last: NOW - 3 * 3600000, events: [] };
  assert.equal(quietFor(row, NOW, [[NOW - 3 * 3600000 + 1000, NOW - 1000]]), 0);
  assert.equal(quietFor(row, NOW), 3 * 3600000);
});

test("a row carries its last turn and how full its context is, and a herd that has all ended says so", () => {
  const reply = { t1: { first: 1, turn: { ended: NOW, ms: 250000, tools: 12, failed: 1 }, context: { tokens: 700000, model: "claude-opus-5-5" }, agents: [
    { id: "k", task: "Kid", started: 1, last: 2, finished: false, current: true, events: [], context: { tokens: 130000, model: "claude-haiku-5-5" } },
  ] } };
  const facts = { t1: { status: { state: "idle" }, foreground: { argv: ["claude", "--model", "opus[1m]"] } } };
  const herd = buildHerd({ root: { address: "t1", name: "r", live: true, agent: true }, nodes: [], facts, reply, fanout: null, now: NOW });
  assert.deepEqual(herd.rows[0].turn, { ended: NOW, ms: 250000, tools: 12, failed: 1 });
  assert.equal(herd.rows[0].context, 88);
  assert.equal(herd.rows[1].context, 16);
  assert.equal(herd.over, false);
  const ended = buildHerd({ root: { address: "t1", name: "r", live: false, agent: true }, nodes: [{ address: "t2", name: "w", parent: "t1", depth: 1, live: false, agent: true }], facts: {}, reply: {}, fanout: null, now: NOW });
  assert.equal(ended.over, true);
});

test("a session on its own counts as 1 running and is the one the map speaks for", () => {
  const herd = buildHerd({ root: { address: "t1", name: "solo", live: true, agent: true }, nodes: [], facts: { t1: { status: { state: "working" } } }, reply: {}, fanout: null, now: NOW });
  assert.equal(herd.running, 1);
  assert.equal(herd.solo?.key, "t1");
});

test("everyone going counts, the session too, and no one is solo once a worker or subagent runs", () => {
  const herd = buildHerd({ root: { address: "t1", name: "memory-research", live: true, agent: true }, nodes: subtree(list, "t1"), facts, reply, fanout: null, now: NOW });
  // t1, t2, sub:b and t5; the process t4 doesn't count.
  assert.equal(herd.running, 4);
  assert.equal(herd.solo, null);
});

test("a finished session counts nothing", () => {
  const herd = buildHerd({ root: { address: "t1", name: "done", live: false, agent: true }, nodes: [], facts: {}, reply: {}, fanout: null, now: NOW });
  assert.equal(herd.running, 0);
  assert.equal(herd.solo, null);
});

// Three background subagents of a session on its own, as herd.py read them for Adam's screenshot: one in a shell
// command, two between commands.
const SHOT = 1793713764500;
const shot = { t1: { model: "claude-opus-5-5", first: SHOT - 218000, size: 10, last: SHOT, events: [[SHOT - 47278, "o", 234]], agents: [
  { id: "audit", task: "Audit orchi for internal data", type: "Explore", started: SHOT - 61445, last: SHOT, finished: false, current: true, events: [[SHOT - 5190, "b", null], [SHOT - 3111, "b", null]] },
  { id: "inventory", task: "Inventory what the installer must bundle", type: "Explore", started: SHOT - 61431, last: SHOT, finished: false, current: true, events: [[SHOT - 9242, "b", 3904]] },
  { id: "map", task: "Map ticket sources for planning", type: "Explore", started: SHOT - 61421, last: SHOT, finished: false, current: true, events: [[SHOT - 3486, "b", 1429]] },
] } };

test("a session's own subagents hang round the middle, one each, in order, in what they're doing, and the counts agree", () => {
  const herd = buildHerd({ root: { address: "t1", name: "Herdr Build", live: true, agent: true }, nodes: [], facts: { t1: { status: { state: "working" } } }, reply: shot, fanout: null, now: SHOT });
  assert.equal(herd.running, 4);
  assert.equal(herd.solo, null);
  const [middle] = hangersOf(herd.groups, []);
  assert.equal(middle.spot, null);
  assert.deepEqual(middle.kids.map((k) => [k.name.split(" ")[0], activityOf(k, SHOT).word]), [["Audit", "Shell"], ["Inventory", "Thinking"], ["Map", "Thinking"]]);
  assert.equal(1 + middle.kids.length, herd.running);
});

test("a subagent with its own place on the map isn't drawn round the middle as well", () => {
  const reply = { t1: { first: 1, agents: [sub({ id: "gate", task: "Gate build (item 9)" }), sub({ id: "other", task: "Look around" })] } };
  const herd = buildHerd({ root: { address: "t1", name: "orch-atlas", live: true, agent: true }, nodes: [], facts: {}, reply, fanout: parseFanout(FANOUT), now: NOW });
  const spots = herd.slots.filter((s) => s.row);
  assert.deepEqual(spots.map((s) => s.key), ["sub:gate"]);
  const [middle] = hangersOf(herd.groups, spots);
  assert.deepEqual(middle.kids.map((k) => k.key), ["sub:other"]);
});

test("a subagent's call sparks along its worker's spoke, and the session's own subagents send none", () => {
  const herd = buildHerd({ root: { address: "t1", name: "memory-research", live: true, agent: true }, nodes: subtree(list, "t1"), facts, reply: {
    ...reply, t2: { first: 1, agents: [sub({ id: "w2kid" })] },
  }, fanout: null, now: NOW });
  const spots = herd.slots;
  assert.deepEqual(spots.map((s) => s.key), ["t2", "t5"]);
  assert.deepEqual(sparkPath("t5", spots, herd.groups), { node: spots[1], inward: true });
  assert.deepEqual(sparkPath("sub:w2kid", spots, herd.groups), { node: spots[0], inward: true });
  assert.equal(sparkPath("sub:b", spots, herd.groups), null);
  // The session's own calls go out, to a node that's running.
  assert.deepEqual(sparkPath("t1", spots, herd.groups), { node: spots[0], inward: false });
  assert.equal(sparkPath("nobody", spots, herd.groups), null);
});
