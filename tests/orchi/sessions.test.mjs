import test from "node:test";
import assert from "node:assert/strict";
import { appendEntry, elapsed, emptyWorld, finishedRun, foundOrchestrators, folderTrust, heldRepos, holdFile, keptPlan, keptProblems, loadWorld, parseBoard, parseBrief, parseHold, planReady, projectProblems, removeHold, repoRun, sessionPhase, sessionRows, stamp, terminalAgents, ticketSessions, trustOf, waitingStarts, writeHold } from "../../mods/orchi/sessions.js";
import { parseEntries, openItems } from "../../mods/orchi/parse.js";

const BOARD = `## plan-1 DECISION 2026-10-30 22:30
Uncertain: keep it separate?
Options: A) yes B) no
ANSWERED plan-1: A (2026-10-30 22:31)
## s1-p1 PLAN 2026-10-30 22:40
Project: atlas
Repo: /r/atlas
Tickets: ENG-1, ENG-2
Start: /fanout atlas --only "a" --merge
## s1-p2 PLAN 2026-10-30 22:40
Project: b.md
Repo: /r/b
Tickets: ENG-3
Start: /fanout b --only "b"
## s1-ready READY 2026-10-30 22:41
`;
const board = (over = {}) => ({ plans: [], ready: null, kept: null, started: null, open: [], answered: [], ...over });
const run = (over = {}) => ({ project: "atlas", done: false, doneAt: null, open: 0, progress: null, ...over });
const phase = (over = {}) => sessionPhase({ board: board(), planner: null, runs: [], paused: [], ...over });

test("a stamp is local YYYY-MM-DD HH:MM", () => {
  assert.equal(stamp(new Date(2026, 0, 2, 3, 4)), "2026-01-02 03:04");
});

test("a board reads its plans, READY and answers", () => {
  const b = parseBoard(BOARD);
  assert.deepEqual(b.plans, [{ project: "atlas", repo: "/r/atlas", tickets: ["linear:ENG-1", "linear:ENG-2"] }, { project: "b", repo: "/r/b", tickets: ["linear:ENG-3"] }]);
  assert.equal(b.ready, "2026-10-30 22:41");
  assert.equal(b.kept, null);
  assert.deepEqual(b.answered.map((a) => a.id), ["plan-1"]);
  assert.equal(b.open.length, 0);
});

test("a board's entries the panel and the switchboard add read back", () => {
  const b = parseBoard(appendEntry(appendEntry(BOARD, "s1-kept", "KEPT", "2026-10-30 23:00"), "s1-started", "STARTED", "2026-10-30 23:05"));
  assert.equal(b.kept, "2026-10-30 23:00");
  assert.equal(b.started, "2026-10-30 23:05");
});

test("a new entry starts its own line", () => {
  assert.equal(appendEntry("## a READY 2026-10-30 22:41", "b", "KEPT", "2026-10-30 23:00"), "## a READY 2026-10-30 22:41\n## b KEPT 2026-10-30 23:00\n");
  assert.equal(appendEntry("", "b", "KEPT", "2026-10-30 23:00"), "## b KEPT 2026-10-30 23:00\n");
  assert.equal(parseEntries(appendEntry("## a READY 2026-10-30 22:41", "b", "KEPT", "2026-10-30 23:00")).length, 2);
});

test("a board can't name a project or repo that isn't the right shape", () => {
  const text = "## s PLAN 2026-10-30 22:40\nProject: ../../etc passwd\nRepo: /r/atlas\nTickets: ENG-1\n## t PLAN 2026-10-30 22:40\nProject: atlas\nRepo: relative\nTickets: ENG-1\n## u PLAN 2026-10-30 22:40\nProject: atlas\nRepo: /r/atlas\nTickets: ENG-1, not a ticket\n";
  assert.deepEqual(parseBoard(text).plans, [{ project: "atlas", repo: "/r/atlas", tickets: ["linear:ENG-1"] }]);
});

