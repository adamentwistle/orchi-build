// What the progress pane shows, worked out from the files an orchestrator keeps and the subagents Claude Code lists.
// No Herdr imports, so `node --test` can load this file. Nothing here reads a clock: `now` comes in, in ms.
import { awake } from "./poll.js";

const HEADING = /^## (\S+) ([A-Z]+) (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/;
const STARTED = /\(started (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/;
const MINUTE = 60000;
const LONG = 1.25;

const title = (word) => word[0].toUpperCase() + word.slice(1);
const present = (v) => (v && v !== "-" ? v : null);
const toMs = (stamp) => { const ms = new Date(String(stamp).replace(" ", "T")).getTime(); return Number.isNaN(ms) ? null : ms; };

// "r13-tracking (item 1)" into its name and item.
function slugParts(slug) {
  const m = /^(.*?)\s*\(item (\w+)\)\s*$/i.exec(slug);
  return m ? { name: m[1], item: m[2] } : { name: slug, item: null };
}

// The table of `.legwork/fanout-state.md`, its heading and its `Progress:` line.
export function parseFanout(text) {
  const rows = text.split("\n").filter((l) => l.startsWith("|")).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  const head = rows.findIndex((r) => r.includes("slug"));
  const at = (name) => (head < 0 ? -1 : rows[head].indexOf(name));
  const items = head < 0 ? [] : rows.slice(head + 2).filter((r) => present(r[at("slug")])).map((r) => {
    const [model, effort] = (r[at("model")] ?? "-").split(/\s+/);
    return { slug: r[at("slug")], ...slugParts(r[at("slug")]), route: r[at("route")] ?? "", model: present(model) && title(model), effort: effort ?? null, state: present(r[at("state")]) ?? "", pr: present(r[at("PR")]) };
  });
  const progress = /^Progress: (\d+)\/(\d+)\s*$/m.exec(text);
  const heading = /^# fanout-state:\s*(.*)$/m.exec(text)?.[1] ?? "";
  return {
    title: /,\s*([^,(]+?)\s*(?:\(|$)/.exec(heading)?.[1] ?? null,
    started: toMs(STARTED.exec(text)?.[1]),
    progress: progress ? { done: Number(progress[1]), total: Number(progress[2]) } : null,
    items,
  };
}

// The newest UPDATE on a switchboard board, as `{ time, text }`, or null.
export function latestUpdate(board) {
  let found = null, reading = false;
  for (const line of board.split("\n")) {
    const m = HEADING.exec(line);
    if (m) { reading = m[2] === "UPDATE"; if (reading) found = { time: toMs(m[3]), text: "" }; continue; }
    if (reading && line.trim()) found.text = found.text ? `${found.text} ${line.trim()}` : line.trim();
  }
  return found?.text ? found : null;
}

// Which list a plan row belongs in. A live worker means active, whatever the table says. Otherwise a closed or kept pane,
// or a merged or done state, means done. State text `running` means active: a subagent row has no pane to show it.
export function planPhase(item, live) {
  if (live) return "active";
  const route = item.route ?? "", state = item.state ?? "";
  if (/^pane\s+closed\b/.test(route) || /^pane\s+\S+\s+kept\b/.test(route)) return "done";
  if (/\b(merged|done)\b/i.test(state)) return "done";
  if (/\brunning\b/i.test(state)) return "active";
  if (/^pane\s+[^\s]+/.test(route)) return "active";
  return item.pr ? "done" : "waiting";
}

const agentModel = (a) => {
  if (a.type === "codex") return "Codex";
  return a.model && a.model !== "inherit" ? title(a.model) : null;
};

// An agent from a session cleared part way has stopped, whatever its file says.
export const agentActive = (a, records) => (a.current && !a.finished) || records?.[a.id]?.state === "working";

const matches = (item, a) => (item.item != null && new RegExp(`\\bitem ${item.item}\\b`, "i").test(a.task)) || a.task.includes(item.name);

// One row per task, from the plan first, then anything running that the plan doesn't name. `workers` are fw- terminals,
// `{ slug, address, started, ended, live }`.
export function buildRows({ items, agents, workers, records }) {
  const used = new Set(), usedWorkers = new Set();
  const rows = items.map((item) => {
    const mine = agents.filter((a) => !used.has(a.id) && matches(item, a));
    mine.forEach((a) => used.add(a.id));
    const worker = workers.find((w) => w.slug === item.slug || w.slug === item.name);
    if (worker) usedWorkers.add(worker.slug);
    const active = mine.some((a) => agentActive(a, records)) || Boolean(worker?.live);
    const phase = planPhase(item, active);
    const started = Math.min(...mine.map((a) => a.started), worker?.started ?? Infinity);
    const ended = Math.max(...mine.map((a) => a.last), worker?.ended ?? 0);
    return {
      key: `plan:${item.slug}`, title: mine[0]?.task ?? item.name, state: item.state, phase, pr: item.pr,
      model: item.model ?? (mine[0] ? agentModel(mine[0]) : null), effort: item.effort ?? mine[0]?.effort ?? null,
      via: worker || /^pane\b/.test(item.route) ? "pane" : "subagent", address: worker?.address ?? null,
      started: Number.isFinite(started) ? started : null, ended: ended > 0 && phase === "done" ? ended : null, planned: true,
    };
  });
  for (const a of agents) {
    if (used.has(a.id)) continue;
    const active = agentActive(a, records);
    rows.push({ key: `agent:${a.id}`, title: a.task, state: "", phase: active ? "active" : "done", pr: null, model: agentModel(a), effort: a.effort, via: "subagent", address: null, started: a.started, ended: active ? null : a.last, planned: false, lastSeen: a.last });
  }
  for (const w of workers) {
    if (usedWorkers.has(w.slug)) continue;
    rows.push({ key: `worker:${w.slug}`, title: w.slug, state: "", phase: w.live ? "active" : "done", pr: null, model: null, effort: null, via: "pane", address: w.address, started: w.started, ended: w.live ? null : w.ended, planned: false });
  }
  return rows;
}

// Longest running first, most recently finished first, then the plan's own order.
export function sortRows(rows) {
  const of = (phase) => rows.filter((r) => r.phase === phase);
  return {
    active: of("active").sort((a, b) => (a.started ?? Infinity) - (b.started ?? Infinity)),
    done: of("done").sort((a, b) => (b.ended ?? 0) - (a.ended ?? 0)),
    waiting: of("waiting"),
  };
}

// The plan's own count when it has one. With no plan, every task seen so far.
export function progressOf(plan, sorted) {
  const done = sorted.done.length, active = sorted.active.length;
  if (plan.progress) return { done: plan.progress.done, active: Math.min(sorted.active.filter((r) => r.planned).length, plan.progress.total - plan.progress.done), total: plan.progress.total };
  return { done, active, total: done + active + sorted.waiting.length };
}

const median = (values) => {
  const list = [...values].sort((a, b) => a - b), mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
};

// Only plan rows count. A reviewer or an Explore run isn't a task like the plan's, so it would pull the usual time down.
const finished = (rows) => rows.filter((r) => r.planned && r.started != null && r.ended != null && r.ended > r.started);

// How long a task like this has taken in this run, in ms: the median of finished plan tasks on the same model, else of
// all of them. Null when none has finished, so no estimate is shown. `gaps` are the stretches the pane's clock saw the
// machine asleep, `[from, to]`, and they don't count.
export function typicalMs(done, model, gaps) {
  const all = finished(done), same = all.filter((r) => r.model && r.model === model);
  const pool = same.length ? same : all;
  return pool.length ? median(pool.map((r) => awake(r.started, r.ended, gaps))) : null;
}

// `{ left, over }` for one active row, in ms, or null. `over` means it's well past the usual time. Just past it, it reads
// as nearly done, because one usual time is a rough guide.
export function rowEstimate(row, done, now, gaps) {
  const typical = typicalMs(done, row.model, gaps);
  if (typical == null || row.started == null) return null;
  const ran = awake(row.started, now, gaps), left = typical - ran;
  if (left > 0) return { left, over: false };
  return ran < typical * LONG ? { left: MINUTE, over: false } : { left: 0, over: true };
}

// Time left on the whole run, in ms, or null. Tasks not yet started share the workers running now.
export function runEstimate(sorted, now, gaps) {
  if (!finished(sorted.done).length) return null;
  const active = sorted.active.map((r) => rowEstimate(r, sorted.done, now, gaps)?.left ?? 0);
  const longest = active.length ? Math.max(...active) : 0;
  const waiting = sorted.waiting.reduce((sum, r) => sum + typicalMs(sorted.done, r.model, gaps), 0);
  return longest + waiting / Math.max(1, sorted.active.length);
}

// "<1m", "12m", "3h 5m" or "2d 15h".
export function duration(ms) {
  const minutes = Math.max(0, Math.floor(ms / MINUTE)), hours = Math.floor(minutes / 60);
  if (!minutes) return "<1m";
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

// Rounded so it doesn't look more exact than it is: to the minute up to 10, then to 5 minutes.
export function aboutLeft(ms) {
  const raw = Math.max(1, Math.round(ms / MINUTE)), minutes = raw <= 10 ? raw : Math.round(raw / 5) * 5;
  if (minutes < 60) return `about ${minutes} min`;
  const rest = minutes % 60;
  return rest ? `about ${Math.floor(minutes / 60)} h ${rest} min` : `about ${Math.floor(minutes / 60)} h`;
}

export function ageText(ms) {
  return ms < MINUTE ? "just now" : `${duration(ms)} ago`;
}
