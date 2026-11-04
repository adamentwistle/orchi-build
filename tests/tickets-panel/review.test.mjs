import test from "node:test";
import assert from "node:assert/strict";
import { MODELS, PR_SUGGESTION, defaultSession, restoreSession, pickModel, pickEffort, sessionProblems, footerLines } from "../../mods/tickets/review.js";

test("workers default to Auto, the others to Opus at high", () => {
  const s = defaultSession();
  assert.deepEqual(s.switchboard, { model: "Opus", effort: "High" });
  assert.deepEqual(s.orchestrator, { model: "Opus", effort: "High" });
  assert.deepEqual(s.workers, { model: "Auto", effort: "Auto" });
  assert.equal(s.prs, "");
  assert.equal(s.after, "start");
});

test("Auto model forces Auto effort", () => {
  assert.deepEqual(pickModel({ model: "Sonnet", effort: "High" }, "Auto"), { model: "Auto", effort: "Auto" });
});

test("leaving Auto gives the model a real effort", () => {
  assert.deepEqual(pickModel({ model: "Auto", effort: "Auto" }, "Sonnet"), { model: "Sonnet", effort: "High" });
});

test("a fixed model can't take Auto effort", () => {
  assert.deepEqual(pickEffort({ model: "Opus", effort: "High" }, "Auto"), { model: "Opus", effort: "High" });
});

test("an effort press is ignored while the model is Auto", () => {
  const auto = { model: "Auto", effort: "Auto" };
  assert.deepEqual(pickEffort(auto, "High"), auto);
});

test("MODELS lists the Claude models in order", () => {
  assert.deepEqual(MODELS, ["Fable", "Opus", "Sonnet", "Haiku"]);
});

test("a ticket without a project or repo is a problem", () => {
  const tickets = [{ ref: "linear:ENG-1" }, { ref: "linear:ENG-2" }];
  const projectOf = (t) => (t.ref === "linear:ENG-1" ? null : { name: "Atlas", repo: null });
  assert.deepEqual(sessionProblems(tickets, projectOf), ["ENG-1 has no legwork project", "Atlas has no repo"]);
});

test("the pull request field starts empty, and a saved copy of the suggestion is cleared", () => {
  assert.equal(restoreSession(undefined).prs, "");
  assert.equal(restoreSession({ prs: PR_SUGGESTION }).prs, "");
});

test("restoreSession keeps what was typed and the other choices", () => {
  const s = restoreSession({ prs: "Merge when green", after: "wait" });
  assert.equal(s.prs, "Merge when green");
  assert.equal(s.after, "wait");
  assert.equal(s.switchboard.model, "Opus");
});

const atlas = { name: "Atlas", file: "atlas", repo: "/r/atlas" };
const lone = { ref: "linear:ENG-1" };
const trusted = { "/r/atlas": true };
const only = (project) => () => project;

test("a project with blocked_on stops Go", () => {
  assert.deepEqual(sessionProblems([lone], only({ ...atlas, blocked_on: "keys" })), ["Atlas is blocked"]);
});

test("a human-only next prompt stops Go, and an ordinary one doesn't", () => {
  for (const prompt of ["Human action, not a Claude session.\nRun the deploy", "DECISION NEEDED\nWhich one?", "  DECISION NEEDED"]) {
    assert.deepEqual(sessionProblems([lone], only({ ...atlas, prompt })), ["Atlas's next prompt needs you first"]);
  }
  assert.deepEqual(sessionProblems([lone], only({ ...atlas, prompt: "/fanout atlas" })), []);
});

test("an orchestrator on that repo stops Go", () => {
  assert.deepEqual(sessionProblems([lone], only(atlas), { busy: new Set(["/r/atlas"]) }), ["An orchestrator is working on Atlas's repo"]);
  assert.deepEqual(sessionProblems([lone], only(atlas), { busy: new Set(["/r/other"]) }), []);
});

