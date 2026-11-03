import test from "node:test";
import assert from "node:assert/strict";
import { FIELD, GAUGE_TICKS, gaugeLabel, gaugeLit, gaugeTone, movePad, newPad, padAt, padChoice, padClosed, padIsCurrent, padKey, padPoint, padReadout, padRowLabels } from "../../mods/claude-chat/pad.js";
import { FALLBACK_MODELS } from "../../mods/claude-chat/picker.js";

const pad = (model = "Opus 5.5", effort = "high") => newPad(FALLBACK_MODELS, { model, effort });

test("the pad starts on the session's own model and effort", () => {
  assert.deepEqual([pad("Sonnet 5.5", "xhigh").row, pad("Sonnet 5.5", "xhigh").col], [2, 3]);
  assert.deepEqual(padChoice(pad("Haiku 5.5", "low")).choice, { model: "Haiku 5.5", effort: "low" });
});

test("a model of a known family on another version starts on that family's row, an unknown one on the first", () => {
  assert.equal(pad("Sonnet 5").row, 2);
  assert.equal(pad("Mystery 9").row, 0);
  assert.equal(pad(undefined, undefined).col, 2, "no effort starts on High");
  assert.equal(newPad(null, {}).models.length, 4, "no rows from the picker yet uses the fallback");
});

test("arrow keys move one cell and stop at every edge", () => {
  let p = pad("Opus 5.5", "low");
  assert.deepEqual([movePad(p, "left").col, movePad(p, "up").row], [0, 0]);
  p = pad("Haiku 5.5", "max");
  assert.deepEqual([movePad(p, "right").col, movePad(p, "down").row], [4, 3]);
  p = pad("Fable 5.1", "medium");
  const moved = movePad(movePad(p, "down"), "right");
  assert.deepEqual(padChoice(moved).choice, { model: "Sonnet 5.5", effort: "high" });
  assert.equal(movePad(p, "pgdn"), p, "other keys change nothing");
  assert.equal(p.row, 1, "the old pad is not changed");
});

test("a press or drag puts the cursor on the cell under the pointer, clamped to the field", () => {
  const p = pad();
  assert.deepEqual([padAt(p, 1, 1).row, padAt(p, 1, 1).col], [0, 0]);
  assert.deepEqual([padAt(p, FIELD.width - 1, FIELD.height - 1).row, padAt(p, FIELD.width - 1, FIELD.height - 1).col], [3, 4]);
  assert.deepEqual([padAt(p, -50, 900).row, padAt(p, -50, 900).col], [3, 0]);
  const mid = padAt(p, FIELD.width / 2, FIELD.height / 2 + 1);
  assert.deepEqual([mid.row, mid.col], [2, 2]);
});

test("a cell's centre maps back to the same cell", () => {
  const p = pad();
  for (let row = 0; row < 4; row++) for (let col = 0; col < 5; col++) {
    const { x, y } = padPoint(row, col, 4);
    const back = padAt(p, x, y);
    assert.deepEqual([back.row, back.col], [row, col]);
  }
});

test("Enter applies, Escape closes, arrows move, the rest is ignored", () => {
  const p = pad();
  assert.equal(padKey(p, "enter").action, "apply");
  assert.equal(padKey(p, "escape").action, "close");
  assert.equal(padKey(p, "right").pad.col, 3);
  assert.deepEqual(padKey(p, "a"), { pad: p, action: null });
});

test("the heading and the labels", () => {
  assert.deepEqual(padReadout(pad("Sonnet 5.5", "xhigh")), { model: "Sonnet 5.5", effort: "xHigh" });
  assert.deepEqual(padRowLabels(pad()), ["Opus", "Fable", "Sonnet", "Haiku"]);
});

test("the pad knows when its cell is what the session already runs", () => {
  assert.equal(padIsCurrent(pad("Opus 5.5", "high"), { model: "Opus 5.5", effort: "high" }), true);
  assert.equal(padIsCurrent(movePad(pad("Opus 5.5", "high"), "left"), { model: "Opus 5.5", effort: "high" }), false);
  assert.equal(padIsCurrent(pad(), null), false);
});

test("the gauge lights a share of its 13 ticks, with a tone that warms as context fills", () => {
  assert.equal(GAUGE_TICKS, 13);
  assert.deepEqual([0, 22, 50, 100].map((p) => gaugeLit(p)), [0, 3, 7, 13]);
  assert.deepEqual([gaugeLit(-5), gaugeLit(140), gaugeLit(null), gaugeLit(NaN), gaugeLit(undefined)], [0, 13, 0, 0, 0]);
  assert.deepEqual([10, 59.9, 60, 84.9, 85, 99].map(gaugeTone), ["done", "done", "working", "working", "blocked", "blocked"]);
  assert.equal(gaugeTone(null), "dim");
  assert.deepEqual([gaugeLabel(22.4), gaugeLabel(0), gaugeLabel(null)], ["22%", "0%", "-"]);
});