test("a brief must be for this session, and bad tickets drop out", () => {
  const brief = { session: "s1", created: "2026-10-30 22:00", tickets: [{ id: "ENG-1", project: "atlas", repo: "/r/atlas" }, { id: "bad id", project: "atlas", repo: "/r/atlas" }, { id: "ENG-2", project: "../atlas", repo: "/r/atlas" }, null], choices: { after: "wait" } };
  const read = parseBrief(JSON.stringify(brief), "s1");
  assert.deepEqual(read.tickets, [{ ref: "linear:ENG-1", project: "atlas", repo: "/r/atlas" }]);
  assert.equal(read.after, "wait");
  assert.equal(parseBrief(JSON.stringify(brief), "s2"), null);
  assert.equal(parseBrief("not json", "s1"), null);
  assert.equal(parseBrief("null", "s1"), null);
});

test("each phase, in the contract's order", () => {
  const started = board({ started: "2026-10-30 23:00", plans: [{}] });
  assert.equal(phase({ board: started, runs: [run({ done: true })] }), "Finished");
  assert.equal(phase({ board: started, runs: [run({ progress: { done: 5, total: 5 } })] }), "Pull requests open");
  assert.equal(phase({ board: started, runs: [run()], paused: ["atlas"] }), "Paused");
  assert.equal(phase({ board: started, runs: [run({ open: 1 })] }), "Needs you");
  assert.equal(phase({ board: started, runs: [run({ progress: { done: 2, total: 5 } })] }), "Running");
  assert.equal(phase({ board: board({ ready: "x" }) }), "Planned");
  assert.equal(phase({ board: board({ kept: "x" }) }), "Planned");
  assert.equal(phase({ planner: { address: "t9" } }), "Planning");
  assert.equal(phase({ planner: { address: "t9" }, board: board({ open: [{}] }) }), "Needs you");
});

test("the order holds when several are true", () => {
  const started = board({ started: "2026-10-30 23:00", ready: "x" });
  assert.equal(phase({ board: started, runs: [run({ done: true, open: 1 })], paused: ["atlas"] }), "Finished");
  assert.equal(phase({ board: started, runs: [run({ progress: { done: 5, total: 5 }, open: 1 })], paused: ["atlas"] }), "Pull requests open");
  assert.equal(phase({ board: started, runs: [run({ open: 1 })], paused: ["atlas"] }), "Paused");
  assert.equal(phase({ board: board({ ready: "x" }), planner: { address: "t9" } }), "Planned");
});

test("one orchestrator done and one with all tasks done has pull requests open", () => {
  const started = board({ started: "x" });
  assert.equal(phase({ board: started, runs: [run({ done: true }), run({ project: "b", progress: { done: 1, total: 1 } })] }), "Pull requests open");
  assert.equal(phase({ board: started, runs: [run({ done: true }), run({ project: "b" })] }), "Running");
});

test("a run with no tasks known isn't done", () => {
  assert.equal(phase({ board: board({ started: "x" }), runs: [run({ progress: { done: 0, total: 0 } })] }), "Running");
});

test("a board nobody is working on is no session", () => {
  assert.equal(phase(), null);
  assert.equal(phase({ board: board({ open: [{}] }) }), null);
});

test("a repo's older run doesn't count against a new one", () => {
  const old = "## atlas-1 DONE 2026-10-20 09:00\nfinished\n## atlas-2 DECISION 2026-10-20 08:00\nUncertain: x\n";
  const r = repoRun(old, "Progress: 7/7\n(started 2026-10-20 08:00)\n", "2026-10-30 23:00");
  assert.deepEqual(r, { done: false, doneAt: null, open: 0, progress: null, prs: [] });
});

test("a repo's run since the start counts", () => {
  const text = "## atlas-1 DECISION 2026-10-30 23:10\nUncertain: x\n## atlas-2 DONE 2026-10-30 23:20\nfinished\n";
  const r = repoRun(text, "Progress: 2/5\n(started 2026-10-30 23:01)\n", "2026-10-30 23:00");
  assert.deepEqual(r, { done: true, doneAt: "2026-10-30 23:20", open: 1, progress: { done: 2, total: 5 }, prs: [] });
});

const FANOUT = `(started 2026-10-30 23:01)
| slug | route | model | state | PR |
|---|---|---|---|---|
| eng-1-fix | subagent | opus high | open | 42 |
| docs | pane closed | sonnet low | merged | #12 |
| later | - | - | queued | - |
`;

test("a run lists the workers that have a pull request, and an older run's don't count", () => {
  // A cell written "#12" reads as the bare number, as every PR cell does.
  assert.deepEqual(repoRun("", FANOUT, "2026-10-30 23:00").prs, [{ slug: "eng-1-fix", pr: "42" }, { slug: "docs", pr: "12" }]);
  assert.deepEqual(repoRun("", FANOUT, "2026-10-31 09:00").prs, []);
});

