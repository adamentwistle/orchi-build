// Pure readers for the files orchi writes. No Herdr imports, so `node --test` can load this file.
// Not anchored at the end: a heading may carry more, such as "Replaces atlas-6" (as switchboard-wait reads it).
const HEADING = /^## (\S+) ([A-Z]+) (\d{4}-\d{2}-\d{2} \d{2}:\d{2})(.*)$/;
const UPDATES = 4;
export const field = (lines, name) => lines.find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? null;

export function parseEntries(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    const m = HEADING.exec(line);
    if (m) entries.push({ id: m[1], kind: m[2], time: m[3], rest: m[4], lines: [] });
    else if (entries.length) entries[entries.length - 1].lines.push(line);
  }
  return entries;
}

// "Replaces atlas-1", "Replaces atlas-1, atlas-2" or "Replaces atlas-1 and atlas-2". switchboard-wait takes only the first id;
// the writer means all of them, so all of them close.
const ID = "[A-Za-z][\\w]*-\\d+";
const LIST = new RegExp(`Replaces (${ID}(?:(?:,\\s*|\\s+and\\s+|\\s*&\\s*)${ID})*)`);
const idsIn = (text) => LIST.exec(text)?.[1].match(new RegExp(ID, "g")) ?? [];

// Ids an entry replaces: on its heading, or on a line that starts with "Replaces". Never mid-sentence.
function replaces(entry) {
  return [...idsIn(entry.rest), ...entry.lines.filter((l) => l.startsWith("Replaces ")).flatMap(idsIn)];
}

// An entry is closed by a line "ANSWERED <id>" (a colon, a space or the end of the line after the id),
// or by a later entry that replaces it.
function closedIds(entries, text) {
  const closed = new Set([...text.matchAll(/^ANSWERED (\S+?)(?::|\s|$)/gm)].map((m) => m[1]));
  entries.forEach((e, i) => { for (const id of replaces(e)) if (entries.slice(0, i).some((p) => p.id === id)) closed.add(id); });
  return closed;
}

// Code marks read as noise in a panel. A `Run:` line keeps them, because it's pasted as written.
const plain = (value) => value?.replaceAll("`", "") ?? null;

function options(value) {
  if (!value) return [];
  return [...value.matchAll(/([A-Z])\)\s*(.*?)(?=\s+[A-Z]\)\s|$)/g)].map((m) => ({ key: m[1], label: plain(m[2]).trim() }));
}

export function openItems(text) {
  const entries = parseEntries(text), closed = closedIds(entries, text);
  return entries
    .filter((e) => ["DECISION", "ACTION"].includes(e.kind) && !closed.has(e.id))
    .map((e) => ({
      id: e.id, kind: e.kind, time: e.time,
      question: plain(field(e.lines, "Uncertain")),
      options: options(field(e.lines, "Options")),
      recommendation: field(e.lines, "Recommendation")?.match(/^[A-Z]\b/)?.[0] ?? null,
      why: plain(field(e.lines, "Why")), doing: plain(field(e.lines, "Do")), place: plain(field(e.lines, "Where")), run: field(e.lines, "Run"),
      blocks: plain(field(e.lines, "Blocks")),
    }));
}

// Closed DECISION entries with the answer given, for the Planning card.
export function answeredItems(text) {
  const entries = parseEntries(text).filter((e) => e.kind === "DECISION");
  const answers = new Map([...text.matchAll(/^ANSWERED (\S+?)(?::\s*(.*?))?(?:\s+\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\))?\s*$/gm)].map((m) => [m[1], m[2] ?? ""]));
  return entries.filter((e) => answers.has(e.id)).map((e) => ({ id: e.id, question: field(e.lines, "Uncertain"), answer: answers.get(e.id) }));
}

// Open items on the boards of running sessions, oldest first. `owners` maps a board to its session,
// `{ name, terminal?, address?, pane?, where? }`. `terminal` marks a planner, whose questions it answers itself.
// `address` is an app terminal to jump to, and `pane` and `where` are what a reply is relayed to. `finished` marks a
// finished run, which only keeps its actions: a question it left open no longer holds anything up.
// Anything else is from a session that has stopped: it's counted, so nothing vanishes unsaid.
export function liveDecisions(boards, owners) {
  const decisions = [];
  let hidden = 0;
  for (const [repo, text] of boards) {
    const open = openItems(text), owner = owners.get(repo);
    const items = owner?.finished ? open.filter((item) => item.kind === "ACTION") : open;
    hidden += open.length - items.length;
    if (owner) {
      decisions.push(...items.map((item) => ({
        ...item, orch: owner.name, terminal: owner.terminal ?? null, board: repo, planner: Boolean(owner.terminal),
        address: owner.address ?? owner.terminal ?? null, pane: owner.pane ?? owner.terminal ?? null, where: owner.where ?? (owner.terminal ? "app" : null),
      })));
    } else hidden += items.length;
  }
  return { decisions: decisions.sort((a, b) => a.time.localeCompare(b.time)), hidden };
}

export function latestKind(text) {
  const entries = parseEntries(text);
  return entries.length ? entries[entries.length - 1].kind : null;
}