test("a second Go on a repo whose planner is still planning is stopped by Go's hold", () => {
  assert.deepEqual(sessionProblems([lone], only(atlas), { held: new Map([["/r/atlas", "s1"]]) }), ["Another session holds Atlas's repo until it's done or discarded"]);
  assert.deepEqual(sessionProblems([lone], only(atlas), { held: new Map([["/r/other", "s1"]]) }), []);
});

test("a start of that project waiting on the switchboard stops Go", () => {
  const requested = { start: new Set(), run: new Set(["atlas"]) };
  assert.deepEqual(sessionProblems([lone], only(atlas), { requested }), ["A start for Atlas is waiting on the switchboard"]);
});

test("a ticket already in a session stops Go", () => {
  assert.deepEqual(sessionProblems([lone], only(atlas), { inSession: new Map([["linear:ENG-1", { session: "s1" }]]) }), ["ENG-1 is already in a session"]);
});

test("an untrusted folder stops Go, and so does one not checked yet", () => {
  assert.deepEqual(sessionProblems([lone], only(atlas), { trust: trusted }), []);
  assert.match(sessionProblems([lone], only(atlas), { trust: { "/r/atlas": false } })[0], /hasn't been trusted in Atlas's folder/);
  assert.match(sessionProblems([lone], only(atlas), { trust: {} })[0], /^Checking Atlas's folder/);
  assert.match(sessionProblems([lone], only(atlas), { trust: { "/r/atlas": null } })[0], /^Could not check Atlas's folder/);
});

test("trust follows the folder the session starts in, not the tracker's spelling", () => {
  const tilde = { ...atlas, repo: "~/atlas" };
  assert.deepEqual(sessionProblems([lone], only(tilde), { trust: { "/h/atlas": true }, folderOf: () => "/h/atlas" }), []);
});

test("a project shared by several tickets says each thing once", () => {
  const tickets = [{ ref: "linear:ENG-1" }, { ref: "linear:ENG-2" }];
  assert.deepEqual(sessionProblems(tickets, only({ ...atlas, blocked_on: "keys" })), ["Atlas is blocked"]);
});

test("a reference the panel can't use stops Go, and its text isn't shown", () => {
  assert.deepEqual(sessionProblems([{ ref: "x; rm -rf" }], only(atlas)), ["A ticket has a reference the panel can't use"]);
  assert.deepEqual(sessionProblems([{ ref: "ENG-1" }], only(atlas)), ["A ticket has a reference the panel can't use"]);
});

test("a project file name that can't build a path stops Go", () => {
  assert.match(sessionProblems([lone], only({ ...atlas, file: "../atlas" }))[0], /file name the panel can't use/);
});

test("several repos need the legwork folder trusted as well, because the planner runs there", () => {
  const projects = { "linear:ENG-1": atlas, "linear:ENG-2": { name: "B", file: "b", repo: "/r/b" } };
  const tickets = [{ ref: "linear:ENG-1" }, { ref: "linear:ENG-2" }], projectOf = (t) => projects[t.ref];
  const trust = { "/r/atlas": true, "/r/b": true };
  assert.deepEqual(sessionProblems(tickets, projectOf, { trust: { ...trust, "/lw": true }, planning: "/lw" }), []);
  assert.match(sessionProblems(tickets, projectOf, { trust: { ...trust, "/lw": false }, planning: "/lw" })[0], /the legwork folder/);
  assert.match(sessionProblems(tickets, projectOf, { trust })[0], /no legwork folder/);
});

test("while Go starts, the hold it just took isn't shown as another session's", () => {
  // Go writes its hold before the planner starts, and the review screen redraws with it while the button says Starting.
  const held = "Another session holds Fernlog's repo until it's done or discarded";
  assert.deepEqual(footerLines([held], { going: true, goError: null }), []);
  assert.deepEqual(footerLines([held], { going: false, goError: null }), [held]);
  assert.deepEqual(footerLines([], { going: false, goError: "Fernlog has no repo" }), ["Fernlog has no repo"]);
});
