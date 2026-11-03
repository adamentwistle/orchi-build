import test from "node:test";
import assert from "node:assert/strict";
import { isLocal, swapState, swapSteps, tidyPairs } from "../../mods/panel-buttons/swap.js";

const term = (over = {}) => ({ pane: "p1", terminal: "t1", tab: "a", app: "claude-code", focused: true, zoomed: false, ...over });
const chat = (over = {}) => ({ pane: "p2", terminal: null, mod: "claude-chat", tab: "a", app: null, focused: false, zoomed: false, ...over });

test("a local Claude Code terminal with no chat yet can swap", () => {
  assert.deepEqual(swapState([term()], {}), { tab: "a", terminal: "t1", terminalPane: "p1", chatPane: null, showing: "terminal" });
});

test("nothing offers a swap when the focused pane isn't Claude Code", () => {
  assert.equal(swapState([term({ app: "codex" })], {}), null);
  assert.equal(swapState([term({ app: null })], {}), null);
  assert.equal(swapState([], {}), null);
});

test("another machine's session doesn't offer a swap", () => {
  assert.equal(swapState([term({ terminal: "win/t1" })], {}), null);
  assert.equal(isLocal("win/t1"), false);
  assert.equal(isLocal("t1"), true);
});

test("a focused chat pane reads as showing chat, through its pair", () => {
  const list = [term({ focused: false }), chat({ focused: true, zoomed: true })];
  assert.deepEqual(swapState(list, { p2: "t1" }), { tab: "a", terminal: "t1", terminalPane: "p1", chatPane: "p2", showing: "chat" });
});

test("a chat pane with no pair, alone in its tab, pairs with the tab's only Claude Code terminal", () => {
  const list = [term({ focused: false }), chat({ focused: true })];
  assert.equal(swapState(list, {}).terminal, "t1");
});

test("two terminals in a tab each keep their own chat", () => {
  const list = [term(), term({ pane: "p3", terminal: "t3", focused: false }), chat(), chat({ pane: "p4" })];
  assert.equal(swapState(list, { p2: "t3", p4: "t1" }).chatPane, "p4");
});

test("a terminal doesn't take a chat from another tab", () => {
  const list = [term(), chat({ tab: "b" })];
  assert.equal(swapState(list, { p2: "t1" }).chatPane, null);
});

test("a first press splits, passing the terminal to the new pane", () => {
  const state = swapState([term()], {});
  assert.deepEqual(swapSteps(state, "chat", [term()]), [["pane.split", { direction: "right", pane: "p1", mod: "claude-chat", props: { terminal: "t1" } }]]);
});

test("a later swap zooms then focuses", () => {
  const list = [term({ zoomed: true }), chat()];
  const state = swapState(list, { p2: "t1" });
  assert.deepEqual(swapSteps(state, "chat", list), [["pane.zoom", { pane: "p2" }], ["pane.focus", { pane: "p2" }]]);
});

test("the pane that's already zoomed isn't zoomed again, because that returns to side by side", () => {
  const list = [term({ focused: false }), chat({ focused: false, zoomed: true })];
  const state = { tab: "a", terminal: "t1", terminalPane: "p1", chatPane: "p2", showing: "terminal" };
  assert.deepEqual(swapSteps(state, "chat", list), [["pane.focus", { pane: "p2" }]]);
});

test("side by side, the target is zoomed", () => {
  const list = [term({ focused: false }), chat({ focused: true })];
  const state = swapState(list, { p2: "t1" });
  assert.deepEqual(swapSteps(state, "terminal", list), [["pane.zoom", { pane: "p1" }], ["pane.focus", { pane: "p1" }]]);
});

test("pairs for panes that have gone are dropped", () => {
  assert.deepEqual(tidyPairs({ p2: "t1", p9: "t9" }, [chat()]), { p2: "t1" });
});

import { SPLIT_MS, splitPending } from "../../mods/panel-buttons/swap.js";

test("a second press before the split shows doesn't split again, and it can't hold the toggle for ever", () => {
  const waiting = { tab: "a", at: 1000 };
  assert.equal(splitPending(waiting, "a", 1000 + SPLIT_MS - 1), true);
  assert.equal(splitPending(waiting, "a", 1000 + SPLIT_MS), false);
  assert.equal(splitPending(waiting, "b", 1001), false);
  assert.equal(splitPending(null, "a", 1001), false);
});
