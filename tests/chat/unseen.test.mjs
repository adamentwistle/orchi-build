import { test } from "node:test";
import assert from "node:assert/strict";
import { UNSEEN_KEY, newMessages, unseenLabel, unseenOf, withUnseen } from "../../mods/claude-chat/unseen.js";
import { UNSEEN_KEY as HEADER_KEY } from "../../mods/pane-header/facts.js";

test("a block of text counts once, however many rows it splits into, and each tool call counts", () => {
  const rows = [
    { id: "10.0.0", kind: "text", block: "10.0" }, { id: "10.0.1", kind: "code", block: "10.0" }, { id: "10.0.2", kind: "text", block: "10.0" },
    { id: "20.0", kind: "tool", tool: "t1" }, { id: "30.0", kind: "tool", tool: "t2" },
    { id: "40.0.0", kind: "text", block: "40.0" },
  ];
  assert.equal(newMessages(rows), 4);
});

test("your own messages, quiet lines, turn ends, results and queue lines don't count", () => {
  const rows = [{ id: "1", kind: "user" }, { id: "2", kind: "sys" }, { id: "3", kind: "worked" }, { kind: "result", tool: "t" }, { id: "4", kind: "queue" }];
  assert.equal(newMessages(rows), 0);
  assert.equal(newMessages(undefined), 0);
});

test("the shared map changes only when this terminal's count does", () => {
  assert.deepEqual(withUnseen(undefined, "t1", 3), { t1: 3 });
  assert.deepEqual(withUnseen({ t2: 1 }, "t1", 3), { t2: 1, t1: 3 });
  assert.equal(withUnseen({ t1: 3 }, "t1", 3), null);
  assert.equal(withUnseen({}, "t1", 0), null);
  assert.equal(withUnseen({ t1: 3 }, null, 1), null);
});

test("a count back at nothing takes the terminal out of the map", () => {
  assert.deepEqual(withUnseen({ t1: 3, t2: 1 }, "t1", 0), { t2: 1 });
  const before = { t1: 3 };
  withUnseen(before, "t1", 0);
  assert.deepEqual(before, { t1: 3 });
});

test("a count reads as 0 for anything that isn't one", () => {
  assert.equal(unseenOf({ t1: 2 }, "t1"), 2);
  assert.equal(unseenOf({ t1: "2" }, "t1"), 0);
  assert.equal(unseenOf({ t1: -1 }, "t1"), 0);
  assert.equal(unseenOf(null, "t1"), 0);
});

test("the label reads N new, and nothing for none", () => {
  assert.equal(unseenLabel(3), "3 new");
  assert.equal(unseenLabel(120), "99+ new");
  assert.equal(unseenLabel(0), null);
});

test("the header reads the key the chat writes", () => {
  assert.equal(UNSEEN_KEY, "chat.unseen");
  assert.equal(HEADER_KEY, UNSEEN_KEY);
});
