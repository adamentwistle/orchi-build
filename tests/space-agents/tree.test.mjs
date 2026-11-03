import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_SPACE, agentNames, agentTree, displayOrder, finishedWorkers, foldKey, foldSummary, kidStatus, nextHeld, pruneFolds, rankOf, spaceActive, subtree,
  terminalName, urgencyOf,
} from "../../mods/space-agents/tree.js";

const agent = (address, status, tab = "tab1", extra = {}) => ({ address, status, tab, space: "s1", seq: 0, ...extra });
const spaces = [
  { id: "s1", tabs: [{ id: "tab1" }, { id: "tab1b" }] },
  { id: "win/s2", tabs: [{ id: "win/tab2" }] },
];
const urgencies = (list) => urgencyOf(list, [], null);
const treeOf = (list, since = () => 0) => agentTree(list, spaces, urgencies(list), since);
const shape = (groups) => groups.map((g) => [g.key, g.members.map((a) => a.address)]);

test("a space's agents sit under their statuses, most urgent first, with empty statuses left out", () => {
  const list = [agent("t1", "idle"), agent("t2", "working"), agent("t3", "blocked"), agent("t4", "working")];
  assert.deepEqual(shape(treeOf(list).get("s1")), [["blocked", ["t3"]], ["working", ["t2", "t4"]], ["idle", ["t1"]]]);
});

test("each status is labelled for people", () => {
  assert.equal(treeOf([agent("t1", "blocked")]).get("s1")[0].label, "Needs you");
});

test("agents go to the space holding their tab, including on another machine", () => {
  const list = [agent("t1", "idle"), agent("win/t2", "done", "win/tab2", { space: "ignored" })];
  const tree = treeOf(list);
  assert.deepEqual(shape(tree.get("s1")), [["idle", ["t1"]]]);
  assert.deepEqual(shape(tree.get("win/s2")), [["done", ["win/t2"]]]);
});

test("a tab no space lists falls back to the agent's own space", () => {
  assert.deepEqual([...treeOf([agent("t1", "idle", "new-tab")]).keys()], ["s1"]);
});

test("an agent no space holds is kept, in its own group", () => {
  const tree = treeOf([agent("t1", "idle", "gone", { space: "gone" })]);
  assert.deepEqual(shape(tree.get(NO_SPACE)), [["idle", ["t1"]]]);
});

test("an unknown status counts as idle", () => {
  assert.deepEqual(shape(treeOf([agent("t1", "unknown")]).get("s1")), [["idle", ["t1"]]]);
});

test("the newest change leads a group, and seq breaks a tie", () => {
  const list = [agent("old", "idle", "tab1", { seq: 9 }), agent("new", "idle", "tab1", { seq: 1 }), agent("tie", "idle", "tab1", { seq: 2 })];
  const since = (a) => ({ old: 1, new: 5, tie: 5 })[a.address];
  assert.deepEqual(shape(treeOf(list, since).get("s1")), [["idle", ["tie", "new", "old"]]]);
});

test("a parent sits with its most urgent sub-agent", () => {
  const list = [agent("t1", "idle")];
  const all = [{ address: "t1", state: "live" }, { address: "k1", parent: "t1", state: "live", status: "error" }];
  const tree = agentTree(list, spaces, urgencyOf(list, all, null), () => 0);
  assert.deepEqual(shape(tree.get("s1")), [["blocked", ["t1"]]]);
});

test("a sub-agent's done doesn't move its parent to Done", () => {
  const list = [agent("t1", "working")];
  const all = [{ address: "k1", parent: "t1", state: "live", status: "done" }];
  assert.deepEqual(shape(agentTree(list, spaces, urgencyOf(list, all, null), () => 0).get("s1")), [["working", ["t1"]]]);
});