const row = (over = {}) => ({ session: "s1", created: "2026-10-30 22:00", after: "start", tickets: ["ENG-1"], board: board({ plans: [{ project: "atlas" }] }), planner: null, runs: [], phase: "Planned", ...over });
const NOW = new Date(2026, 9, 30, 23, 30).getTime();

test("Needs you sorts first, then the newest", () => {
  const rows = sessionRows([row({ session: "a", phase: "Running", created: "2026-10-30 23:00" }), row({ session: "b", phase: "Needs you", created: "2026-10-30 20:00" }), row({ session: "c", phase: "Planned", created: "2026-10-30 22:00" })], NOW);
  assert.deepEqual(rows.map((r) => r.session), ["b", "a", "c"]);
});

test("a row says where it runs, how long and what's going on", () => {
  const [planning] = sessionRows([row({ phase: "Planning", planner: { address: "t9", where: "Planning / Plan ENG-1" } })], NOW);
  assert.deepEqual([planning.dot, planning.where, planning.time, planning.detail], ["working", "Planning / Plan ENG-1", "1h 30m", "Reading the tickets"]);
  const started = board({ started: "2026-10-30 23:00", plans: [{ project: "atlas" }, { project: "b" }] });
  const runs = [run({ progress: { done: 2, total: 5 } }), run({ progress: { done: 1, total: 2 } })];
  const [running] = sessionRows([row({ phase: "Running", board: started, runs })], NOW);
  assert.deepEqual([running.dot, running.where, running.detail], ["working", "orch-atlas, orch-b", "3 of 7 tasks done"]);
  const [needs] = sessionRows([row({ phase: "Needs you", board: board({ open: [{}] }) })], NOW);
  assert.deepEqual([needs.dot, needs.detail], ["blocked", "1 open question. Press to open it."]);
  const [kept] = sessionRows([row({ board: board({ kept: "x" }) })], NOW);
  assert.equal(kept.detail, "Kept for later");
});

test("a finished run drops out after a day, and a discarded plan at once", () => {
  const done = (doneAt) => row({ phase: "Finished", runs: [run({ done: true, doneAt })] });
  assert.equal(sessionRows([done("2026-10-30 20:00")], NOW).length, 1);
  assert.equal(sessionRows([done("2026-10-28 20:00")], NOW).length, 0);
  assert.equal(sessionRows([row()], NOW, ["s1"]).length, 0);
});

test("elapsed reads minutes, then hours, and nothing for a bad stamp", () => {
  assert.equal(elapsed("2026-10-30 23:20", NOW), "10m");
  assert.equal(elapsed("2026-10-30 21:25", NOW), "2h 05m");
  assert.equal(elapsed("nonsense", NOW), "");
  assert.equal(elapsed("", NOW), "");
});

test("a ticket is in a session unless that session has finished", () => {
  const rows = [row({ tickets: ["ENG-1"], phase: "Running" }), row({ session: "s2", tickets: ["ENG-2"], phase: "Finished" })];
  assert.deepEqual([...ticketSessions(rows).keys()], ["ENG-1"]);
  assert.equal(ticketSessions(rows).get("ENG-1").session, "s1");
});

test("Plan ready shows for Wait for me, and waits out a handover otherwise", () => {
  const ready = board({ ready: "2026-10-30 23:25" });
  assert.equal(planReady(row({ after: "wait", board: ready }), NOW), true);
  assert.equal(planReady(row({ after: "start", board: ready }), NOW), false);
  assert.equal(planReady(row({ after: "start", board: board({ ready: "2026-10-30 23:00" }) }), NOW), true);
  assert.equal(planReady(row({ after: "wait", board: board({ ready: "x", kept: "y" }) }), NOW), false);
  assert.equal(planReady(row({ phase: "Running", after: "wait", board: ready }), NOW), false);
});

test("a kept plan is Planned with a KEPT entry", () => {
  assert.equal(keptPlan(row({ board: board({ kept: "x" }) })), true);
  assert.equal(keptPlan(row({ board: board({ ready: "x" }) })), false);
  assert.equal(keptPlan(row({ phase: "Running", board: board({ kept: "x" }) })), false);
});

