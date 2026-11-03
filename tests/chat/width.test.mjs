import test from "node:test";
import assert from "node:assert/strict";
import { chatWidth } from "../../mods/claude-chat/width.js";

test("a pane that hasn't reported its size, or a narrow one, keeps the smallest width", () => {
  assert.equal(chatWidth(0), 800);
  assert.equal(chatWidth(640), 800);
  assert.equal(chatWidth(941), 800);
});

test("the chat grows with the pane", () => {
  assert.equal(chatWidth(1000), 850);
  assert.equal(chatWidth(1400), 1190);
});

test("it stops growing at the largest width", () => {
  assert.equal(chatWidth(1648), 1400);
  assert.equal(chatWidth(3000), 1400);
});
