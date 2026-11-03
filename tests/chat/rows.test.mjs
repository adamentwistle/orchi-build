import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aimAbove, appendReply, clock, editorLanguage, emptyThread, fixedHeight, formatTook, formatWorked, heightOf, listItems, listSizes, measured, mix, pendingItems, prependReply,
  shownItems, sizeKey, statusText, toolState, workedLine,
} from "../../mods/claude-chat/rows.js";

const text = (id, value = "hi") => ({ id, kind: "text", text: value, at: 1 });
const user = (id) => ({ id, kind: "user", text: "yo", at: 1 });
const tool = (id, name = "Bash") => ({ id: `r${id}`, kind: "tool", tool: id, name, target: "x", at: 1000 });
const result = (id, ok = true, at = 2500) => ({ kind: "result", tool: id, ok, at, line: 77, size: 3 });
const code = (id, body = "a\nb") => ({ id, kind: "code", lang: "js", code: body, at: 1 });
const first = (rows, extra = {}) => prependReply(emptyThread(), { rows, start: 100, end: 200, more: true, ...extra });
const none = new Set();

test("a first read sets the range", () => {
  const t = first([text("a")]);
  assert.deepEqual([t.start, t.end, t.more, t.rows.length], [100, 200, true, 1]);
});

test("rows read later go on the end", () => {
  const t = appendReply(first([text("a")]), { rows: [text("b")], start: 200, end: 300 });
  assert.deepEqual(t.rows.map((r) => r.id), ["a", "b"]);
  assert.equal(t.end, 300);
  assert.equal(t.start, 100);
});

test("a stale forward reply changes nothing", () => {
  const t = first([text("a")]);
  assert.equal(appendReply(t, { rows: [text("b")], start: 150, end: 300 }), t);
});

test("history goes on the front and its range joins up", () => {
  const t = prependReply(first([text("b")]), { rows: [text("a")], start: 0, end: 100, more: false });
  assert.deepEqual(t.rows.map((r) => r.id), ["a", "b"]);
  assert.deepEqual([t.start, t.end, t.more], [0, 200, false]);
});

test("a stale page of history changes nothing", () => {
  const t = first([text("b")]);
  assert.equal(prependReply(t, { rows: [text("a")], start: 0, end: 50, more: false }), t);
});

test("a result never becomes a row, and finishes its tool", () => {
  const t = first([tool("x"), result("x")]);
  assert.deepEqual(t.rows.map((r) => r.kind), ["tool"]);
  assert.deepEqual(toolState(t.rows[0], t.results), { status: "ok", took: 1500, line: 77 });
});

test("a failed tool reads as an error, and an unanswered one as running", () => {
  const t = first([tool("x"), result("x", false), tool("y")]);
  assert.equal(toolState(t.rows[0], t.results).status, "error");
  assert.deepEqual(toolState(t.rows[1], t.results), { status: "running", took: null, line: null });
});

test("a result read before its call still finds it", () => {
  const later = first([result("x")]);
  const t = prependReply(later, { rows: [tool("x")], start: 0, end: 100, more: false });
  assert.equal(toolState(t.rows[0], t.results).status, "ok");
});

test("a result in a later read finishes a running tool", () => {
  const t = appendReply(first([tool("x")]), { rows: [result("x")], start: 200, end: 250 });
  assert.equal(toolState(t.rows[0], t.results).status, "ok");
  assert.equal(t.rows.length, 1);
});

test("tool lines in a run join one card", () => {
  const items = listItems(first([text("a"), tool("x"), tool("y"), tool("z"), text("b")]), none, false);
  assert.deepEqual(items.map((i) => [i.first ?? null, i.last ?? null]), [[null, null], [true, false], [false, false], [false, true], [null, null]]);
  assert.deepEqual(items.map((i) => i.top), [26, 10, 0, 0, 10]);
});

test("a code row gives a header band and a body, each its own item", () => {
  const items = listItems(first([code("c")]), none, false);
  assert.deepEqual(items.map((i) => [i.key, i.type]), [["c:head", "code-head"], ["c:body", "code-body"]]);
  assert.equal(items[1].top, 0);
});

