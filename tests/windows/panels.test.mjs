// Checks for the Windows side of the Legwork (Linear) and Orchi panels. The Mac side is covered by tests/linear and
// tests/orchi, which pass no Windows flag and so take the Mac path on any machine.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProjects, projectFolder } from "../../mods/linear/legwork.js";
import { legworkMode, listedProjects, projectRow, projectRows } from "../../mods/linear/legwork-rows.js";
import { goPlan } from "../../mods/linear/go.js";
import { defaultSession, sessionProblems } from "../../mods/linear/review.js";
import { taskFor } from "../../mods/linear/task.js";
import { claudeArgv, psQuote, startClaude, windowsScript } from "../../mods/linear/launch.js";
import { ABSOLUTE, folderTrust, parseBrief, terminalAgents } from "../../mods/linear/sessions.js";
import { sendRequest, switchboardDir } from "../../mods/linear/switchboard.js";
import { orchiDir } from "../../mods/linear/settings.js";
import { copyText, finishRun, sendAnswer, windowsAnswer } from "../../mods/orchi/actions.js";
import { parseTracker, trackerProjects } from "../../mods/orchi/plans.js";

const PYTHON = process.platform === "win32" ? "python" : "python3";
const mod = (path) => fileURLToPath(new URL(`../../mods/${path}`, import.meta.url));
const same = (a, b) => assert.equal(readFileSync(mod(b), "utf8"), readFileSync(mod(a), "utf8"), `${b} should match ${a}`);
const HOSTILE = `a'b; rm "$x" $(whoami) \`id\` & | %PATH%`;
// Orchi's settings on a Windows machine: the profile folder and the checkout.
const SETTINGS = { claude_dir: "C:/Users/a/.claude-alt", orchi_dir: "D:/src/orchi-build" };

test("the panels' shared files are the same in every mod that carries them", () => {
  for (const f of ["sessions.js", "switchboard.js", "launch.js", "draft.js", "parse.js", "ui.js", "platform.js", "win.py"]) same(`linear/${f}`, `orchi/${f}`);
  same("claude-chat/draft.js", "linear/draft.js");
  same("claude-chat/platform.js", "linear/platform.js");
  same("claude-chat/win.py", "linear/win.py");
  same("linear-agent/task.js", "linear/task.js");
});

// A tracker on disk, read by win.py as the panels read it: one CRLF project, the template and a done project.
function tracker() {
  const dir = mkdtempSync(join(tmpdir(), "tracker-"));
  mkdirSync(join(dir, "projects"));
  writeFileSync(join(dir, "projects", "atlas.md"), "---\r\nname: atlas\r\ncategory: personal\r\nstatus: running\r\nrepo: D:\\src\\atlas\r\nupdated: 2026-10-21\r\n---\r\n\r\n## Next prompt\r\n\r\n```\r\nFollow the switchboard-protocol skill.\r\n/fanout atlas\r\n```\r\n");
  writeFileSync(join(dir, "projects", "_template.md"), "---\nname: Project Name\ncategory: personal\nstatus: queued\nrepo: ~/code/x\n---\n");
  writeFileSync(join(dir, "projects", "old.md"), "---\nname: old\ncategory: work\nstatus: done\nrepo: ~/Projects/old\n---\n");
  return execFileSync(PYTHON, ["-I", "-S", mod("linear/win.py"), "tracker", dir], { encoding: "utf8" });
}

test("win.py reads a tracker in the Mac's format, LF only, whatever the files' line endings", () => {
  const text = tracker();
  assert.equal(text.includes("\r"), false);
  const [template, atlas, old] = parseProjects(text);
  assert.deepEqual([template.file, atlas.file, old.file], ["_template", "atlas", "old"]);
  assert.equal(atlas.status, "running");
  assert.equal(atlas.updated, "2026-10-21");
  assert.equal(atlas.repo, "D:\\src\\atlas");
  assert.equal(atlas.prompt, "Follow the switchboard-protocol skill.\n/fanout atlas");
  assert.deepEqual(parseTracker(text).map((p) => p.file), ["_template", "atlas", "old"]);
});

test("Orchi lists every category on Windows and work only on the Mac, never the template", () => {
  const projects = parseTracker(tracker());
  assert.deepEqual(trackerProjects(projects, true).map((p) => p.file), ["atlas", "old"]);
  assert.deepEqual(trackerProjects(projects, false).map((p) => p.file), ["old"]);
});

test("the Legwork panel lists projects as rows shaped like tickets, filtered by category, without done or iceboxed ones", () => {
  const projects = parseProjects(tracker());
  assert.deepEqual(listedProjects(projects).map((p) => p.file), ["atlas"]);
  const [row] = projectRows(projects);
  assert.equal(row.identifier, "atlas");
  assert.equal(row.id, "lw:atlas");
  assert.equal(row.project, "Personal");
  assert.equal(row.state, "Running");
  assert.equal(row.stateType, "started");
  assert.equal(row.updatedAt, "2026-10-21T00:00:00");
  assert.equal(row.legwork, true);
  assert.equal(row.category, "personal");
  assert.deepEqual(projectRows([{ ...projects[1], status: "icebox", updated: null }]), []);
  assert.equal(projectRows([{ ...projects[1], status: "review" }])[0].state, "In review");
});