const context = (over = {}) => ({ folderOf: (p) => p.repo, busy: new Set(), trust: { "/r/atlas": true }, ...over });
const atlas = { file: "atlas", name: "Atlas", repo: "/r/atlas" };

test("Go's rules for a project", () => {
  assert.deepEqual(projectProblems(atlas, context()), []);
  assert.deepEqual(projectProblems({ ...atlas, repo: null }, context()), ["Atlas has no repo"]);
  assert.deepEqual(projectProblems({ ...atlas, blocked_on: "keys" }, context()), ["Atlas is blocked"]);
  assert.deepEqual(projectProblems({ ...atlas, prompt: "DECISION NEEDED\nwhich" }, context()), ["Atlas's next prompt needs you first"]);
  assert.deepEqual(projectProblems(atlas, context({ busy: new Set(["/r/atlas"]) })), ["An orchestrator is working on Atlas's repo"]);
});

test("Start on a kept plan re-runs Go's rules, and its own tickets don't count", () => {
  const plan = { project: "atlas", repo: "/r/atlas", tickets: ["ENG-1"] };
  const s = row({ phase: "Planned", board: board({ kept: "x", plans: [plan] }) });
  const projectOf = () => atlas;
  assert.deepEqual(keptProblems(s, projectOf, [s], context()), []);
  const other = row({ session: "s2", phase: "Running", tickets: ["ENG-1"] });
  assert.deepEqual(keptProblems(s, projectOf, [s, other], context()), ["ENG-1 is already in a session"]);
  assert.match(keptProblems(s, projectOf, [s], context({ trust: { "/r/atlas": false } }))[0], /hasn't been trusted/);
  assert.deepEqual(keptProblems(s, () => null, [s], context()), []);
  assert.deepEqual(keptProblems(row({ board: board({ kept: "x" }) }), projectOf, [], context()), ["This plan names no projects"]);
});

test("another session's hold on a repo stops a start, and a session's own hold doesn't", () => {
  const held = new Map([["/r/atlas", "s1"]]);
  assert.deepEqual(projectProblems(atlas, context({ held })), ["Another session holds Atlas's repo until it's done or discarded"]);
  assert.deepEqual(projectProblems(atlas, context({ held, own: "s1" })), []);
  // An orchestrator on the repo already says why, so the hold isn't said twice.
  assert.deepEqual(projectProblems(atlas, context({ held, busy: new Set(["/r/atlas"]) })), ["An orchestrator is working on Atlas's repo"]);
  const plan = { project: "atlas", repo: "/r/atlas", tickets: ["ENG-1"] };
  const s = row({ phase: "Planned", board: board({ kept: "x", plans: [plan] }) });
  assert.deepEqual(keptProblems(s, () => atlas, [s], context({ held })), []);
  assert.deepEqual(keptProblems(row({ session: "s2", board: board({ kept: "x", plans: [plan] }) }), () => atlas, [], context({ held })), ["Another session holds Atlas's repo until it's done or discarded"]);
});

test("a start still waiting on the switchboard stops a second one", () => {
  const requested = waitingStarts(["run atlas\n", "start s1\n", "pause atlas\n", "run bad name\n"]);
  assert.deepEqual([...requested.run], ["atlas"]);
  assert.deepEqual([...requested.start], ["s1"]);
  assert.deepEqual(projectProblems(atlas, context({ requested })), ["A start for Atlas is waiting on the switchboard"]);
  const s = row({ phase: "Planned", board: board({ kept: "x", plans: [{ project: "b", repo: "/r/atlas", tickets: [] }] }) });
  assert.deepEqual(keptProblems(s, () => null, [s], context({ requested })), ["This plan's start is waiting on the switchboard"]);
});

test("a hold lasts until its session finishes or is discarded, and one that never showed lets go", () => {
  const holds = [{ session: "s1", repos: ["/r/atlas"], at: 0 }, { session: "s2", repos: ["/r/b"], at: 0 }, { session: "s3", repos: ["/r/c"], at: 0 }, { session: "s4", repos: ["/r/d"], at: 9 * 60000 }];
  const sessions = [{ session: "s1", phase: "Planning" }, { session: "s2", phase: "Finished" }];
  const { held, stale } = heldRepos(holds, sessions, [], 10 * 60000);
  assert.deepEqual([...held], [["/r/atlas", "s1"], ["/r/d", "s4"]]);
  assert.deepEqual(stale, ["s2", "s3"]);
  assert.deepEqual(heldRepos(holds, sessions, ["s1"], 0).stale, ["s1", "s2"]);
});

test("a hold reads back only for its own session, with absolute repos", () => {
  assert.deepEqual(parseHold('{"session":"s1","repos":["/r/atlas","relative","/r/b"],"at":5}', "s1"), { session: "s1", repos: ["/r/atlas", "/r/b"], at: 5 });
  assert.equal(parseHold('{"session":"s2","repos":[],"at":5}', "s1"), null);
  assert.equal(parseHold("not json", "s1"), null);
  assert.equal(parseHold('{"session":"s1","repos":[]}', "s1"), null);
});

test("Go's hold is written and removed under the switchboard folder", async () => {
  const calls = [], written = {};
  const io = { home: () => "/h", now: () => 42, exec: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: "" }; }, writeTextFile: async (path, text) => { written[path] = text; } };
  await writeHold(io, "s1", ["/r/atlas", "nope"]);
  assert.deepEqual(JSON.parse(written[holdFile({}, "/h", "s1")]), { session: "s1", repos: ["/r/atlas"], at: 42 });
  await removeHold(io, "s1");
  await removeHold(io, "../x");
  assert.deepEqual(calls, [["mkdir", "-p", "/h/.claude/switchboard/holds"], ["rm", "-f", "/h/.claude/switchboard/holds/s1.json"]]);
  await assert.rejects(writeHold(io, "a b", []));
});