export function parseState(text) {
  const state = { watching: [], started: {}, paused: [] };
  let section = null;
  for (const line of text.split("\n")) {
    const heading = /^## (\S+)/.exec(line);
    if (heading) { section = heading[1]; continue; }
    const parts = line.trim().split(/\s+/);
    if (!parts[0]) continue;
    if (section === "watching" && parts.length === 3) state.watching.push({ project: parts[0], repo: parts[1], pane: parts[2] });
    if (section === "started") state.started[parts[0]] = parts.slice(1).join(" ");
    if (section === "paused") state.paused.push(parts[0]);
  }
  return state;
}

export function parseProgress(text) {
  const m = /^Progress: (\d+)\/(\d+)\s*$/m.exec(text);
  return m ? { done: Number(m[1]), total: Number(m[2]) } : null;
}

const title = (word) => word[0].toUpperCase() + word.slice(1);

// A PR cell may be written "65" or "#65". The number is kept bare, so "#" isn't drawn twice and a link can use it.
const prNumber = (cell) => String(cell ?? "").replace(/^#+\s*/, "");

export function parseItems(text) {
  const rows = text.split("\n").filter((l) => l.startsWith("|")).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  const head = rows.findIndex((r) => r.includes("slug"));
  if (head < 0) return [];
  const at = (name) => rows[head].indexOf(name);
  return rows.slice(head + 2).map((r) => {
    const [model, effort] = (r[at("model")] ?? "-").split(/\s+/);
    const plain = (v) => (v && v !== "-" ? v : null);
    return { slug: r[at("slug")], route: r[at("route")], model: plain(model) && title(model), effort: effort ?? null, state: r[at("state")], pr: plain(prNumber(r[at("PR")])) };
  });
}

// What the board says about a run since it started: its last few UPDATEs, newest first, when anything last landed,
// and how many calls the orchestrator made alone.
export function boardActivity(text, since) {
  const entries = parseEntries(text).filter((e) => !since || e.time >= since);
  const updates = entries.filter((e) => e.kind === "UPDATE").slice(-UPDATES).reverse()
    .map((e) => ({ time: e.time, text: plain(e.lines.map((l) => l.trim()).filter(Boolean).join(" ")) }));
  return { lastAt: entries.at(-1)?.time ?? null, decided: entries.filter((e) => e.kind === "DECIDED").length, updates };
}

// "Sonnet 5.5 high" from the status line, or null. The last one on the screen is the current one.
export function parseModel(screen) {
  const m = [...screen.matchAll(/model:\W*([A-Za-z][\w.\s]*?)\W+-\W+(\w+)\W+context:/g)].at(-1);
  return m ? `${m[1].replace(/\s+/g, " ")} ${m[2]}` : null;
}

export function parseContext(screen) {
  // The last status line on the screen is the current one.
  const all = [...screen.matchAll(/context:\D*?([\d.]+)%/g)];
  return all.length ? Number(all.at(-1)[1]) : null;
}

// "12m", "3h" or "2d" since a local `YYYY-MM-DD HH:MM` stamp, or null when it doesn't read.
export function ageOf(stamp, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(stamp ?? "");
  if (!m) return null;
  const minutes = Math.max(0, Math.floor((now - new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime()) / 60000));
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d`;
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h` : `${minutes}m`;
}

// Which list a worker row belongs in. A live fw-<slug> terminal means running, whatever the table says.
// Otherwise a closed or kept pane, or a merged or done state, means completed; a state of running or
// a located pane ("pane wGZ:p1") means running. "queued", a route of "-" and a bare "pane" are queued.
export function workerPhase(item, liveNames) {
  if (liveNames?.has(`fw-${item.slug}`)) return "running";
  const route = item.route ?? "";
  if (/^pane\s+closed\b/.test(route) || /^pane\s+\S+\s+kept\b/.test(route)) return "completed";
  if (/\b(merged|done)\b/i.test(item.state ?? "")) return "completed";
  // A subagent has no terminal to find, so its state is all there is.
  if (/\brunning\b/i.test(item.state ?? "")) return "running";
  if (/^pane\s+[^\s]+/.test(route)) return "running";
  return item.pr ? "completed" : "queued";
}

// `o.pending` is "pausing" or "resuming" while the switchboard works on it, and outranks everything else.
export function orchestratorStatus(o) {
  if (o.pending === "pausing") return ["Pausing", "working"];
  if (o.pending === "resuming") return ["Resuming", "working"];
  if (o.paused) return ["Paused", "dim"];
  if (o.waiting) return ["Waiting on you", "blocked"];
  if (o.status === "blocked") return ["Needs you", "blocked"];
  if (o.status === "working") return ["Running", "working"];
  if (o.status === "done") return ["Finished", "done"];
  return ["Idle", "dim"];
}

// The agents in `herdr agent list` output. A reply that does not parse is an empty list.
export function parseAgentList(text) {
  try {
    return (JSON.parse(text)?.result?.agents ?? []).map((a) => ({
      name: a.title ?? a.terminal_title_stripped ?? "", cwd: a.cwd, pane: a.pane_id, status: a.agent_status,
    }));
  } catch { return []; }
}