test("gaps follow the agreed look", () => {
  const items = listItems(first([user("u"), text("a"), code("c"), { id: "w", kind: "worked", ms: 1, at: 1 }, user("v")]), none, false);
  assert.deepEqual(items.map((i) => i.top), [26, 14, 10, 0, 14, 26]);
});

test("the status row is the last item, only while working", () => {
  const t = first([text("a")]);
  assert.equal(listItems(t, none, true).at(-1).type, "status");
  assert.equal(listItems(t, none, false).at(-1).type, "text");
  assert.equal(listItems(emptyThread(), none, true).length, 1);
});

test("keys are stable as rows arrive, and unique", () => {
  const t = first([text("a"), tool("x"), code("c")]);
  const before = listItems(t, none, false).map((i) => i.key);
  const after = listItems(appendReply(t, { rows: [text("b")], start: 200, end: 300 }), none, true).map((i) => i.key);
  assert.deepEqual(after.slice(0, before.length), before);
  assert.equal(new Set(after).size, after.length);
});

test("an open tool line is measured, and a shut one has a fixed height", () => {
  const t = first([tool("x"), result("x")]);
  const shut = listItems(t, none, false)[0], open = listItems(t, new Set(["x"]), false)[0];
  assert.equal(measured(shut), false);
  assert.equal(measured(open), true);
  assert.notEqual(sizeKey(shut), sizeKey(open));
  assert.equal(fixedHeight(shut), 38);
  assert.equal(fixedHeight(open), null);
});

test("fixed heights for code and the footer", () => {
  const [head, body] = listItems(first([code("c", "1\n2\n3")]), none, false);
  assert.equal(fixedHeight(head), 33);
  assert.equal(fixedHeight(body), 85);
  assert.equal(fixedHeight({ type: "worked" }), 20);
  assert.equal(fixedHeight({ type: "text" }), null);
});

test("a height is the gap plus the measure, and unknown until measured", () => {
  const item = { type: "text", key: "a", top: 10, row: text("a") };
  assert.equal(heightOf(item, { a: 100 }), 110);
  assert.equal(heightOf(item, {}), null);
  assert.equal(heightOf({ type: "worked", key: "w", top: 10, row: {} }, {}), 30);
});

test("a row joins the list once its height is known, and fixed rows are known at once", () => {
  const items = listItems(first([text("a"), tool("x"), text("b")]), none, false);
  assert.deepEqual(shownItems(items, { b: 20 }).map((i) => i.key), ["tool:x", "b"]);
});

test("rows to measure run newest first up to the limit, and skip what's fresh", () => {
  const items = listItems(first(Array.from({ length: 10 }, (_, i) => text(`m${i}`))), none, false);
  assert.deepEqual(pendingItems(items, new Set(), 3).map((i) => i.key), ["m9", "m8", "m7"]);
  assert.deepEqual(pendingItems(items, new Set(["m9", "m7"]), 3).map((i) => i.key), ["m8", "m6", "m5"]);
  assert.equal(pendingItems(items, new Set(items.map((i) => i.key)), 3).length, 0);
});

test("rows with a fixed height are never measured", () => {
  assert.equal(pendingItems(listItems(first([tool("x"), code("c")]), none, false), new Set(), 8).length, 0);
});

test("to show a row at the top of the view, the list aims one overscan above it", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ type: "worked", key: `w${i}`, top: 80, row: {} }));
  assert.equal(aimAbove(items, {}, 8, 200), 6);
  assert.equal(aimAbove(items, {}, 8, 250), 5);
  assert.equal(aimAbove(items, {}, 1, 500), 0);
});

test("the status text comes from a word or an object, and never fails", () => {
  assert.equal(statusText("Searching for web"), "Searching for web");
  assert.equal(statusText({ msg: "Listing files", state: "working" }), "Listing files");
  assert.equal(statusText(null), "Working");
  assert.equal(statusText({ state: "working" }), "Working");
  assert.equal(statusText(""), "Working");
  assert.equal(statusText(4), "Working");
});

