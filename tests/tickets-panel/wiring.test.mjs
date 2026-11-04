// The tickets panel replaces the Linear panel everywhere one is named: the layout, the key, the panel button, the
// Orchi panel's shared choices, and the test hook a private window runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { testing, scriptSteps } from "../../mods/tickets/test-hook.js";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

function mods(node, found = []) {
  if (Array.isArray(node)) node.forEach((n) => mods(n, found));
  else if (node && typeof node === "object") {
    if (typeof node.mod === "string") found.push(node.mod);
    Object.values(node).forEach((v) => mods(v, found));
  }
  return found;
}

test("there is one tickets panel and no Linear panel", () => {
  assert.ok(existsSync(new URL("mods/tickets/main.js", root)));
  assert.ok(!existsSync(new URL("mods/linear", root)));
});

test("the layout holds the tickets block in the panel stack, and no linear block", () => {
  const layout = JSON.parse(read("layouts/main-linear.json"));
  const used = mods(layout);
  assert.ok(used.includes("tickets"));
  assert.ok(!used.includes("linear"));
});

test("the key opens the tickets panel", () => {
  assert.ok(!existsSync(new URL("keys/linear.json", root)));
  assert.deepEqual(JSON.parse(read("keys/tickets.json")), { global: { "ctrl-shift-y": "mod.open:tickets" } });
});

test("the panel button opens the tickets panel, with the tickets glyph", () => {
  const text = read("mods/panel-buttons/main.js");
  assert.ok(text.includes('button("tickets", "Tickets", "mods/tickets/tickets.svg"'));
  assert.ok(!text.includes('"linear"'));
});

test("the review screen's choices are shared under tickets, and Orchi reads them there", () => {
  assert.ok(read("mods/tickets/main.js").includes('"tickets.session"'));
  assert.ok(read("mods/orchi/main.js").includes('const SESSION = "tickets.session"'));
});

test("the test hook runs only in a private home, and only steps it knows", () => {
  assert.equal(testing("/Users/a/.config/hd/b13/"), true);
  assert.equal(testing("/Users/a/.config/herdr-app"), false);
  const steps = scriptSteps(JSON.stringify([
    { do: "source", value: "linear" }, { do: "category", value: "work" }, { do: "open", ref: "linear:ENG-12" },
    { do: "back" }, { do: "tick", ref: "gh:acme/app#7" }, { do: "send", ref: "legwork:birch" }, { do: "go" },
    { do: "move", ref: "linear:ENG-12", value: "In Review" }, { do: "move", ref: "linear:ENG-12" },
    { do: "act", ref: "legwork:birch", value: "Pickup" },
    { do: "rm -rf" }, { do: "open", ref: "nope" }, "x",
  ]));
  assert.deepEqual(steps.map((s) => s.do), ["source", "category", "open", "back", "tick", "send", "go", "move", "act"]);
  assert.deepEqual(scriptSteps("not json"), []);
});

test("NOTICE.md names the GitHub mark and the glyphs drawn for Orchi", () => {
  const notice = read("NOTICE.md");
  assert.ok(notice.includes("mods/tickets/linear.svg"));
  assert.ok(notice.includes("mods/tickets/github.svg"));
  assert.ok(notice.includes("mods/tickets/legwork.svg") && notice.includes("mods/tickets/markdown.svg"));
});