test("a listed sub-agent uses the list's status, and error reads as blocked", () => {
  assert.equal(kidStatus({ address: "k", status: "idle" }, new Map([["k", "working"]])), "working");
  assert.equal(kidStatus({ address: "k", status: "error" }, new Map()), "blocked");
});

test("subtree leaves out ended sub-agents and draws the lines", () => {
  const all = [
    { address: "a", parent: "t1", state: "live" },
    { address: "b", parent: "t1", state: "ended" },
    { address: "c", parent: "t1", state: "live" },
    { address: "d", parent: "a", state: "live" },
  ];
  assert.deepEqual(subtree(all, "t1").map((s) => [s.t.address, s.lines]), [["a", ["├"]], ["d", ["│", "└"]], ["c", ["└"]]]);
});

test("a done agent you're looking at stays in Done until you leave it", () => {
  const seen = nextHeld([agent("t1", "done", "tab1", { focused: true })], null);
  const still = nextHeld([agent("t1", "idle", "tab1", { focused: true })], seen);
  assert.equal(rankOf(agent("t1", "idle"), still), 3);
  const left = nextHeld([agent("t1", "idle"), agent("t2", "idle", "tab1", { focused: true })], still);
  assert.equal(rankOf(agent("t1", "idle"), left), 1);
});

test("a done agent that starts working moves at once", () => {
  const seen = nextHeld([agent("t1", "done", "tab1", { focused: true })], null);
  const moved = nextHeld([agent("t1", "working", "tab1", { focused: true })], seen);
  assert.equal(rankOf(agent("t1", "working"), moved), 2);
});

test("the order next and previous walk matches the drawing, with space-less agents last", () => {
  const list = [agent("t1", "idle"), agent("t2", "blocked"), agent("win/t3", "idle", "win/tab2"), agent("t4", "idle", "gone", { space: "gone" })];
  assert.deepEqual(displayOrder(["win/s2", "s1"], treeOf(list)), ["win/t3", "t2", "t1", "t4"]);
});

test("a folded space says how many and the most urgent status", () => {
  assert.deepEqual(foldSummary(treeOf([agent("t1", "idle"), agent("t2", "done"), agent("t3", "idle")]).get("s1")), { count: 3, top: "done" });
  assert.deepEqual(foldSummary([]), { count: 0, top: null });
});

test("folds of gone spaces go, and those on another machine or with no space stay", () => {
  const folds = ["s1", foldKey.status("s1", "idle"), foldKey.kids("s1", "t1"), "gone", foldKey.status("gone", "idle"), "win/s9", foldKey.status(NO_SPACE, "idle")];
  assert.deepEqual(pruneFolds(folds, ["s1"]), ["s1", "s1|idle", "s1|kids|t1", "win/s9", "no-space|idle"]);
});

test("names: a named tab wins, and an automatic tab number gives way to the agent's title", () => {
  const list = [agent("t1", "idle", "tab1", { tab_name: "reviewer" }), agent("t2", "idle", "tab1", { tab_name: "2", title: "Fix the fold" })];
  const names = agentNames(list, (a) => a.tab_name, (a) => a.title ?? "Claude Code");
  assert.deepEqual([...names.values()], ["reviewer", "Fix the fold"]);
});

test("names: two titled agents on automatic tabs keep their titles, with no tab number", () => {
  const list = [agent("t1", "idle", "tab1", { tab_name: "1", title: "One" }), agent("t2", "idle", "tab1", { tab_name: "3", title: "Two" })];
  assert.deepEqual([...agentNames(list, (a) => a.tab_name, (a) => a.title).values()], ["One", "Two"]);
});

test("names: only agents that would read the same in one space get the tab number", () => {
  const list = [
    agent("t1", "idle", "tab1", { tab_name: "1" }),
    agent("t2", "idle", "tab1", { tab_name: "2" }),
    agent("t3", "idle", "win/tab2", { space: "s2", tab_name: "1" }),
  ];
  assert.deepEqual([...agentNames(list, (a) => a.tab_name, () => "Claude Code").values()], ["Claude Code \u00b7 1", "Claude Code \u00b7 2", "Claude Code"]);
});

