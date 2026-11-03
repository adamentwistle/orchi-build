// The Legwork card's briefing, read from a project file as /pickup reads it, and what Pickup and Go start.
import test from "node:test";
import assert from "node:assert/strict";
import { briefingOf, clip, goLine, pickupLine } from "../../mods/linear/briefing.js";
import { claudeArgv, startClaude } from "../../mods/linear/launch.js";

const FILE = `---
name: Atlas
category: personal
status: queued
energy: deep
description: A small app, being rebuilt.
repo: D:/src/atlas
updated: 2026-10-21
blocked_on: a review of 07
---

## Next prompt

\`\`\`text
Read NEXT.md.

Task: port 07 into index.html
as the new start page.

Done when: it renders at 1440 and 390 wide.
Model: opus

Final step: run /wrap.
\`\`\`

## Log

- 2026-10-19: Started the spikes.
- 2026-10-21 (14:02): Built 07-combined.
  Waiting on feedback.
- 2026-10-20: Picked 06 and 05.
`;

test("a briefing has what the project is, where it stands, the latest log entry and the next prompt's parts", () => {
  const b = briefingOf(FILE.replace(/\n/g, "\r\n"));
  assert.equal(b.name, "Atlas");
  assert.equal(b.description, "A small app, being rebuilt.");
  assert.deepEqual([b.status, b.category, b.energy, b.updated], ["queued", "personal", "deep", "2026-10-21"]);
  assert.equal(b.blockedOn, "a review of 07");
  assert.deepEqual(b.last, { date: "2026-10-21", time: "14:02", text: "Built 07-combined. Waiting on feedback." });
  assert.equal(b.task, "port 07 into index.html as the new start page.");
  assert.equal(b.doneWhen, "it renders at 1440 and 390 wide.");
  assert.equal(b.model, "opus");
  assert.equal(b.effort, null);
  assert.match(b.prompt, /^Read NEXT\.md\./);
});

test("a file with no prompt, no log and no frontmatter still briefs", () => {
  const b = briefingOf("just text");
  assert.deepEqual([b.name, b.last, b.task, b.prompt], [null, null, null, ""]);
});

test("long text is clipped at a word", () => {
  assert.equal(clip("short", 10), "short");
  assert.equal(clip("one two three four five", 16), "one two three…");
});

test("Pickup and Go type /pickup and /go with the project's file name", () => {
  assert.equal(pickupLine("birch"), "/pickup birch");
  assert.equal(goLine("cedar"), "/go cedar");
});

test("with no model or effort, claude starts on its own defaults, and with them the Mac's line is unchanged", () => {
  assert.deepEqual(claudeArgv(null, null, "/go x"), ["claude", "/go x"]);
  assert.deepEqual(claudeArgv("opus", "high", "t", ["--x"]), ["claude", "--x", "--model", "opus", "--effort", "high", "t"]);
});

test("a focused start shows the new tab's space and then the tab, once the tab has its name", async () => {
  const calls = [];
  const exec = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: "" }; };
  const hc = async () => ({ code: 0, stdout: JSON.stringify({ address: "t9" }) });
  const t = await startClaude({ exec, hc, home: () => "C:/Users/a", windows: true, win: "w.py" },
    { model: null, effort: null, task: "/pickup atlas", tab: "Atlas", folder: "D:/src/atlas", space: "sp1", spaceName: "Atlas", focus: true });
  assert.equal(t, "t9");
  const done = calls.map((c) => c.slice(0, 3).join(" "));
  assert.deepEqual(done.slice(-2), ["herdr-app do space.select", "herdr-app do tab.select"]);
  assert.deepEqual(JSON.parse(calls.at(-2)[3]), { id: "sp1" });
  assert.match(JSON.parse(calls.at(-1)[3]).id, /^tb[0-9a-f]+$/);
  const quiet = [];
  await startClaude({ exec: async (c, a) => { quiet.push(a[1]); return { code: 0, stdout: "" }; }, hc, home: () => "/Users/a" },
    { model: "opus", effort: "high", task: "t", tab: "T", folder: "/x", space: "sp1" });
  assert.equal(quiet.includes("space.select"), false);
});
