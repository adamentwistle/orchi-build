// The rules behind Mark complete and Stop on an orchestrator's card. No Herdr imports, so `node --test` can load this file.
import { openItems, parseEntries } from "./parse.js";

// How long a run's board has to be still before Mark complete is offered. An orchestrator waiting on the user is idle too,
// so idle alone doesn't mean the run has gone quiet.
export const QUIET_MS = 15 * 60 * 1000;

const toMs = (time) => new Date(String(time ?? "").replace(" ", "T")).getTime();
const busy = (status) => status === "working" || status === "blocked";

// Minutes since a board stamp, or null for none.
const minutesSince = (time, now) => (Number.isFinite(toMs(time)) ? Math.max(0, Math.floor((now - toMs(time)) / 60000)) : null);

const nameOf = (t) => t.name ?? t.labels?.["orchi.name"] ?? "";

// The `fw-<slug>` names of the run's workers that are live now: a live terminal in the app, or an agent in terminal
// Herdr. `slugs` come from the run's fanout state.
export function liveWorkers(live, agents, slugs) {
  const names = new Set([...live.filter((t) => t.state === "live").map(nameOf), ...agents.map((a) => a.name)]);
  return [...new Set(slugs)].map((s) => `fw-${s}`).filter((n) => names.has(n));
}

const workersLine = (names) => (names.length === 1 ? `${names[0]} is still running` : `${names.length} workers are still running (${names.join(", ")})`);

// Whether the card offers Mark complete: not in a turn, no worker live, nothing open for the user, not paused or pausing,
// and nothing on its board for QUIET_MS. A run that has written nothing since it started counts from its start.
export function completeOffered(o, now) {
  if (busy(o.status) || o.liveWorkers?.length || o.waiting || o.paused || o.pending) return false;
  const last = o.activity?.lastAt ?? o.started ?? null;
  const ms = toMs(last);
  return !Number.isFinite(ms) || now - ms >= QUIET_MS;
}

// The same rule on fresh data at the press, as one reason, or null when it can go ahead. `board` is the repo's
// switchboard file as it is now, `status` the terminal's status now, and `workers` its live workers now.
export function completeProblem({ board, status, paused, workers = [] }, now) {
  if (busy(status)) return "It's working again, so it wasn't marked complete";
  if (workers.length) return `${workersLine(workers)}, so it wasn't marked complete`;
  if (paused) return "It's paused, so it wasn't marked complete. Play it, or Stop it";
  const open = openItems(board ?? "");
  if (open.length) return `${open[0].kind === "ACTION" ? "An action" : "A question"} is open on its board (${open[0].id}), so it wasn't marked complete`;
  const last = parseEntries(board ?? "").at(-1)?.time ?? null, minutes = minutesSince(last, now);
  if (minutes != null && minutes * 60000 < QUIET_MS) return `It wrote to its board ${minutes === 0 ? "just now" : `${minutes}m ago`}, so it wasn't marked complete`;
  return null;
}

// What Stop ends, from the terminal list read at the press: the orchestrator's terminal by its name, and the live
// `fw-<slug>` terminal of each worker in its fanout state. Nothing from an earlier load.
export function stopTargets(live, name, slugs) {
  const alive = live.filter((t) => t.state === "live");
  const wanted = new Set(slugs.map((s) => `fw-${s}`));
  const workers = alive.filter((t) => wanted.has(nameOf(t))).map((t) => ({ name: nameOf(t), address: t.address }));
  const own = alive.find((t) => nameOf(t) === name);
  return [...workers, ...(own ? [{ name, address: own.address }] : [])].filter((t) => t.address);
}

const firstLine = (text) => String(text ?? "").trim().split("\n")[0];

// One line naming every kill that failed, or null when all went. `results` pairs a target with its `hc kill` reply
// or the error it threw.
export function killFailures(results) {
  const failed = results.filter((r) => r.error || r.reply?.code !== 0).map((r) => {
    const why = r.error ? String(r.error.message ?? r.error) : firstLine(r.reply?.stderr) || firstLine(r.reply?.stdout) || `exit ${r.reply?.code}`;
    return `${r.target.name} (${r.target.address}): ${why}`;
  });
  return failed.length ? `Stop couldn't end ${failed.length === 1 ? "a terminal" : `${failed.length} terminals`}. ${failed.join("; ")}` : null;
}
