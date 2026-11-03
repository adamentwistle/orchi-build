import { test } from "node:test";
import assert from "node:assert/strict";
import { goPlan, newSession, plannerPlace, planLabels, planTab } from "../../mods/linear/go.js";
import { defaultSession, PR_SUGGESTION } from "../../mods/linear/review.js";
import { parseBrief } from "../../mods/linear/sessions.js";

const projects = { "ENG-1": { file: "atlas", repo: "~/dev/atlas" }, "ENG-2": { file: "b", repo: "/r/b" } };
const ask = (over = {}) => ({
  session: "s20261030-2240-1f3a", tickets: [{ identifier: "ENG-1" }, { identifier: "ENG-2" }], projectOf: (t) => projects[t.identifier],
  choices: defaultSession(), created: new Date(2026, 9, 30, 22, 40), home: "/h", ...over,
});

test("a session id is shaped for a file, a label and a request", () => {
  assert.equal(newSession(new Date(2026, 9, 30, 22, 40), "1f3a"), "s20261030-2240-1f3a");
  assert.match(newSession(new Date(2026, 0, 2, 3, 4), "ab"), /^s20260102-0304-ab$/);
});

test("the labels are the contract's three", () => {
  assert.deepEqual(planLabels("s1", ["ENG-1", "ENG-2"]), ["orchi.plan=s1", "orchi.session=s1", "orchi.tickets=ENG-1,ENG-2"]);
});

test("the tab names a lone ticket and counts several", () => {
  assert.equal(planTab(["ENG-1"]), "Plan ENG-1");
  assert.equal(planTab(["ENG-1", "ENG-2"]), "Plan 2 tickets");
});

test("the brief has the contract's fields, with repos as absolute paths", () => {
  const { brief } = goPlan(ask());
  assert.deepEqual(Object.keys(brief), ["session", "created", "tickets", "choices"]);
  assert.equal(brief.created, "2026-10-30 22:40");
  assert.deepEqual(brief.tickets, [{ id: "ENG-1", project: "atlas", repo: "/h/dev/atlas" }, { id: "ENG-2", project: "b", repo: "/r/b" }]);
  assert.deepEqual(Object.keys(brief.choices).sort(), Object.keys(defaultSession()).sort());
});

test("an empty pull request field goes in as its suggestion, because empty means that", () => {
  assert.equal(goPlan(ask()).brief.choices.prs, PR_SUGGESTION);
  const typed = { ...defaultSession(), prs: "Merge when green" };
  assert.equal(goPlan(ask({ choices: typed })).brief.choices.prs, "Merge when green");
});

test("what the panel writes is what it reads back", () => {
  const { brief } = goPlan(ask());
  const read = parseBrief(JSON.stringify(brief), brief.session);
  assert.equal(read.created, brief.created);
  assert.deepEqual(read.tickets, brief.tickets);
  assert.equal(read.after, "start");
});

test("the planner runs on the Orchestrator choice", () => {
  const choices = { ...defaultSession(), orchestrator: { model: "Sonnet", effort: "Xhigh" } };
  const plan = goPlan(ask({ choices }));
  assert.deepEqual([plan.model, plan.effort], ["sonnet", "xhigh"]);
});

test("the repos are listed once each", () => {
  const same = { "ENG-1": { file: "atlas", repo: "/r/atlas" }, "ENG-2": { file: "atlas", repo: "/r/atlas" } };
  assert.deepEqual(goPlan(ask({ projectOf: (t) => same[t.identifier] })).repos, ["/r/atlas"]);
});

test("nothing starts on a bad shape", () => {
  assert.equal(goPlan(ask({ session: "a b" })), null);
  assert.equal(goPlan(ask({ tickets: [] })), null);
  assert.equal(goPlan(ask({ projectOf: () => null })), null);
  assert.equal(goPlan(ask({ projectOf: () => ({ file: "../atlas", repo: "/r/atlas" }) })), null);
  assert.equal(goPlan(ask({ projectOf: () => ({ file: "atlas", repo: "relative/atlas" }) })), null);
  assert.equal(goPlan(ask({ projectOf: () => ({ file: "atlas", repo: null }) })), null);
});

test("one repo plans in that project's space", () => {
  const spaces = [{ id: "a", folder: "/r/atlas", machine: null }, { id: "win", folder: "/r/b", machine: "win" }];
  assert.deepEqual(plannerPlace(["/r/atlas"], "/lw", spaces, () => "new"), { folder: "/r/atlas", space: "a", spaceName: null });
});

test("a repo with no space on this Mac opens one, and Herdr names it after the folder", () => {
  const spaces = [{ id: "win", folder: "/r/atlas", machine: "win" }];
  assert.deepEqual(plannerPlace(["/r/atlas"], "/lw", spaces, () => "new"), { folder: "/r/atlas", space: "new", spaceName: null });
});

test("several repos plan in a Planning space in the legwork repo", () => {
  assert.deepEqual(plannerPlace(["/a", "/b"], "/lw", [], () => "new"), { folder: "/lw", space: "new", spaceName: "Planning" });
  const spaces = [{ id: "p", name: "Planning", folder: "/lw", machine: null }];
  assert.deepEqual(plannerPlace(["/a", "/b"], "/lw", spaces, () => "new"), { folder: "/lw", space: "p", spaceName: null });
});