test("legwork mode is Windows with a legwork folder and no Linear key", () => {
  assert.equal(legworkMode({ legwork: { dir: "D:/l" }, apiKey: null }, true), true);
  assert.equal(legworkMode({ legwork: { dir: "D:/l" }, apiKey: "lin_x" }, true), false);
  assert.equal(legworkMode({ legwork: { dir: "/l" }, apiKey: null }, false), false);
  assert.equal(legworkMode({ legwork: null, apiKey: null }, true), false);
});

test("a Windows repo is a full path, and comes back with forward slashes", () => {
  for (const path of ["D:/src/x", "D:\\src\\x", "/Users/a/x"]) assert.equal(ABSOLUTE.test(path), true, path);
  for (const path of ["dev/x", "D:src", "~/x", "D:/a\nb"]) assert.equal(ABSOLUTE.test(path), false, path);
  assert.equal(projectFolder({ repo: "D:\\src\\atlas" }, "C:\\Users\\a"), "D:/src/atlas");
  assert.equal(projectFolder({ repo: "~/Projects/x" }, "C:\\Users\\a"), "C:/Users/a/Projects/x");
  assert.equal(projectFolder({ repo: "~/Projects/x" }, "/Users/a"), "/Users/a/Projects/x");
});

test("Go on legwork projects writes a brief that says so, and a task in fixed words", () => {
  const [row] = projectRows(parseProjects(tracker()));
  const project = { file: "atlas", name: "atlas", repo: "D:/src/atlas" };
  const plan = goPlan({ session: "s1", tickets: [row], projectOf: () => project, choices: defaultSession(), created: new Date(2026, 10, 1, 9, 0), home: "C:/Users/a", source: "legwork" });
  assert.equal(plan.brief.source, "legwork");
  assert.deepEqual(plan.brief.tickets, [{ id: "atlas", project: "atlas", repo: "D:/src/atlas" }]);
  assert.equal(plan.task, taskFor("s1", "legwork"));
  assert.ok(plan.task.startsWith("Follow the ticket-session skill for session s1. Its brief lists legwork projects"));
  assert.deepEqual(plan.labels, ["orchi.plan=s1", "orchi.session=s1", "orchi.tickets=atlas"]);
  // Without the legwork source a project's name isn't a ticket id, so nothing starts.
  assert.equal(goPlan({ session: "s1", tickets: [row], projectOf: () => project, choices: defaultSession(), created: new Date(), home: "C:/Users/a" }), null);
  assert.deepEqual(sessionProblems([row], () => ({ ...project, prompt: "" })), []);
});

test("a legwork brief reads back with its projects, and a Linear brief still refuses them", () => {
  const brief = (source) => JSON.stringify({ session: "s1", created: "2026-11-01 09:00", ...(source ? { source } : {}), tickets: [{ id: "atlas", project: "atlas", repo: "D:/src/atlas" }], choices: {} });
  assert.deepEqual(parseBrief(brief("legwork"), "s1").tickets.map((t) => t.id), ["atlas"]);
  assert.deepEqual(parseBrief(brief(null), "s1").tickets, []);
});

test("PowerShell words are single-quoted with quotes doubled, so hostile text stays one argument", () => {
  assert.equal(psQuote(HOSTILE), `'a''b; rm "$x" $(whoami) \`id\` & | %PATH%'`);
  const script = windowsScript("C:\\Users\\a", claudeArgv("opus", "high", HOSTILE));
  assert.equal(script, "$env:HERDR_ENV = '1'; $env:DISABLE_AUTO_UPDATE = 'true'; $env:PATH = 'C:\\Users\\a\\.local\\libexec\\orchi-app;' + $env:PATH; "
    + `& 'claude' '--model' 'opus' '--effort' 'high' '${HOSTILE.replace(/'/g, "''")}'`);
});

test("a Windows start runs pwsh with that script, and waits with win.py between tab names", async () => {
  const calls = [];
  const io = {
    home: () => "C:\\Users\\a", windows: true, win: "W/win.py",
    exec: async (command, args) => { calls.push([command, ...args]); return calls.length < 3 ? { code: 1, stdout: "no tab" } : { code: 0, stdout: "{}" }; },
    hc: async (args) => { calls.push(["hc", ...args]); return { code: 0, stdout: '{"address":"t9"}' }; },
  };
  assert.equal(await startClaude(io, { model: "opus", effort: "high", task: HOSTILE, tab: "Plan", folder: "D:/src/x", space: "sp1", labels: ["orchi.plan=s1"] }), "t9");
  const run = calls[0], at = run.indexOf("--");
  assert.deepEqual(run.slice(at + 1, at + 5), ["pwsh.exe", "-NoLogo", "-NoExit", "-Command"]);
  assert.equal(run[at + 5], windowsScript("C:\\Users\\a", claudeArgv("opus", "high", HOSTILE)));
  assert.equal(run.length, at + 6);
  assert.deepEqual(calls[2], ["python", "-I", "-S", "W/win.py", "sleep", "0.25"]);
});

