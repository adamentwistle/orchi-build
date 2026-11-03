// The sessions Go starts: briefs and boards under the switchboard's planning folder, their phases, and the rules that
// stop a start. No Herdr imports, so `node --test` can load this file. `mods/linear` and `mods/orchi` carry the same copy.
import { parseEntries, field, openItems, answeredItems, latestKind, parseState, parseProgress, parseAgentList, parseItems } from "./parse.js";
import { NAME, parseLock, holderOf, planningDir, switchboardDir } from "./switchboard.js";
import { claudeDir } from "./settings.js";
import { linearKey } from "./refs.js";


export const ABSOLUTE = /^\/[^\u0000-\u001f\u007f-\u009f]*$/;
const HUMAN = /^(Human action, not a Claude session\.|DECISION NEEDED)/;
const FINISHED_MS = 24 * 3600 * 1000;
const READY_GRACE_MS = 10 * 60 * 1000;
const HOLD_GRACE_MS = 10 * 60 * 1000;
const START_LINE = /^(start|run) ([\w-]+)$/;

const pad = (n) => String(n).padStart(2, "0");

// The local `YYYY-MM-DD HH:MM` every file here uses.
export const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toMs = (time) => new Date((time ?? "").replace(" ", "T")).getTime();

// The brief Go wrote, or null. Ids and paths are checked here, because they build paths and requests later. A ticket is
// a Linear reference, held as its bare key.
export function parseBrief(text, session) {
  let brief;
  try { brief = JSON.parse(text); } catch { return null; }
  if (brief?.session !== session || !Array.isArray(brief.tickets)) return null;
  const seen = new Set();
  const tickets = brief.tickets.filter((t) => linearKey(t?.id) && NAME.test(t?.project ?? "") && ABSOLUTE.test(t?.repo ?? ""))
    .map((t) => ({ ...t, id: linearKey(t.id) })).filter((t) => !seen.has(t.id) && seen.add(t.id));
  return { session, created: String(brief.created ?? ""), tickets, after: brief.choices?.after === "wait" ? "wait" : "start", choices: brief.choices ?? null };
}

// A planner reads ticket text and writes this board, so what it says is shape-checked as well.
function planEntry(entry) {
  const project = /^(?:.*\/)?([\w-]+?)(?:\.md)?$/.exec(field(entry.lines, "Project") ?? "")?.[1], repo = field(entry.lines, "Repo");
  if (!NAME.test(project ?? "") || !ABSOLUTE.test(repo ?? "")) return null;
  const tickets = (field(entry.lines, "Tickets") ?? "").split(",").map(linearKey).filter(Boolean);
  return { project, repo, tickets: [...new Set(tickets)] };
}

export function parseBoard(text) {
  const entries = parseEntries(text);
  const last = (kind) => entries.filter((e) => e.kind === kind).at(-1)?.time ?? null;
  return {
    plans: entries.filter((e) => e.kind === "PLAN").map(planEntry).filter(Boolean),
    ready: last("READY"), kept: last("KEPT"), started: last("STARTED"),
    open: openItems(text), answered: answeredItems(text),
  };
}

// A board may end with no newline, so a new heading starts on its own line.
export const appendEntry = (text, id, kind, time) => `${text}${text && !text.endsWith("\n") ? "\n" : ""}## ${id} ${kind} ${time}\n`;