import { addChoice, afterApply, mergeCurrent, nextStep, routeModel, triedAfter } from "../../mods/claude-chat/pad.js";

test("a bare /model or /effort opens the pad, and is never sent", () => {
  for (const text of ["/model", "/effort", "  /model  ", "/MODEL"]) assert.deepEqual(routeModel(text, FALLBACK_MODELS), { open: true }, text);
});

test("/model with a name chooses that row, keeping the effort", () => {
  assert.deepEqual(routeModel("/model sonnet", FALLBACK_MODELS), { choose: { model: "Sonnet 5.5", effort: null }, row: FALLBACK_MODELS[2] });
  assert.equal(routeModel("/model Haiku 5.5", FALLBACK_MODELS).choose.model, "Haiku 5.5");
  assert.equal(routeModel("/model fable max", FALLBACK_MODELS).choose.effort, "max");
});

test("/effort with a level chooses it, and leaves the model to the session", () => {
  assert.deepEqual(routeModel("/effort low", FALLBACK_MODELS).choose, { model: null, effort: "low" });
  assert.equal(routeModel("/effort XHIGH", FALLBACK_MODELS).choose.effort, "xhigh");
});

test("a value that doesn't fit opens the pad with a note, and sends nothing", () => {
  assert.match(routeModel("/model gpt", FALLBACK_MODELS).note, /no model called gpt/);
  assert.match(routeModel("/model default", FALLBACK_MODELS).note, /no model called/);
  assert.match(routeModel("/effort auto", FALLBACK_MODELS).note, /efforts are/);
});

test("other text is not a model command", () => {
  for (const text of ["hello", "/models", "/modelx", "/clear", "say /model", "/model\nmore", "", null]) assert.equal(routeModel(text, FALLBACK_MODELS), null, String(text));
});

test("the status line doesn't undo a change it hasn't caught up with, until the grace is over", () => {
  const set = { model: "Haiku 5.5", effort: "low", at: 1000 };
  const old = { model: "Opus 5.5", effort: "high" };
  assert.deepEqual(mergeCurrent(set, old, set, 5000), set, "an old reading inside the grace is ignored");
  assert.deepEqual(mergeCurrent(set, { model: "Haiku 5.5", effort: "low" }, set, 5000), { model: "Haiku 5.5", effort: "low" });
  assert.deepEqual(mergeCurrent(set, old, set, 30000), old, "after the grace the status line wins");
  assert.deepEqual(mergeCurrent(null, old, null, 5000), old);
  assert.deepEqual(mergeCurrent(old, null, null, 5000), old, "an unreadable status line changes nothing");
  assert.deepEqual(mergeCurrent(old, { model: "Opus 5.5", effort: null }, null, 5000), old, "a status line without effort keeps the effort of the same model");
  assert.deepEqual(mergeCurrent(old, { model: "Haiku 5.5", effort: null }, null, 5000), { model: "Haiku 5.5", effort: null });
});

test("a waiting choice applies once the session is between turns, and once per state", () => {
  const base = { pending: { choice: {} }, applying: false, tried: null };
  assert.equal(nextStep({ ...base, state: "working" }), null);
  assert.equal(nextStep({ ...base, state: "blocked" }), null);
  assert.equal(nextStep({ ...base, state: "idle" }), "apply");
  assert.equal(nextStep({ ...base, state: "done" }), "apply");
  assert.equal(nextStep({ ...base, state: "idle", tried: "idle" }), null, "a try that came to nothing isn't repeated in the same state");
  assert.equal(nextStep({ ...base, state: "idle", applying: true }), null);
  assert.equal(nextStep({ ...base, state: "idle", pending: null }), null);
});

// ---- what a typed command leaves to the picker, and what an apply leaves behind ----

test("a typed effort names no model, so what the pane holds can't move the session", () => {
  assert.deepEqual(routeModel("/effort high", FALLBACK_MODELS), { choose: { model: null, effort: "high" }, row: null });
});

test("a typed model with no effort leaves the effort to the session", () => {
  assert.deepEqual(routeModel("/model sonnet", FALLBACK_MODELS).choose, { model: "Sonnet 5.5", effort: null });
});

test("a confirmed apply takes the values Claude Code printed", () => {
  const r = afterApply({ ok: true, set: { model: "Sonnet 5.5", effort: "high" } }, { model: "Haiku 5.5", effort: "low" }, null, 900);
  assert.deepEqual(r, { current: { model: "Sonnet 5.5", effort: "high" }, applied: { model: "Sonnet 5.5", effort: "high", at: 900 }, pending: false, note: null, read: true });
});