test("on Windows the switchboard and the checkout come from Orchi's settings, and folders come from win.py", async () => {
  assert.equal(switchboardDir(SETTINGS, "C:/Users/a"), "C:/Users/a/.claude-alt/switchboard");
  assert.equal(orchiDir(SETTINGS, "C:/Users/a"), "D:/src/orchi-build");
  const calls = [], writes = [];
  const io = {
    home: () => "C:/Users/a", now: () => 1000, random: () => "ab12", windows: true, win: "W/win.py", orchi: SETTINGS,
    exec: async (command, args) => { calls.push([command, ...args]); return { code: 0, stdout: "" }; },
    hc: async (args) => { calls.push(["hc", ...args]); return { code: 0, stdout: "" }; },
    readTextFile: async (path) => (path.endsWith("/lock") ? '{"terminal": "t7", "herdr": "app"}' : null),
    writeTextFile: async (path, text) => { writes.push([path, text]); return null; },
    terminals: () => [{ address: "t7", state: "live" }], spaces: () => [], agents: async () => [],
  };
  await sendRequest(io, "pause atlas", null);
  assert.ok(calls.some((c) => c.join(" ") === "python -I -S W/win.py mkdir C:/Users/a/.claude-alt/switchboard/requests"));
  assert.deepEqual(writes[0], ["C:/Users/a/.claude-alt/switchboard/requests/1000-ab12.req", "pause atlas\n"]);
});

test("trust on Windows is read from the profile in Orchi's settings with python, keyed by forward slashes", async () => {
  const calls = [];
  await folderTrust(async (command, args) => { calls.push([command, ...args]); return { code: 0, stdout: "True\n" }; }, "C:/Users/a", "D:\\src\\x", SETTINGS, true);
  assert.deepEqual([calls[0][0], calls[0][1], ...calls[0].slice(3)], ["python", "-c", "C:/Users/a/.claude-alt/.claude.json", "D:/src/x"]);
});

test("terminal Herdr isn't asked for agents on Windows", async () => {
  let asked = false;
  assert.deepEqual(await terminalAgents(async () => { asked = true; return { code: 0, stdout: "[]" }; }, true), []);
  assert.equal(asked, false);
});

test("Orchi's answers and finishes run switchboard-answer under python on Windows, every value its own argument", async () => {
  const calls = [];
  const exec = async (command, args) => { calls.push([command, ...args]); return { code: 0, stdout: "", stderr: "" }; };
  const d = { id: "plan-1", pane: "t7", board: "C:/Users/a/.claude-alt/switchboard/planning/s1.md", planner: true, orch: "plan-s1" };
  const script = windowsAnswer(SETTINGS, "C:/Users/a");
  assert.equal(script, "D:/src/orchi-build/bin/switchboard-answer");
  await sendAnswer(exec, "C:/Users/a", d, HOSTILE, SETTINGS, true);
  assert.deepEqual(calls[0], ["python", script, "--board", d.board, "t7", "plan-1", HOSTILE]);
  await finishRun(exec, "C:/Users/a", "D:/src/x", "Stopped by Adam from the Orchi panel.", SETTINGS, true);
  assert.deepEqual(calls[1], ["python", script, "--finish", "D:/src/x", "Stopped by Adam from the Orchi panel."]);
  await copyText(exec, HOSTILE, "W/win.py");
  assert.deepEqual(calls[2], ["python", "-I", "-S", "W/win.py", "copy-text", HOSTILE]);
});

test("the Legwork filters are All, Business, Work and Personal, and each project is its own card by name", async () => {
  const { LEGWORK_BUCKETS, counts, ticketGroups } = await import("../../mods/linear/queue.js");
  assert.deepEqual(LEGWORK_BUCKETS.map(([, label]) => label), ["All", "Business", "Work", "Personal"]);
  const rows = [
    projectRow({ file: "b", name: "Beta", category: "work", status: "queued" }),
    projectRow({ file: "a", name: "Alpha", category: "personal", status: "running" }),
    projectRow({ file: "c", name: "Gamma", category: "business", status: "review" }),
  ];
  assert.deepEqual(counts(rows), { all: 3, business: 1, work: 1, personal: 1 });
  const byName = (issue) => issue.title;
  assert.deepEqual(ticketGroups(rows, "all", byName).map((g) => g.label), ["Alpha", "Beta", "Gamma"]);
  assert.deepEqual(ticketGroups(rows, "work", byName).map((g) => g.label), ["Beta"]);
});