test("times read as agreed", () => {
  assert.equal(formatWorked(41000), "41s");
  assert.equal(formatWorked(347255), "5m 47s");
  assert.equal(formatWorked(3 * 3600000 + 120000), "3h 2m");
  assert.equal(formatTook(null), "");
  assert.equal(formatTook(380), "0.4s");
  assert.equal(formatTook(65000), "1m 5s");
  assert.equal(clock(new Date(2026, 9, 31, 7, 5)), "07:05");
  assert.equal(workedLine({ ms: 41000, at: new Date(2026, 9, 31, 12, 58).getTime() }), "Worked for 41s · 12:58");
});

test("a fence's language maps to the editor's name, and an unknown one passes through", () => {
  assert.equal(editorLanguage("js"), "javascript");
  assert.equal(editorLanguage("sh"), "bash");
  assert.equal(editorLanguage(""), "text");
  assert.equal(editorLanguage("sql"), "sql");
});

test("the well sits between its two colours, and a colour it can't read stays", () => {
  assert.equal(mix("#20262b", "#33393f", 0.6), "#2b3137");
  assert.equal(mix("#ffffff14", "#000000", 0), "#ffffff");
  assert.equal(mix("red", "#000000", 0.5), "red");
});

test("queue lines fold into the thread's queue and never become rows", () => {
  const first = prependReply(emptyThread(), { rows: [{ kind: "queue", op: "enqueue", text: "one" }, { id: "1", kind: "user", text: "hi" }], start: 0, end: 10, more: false });
  assert.deepEqual(first.queue, [{ text: "one" }]);
  assert.equal(first.rows.length, 1);
  const next = appendReply(first, { rows: [{ kind: "queue", op: "dequeue", text: null }], start: 10, end: 20 });
  assert.deepEqual(next.queue, []);
});

test("a page of history leaves the live queue alone", () => {
  const live = prependReply(emptyThread(), { rows: [{ kind: "queue", op: "enqueue", text: "now" }], start: 50, end: 60, more: true });
  const older = prependReply(live, { rows: [{ kind: "queue", op: "enqueue", text: "old" }], start: 0, end: 50, more: false });
  assert.deepEqual(older.queue, [{ text: "now" }]);
});

test("sent text draws as your own at the end, before the status row", () => {
  const thread = prependReply(emptyThread(), { rows: [{ id: "1", kind: "text", block: "b", text: "hi" }], start: 0, end: 10, more: false });
  const items = listItems(thread, new Set(), true, [{ id: "sent:1", text: "hello" }]);
  assert.deepEqual(items.map((x) => [x.key, x.type]), [["1", "text"], ["sent:1", "user"], ["status", "status"]]);
  assert.equal(items[1].sent, true);
  assert.equal(items[1].top, 26);
});

// tail.py cuts a code block at 16,000 characters. A 300-line block of 63-character lines keeps 254 of them.
test("the list is handed the height a clipped code card draws at, so no blank opens under it", () => {
  const whole = Array.from({ length: 300 }, (_, i) => `print("line ${String(i + 1).padStart(3, "0")}: the quick brown fox jumps over the lazy dog")`).join("\n");
  const kept = whole.slice(0, 16_000);
  const thread = first([user("u"), { ...code("c", kept), lang: "python", clipped: true }, { id: "w", kind: "worked", ms: 24_000, at: 2 }]);
  const items = listItems(thread, none, false);
  const sizes = listSizes(items, { u: 40 }, { overscan: 480 });
  const body = items.findIndex((item) => item.type === "code-body");
  // The card's box is `.h()` of this, in the app's pixels: 254 lines of 20, and its padding.
  assert.equal(kept.split("\n").length, 254);
  assert.equal(sizes[body + 1], 254 * 20 + 25);
  assert.deepEqual(sizes, [480, 26 + 40, 14 + 33, 5105, 14 + 20 + 18]);
});