test("the trust check prints one flag and passes the folder as an argument", async () => {
  const calls = [];
  const hostile = `/r/atlas"; print(open('/etc/passwd').read()) #`;
  const answer = await folderTrust(async (c, a) => { calls.push([c, ...a]); return { code: 0, stdout: "False\n" }; }, "/h", hostile);
  assert.equal(answer, false);
  assert.deepEqual([calls[0][0], calls[0][1]], ["python3", "-c"]);
  assert.ok(!calls[0][2].includes("/r/atlas"));
  assert.deepEqual(calls[0].slice(3), ["/h/.claude.json", hostile]);
  await folderTrust(async (c, a) => { calls.push([c, ...a]); return { code: 0, stdout: "True\n" }; }, "/h", "/r", { claude_dir: "~/.claude-alt" });
  assert.equal(calls[1][3], "/h/.claude-alt/.claude.json");
});

test("the flag is read as true, false or unknown", async () => {
  assert.equal(await folderTrust(async () => ({ code: 0, stdout: "True\n" }), "/h", "/r"), true);
  assert.equal(await folderTrust(async () => ({ code: 1, stdout: "" }), "/h", "/r"), null);
  assert.equal(await folderTrust(async () => { throw new Error("no python"); }, "/h", "/r"), null);
});

test("each folder is asked about once", async () => {
  let asked = 0;
  const trust = await trustOf(async () => { asked++; return { code: 0, stdout: "True\n" }; }, "/h", ["/a", "/a", "/b"]);
  assert.deepEqual(trust, { "/a": true, "/b": true });
  assert.equal(asked, 2);
});

test("the real command answers true, false and missing from a stand-in file", async (t) => {
  const { execFile } = await import("node:child_process");
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const home = await mkdtemp(`${tmpdir()}/trust-`);
  t.after(() => rm(home, { recursive: true }));
  await mkdir(`${home}/.claude-alt`);
  await writeFile(`${home}/.claude-alt/.claude.json`, JSON.stringify({ oauthAccount: { emailAddress: "secret" }, projects: { "/yes": { hasTrustDialogAccepted: true }, "/no": { hasTrustDialogAccepted: false }, "/yes/child": {} } }));
  const exec = (command, args) => new Promise((resolve) => execFile(command, args, (e, stdout, stderr) => resolve({ code: e ? 1 : 0, stdout, stderr })));
  const s = { claude_dir: `${home}/.claude-alt` };
  assert.equal(await folderTrust(exec, home, "/yes", s), true);
  assert.equal(await folderTrust(exec, home, "/no", s), false);
  assert.equal(await folderTrust(exec, home, "/yes/child", s), false);
  assert.equal(await folderTrust(exec, home, "/absent", s), false);
  assert.equal(await folderTrust(exec, home, "/yes"), null);
  const r = await exec("python3", ["-c", 'import json,sys\nprint(json.load(open(sys.argv[1])).get("projects",{}).get(sys.argv[2],{}).get("hasTrustDialogAccepted") is True)', `${home}/.claude-alt/.claude.json`, "/yes"]);
  assert.ok(!r.stdout.includes("secret"));
});

