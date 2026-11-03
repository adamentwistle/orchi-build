import test from "node:test";
import assert from "node:assert/strict";
import { parseEntries, openItems, latestKind, parseState, parseProgress, parseItems, parseContext, parseModel, boardActivity, workerPhase, orchestratorStatus, parseAgentList, liveDecisions, answeredItems } from "../../mods/orchi/parse.js";

const FILE = `## atlas-1 UPDATE 2026-10-30 09:00
Run started.

## atlas-2 DECISION 2026-10-30 09:10
Attempted: read the routes
Uncertain: share the rules or copy them?
Options: A) share B) copy
Recommendation: A, one place to fix
Blocks: nothing
Meanwhile: writing tests

## atlas-3 DECISION 2026-10-30 09:20
Uncertain: first
Options: A) x B) y
Recommendation: A
Blocks: nothing
Meanwhile: waiting

ANSWERED atlas-3: A

## atlas-4 DECISION 2026-10-30 09:30
Uncertain: second
Options: A) x B) y
Recommendation: B
Blocks: nothing
Meanwhile: waiting

## atlas-5 DECIDED 2026-10-30 09:40
Replaces atlas-4
Adam said B.

## atlas-6 ACTION 2026-10-30 09:50
Why: the permission check refused the merge
Do: merge pull request 65
Where: the orch-atlas terminal
Run: ! gh pr merge 65 --squash
Blocks: item 3
Meanwhile: waiting
`;

test("entries keep their id, kind and time", () => {
  const entries = parseEntries(FILE);
  assert.equal(entries.length, 6);
  assert.deepEqual([entries[1].id, entries[1].kind, entries[1].time], ["atlas-2", "DECISION", "2026-10-30 09:10"]);
});

test("answered and replaced decisions are closed", () => {
  assert.deepEqual(openItems(FILE).map((i) => i.id), ["atlas-2", "atlas-6"]);
});

test("the context reads past the status line's separator glyphs", () => {
  assert.equal(parseContext("context:\u00a0\ue0b0\u00a0▓▓░░░░░░░░\u00a015.1%\u00a0\u00a0\uf021\u00a00"), 15.1);
});

test("a paused run says so, even with a question open", () => {
  assert.equal(orchestratorStatus({ paused: true, waiting: true, status: "done" })[0], "Paused");
});

test("a finished run keeps its actions and leaves its questions out", () => {
  const board = "## atlas-1 DECISION 2026-10-30 09:00\nUncertain: Which?\n## atlas-2 ACTION 2026-10-30 09:01\nDo: Merge it\n## atlas-3 DONE 2026-10-30 09:02\n";
  const { decisions, hidden } = liveDecisions(new Map([["/r/atlas", board]]), new Map([["/r/atlas", { name: "orch-atlas", pane: "t1", finished: true }]]));
  assert.deepEqual(decisions.map((d) => d.id), ["atlas-2"]);
  assert.equal(hidden, 1);
});

test("an option's code marks aren't shown", () => {
  const [item] = openItems("## atlas-1 DECISION 2026-10-30 09:00\nUncertain: Which?\nOptions: A) `- hola` (plain) B) `- hola!`\n");
  assert.deepEqual(item.options, [{ key: "A", label: "- hola (plain)" }, { key: "B", label: "- hola!" }]);
});

test("an open decision carries its question and options", () => {
  const [item] = openItems(FILE);
  assert.equal(item.question, "share the rules or copy them?");
  assert.deepEqual(item.options, [{ key: "A", label: "share" }, { key: "B", label: "copy" }]);
  assert.equal(item.recommendation, "A");
});

test("an open action carries its command", () => {
  const item = openItems(FILE)[1];
  assert.equal(item.kind, "ACTION");
  assert.equal(item.run, "! gh pr merge 65 --squash");
  assert.equal(item.place, "the orch-atlas terminal");
});

test("latest kind reads the last entry", () => {
  assert.equal(latestKind(FILE), "ACTION");
  assert.equal(latestKind(""), null);
});

test("the state file gives watched projects, start times and paused ones", () => {
  const state = parseState(`# switchboard state
updated: 2026-10-30 10:00
## watching
atlas /Users/me/dev/atlas wDQ:p7
## started
atlas 2026-10-30 08:00
## check-ins
atlas 2026-10-30 09:00
## paused
atlas
`);
  assert.deepEqual(state.watching, [{ project: "atlas", repo: "/Users/me/dev/atlas", pane: "wDQ:p7" }]);
  assert.equal(state.started.atlas, "2026-10-30 08:00");
  assert.deepEqual(state.paused, ["atlas"]);
});