test("names: a terminal named with hc --name reads as that name, not its address, and a named tab still wins", () => {
  const list = [
    agent("t3", "working", "tab1", { tab_name: "2", title: "t3" }),
    agent("t4", "working", "tab1", { tab_name: "3", title: "t4" }),
    agent("t5", "idle", "tab1", { tab_name: "4", title: "t5" }),
    agent("t6", "idle", "tab1", { tab_name: "reviewer", title: "t6" }),
  ];
  const terms = new Map([
    ["t3", { address: "t3", name: "orch-alpha" }],
    ["t4", { address: "t4", name: "orch-beta" }],
    ["t5", { address: "t5", name: null }],
    ["t6", { address: "t6", name: "orch-gamma" }],
  ]);
  const names = agentNames(list, (a) => a.tab_name, (a) => a.title, (a) => terminalName(terms.get(a.address)));
  assert.deepEqual([...names.values()], ["orch-alpha", "orch-beta", "t5", "reviewer"]);
});

test("a terminal's name is its own, trimmed, and null when it has none", () => {
  assert.equal(terminalName({ name: "orch-alpha" }), "orch-alpha");
  assert.equal(terminalName({ name: " " }), null);
  assert.equal(terminalName({ name: null }), null);
  assert.equal(terminalName(undefined), null);
});

test("names: an agent with no title or program falls back to its tab number", () => {
  assert.deepEqual([...agentNames([agent("t1", "idle", "tab1", { tab_name: "1" })], (a) => a.tab_name, () => null).values()], ["1"]);
});

test("a space is active while an agent or a sub-agent in it is working", () => {
  const groups = (status) => [{ members: [agent("t1", status)] }];
  assert.equal(spaceActive(groups("working"), [], new Map()), true);
  assert.equal(spaceActive(groups("idle"), [], new Map()), false);
  assert.equal(spaceActive(groups("blocked"), [], new Map()), false);
  assert.equal(spaceActive([], [], new Map()), false);
  const kid = [{ address: "k1", parent: "t1", state: "live", status: "working" }];
  assert.equal(spaceActive(groups("idle"), kid, new Map()), true);
});

const worker = (address, status, state = "live") => ({ address, parent: "t1", status, state });
const none = new Set();

test("a worker that stops working has finished, once", () => {
  const first = finishedWorkers(new Map(), [worker("k1", "working")], none);
  assert.deepEqual(first.finished, []);
  const second = finishedWorkers(first.current, [worker("k1", "done")], none);
  assert.deepEqual(second.finished, ["k1"]);
  assert.deepEqual(finishedWorkers(second.current, [worker("k1", "done")], none).finished, []);
});

test("a worker that goes idle or ends has finished, and one blocked or still working hasn't", () => {
  const before = new Map([["a", "working"], ["b", "working"], ["c", "working"], ["d", "working"]]);
  const all = [worker("a", "idle"), worker("b", "blocked"), worker("c", "working"), worker("d", "done", "finished"), { address: "t1", state: "live" }];
  assert.deepEqual(finishedWorkers(before, all, none).finished, ["a", "d"]);
});

test("a worker already idle when first seen hasn't finished anything", () => {
  assert.deepEqual(finishedWorkers(new Map([["k1", "idle"]]), [worker("k1", "done")], none).finished, []);
});

test("a worker with a pane is left out, because the app plays its sound", () => {
  const seen = finishedWorkers(new Map(), [worker("k1", "working")], new Set(["k1"]));
  assert.equal(seen.current.size, 0);
});

test("an empty terminal list finishes nobody and keeps what it knew", () => {
  const before = new Map([["k1", "working"]]);
  const { current, finished } = finishedWorkers(before, [], none);
  assert.deepEqual(finished, []);
  assert.equal(current, before);
});
