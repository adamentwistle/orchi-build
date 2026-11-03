import test from "node:test";
import assert from "node:assert/strict";
// The Mac's reading width. `false` asks for it on any machine, and the Windows fill is checked at the end.
import { chatWidth } from "../../mods/claude-chat/width.js";

test("a pane that hasn't reported its size, or a narrow one, keeps the smallest width", () => {
  assert.equal(chatWidth(0, false), 800);
  assert.equal(chatWidth(640, false), 800);
  assert.equal(chatWidth(941, false), 800);
});

test("the chat grows with the pane", () => {
  assert.equal(chatWidth(1000, false), 850);
  assert.equal(chatWidth(1400, false), 1190);
});

test("it stops growing at the largest width", () => {
  assert.equal(chatWidth(1648, false), 1400);
  assert.equal(chatWidth(3000, false), 1400);
});

test("on Windows the chat fills the pane, less a margin each side", () => {
  assert.equal(chatWidth(640, true), 800);
  assert.equal(chatWidth(2200, true), 2152);
  assert.equal(chatWidth(3000, true), 2952);
});