test("progress reads the fixed line, and is null without it", () => {
  assert.deepEqual(parseProgress("# fanout-state\nProgress: 3/6\n"), { done: 3, total: 6 });
  assert.equal(parseProgress("# fanout-state\n"), null);
});

test("the items table gives workers with their model and effort", () => {
  const items = parseItems(`## Items
| # | slug | branch | base | route | model | state | PR | bugbot |
|---|---|---|---|---|---|---|---|---|
| 1a | sendgrid-worker | feat/a | main | pane | opus high | DRAFT PR OPEN | 65 | CLEAR |
| 2 | notes | - | - | orchestrator | - | queued | - | - |
`);
  assert.deepEqual(items[0], { slug: "sendgrid-worker", route: "pane", model: "Opus", effort: "high", state: "DRAFT PR OPEN", pr: "65" });
  assert.equal(items[1].pr, null);
  assert.equal(items[1].model, null);
});

test("context reads the status line figure", () => {
  assert.equal(parseContext("model:  Haiku 5.5  -  medium  context:  ▓░░░░░░░░░ 6.3%   0  cache"), 6.3);
  assert.equal(parseContext("no status line here"), null);
});

import { ageOf } from "../../mods/orchi/parse.js";

test("age reads like the status line, from a local stamp", () => {
  const now = new Date(2026, 9, 30, 12, 0).getTime();
  assert.equal(ageOf("2026-10-30 11:48", now), "12m");
  assert.equal(ageOf("2026-10-30 09:00", now), "3h");
  assert.equal(ageOf("2026-10-28 12:00", now), "2d");
  assert.equal(ageOf("garbage", now), null);
});

test("a heading with text after the time is still an entry, and its Replaces closes the old one", () => {
  const text = `## cedar-6 DECISION 2026-10-01 20:00
Uncertain: old
Options: A) x B) y

## cedar-9 DECISION 2026-10-01 21:21 Replaces cedar-6
Uncertain: new
Options: A) x B) y
`;
  assert.equal(parseEntries(text).length, 2);
  assert.deepEqual(openItems(text).map((i) => i.id), ["cedar-9"]);
});

test("a bare ANSWERED at the end of a line closes the decision", () => {
  const text = "## atlas-3 DECISION 2026-10-30 09:20\nUncertain: x\n\nANSWERED atlas-3\n";
  assert.deepEqual(openItems(text), []);
});

test("Replaces mid-sentence does not close anything", () => {
  const text = `## atlas-1 DECISION 2026-10-30 09:00
Uncertain: x

## atlas-2 DECISION 2026-10-30 09:10
Uncertain: this Replaces atlas-1 in spirit only
`;
  assert.deepEqual(openItems(text).map((i) => i.id), ["atlas-1", "atlas-2"]);
});

test("Replaces with two ids closes both", () => {
  const text = `## atlas-1 DECISION 2026-10-30 09:00
Uncertain: a

## atlas-2 DECISION 2026-10-30 09:05
Uncertain: b

## atlas-3 DECISION 2026-10-30 09:10
Replaces atlas-1 and atlas-2
Uncertain: c
`;
  assert.deepEqual(openItems(text).map((i) => i.id), ["atlas-3"]);
});

test("an earlier entry never closes a later one", () => {
  const text = `## atlas-1 DECISION 2026-10-30 09:00
Replaces atlas-2
Uncertain: a

## atlas-2 DECISION 2026-10-30 09:05
Uncertain: b
`;
  assert.deepEqual(openItems(text).map((i) => i.id), ["atlas-1", "atlas-2"]);
});

// Rows as written in a repo's .legwork/fanout-state.md.
const row = (route, state, pr = "-") => ({ slug: "x", route, state, pr });

test("a live fw terminal or a located pane means running", () => {
  assert.equal(workerPhase(row("pane wGZ:p1", "DRAFT PR OPEN 13:09 GATE PASS", "68"), new Set()), "running");
  assert.equal(workerPhase({ ...row("-", "queued"), slug: "knock-route" }, new Set(["fw-knock-route"])), "running");
});

test("a closed pane, or a merged or done state, means completed", () => {
  assert.equal(workerPhase(row("pane closed", "DRAFT PR OPEN 12:04 GATE PASS 788ca1c1", "65"), new Set()), "completed");
  assert.equal(workerPhase(row("pane wGW:p1 kept", "PR OPEN 11:0x GATE PASS 03b1f552", "390"), new Set()), "completed");
  assert.equal(workerPhase(row("pane wGZ:p1", "MERGED 14:00", "68"), new Set()), "completed");
  assert.equal(workerPhase(row("-", "done"), new Set()), "completed");
});