test("a busy apply stays waiting", () => {
  const was = { model: "Haiku 5.5", effort: "low" };
  assert.deepEqual(afterApply({ ok: false, reason: "busy" }, was, null, 900), { current: was, applied: null, pending: true, note: null, read: false });
});

test("an unconfirmed apply doesn't claim nothing changed, and lets the status line correct the pane at once", () => {
  const was = { model: "Haiku 5.5", effort: "low" };
  const r = afterApply({ ok: false, reason: "unconfirmed" }, was, { ...was, at: 800 }, 900);
  assert.equal(r.applied, null, "no grace, or the status line couldn't correct it");
  assert.equal(r.read, true);
  assert.equal(r.pending, false);
  assert.doesNotMatch(r.note, /didn't change/);
  assert.match(r.note, /confirm/);
  assert.deepEqual(mergeCurrent(r.current, { model: "Sonnet 5.5", effort: "low" }, r.applied, 901), { model: "Sonnet 5.5", effort: "low" });
});

test("a failed apply reads the status line too", () => {
  const r = afterApply({ ok: false, reason: "mismatch" }, null, null, 900);
  assert.equal(r.read, true);
  assert.match(r.note, /didn't change/);
});

test("a choice made while another waits adds to it, so neither is lost", () => {
  const sonnet = routeModel("/model sonnet", FALLBACK_MODELS);
  const high = routeModel("/effort high", FALLBACK_MODELS);
  const both = { choice: { model: "Sonnet 5.5", effort: "high" }, row: sonnet.row };
  assert.deepEqual(addChoice(addChoice(null, sonnet.choose, sonnet.row), high.choose, high.row), both, "/model then /effort");
  assert.deepEqual(addChoice(addChoice(null, high.choose, high.row), sonnet.choose, sonnet.row), both, "/effort then /model");
});

test("what a later choice names replaces what's waiting", () => {
  const fable = routeModel("/model fable low", FALLBACK_MODELS);
  const waiting = { choice: { model: "Sonnet 5.5", effort: "high" }, row: FALLBACK_MODELS[2] };
  assert.deepEqual(addChoice(waiting, fable.choose, fable.row), { choice: { model: "Fable 5.1", effort: "low" }, row: fable.row });
});

test("a failed apply that left the picker open says so", () => {
  assert.match(afterApply({ ok: false, reason: "mismatch", closed: false }, null, null, 900).note, /still open/);
});

test("a dialog or a stash in the terminal gets its own note", () => {
  assert.match(afterApply({ ok: false, reason: "dialog" }, null, null, 900).note, /dialog/);
  assert.match(afterApply({ ok: false, reason: "stashed" }, null, null, 900).note, /stashed/);
});

test("a busy try is forgotten once the session has been anything but ready, so it's tried again at the next idle", () => {
  assert.equal(triedAfter("idle", "working"), null);
  assert.equal(triedAfter("idle", "blocked"), null);
  assert.equal(triedAfter("idle", "idle"), "idle");
  assert.equal(triedAfter("idle", "done"), "idle");
  assert.equal(triedAfter(null, "idle"), null);
});

test("an effort that couldn't be set says why, and how to get past it", () => {
  assert.match(afterApply({ ok: false, reason: "no effort line" }, null, null, 900).note, /too small/);
});

test("a change that couldn't see the effort keeps the effort the pane holds", () => {
  const r = afterApply({ ok: true, set: { model: "Sonnet 5.5", effort: null } }, { model: "Haiku 5.5", effort: "low" }, null, 900);
  assert.deepEqual(r.current, { model: "Sonnet 5.5", effort: "low" });
});

test("closing a pad whose puck ended where it began sends nothing", () => {
  const start = pad("Haiku 5.5", "low");
  assert.equal(padClosed(start, start, { model: "Haiku 5.5", effort: "low" }), "none");
  assert.equal(padClosed(movePad(movePad(start, "up"), "down"), start, { model: "Haiku 5.5", effort: "low" }), "none");
  // The session's values can't be read yet, and a pad nobody moved still changes nothing.
  const blind = newPad(FALLBACK_MODELS, {});
  assert.equal(padClosed(blind, blind, null), "none");
});

test("closing a moved pad applies it", () => {
  const start = pad("Haiku 5.5", "low");
  assert.equal(padClosed(movePad(start, "right"), start, { model: "Haiku 5.5", effort: "low" }), "apply");
  assert.equal(padClosed(padAt(start, 0, 0), start, { model: "Haiku 5.5", effort: "low" }), "apply");
});

test("moving back onto the session's own values takes back a choice that's waiting", () => {
  const start = pad("Sonnet 5.5", "high"), back = pad("Haiku 5.5", "low");
  assert.equal(padClosed(back, start, { model: "Haiku 5.5", effort: "low" }, true), "cancel");
  assert.equal(padClosed(back, start, { model: "Haiku 5.5", effort: "low" }, false), "apply");
});
