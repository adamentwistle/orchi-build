// What the panel asks `orchi tickets`, and what it makes of the answers. `orchi tickets` is the only thing that reads or
// writes a ticket, so the panel calls no source itself. No Herdr imports, so `node --test` can load this file.
import { isRef, parseRef } from "./refs.js";
import { SOURCES } from "./settings.js";

// `uv tool install` puts orchi in ~/.local/bin. The app starts with a bare PATH, so that comes first.
export const orchiPath = (home) => [`${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");

// What `/usr/bin/env` runs: every value its own argument, and a reference only as orchi tickets writes it.
const run = (home, ...args) => [`PATH=${orchiPath(home)}`, "orchi", "tickets", ...args];
const STATE = /^[^\u0000-\u001f\u007f-\u009f-][^\u0000-\u001f\u007f-\u009f]{0,79}$/;

export const listArgv = (home) => run(home, "--json");
export const showArgv = (home, ref) => (isRef(ref) ? run(home, "show", ref, "--json") : null);
export const statesArgv = (home, ref) => (isRef(ref) && parseRef(ref).source === "linear" ? run(home, "states", ref, "--json") : null);

// A Linear status change. The press is the yes, and the state was picked from the team's list, so an earlier one counts.
export function moveArgv(home, ref, state) {
  const name = typeof state === "string" ? state.trim() : "";
  if (!isRef(ref) || parseRef(ref).source !== "linear" || !STATE.test(name)) return null;
  return run(home, "move", ref, name, "--back", "--yes", "--json");
}

const text = (v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const json = (raw) => { try { return JSON.parse(raw); } catch { return undefined; } };

// One ticket as orchi tickets gives it, or null when it isn't that shape. Text fields are text, whatever came.
function ticketOf(t) {
  if (!t || typeof t !== "object" || !isRef(t.ref)) return null;
  const ref = parseRef(t.ref);
  if (t.source !== ref.source) return null;
  return {
    ref: ref.ref, source: ref.source, id: ref.id, title: text(t.title), state: text(t.state), open: t.open !== false,
    url: typeof t.url === "string" ? t.url : null, updated: typeof t.updated === "string" ? t.updated : null,
    project: typeof t.project === "string" ? t.project : null,
    labels: Array.isArray(t.labels) ? t.labels.filter((l) => typeof l === "string") : [],
    body: typeof t.body === "string" ? t.body : null,
  };
}

const BAD = "orchi tickets gave an answer the panel can't read";

// `orchi tickets --json`: every chosen source's open tickets, a line for each source that had a problem, and the
// sources it read. It exits 1 when a source had a problem, and still prints the others.
export function parseList(raw) {
  const answer = json(raw);
  if (!answer || typeof answer !== "object" || !Array.isArray(answer.tickets)) throw new Error(BAD);
  return {
    tickets: answer.tickets.map(ticketOf).filter(Boolean),
    problems: (Array.isArray(answer.problems) ? answer.problems : []).map((p) => `${text(p?.source)}: ${text(p?.message)}`),
    failed: SOURCES.filter((s) => Array.isArray(answer.problems) && answer.problems.some((p) => p?.source === s)),
    sources: SOURCES.filter((s) => Array.isArray(answer.sources) && answer.sources.includes(s)),
  };
}

export const parseShow = (raw) => ticketOf(json(raw));

// A Linear ticket's state and its team's states, in board order.
export function parseStates(raw) {
  const answer = json(raw);
  if (!answer || !Array.isArray(answer.states)) return null;
  const states = answer.states.filter((s) => typeof s?.name === "string").map((s) => ({ name: s.name, type: text(s.type) }));
  return { state: text(answer.state), states };
}

const firstLine = (t) => String(t ?? "").trim().split("\n")[0];

// Why a run failed, in one line.
export function failure(r) {
  if (r?.code === 127 || /orchi: No such file/.test(r?.stderr ?? "")) return "orchi isn't installed";
  return firstLine(r?.stderr) || "orchi tickets failed";
}

// How long the panel waits on a call before it gives up, or null for no limit. A move is never given up on: the wait
// can't stop the process, so a second press could write while the first still might. orchi's own requests time out.
export const READ_LIMIT_MS = 60000;
export const limitFor = (argv) => (argv?.[3] === "move" ? null : READ_LIMIT_MS);

// Why a move made nothing, in one line: the change that failed, else the problem orchi named, else its own line.
export function moveFailure(r) {
  const answer = json(r?.stdout);
  const failed = Array.isArray(answer?.changes) ? answer.changes.find((c) => c?.status === "failed" && c.error) : null;
  if (failed) return text(failed.error);
  if (Array.isArray(answer?.problems) && answer.problems.length) return text(answer.problems[0]);
  return failure(r);
}

// `exec` has no timeout, so the work is raced against `sleep(ms)`.
export async function withTimeout(start, ms, sleep, what) {
  let timedOut = false;
  const timer = sleep(ms).then(() => { timedOut = true; throw new Error(`${what} didn't answer in ${Math.round(ms / 1000)} s`); });
  timer.catch(() => {});
  const work = start();
  work.catch(() => {});
  return Promise.race([work, timer]).catch((e) => { throw timedOut ? new Error(`${what} didn't answer in ${Math.round(ms / 1000)} s`) : e; });
}

// One answer counts per key, such as `body <ref>`: the one asked for last. An older one that comes back late is dropped.
export class Latest {
  constructor() { this.asked = new Map(); }
  begin(key) { const n = (this.asked.get(key) ?? 0) + 1; this.asked.set(key, n); return n; }
  current(key, n) { return this.asked.get(key) === n; }
}