test("a pull request with no live terminal counts as completed", () => {
  assert.equal(workerPhase(row("-", "DRAFT PR OPEN", "70"), new Set()), "completed");
  assert.equal(workerPhase(row("pane", "DRAFT PR OPEN 12:5x", "67"), new Set()), "completed");
});

test("no pull request and no live terminal is neither list", () => {
  assert.equal(workerPhase({ ...row("-", "queued"), pr: null }, new Set()), "queued");
  assert.equal(workerPhase({ ...row("pane", "queued"), pr: null }, new Set()), "queued");
});

test("a live terminal beats a closed route", () => {
  assert.equal(workerPhase(row("pane closed", "queued"), new Set(["fw-x"])), "running");
});

test("a blocked orchestrator reads Needs you with a blocked dot", () => {
  assert.deepEqual(orchestratorStatus({ status: "blocked" }), ["Needs you", "blocked"]);
  assert.deepEqual(orchestratorStatus({ status: "working", waiting: true }), ["Waiting on you", "blocked"]);
  assert.deepEqual(orchestratorStatus({ status: "working" }), ["Running", "working"]);
  assert.deepEqual(orchestratorStatus({ status: "idle" }), ["Idle", "dim"]);
});

test("context reads the last status line on the screen", () => {
  const screen = "model: Opus  context:  ▓░░░░░░░░░ 6.3%  cache\n...\nmodel: Opus  context:  ▓▓▓▓░░░░░░ 41.0%  cache";
  assert.equal(parseContext(screen), 41);
});

test("a bad agent list reply is an empty list, not an error", () => {
  assert.deepEqual(parseAgentList("not json"), []);
  assert.deepEqual(parseAgentList('{"result":{"agents":[{"title":"orch-atlas","cwd":"/r","pane_id":"p1","agent_status":"idle"}]}}'),
    [{ name: "orch-atlas", cwd: "/r", pane: "p1", status: "idle" }]);
});

test("liveDecisions shows only boards with a running session and counts the rest", () => {
  const board = (id, time) => `## ${id} DECISION ${time}\nUncertain: which?\nOptions: A) a B) b\n`;
  const boards = new Map([["/live", board("atlas-2", "2026-10-30 09:00")], ["/gone", board("b-1", "2026-10-03 09:00")]]);
  const { decisions, hidden } = liveDecisions(boards, new Map([["/live", { name: "orch-atlas" }]]));
  assert.deepEqual(decisions.map((d) => [d.id, d.orch]), [["atlas-2", "orch-atlas"]]);
  assert.equal(hidden, 1);
});

test("liveDecisions sorts oldest first across boards", () => {
  const board = (id, time) => `## ${id} DECISION ${time}\nUncertain: which?\n`;
  const boards = new Map([["/a", board("a-1", "2026-10-30 09:00")], ["/b", board("b-1", "2026-10-29 09:00")]]);
  const { decisions } = liveDecisions(boards, new Map([["/a", { name: "orch-a" }], ["/b", { name: "orch-b" }]]));
  assert.deepEqual(decisions.map((d) => d.id), ["b-1", "a-1"]);
});

test("a planner's questions show as decisions and carry its terminal", () => {
  const boards = new Map([["/s/planning/birch.md", "## plan-1 DECISION 2026-10-30 09:00\nUncertain: which?\n"]]);
  const { decisions } = liveDecisions(boards, new Map([["/s/planning/birch.md", { name: "plan-birch", terminal: "t9" }]]));
  assert.deepEqual(decisions.map((d) => [d.id, d.orch, d.terminal]), [["plan-1", "plan-birch", "t9"]]);
});

test("an entry carries what a reply needs: its board, pane and which Herdr", () => {
  const boards = new Map([["/repo", "## atlas-2 DECISION 2026-10-30 09:00\nUncertain: which?\n"]]);
  const owners = new Map([["/repo", { name: "orch-atlas", address: "t3", pane: "t3", where: "app" }]]);
  const [d] = liveDecisions(boards, owners).decisions;
  assert.deepEqual([d.board, d.pane, d.where, d.address, d.planner, d.terminal], ["/repo", "t3", "app", "t3", false, null]);
});

test("a planner's board replies by its terminal, in the app", () => {
  const boards = new Map([["/p/s1.md", "## plan-1 DECISION 2026-10-30 09:00\nUncertain: which?\n"]]);
  const [d] = liveDecisions(boards, new Map([["/p/s1.md", { name: "plan-s1", terminal: "t9" }]])).decisions;
  assert.deepEqual([d.board, d.pane, d.where, d.address, d.planner], ["/p/s1.md", "t9", "app", "t9", true]);
});