// One project's run since its session started. A repo's board and fanout state can hold an older run, so anything
// from before `since` doesn't count. `prs` are the workers with a pull request: the slug and the PR cell as written.
export function repoRun(boardText, fanoutText, since) {
  const latest = parseEntries(boardText).filter((e) => e.time >= since).at(-1);
  const fanoutStart = /\(started (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(fanoutText)?.[1] ?? null;
  const older = Boolean(fanoutStart && fanoutStart < since);
  return {
    done: latest?.kind === "DONE", doneAt: latest?.kind === "DONE" ? latest.time : null,
    open: openItems(boardText).filter((i) => i.time >= since).length,
    progress: older ? null : parseProgress(fanoutText),
    prs: older ? [] : parseItems(fanoutText).filter((i) => i.slug && i.pr).map((i) => ({ slug: i.slug, pr: i.pr })),
  };
}

const tasksDone = (run) => Boolean(run.progress?.total) && run.progress.done >= run.progress.total;

// The first that holds wins, in the order the build contract gives. A board nobody is working on, with no READY, is no
// session at all. A question on a planner's board counts only while that planner runs, as it does in Decisions.
export function sessionPhase({ board, planner, runs, paused }) {
  const started = Boolean(board.started);
  if (started && runs.length && runs.every((r) => r.done)) return "Finished";
  if (started && runs.length && runs.every((r) => r.done || tasksDone(r))) return "Pull requests open";
  if (started && runs.some((r) => paused.includes(r.project))) return "Paused";
  if ((planner && board.open.length) || runs.some((r) => r.open > 0)) return "Needs you";
  if (started) return "Running";
  if (board.ready || board.kept) return "Planned";
  return planner ? "Planning" : null;
}

const DOTS = { "Needs you": "blocked", Planning: "working", Running: "working", "Pull requests open": "done", Finished: "done" };

function detailOf(s) {
  const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (s.phase === "Needs you") return `${count(s.board.open.length + s.runs.reduce((n, r) => n + r.open, 0), "open question")}. Press to open it.`;
  if (s.phase === "Planned") return s.board.kept ? "Kept for later" : "Plan ready";
  if (s.phase === "Planning") return s.board.answered.length ? `${count(s.board.answered.length, "question")} answered` : "Reading the tickets";
  if (s.phase === "Paused") return "Paused at a safe point";
  if (s.phase === "Pull requests open") return "All tasks done";
  if (s.phase === "Finished") return "Run finished";
  const known = s.runs.filter((r) => r.progress);
  if (!known.length) return "Orchestrators running";
  return `${known.reduce((n, r) => n + r.progress.done, 0)} of ${known.reduce((n, r) => n + r.progress.total, 0)} tasks done`;
}

const whereOf = (s) => (s.board.started ? s.board.plans.map((p) => `orch-${p.project}`).join(", ") : s.planner?.where ?? "Planning");

// "12m", "3h 05m" since a stamp, or "" when it doesn't read.
export function elapsed(since, now) {
  const ms = now - toMs(since);
  if (!(ms >= 0)) return "";
  const minutes = Math.floor(ms / 60000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

// In Herdr's rows, Needs you first, then newest. A finished run drops out a day after it ended, and a discarded
// plan at once.
export function sessionRows(sessions, now, discarded = []) {
  const gone = (s) => discarded.includes(s.session) || (s.phase === "Finished" && now - Math.max(...s.runs.map((r) => toMs(r.doneAt))) > FINISHED_MS);
  const rows = sessions.filter((s) => !gone(s)).map((s) => ({ ...s, dot: DOTS[s.phase] ?? "dim", where: whereOf(s), time: elapsed(s.created, now), detail: detailOf(s) }));
  return rows.sort((a, b) => (b.phase === "Needs you") - (a.phase === "Needs you") || b.created.localeCompare(a.created));
}

// Ticket ID to the row holding it. A finished run no longer holds its tickets.
export function ticketSessions(rows) {
  return new Map(rows.filter((r) => r.phase !== "Finished").flatMap((r) => r.tickets.map((id) => [id, r])));
}

// A plan set to start by itself has gone to the switchboard, so offering Start would risk a second start. It's offered
// only if that handover hasn't shown up after a while.
export function planReady(s, now) {
  if (s.phase !== "Planned" || s.board.kept || !s.board.ready) return false;
  return s.after === "wait" || now - toMs(s.board.ready) > READY_GRACE_MS;
}

export const keptPlan = (s) => s.phase === "Planned" && Boolean(s.board.kept);

async function readSessions(io, state, live) {
  const dir = planningDir(io.orchi, io.home());
  const text = (path) => io.readTextFile(path).then((t) => t ?? "").catch(() => "");
  const listed = await io.exec("ls", ["-1", dir]).catch(() => null);
  const names = (listed?.code === 0 ? listed.stdout.split("\n") : []).map((n) => /^([\w-]+)\.json$/.exec(n)?.[1]).filter(Boolean);
  const sessions = await Promise.all(names.map(async (session) => {
    const brief = parseBrief(await text(`${dir}/${session}.json`), session);
    if (!brief) return null;
    const board = parseBoard(await text(`${dir}/${session}.md`));
    const terminal = live.find((t) => t.state === "live" && t.labels?.["orchi.session"] === session);
    const planner = terminal ? { address: terminal.address, where: terminal.where ?? null, tab: terminal.labels["herdr.tab"] ?? null } : null;
    const runs = !board.started ? [] : await Promise.all(board.plans.map(async (p) => {
      const [repoBoard, fanout] = await Promise.all([text(`${p.repo}/.legwork/switchboard.md`), text(`${p.repo}/.legwork/fanout-state.md`)]);
      return { ...p, ...repoRun(repoBoard, fanout, board.started) };
    }));
    const phase = sessionPhase({ board, planner, runs, paused: state.paused });
    return phase ? { session, created: brief.created, after: brief.after, tickets: brief.tickets.map((t) => t.id), board, planner, runs, phase } : null;
  }));
  return sessions.filter(Boolean);
}

// hc can only name a terminal when it starts one, so bin/herdr-adapter keeps the other names in a label.
export const terminalName = (t) => t.name ?? t.labels?.["orchi.name"] ?? "";

// Orchestrators in the app and in terminal Herdr, by their `orch-<project>` names.
export function foundOrchestrators(live, agents) {
  const app = live.filter((t) => t.state === "live" && terminalName(t).startsWith("orch-"))
    .map((t) => ({ where: "app", name: terminalName(t), project: terminalName(t).slice(5), address: t.address, cwd: t.cwd, status: t.status }));
  const terminal = agents.filter((a) => a.name.startsWith("orch-"))
    .map((a) => ({ where: "terminal", name: a.name, project: a.name.slice(5), pane: a.pane, cwd: a.cwd, status: a.status }));
  return [...app, ...terminal];
}

// Anything but a live turn counts as stopped: a session that has exited leaves a shell, which reports neither idle nor done.
export const finishedRun = (status, board) => latestKind(board) === "DONE" && status !== "working" && status !== "blocked";

// Repos an orchestrator is working on. Each has one `.legwork/switchboard.md` and one `.legwork/fanout-state.md`, so a
// second run would overwrite them. A finished run that has stopped doesn't count, and a watched repo always does,
// because a pane loses its name when Claude Code restarts in it.
async function busyRepos(io, found, state) {
  const repos = new Set(state.watching.map((w) => w.repo));
  await Promise.all(found.map(async (o) => {
    const repo = state.watching.find((w) => w.project === o.project)?.repo ?? o.cwd;
    if (!repo) return;
    const board = await io.readTextFile(`${repo}/.legwork/switchboard.md`).catch(() => null);
    if (!finishedRun(o.status, board ?? "")) repos.add(repo);
  }));
  return repos;
}

export async function terminalAgents(exec) {
  const r = await exec("herdr", ["agent", "list"]).catch(() => null);
  return r?.code === 0 ? parseAgentList(r.stdout) : [];
}

// ---- holds and waiting requests ----

// Go holds each repo of its session from the press, before a planner or an orchestrator shows for it, so a second Go
// on that repo can't get through while the first is still planning. One file a session, naming its repos.
export const holdFile = (s, home, session) => `${switchboardDir(s, home)}/holds/${session}.json`;

export function parseHold(text, session) {
  let hold;
  try { hold = JSON.parse(text); } catch { return null; }
  if (hold?.session !== session || !Array.isArray(hold.repos) || typeof hold.at !== "number") return null;
  return { session, repos: hold.repos.filter((r) => typeof r === "string" && ABSOLUTE.test(r)), at: hold.at };
}

export async function writeHold(io, session, repos) {
  if (!NAME.test(session ?? "")) throw new Error("That session's name can't be a file name");
  await io.exec("mkdir", ["-p", `${switchboardDir(io.orchi, io.home())}/holds`]);
  await io.writeTextFile(holdFile(io.orchi, io.home(), session), `${JSON.stringify({ session, repos: repos.filter((r) => ABSOLUTE.test(r ?? "")), at: io.now() })}\n`, null);
}

export async function removeHold(io, session) {
  if (NAME.test(session ?? "")) await io.exec("rm", ["-f", holdFile(io.orchi, io.home(), session)]).catch(() => null);
}

// A hold lasts until its session has finished, meaning every run wrote its DONE, or it's discarded. A session that never
// showed, such as a planner that didn't start, lets go after a grace period. `held` maps a repo to the session holding
// it, and `stale` names the holds that have let go.
export function heldRepos(holds, sessions, discarded, now) {
  const held = new Map(), stale = [];
  for (const h of holds) {
    const s = sessions.find((x) => x.session === h.session);
    const live = !discarded.includes(h.session) && (s ? s.phase !== "Finished" : now - h.at < HOLD_GRACE_MS);
    if (!live) { stale.push(h.session); continue; }
    for (const repo of h.repos) if (!held.has(repo)) held.set(repo, h.session);
  }
  return { held, stale };
}

// `start <session>` and `run <project>` lines still waiting in requests/. The switchboard deletes a request once it has
// acted on it, so these are starts asked for and not yet begun.
export function waitingStarts(lines) {
  const requested = { start: new Set(), run: new Set() };
  for (const line of lines) {
    const m = START_LINE.exec(String(line ?? "").trim());
    if (m) requested[m[1]].add(m[2]);
  }
  return requested;
}

async function listed(io, dir, pattern) {
  const r = await io.exec("ls", ["-1", dir]).catch(() => null);
  return (r?.code === 0 ? r.stdout.split("\n") : []).map((n) => pattern.exec(n)?.[1]).filter(Boolean);
}

async function readHolds(io) {
  const dir = `${switchboardDir(io.orchi, io.home())}/holds`;
  const names = await listed(io, dir, /^([\w-]+)\.json$/);
  const holds = await Promise.all(names.map(async (session) => parseHold((await io.readTextFile(`${dir}/${session}.json`).catch(() => null)) ?? "", session)));
  return holds.filter(Boolean);
}

async function readRequests(io) {
  const dir = `${switchboardDir(io.orchi, io.home())}/requests`;
  const names = await listed(io, dir, /^([\w-]+)\.req$/);
  return waitingStarts(await Promise.all(names.map(async (n) => (await io.readTextFile(`${dir}/${n}.req`).catch(() => null)) ?? "")));
}

export const emptyWorld = () => ({
  state: parseState(""), live: [], agents: [], holder: { where: null, terminal: null }, found: [], sessions: [], busy: new Set(),
  held: new Map(), requested: { start: new Set(), run: new Set() },
});

// What both panels read about running work. `io` holds the Herdr calls, so `node --test` can pass stand-ins.
// `io.discarded()`, where a panel passes it, is the shared list of discarded sessions.
export async function loadWorld(io) {
  const root = switchboardDir(io.orchi, io.home());
  const [stateText, lockText, agents] = await Promise.all([
    io.readTextFile(`${root}/state.md`).catch(() => null), io.readTextFile(`${root}/lock`).catch(() => null), io.agents(),
  ]);
  const state = parseState(stateText ?? "");
  const live = (() => { try { return io.terminals(); } catch { return []; } })();
  const found = foundOrchestrators(live, agents);
  const [sessions, busy, holds, requested] = await Promise.all([readSessions(io, state, live), busyRepos(io, found, state), readHolds(io), readRequests(io)]);
  const discarded = (() => { try { return io.discarded?.() ?? []; } catch { return []; } })();
  const { held, stale } = heldRepos(holds, sessions, Array.isArray(discarded) ? discarded : [], io.now?.() ?? Date.now());
  await Promise.all(stale.map((session) => removeHold(io, session)));
  return { state, live, agents, holder: holderOf(parseLock(lockText ?? ""), live, agents), found, sessions, busy, held, requested };
}

const TRUST = `import json,sys
print(json.load(open(sys.argv[1])).get("projects",{}).get(sys.argv[2],{}).get("hasTrustDialogAccepted") is True)`;

// Claude Code's own config file: in the profile folder Orchi's settings name, or ~/.claude.json for the default profile.
export const trustFile = (s, home) => (typeof s?.claude_dir === "string" && s.claude_dir.trim() ? `${claudeDir(s, home)}/.claude.json` : `${home}/.claude.json`);

// The one flag for this folder. The file holds account details, so it's read in a process that prints only that
// flag, and the panel never holds any of it. True or false, or null when it couldn't be read. `s` is Orchi's settings.
export async function folderTrust(exec, home, folder, s) {
  const r = await exec("python3", ["-c", TRUST, trustFile(s, home), folder]).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() === "True" : null;
}

export async function trustOf(exec, home, folders, s) {
  return Object.fromEntries(await Promise.all([...new Set(folders)].map(async (folder) => [folder, await folderTrust(exec, home, folder, s)])));
}

// Why this project can't take a run now. `trust` maps a folder to `folderTrust`'s answer, and a folder not yet asked
// about stops a start until it has been. Nothing answers the trust question for the user. `held` maps a repo to the session
// holding it, and `own` is the session asking, whose own hold doesn't count. `requested` holds starts still waiting on
// the switchboard.
export function projectProblems(project, { folderOf, busy = new Set(), trust = null, held = new Map(), own = null, requested = null }) {
  const name = project.name ?? project.file;
  if (!project.repo) return [`${name} has no repo`];
  const folder = folderOf(project), problems = [];
  if (project.blocked_on) problems.push(`${name} is blocked`);
  if (HUMAN.test((project.prompt ?? "").trimStart())) problems.push(`${name}'s next prompt needs you first`);
  if (busy.has(folder)) problems.push(`An orchestrator is working on ${name}'s repo`);
  else if (held.has(folder) && held.get(folder) !== own) problems.push(`Another session holds ${name}'s repo until it's done or discarded`);
  if (project.file && requested?.run?.has(project.file)) problems.push(`A start for ${name} is waiting on the switchboard`);
  if (trust) problems.push(...folderProblem(trust, folder, `${name}'s folder`));
  return problems;
}

export function folderProblem(trust, folder, label) {
  if (trust[folder] === undefined) return [`Checking ${label}`];
  if (trust[folder] === null) return [`Could not check ${label}`];
  return trust[folder] ? [] : [`Claude Code hasn't been trusted in ${label}. Open it there first`];
}

// Go's rules again for a plan that's about to start. Its own tickets don't count against it.
export function keptProblems(s, projectOf, rows, context) {
  const others = ticketSessions(rows.filter((r) => r.session !== s.session));
  const taken = s.tickets.filter((id) => others.has(id)).map((id) => `${id} is already in a session`);
  if (context.requested?.start?.has(s.session)) taken.push("This plan's start is waiting on the switchboard");
  if (!s.board.plans.length) return [...taken, "This plan names no projects"];
  return [...taken, ...s.board.plans.flatMap((p) => projectProblems(projectOf(p.project) ?? { file: p.project, repo: p.repo }, { ...context, own: s.session }))];
}
