// A legwork card briefs as /pickup does, read from the project file, and Pickup and Go start a session with its name.
import test from "node:test";
import assert from "node:assert/strict";
import { briefingOf, clip } from "../../mods/tickets/briefing.js";

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


test("blocked_on none is not a block", () => {
  assert.equal(briefingOf("---\nname: A\nblocked_on: none\n---\n").blockedOn, null);
  assert.equal(briefingOf("---\nname: A\nblocked_on: None\n---\n").blockedOn, null);
});

test("of two log entries on the same day, the later time is the last", () => {
  const log = "## Log\n\n- 2026-11-04 (09:00): started\n- 2026-11-04 (17:30): shipped the pull request\n";
  assert.equal(briefingOf(log).last.text, "shipped the pull request");
  assert.equal(briefingOf("## Log\n\n- 2026-11-04: newest\n- 2026-11-04: older\n").last.text, "newest");
});

test("a heading inside the next prompt's fence doesn't end it, and a longer Next prompt heading still counts", () => {
  const file = "## Next prompt (for /go)\n\n```text\nRead this.\n\n## Context\n\nTask: ship it.\nModel: opus\n```\n\n## Log\n";
  const b = briefingOf(file);
  assert.equal(b.task, "ship it.");
  assert.equal(b.model, "opus");
});

test("only a quote pair around a whole value is taken off", () => {
  const b = briefingOf('---\nblocked_on: waiting on "API key"\ndescription: "A tool"\n---\n');
  assert.equal(b.blockedOn, 'waiting on "API key"');
  assert.equal(b.description, "A tool");
});

test("the same day's entries: by time when each has one, else by the file's own order", () => {
  const newestFirst = "## Log\n\n- 2026-11-04: shipped\n- 2026-11-04 (09:00): started\n- 2026-11-03: planned\n";
  assert.equal(briefingOf(newestFirst).last.text, "shipped");
  const oldestFirst = "## Log\n\n- 2026-11-03: planned\n- 2026-11-04: started\n- 2026-11-04: shipped\n";
  assert.equal(briefingOf(oldestFirst).last.text, "shipped");
  const timed = "## Log\n\n- 2026-11-04 (9:05): started\n- 2026-11-04 (14:00): shipped\n";
  assert.equal(briefingOf(timed).last.text, "shipped");
});
