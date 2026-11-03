// Works out who is in a herd and what each of them is doing. No Herdr imports, so `node --test` can load this file.
// Nothing here reads a clock: `now` comes in, in ms.
import { awake } from "./poll.js";
import { bigModels, contextPercent } from "./usage.js";

const CLAUDE = "claude-code";
const MAX_DEPTH = 6;
const QUIET_MS = 3 * 60000;
const MODEL_NAME = /^claude-([a-z]+)-(\d+)-(\d+)/;

// hc can only name a terminal when it starts one, so bin/herdr-adapter keeps the other names in a label.
export const terminalName = (t) => t?.name ?? t?.labels?.["orchi.name"] ?? "";
export const shortName = (name) => String(name ?? "").replace(/^(fw|orch)-/, "");
const title = (word) => word[0].toUpperCase() + word.slice(1);
const present = (v) => (v && v !== "-" ? v : null);

// An ended terminal that was restarted in place under the same name gives way to the one that took its place: a live one,
// or else the newest. Everyone else is kept by their own address, so two unnamed sessions, or two live terminals that
// share a name, are two rows.
function superseded(t, siblings) {
  const name = terminalName(t);
  if (!name || t.state === "live") return false;
  const same = siblings.filter((o) => terminalName(o) === name);
  return same.some((o) => o.state === "live") || same.at(-1) !== t;
}