test("orchestrators come from both Herdrs by their names", () => {
  const found = foundOrchestrators([{ name: "orch-atlas", address: "t1", cwd: "/r/atlas", state: "live", status: "working" }, { name: "orch-gone", address: "t2", state: "exited" }, { name: "other", address: "t3", state: "live" }], [{ name: "orch-b", pane: "w:p1", cwd: "/r/b", status: "idle" }]);
  assert.deepEqual(found.map((o) => [o.where, o.project]), [["app", "atlas"], ["terminal", "b"]]);
});

test("an orchestrator named by the adapter is found by its label", () => {
  const found = foundOrchestrators([{ name: null, labels: { "orchi.name": "orch-cedar" }, address: "t3d", cwd: "/r/d", state: "live", status: "working" }], []);
  assert.deepEqual(found.map((o) => [o.name, o.project, o.address]), [["orch-cedar", "cedar", "t3d"]]);
});

test("a finished run that has stopped isn't running", () => {
  const done = "## atlas-1 DONE 2026-10-30 09:00\n";
  assert.equal(finishedRun("idle", done), true);
  assert.equal(finishedRun("done", done), true);
  assert.equal(finishedRun("working", done), false);
  assert.equal(finishedRun("idle", "## atlas-1 UPDATE 2026-10-30 09:00\n"), false);
});

test("a bad agent list reads as none", async () => {
  assert.deepEqual(await terminalAgents(async () => ({ code: 1, stdout: "" })), []);
  assert.deepEqual(await terminalAgents(async () => { throw new Error("no herdr"); }), []);
  assert.deepEqual(await terminalAgents(async () => ({ code: 0, stdout: "not json" })), []);
});

test("the empty world has what a first render reads", () => {
  const world = emptyWorld();
  assert.equal(world.holder.where, null);
  assert.deepEqual(world.sessions, []);
  assert.equal(world.busy.size, 0);
});

const ROOT = "/h/.claude-alt/switchboard";
const ORCHI = { claude_dir: "~/.claude-alt" };
const files = (extra) => ({
  [`${ROOT}/state.md`]: "## watching\nb /r/b t2\n## started\n## paused\natlas\n",
  [`${ROOT}/lock`]: '{"terminal": "t7", "herdr": "app", "started": "2026-10-30 22:00"}',
  [`${ROOT}/planning/s1.json`]: JSON.stringify({ session: "s1", created: "2026-10-30 22:00", tickets: [{ id: "ENG-1", project: "atlas", repo: "/r/atlas" }], choices: { after: "wait" } }),
  ...extra,
});
const standIn = (text, live = [], listing = "s1.json\ns1.md\nbad name.json\nnotes.txt\n") => ({
  home: () => "/h", orchi: ORCHI, exec: async () => ({ code: 0, stdout: listing }), agents: async () => [],
  readTextFile: async (path) => text[path] ?? null, terminals: () => live,
});

test("loadWorld finds a live planner by its label", async () => {
  const live = [{ address: "t9", state: "live", where: "Atlas / Plan ENG-1", labels: { "orchi.session": "s1", "orchi.plan": "s1", "herdr.tab": "tb1" } }];
  const world = await loadWorld(standIn(files({ [`${ROOT}/planning/s1.md`]: "" }), live));
  assert.equal(world.sessions.length, 1);
  assert.equal(world.sessions[0].phase, "Planning");
  assert.deepEqual(world.sessions[0].planner, { address: "t9", where: "Atlas / Plan ENG-1", tab: "tb1" });
  assert.deepEqual(world.sessions[0].tickets, ["linear:ENG-1"]);
});

test("loadWorld ignores a planner's old session once it's gone", async () => {
  const world = await loadWorld(standIn(files({ [`${ROOT}/planning/s1.md`]: "" })));
  assert.deepEqual(world.sessions, []);
});