test("an orchestrator in terminal Herdr has a pane to reply to and no address to jump to", () => {
  const boards = new Map([["/repo", "## atlas-2 ACTION 2026-10-30 09:00\nDo: x\n"]]);
  const [d] = liveDecisions(boards, new Map([["/repo", { name: "orch-atlas", pane: "wGZ:p1", where: "terminal" }]])).decisions;
  assert.deepEqual([d.pane, d.where, d.address], ["wGZ:p1", "terminal", null]);
});

test("answeredItems gives each closed decision and its answer, without the date", () => {
  const text = `## plan-1 DECISION 2026-10-30 09:00
Uncertain: keep it separate?
ANSWERED plan-1: Yes, keep it separate (2026-10-30 09:05)
## plan-2 DECISION 2026-10-30 09:10
Uncertain: in order?
## plan-3 DECISION 2026-10-30 09:20
Uncertain: third?
ANSWERED plan-3
`;
  assert.deepEqual(answeredItems(text), [
    { id: "plan-1", question: "keep it separate?", answer: "Yes, keep it separate" },
    { id: "plan-3", question: "third?", answer: "" },
  ]);
});

test("pausing and resuming outrank everything else on the card", () => {
  assert.deepEqual(orchestratorStatus({ pending: "pausing", waiting: true, status: "blocked" }), ["Pausing", "working"]);
  assert.deepEqual(orchestratorStatus({ pending: "resuming", paused: true }), ["Resuming", "working"]);
  assert.deepEqual(orchestratorStatus({ paused: true, status: "idle" }), ["Paused", "dim"]);
});

test("a subagent shows as running from its state, with no terminal to find", () => {
  const row = (state, pr) => ({ slug: "r13-export", route: "subagent", state, pr: pr ?? null });
  assert.equal(workerPhase(row("running"), new Set()), "running");
  assert.equal(workerPhase(row("done, report written"), new Set()), "completed");
  assert.equal(workerPhase(row("queued"), new Set()), "queued");
});

test("the board gives the run's newest update and counts only this run", () => {
  const board = `## atlas-1 UPDATE 2026-10-30 09:00
Old run.

## atlas-2 DECIDED 2026-10-30 09:05
Old call.

## atlas-3 UPDATE 2026-10-31 14:56
Run started, \`item 0\` first.

## atlas-4 DECIDED 2026-10-31 15:00
A call.

## atlas-5 ACTION 2026-10-31 15:10
Why: x
`;
  assert.deepEqual(boardActivity(board, "2026-10-31 14:56"), {
    lastAt: "2026-10-31 15:10", decided: 1, updates: [{ time: "2026-10-31 14:56", text: "Run started, item 0 first." }],
  });
  assert.deepEqual(boardActivity("", null), { lastAt: null, decided: 0, updates: [] });
});

test("the model comes off the status line, past its separators", () => {
  assert.equal(parseModel("   model:  Sonnet 5.5  -  high  context:  ▓░░░░ 11.4%"), "Sonnet 5.5 high");
  assert.equal(parseModel("model:\u00a0\ue0b0\u00a0Opus 5.5\u00a0-\u00a0xhigh\u00a0\ue0b0\u00a0context:\u00a0▓ 4%"), "Opus 5.5 xhigh");
  assert.equal(parseModel("nothing here"), null);
});

test("an open entry carries what it blocks", () => {
  const [item] = openItems("## atlas-1 ACTION 2026-10-30 09:00\nDo: run it\nBlocks: `the release`\n");
  assert.equal(item.blocks, "the release");
});

test("the board keeps the last four updates, newest first, with every line of each", () => {
  const board = [1, 2, 3, 4, 5].map((n) => `## atlas-${n} UPDATE 2026-10-31 15:0${n}\nUpdate ${n}.\nSecond line.\n`).join("\n");
  const { updates } = boardActivity(board, null);
  assert.deepEqual(updates.map((u) => u.time.slice(-2)), ["05", "04", "03", "02"]);
  assert.equal(updates[0].text, "Update 5. Second line.");
});

test("a PR cell written with a leading # keeps the number bare, so it isn't drawn as ##1", () => {
  const items = parseItems(`| slug | route | model | state | PR |
|---|---|---|---|---|
| a | pane | sonnet high | merged | #1 |
| b | pane | sonnet high | open | 12 |
| c | pane | sonnet high | open | ##3 |
| d | pane | sonnet high | queued | # |
| e | pane | sonnet high | queued | - |
`);
  assert.deepEqual(items.map((i) => i.pr), ["1", "12", "3", null, null]);
  assert.equal(workerPhase({ ...items[3], route: "-", state: "queued" }, new Set()), "queued");
});