// Everyone under `root`, parents first. Each entry keeps the terminal it came from.
export function subtree(list, root) {
  const kids = new Map(), out = [], walked = new Set([root]);
  for (const t of list) {
    if (!t.parent) continue;
    if (!kids.has(t.parent)) kids.set(t.parent, []);
    kids.get(t.parent).push(t);
  }
  const walk = (address, depth) => {
    if (depth > MAX_DEPTH) return;
    const siblings = kids.get(address) ?? [];
    for (const t of siblings) {
      if (walked.has(t.address) || superseded(t, siblings)) continue;
      walked.add(t.address);
      out.push({ address: t.address, name: terminalName(t) || t.agent || t.address, parent: address, depth, live: t.state === "live", agent: t.agent === CLAUDE });
      walk(t.address, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

// The panel follows the session in view: the focused pane if it's one, otherwise the first in the focused pane's tab.
export function sessionOf(panes) {
  const local = (p) => p.app === CLAUDE && p.terminal && !p.terminal.includes("/");
  const here = panes.find((p) => p.focused);
  if (!here) return null;
  return (local(here) ? here : panes.find((p) => p.tab === here.tab && local(p)))?.terminal ?? null;
}

// Whoever is focused, the herd is shown from its top.
export function rootOf(list, address) {
  const byAddress = new Map(list.map((t) => [t.address, t])), seen = new Set();
  let at = byAddress.get(address);
  while (at?.parent && byAddress.has(at.parent) && !seen.has(at.address)) { seen.add(at.address); at = byAddress.get(at.parent); }
  return at ?? null;
}

// "claude-opus-5-5" into "Opus 5.5". Anything else stays as it came, so "sonnet" becomes "Sonnet".
export function modelName(id) {
  if (!id) return null;
  const m = MODEL_NAME.exec(id);
  return m ? `${title(m[1])} ${m[2]}.${m[3]}` : title(String(id));
}

// What `--model` and `--effort` said when a session started.
export function argOf(argv, flag) {
  const i = (argv ?? []).indexOf(flag);
  return i >= 0 ? argv[i + 1] ?? null : null;
}

// The table of `.legwork/fanout-state.md` and its `Progress:` line.
export function parseFanout(text) {
  const rows = text.split("\n").filter((l) => l.startsWith("|")).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  const head = rows.findIndex((r) => r.includes("slug"));
  const at = (name) => (head < 0 ? -1 : rows[head].indexOf(name));
  const items = head < 0 ? [] : rows.slice(head + 2).filter((r) => present(r[at("slug")])).map((r) => {
    const slug = r[at("slug")], m = /^(.*?)\s*\(item (\w+)\)\s*$/i.exec(slug);
    return { slug, name: m ? m[1] : slug, item: m ? m[2] : null, route: r[at("route")] ?? "", state: present(r[at("state")]) ?? "" };
  });
  const progress = /^Progress: (\d+)\/(\d+)\s*$/m.exec(text);
  return { items, progress: progress ? { done: Number(progress[1]), total: Number(progress[2]) } : null };
}

const itemLabel = (name) => name.replace(/^\d+-/, "").replace(/-/g, " ");
const itemDone = (item) => /\b(merged|done)\b/i.test(item.state) || /\bclosed\b/.test(item.route);

// Which plan item a row is doing, by its name, by the plan's route, or by a subagent's description naming it.
function itemOf(items, row) {
  const name = shortName(row.name);
  return items.find((i) => i.name === name || i.slug === name || new RegExp(`(^|\\s)fw-${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(i.route))
    ?? (row.kind === "subagent" ? items.find((i) => i.item && new RegExp(`\\bitem ${i.item}\\b`, "i").test(row.name)) : undefined)
    ?? null;
}

// One point on the orbit per plan item, in plan order, then one per worker the plan doesn't name.
export function slotsOf(items, rows) {
  const direct = rows.filter((r) => r.depth === 1 && r.kind !== "process");
  const taken = new Map();
  for (const row of direct) {
    const item = itemOf(items, row);
    if (item && (!taken.has(item) || row.state !== "finished")) taken.set(item, row);
  }
  const claimed = new Set(taken.values());
  const slots = items.map((item) => {
    const row = taken.get(item);
    return {
      key: row?.key ?? `item:${item.slug}`, label: itemLabel(item.name), row: row ?? null,
      state: row ? row.state : itemDone(item) ? "finished" : /\brunning\b/i.test(item.state) ? "idle" : "queued",
    };
  });
  for (const row of direct) {
    if (!claimed.has(row) && row.kind === "worker" && row.state !== "finished") slots.push({ key: row.key, label: shortName(row.name), row, state: row.state });
  }
  return slots;
}

export const openTool = (events) => (events ?? []).findLast((e) => e[2] == null)?.[1] ?? null;

// How long a working session has shown no sign of life, or 0. A tool that's running is a sign of life, and time the
// machine spent asleep, in `gaps`, isn't quiet.
export function quietFor(row, now, gaps) {
  if (row.state !== "working" || row.last == null || openTool(row.events)) return 0;
  const gap = awake(row.last, now, gaps);
  return gap >= QUIET_MS ? gap : 0;
}

const stateOf = (fact, live) => {
  if (!live) return "finished";
  const s = fact?.status?.state;
  return s === "working" || s === "blocked" ? s : fact?.status ? "idle" : "running";
};

const blockedFirst = (a, b) => (b.state === "blocked") - (a.state === "blocked");

// The transcript names the model but not whether it was asked for with the large window, which `--model` does.
const withModel = (context, asked) => (context && /\[1m\]/i.test(asked ?? "") ? { ...context, model: `${context.model}[1m]` } : context);

// A subagent ends when its meta file says `finished`. One from a transcript before a /clear, or one that crashed or was
// stopped, never gets it, so it has ended once its session isn't the current one.
export const subagentEnded = (a) => a.finished === true || a.current === false;

// `reply` is what herd.py printed. `facts` holds `hc get` for each terminal, by address. `gaps` are the stretches the
// panel's clock saw the machine asleep, `[from, to]` in ms.
export function buildHerd({ root, nodes, facts, reply, fanout, now, gaps = [] }) {
  const sessions = reply ?? {};
  // A model seen past 200k anywhere in the herd has the large window everywhere, as the sidebar counts it.
  const big = bigModels(Object.values(sessions).flatMap((s) => [s?.context, ...(s?.agents ?? []).map((a) => a.context)]));
  const rowFor = (node) => {
    const fact = facts[node.address], session = sessions[node.address];
    const kind = node.depth === 0 ? "root" : node.agent ? "worker" : "process";
    return {
      key: node.address, address: node.address, parent: node.parent ?? null, kind, depth: node.depth, name: kind === "root" ? node.name : shortName(node.name),
      state: stateOf(fact, node.live), status: typeof fact?.status?.msg === "string" ? fact.status.msg : null,
      started: fact?.created_ms ?? null, ended: fact?.finished_ms ?? null,
      model: modelName(session?.model) ?? modelName(argOf(fact?.foreground?.argv, "--model")), effort: argOf(fact?.foreground?.argv, "--effort"),
      size: session?.size ?? 0, last: session?.last ?? null, events: session?.events ?? [], failed: Boolean(fact?.exit_code),
      command: kind === "process" ? (fact?.foreground?.argv ?? fact?.argv ?? []).join(" ").slice(0, 200) : null,
      turn: session?.turn ?? null, context: kind === "process" ? null : contextPercent(withModel(session?.context, argOf(fact?.foreground?.argv, "--model")), big),
    };
  };
  const subagentRows = (owner, session) => (session?.agents ?? []).map((a) => {
    const ended = subagentEnded(a);
    return {
      key: `sub:${a.id}`, address: null, parent: owner.key, kind: "subagent", depth: owner.depth + 1, name: a.task,
      state: ended ? "finished" : "working", status: null, type: a.type, started: a.started, ended: ended ? a.last : null,
      model: modelName(a.model), effort: a.effort, size: 0, last: a.last, events: ended ? [] : a.events ?? [], command: null,
      turn: null, context: ended ? null : contextPercent(a.context, big),
    };
  });

  const rootRow = rowFor({ ...root, depth: 0 });
  rootRow.started = sessions[root.address]?.first ?? rootRow.started;
  rootRow.title = nodes.length ? "Orchestrator" : "This session";
  const all = [rootRow, ...subagentRows(rootRow, sessions[root.address])];
  for (const node of nodes) { const row = rowFor(node); all.push(row, ...subagentRows(row, sessions[node.address])); }
  for (const row of all) { row.quiet = quietFor(row, now, gaps); row.title ??= row.name; }

  // Parents first, with anyone blocked at the top of their group. Someone whose parent has ended still shows.
  const going = all.filter((r) => r.state !== "finished"), ordered = [];
  const add = (row) => {
    ordered.push(row);
    for (const kid of going.filter((r) => r.parent === row.key).sort(blockedFirst)) add(kid);
  };
  if (rootRow.state !== "finished") add(rootRow);
  for (const row of going) if (!ordered.includes(row)) ordered.push(row);

  // Each worker with everything under it, so a row can fold them away. Whoever has no worker above them stands alone.
  const byKey = new Map(ordered.map((r) => [r.key, r]));
  const isTop = (r) => r.kind === "root" || (r.kind === "worker" && r.depth === 1);
  const groups = new Map(ordered.filter(isTop).map((r) => [r.key, { row: r, kids: [] }]));
  for (const row of ordered) {
    if (isTop(row)) continue;
    let up = byKey.get(row.parent);
    while (up && !isTop(up)) up = byKey.get(up.parent);
    if (up) groups.get(up.key).kids.push(row);
    else groups.set(row.key, { row, kids: [] });
  }

  // A plan file outlives its run, so it only counts for an orchestrator, or once someone here is doing one of its items.
  const listed = fanout?.items ?? [];
  const planned = /^orch-/.test(rootRow.name) || all.some((r) => r.depth === 1 && r.kind !== "process" && itemOf(listed, r));
  const items = planned ? listed : [];
  const slots = slotsOf(items, all);
  const counted = slots.filter((s) => s.state === "finished").length;
  // Every agent still going counts, this session among them, so a session on its own reads 1 running, not 0.
  const agentsGoing = ordered.filter((r) => r.kind !== "process");
  return {
    running: agentsGoing.length,
    // This session, when it's the only agent going, so the map can say what it's doing.
    solo: agentsGoing.length === 1 && agentsGoing[0] === rootRow ? rootRow : null,
    name: rootRow.name,
    started: rootRow.started,
    done: planned ? fanout?.progress?.done ?? counted : 0,
    total: planned ? fanout?.progress?.total ?? items.length : 0,
    rows: ordered,
    groups: [...groups.values()],
    finished: all.filter((r) => r.state === "finished").sort((a, b) => (b.ended ?? 0) - (a.ended ?? 0)),
    slots,
    gaps,
    // Nothing here will change again, so there's no need to keep reading.
    over: rootRow.state === "finished" && all.every((r) => r.state === "finished"),
  };
}