test("loadWorld reads the repos of a started session, and paused projects", async () => {
  const board = "## s1-p1 PLAN 2026-10-30 22:40\nProject: atlas\nRepo: /r/atlas\nTickets: ENG-1\n## s1-started STARTED 2026-10-30 23:00\n";
  const world = await loadWorld(standIn(files({ [`${ROOT}/planning/s1.md`]: board, "/r/atlas/.legwork/fanout-state.md": "Progress: 1/3\n" })));
  assert.equal(world.sessions[0].phase, "Paused");
  assert.deepEqual(world.sessions[0].runs[0].progress, { done: 1, total: 3 });
});

test("loadWorld marks repos with an orchestrator, and leaves out a finished one", async () => {
  const live = [
    { name: "orch-atlas", address: "t1", cwd: "/r/atlas", state: "live", status: "working" },
    { name: "orch-c", address: "t3", cwd: "/r/c", state: "live", status: "idle" },
  ];
  const world = await loadWorld(standIn(files({ "/r/c/.legwork/switchboard.md": "## c-1 DONE 2026-10-30 09:00\n" }), live));
  assert.deepEqual([...world.busy].sort(), ["/r/atlas", "/r/b"]);
});

test("loadWorld reads the lock for who holds the switchboard", async () => {
  const world = await loadWorld(standIn(files({}), [{ address: "t7", state: "live" }]));
  assert.deepEqual(world.holder, { where: "app", terminal: "t7" });
});

test("loadWorld with nothing on disk is empty, not an error", async () => {
  const world = await loadWorld({ home: () => "/h", exec: async () => ({ code: 1, stdout: "" }), agents: async () => [], readTextFile: async () => { throw new Error("no file"); }, terminals: () => { throw new Error("none"); } });
  assert.deepEqual(world.sessions, []);
  assert.equal(world.holder.where, null);
  assert.equal(world.busy.size, 0);
  assert.equal(world.held.size, 0);
  assert.equal(world.requested.run.size, 0);
});

test("loadWorld reads holds and waiting starts, and removes a hold that has let go", async () => {
  const listings = { [`${ROOT}/holds`]: "s1.json\ns9.json\n", [`${ROOT}/requests`]: "1-a.req\n2-b.req\n", [`${ROOT}/planning`]: "s1.json\ns1.md\n" };
  const text = files({
    [`${ROOT}/planning/s1.md`]: "",
    [`${ROOT}/holds/s1.json`]: JSON.stringify({ session: "s1", repos: ["/r/atlas"], at: 29 * 60000 }),
    [`${ROOT}/holds/s9.json`]: JSON.stringify({ session: "s9", repos: ["/r/z"], at: 0 }),
    [`${ROOT}/requests/1-a.req`]: "run b\n", [`${ROOT}/requests/2-b.req`]: "pause atlas\n",
  });
  const calls = [];
  const io = {
    home: () => "/h", orchi: ORCHI, now: () => 30 * 60000, agents: async () => [], terminals: () => [], discarded: () => [],
    exec: async (cmd, args) => { calls.push([cmd, ...args]); return cmd === "ls" ? { code: 0, stdout: listings[args[1]] ?? "" } : { code: 0, stdout: "" }; },
    readTextFile: async (path) => text[path] ?? null,
  };
  const world = await loadWorld(io);
  assert.deepEqual([...world.held], [["/r/atlas", "s1"]]);
  assert.deepEqual([...world.requested.run], ["b"]);
  assert.deepEqual(calls.filter((c) => c[0] === "rm"), [["rm", "-f", `${ROOT}/holds/s9.json`]]);
});

test("a question on a planner's board shows as Needs you", async () => {
  const live = [{ address: "t9", state: "live", labels: { "orchi.session": "s1" } }];
  const world = await loadWorld(standIn(files({ [`${ROOT}/planning/s1.md`]: "## plan-1 DECISION 2026-10-30 22:30\nUncertain: which?\n" }), live));
  assert.equal(world.sessions[0].phase, "Needs you");
  assert.equal(openItems("## plan-1 DECISION 2026-10-30 22:30\nUncertain: which?\n").length, 1);
});

test("a finished run counts as stopped whatever a pane that isn't in a turn reports", () => {
  const board = "## atlas-1 DONE 2026-10-31 20:00\nFinished.\n";
  for (const status of ["done", "idle", "unknown", undefined, null]) assert.equal(finishedRun(status, board), true, String(status));
  for (const status of ["working", "blocked"]) assert.equal(finishedRun(status, board), false, status);
  assert.equal(finishedRun("idle", "## atlas-1 UPDATE 2026-10-31 20:00\nStill going.\n"), false);
});
