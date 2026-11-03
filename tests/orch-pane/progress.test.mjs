import test from "node:test";
import assert from "node:assert/strict";
import { closeSteps, newPane, openSteps, openedSteps, progressState } from "../../mods/panel-buttons/progress.js";

const orch = { pane: "p1", tab: "T", terminal: "t1", app: "claude-code", title: "orch-atlas", focused: true };
const named = () => "";

test("the button shows on an orchestrator and on nothing else", () => {
  assert.equal(progressState([orch], named).terminal, "t1");
  assert.equal(progressState([{ ...orch, title: "Atlas pickup" }], named), null);
  assert.equal(progressState([{ ...orch, title: "x" }], (a) => (a === "t1" ? "orch-atlas" : "")).terminal, "t1");
  assert.equal(progressState([{ ...orch, app: null }], named), null);
  assert.equal(progressState([{ ...orch, terminal: "remote/t1" }], named), null);
  assert.equal(progressState([], named), null);
});

test("it stays on whichever pane of that tab has the focus", () => {
  const progress = { pane: "p2", tab: "T", mod: "orch-pane", focused: true };
  assert.equal(progressState([{ ...orch, focused: false }, progress], named).progressPane, "p2");
  const chat = { pane: "p3", tab: "T", mod: "claude-chat", focused: true, zoomed: true };
  const state = progressState([{ ...orch, focused: false }, chat], named);
  assert.deepEqual([state.chatPane, state.zoomed, state.progressPane], ["p3", "p3", null]);
  assert.equal(progressState([{ ...orch, focused: false, tab: "U" }, chat], named), null);
});

test("opening splits to the right of the terminal and names it", () => {
  assert.deepEqual(openSteps({ terminalPane: "p1", terminal: "t1" }), [["pane.split", { direction: "right", pane: "p1", mod: "orch-pane", props: { terminal: "t1" } }]]);
});

test("the keyboard stays put beside a terminal, and a zoomed tab swaps to the new pane", () => {
  assert.deepEqual(openedSteps({ zoomed: false, from: "p1" }, "p9"), [["pane.focus", { pane: "p1" }]]);
  assert.deepEqual(openedSteps({ zoomed: true, from: "p3" }, "p9"), [["pane.zoom", { pane: "p9" }], ["pane.focus", { pane: "p9" }]]);
});

test("closing a zoomed progress pane hands the view back first", () => {
  assert.deepEqual(closeSteps({ progressPane: "p2", zoomed: null, chatPane: null, terminalPane: "p1" }), [["pane.close", { pane: "p2" }]]);
  assert.deepEqual(closeSteps({ progressPane: "p2", zoomed: "p2", chatPane: "p3", terminalPane: "p1" }), [["pane.zoom", { pane: "p3" }], ["pane.focus", { pane: "p3" }], ["pane.close", { pane: "p2" }]]);
  assert.deepEqual(closeSteps({ progressPane: "p2", zoomed: "p2", chatPane: null, terminalPane: "p1" })[0], ["pane.zoom", { pane: "p1" }]);
});

test("the new pane is the one that wasn't there at the press", () => {
  const wait = { tab: "T", known: ["p1", "p2"] };
  assert.equal(newPane([{ pane: "p2", tab: "T", mod: "orch-pane" }, { pane: "p9", tab: "T", mod: "orch-pane" }], wait).pane, "p9");
  assert.equal(newPane([{ pane: "p9", tab: "U", mod: "orch-pane" }], wait), undefined);
});
