import test from "node:test";
import assert from "node:assert/strict";
import { planOf } from "../../mods/plan-view/roadmap.js";

const FILE = `---
name: Atlas
status: queued
---

## Next prompt

\`\`\`text
/fanout atlas
\`\`\`

## Roadmap 12 (2026-10-29)

Newest plan.

| # | Item |
|---|---|
| 1 | One |

## Roadmap 11 (2026-10-28)

Older plan.

## Log

- 2026-10-29: did things.
`;

test("planOf returns the newest roadmap section and nothing else", () => {
  const plan = planOf(FILE);
  assert.ok(plan.startsWith("## Roadmap 12"));
  assert.ok(plan.includes("| 1 | One |"));
  assert.ok(!plan.includes("Older plan"));
  assert.ok(!plan.includes("name: Atlas"));
  assert.ok(!plan.includes("/fanout"));
});

test("planOf falls back on the next prompt when there is no roadmap", () => {
  const plan = planOf("---\nname: X\n---\n\n## Next prompt\n\nDo the thing.\n\n## Log\n\n- old\n");
  assert.equal(plan, "## Next prompt\n\nDo the thing.");
});

test("planOf is null for a project with neither", () => {
  assert.equal(planOf("---\nname: X\n---\n\n## Log\n"), null);
});

test("a roadmap at the end of the file runs to the end", () => {
  assert.equal(planOf("## Roadmap 1\n\nOnly plan.\n"), "## Roadmap 1\n\nOnly plan.");
});

test("a planning board shows its PLAN entries, without its questions or its READY", () => {
  const plan = planOf(`## plan-1 DECISION 2026-10-30 22:30
Uncertain: which?
## s1-p1 PLAN 2026-10-30 22:40
Project: atlas
Start: /fanout atlas --only "a"
## s1-p2 PLAN 2026-10-30 22:41
Project: b
## s1-ready READY 2026-10-30 22:41
`);
  assert.match(plan, /s1-p1 PLAN/);
  assert.match(plan, /Project: b/);
  assert.doesNotMatch(plan, /Uncertain|READY/);
});
