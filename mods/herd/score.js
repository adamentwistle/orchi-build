// Turns tool calls into a coloured ribbon, says in a word what each agent is doing, and works out where things sit on the
// map. No Herdr imports, so `node --test` can load this file. Nothing here reads a clock: `now` comes in, in ms.
import { awake } from "./poll.js";

export const WINDOW_MS = 30 * 60000;
const MIN_NOTE = 2;
const FRESH_MS = 12000;
const HANDOFF_MS = 10000;
const HIT_PX = 4;

// One colour means one thing everywhere: on the map, the ribbons and the key.
const TOOL_TONE = { w: "write", b: "shell", r: "read", h: "wait", o: "tool", a: "mark", s: "mark" };
const TOOL_WORD = { w: "Writing", b: "Shell", r: "Reading", h: "Waiting", o: "Working", a: "Starting", s: "Skill" };
export const toneOf = (tool) => TOOL_TONE[tool] ?? "tool";

// An Agent call stays open for as long as a subagent it started in the foreground runs, so a long one is waiting on
// subagents, not a moment's mark.
const noteTone = (tool, length) => (tool === "a" && (length == null || length >= HANDOFF_MS) ? "wait" : toneOf(tool));

// [[started ms, tool, length ms or null while it runs], ...] into notes, in px from the left of a ribbon `width` wide.
export function notesOf(events, now, width, windowMs = WINDOW_MS) {
  const x = (t) => width * (1 - (now - t) / windowMs), notes = [];
  for (const [at, tool, length] of events ?? []) {
    const end = length == null ? now : Math.min(at + length, now);
    if (at > now || end < now - windowMs) continue;
    const from = Math.max(0, x(at));
    notes.push({ from, to: Math.max(from + MIN_NOTE, x(end)), tone: noteTone(tool, length), sounding: length == null || now - end < FRESH_MS });
  }
  return notes;
}

// Notes that share a colour are drawn as one path, so a busy ribbon stays one or two draws per colour.
export function groupNotes(notes) {
  const groups = new Map();
  for (const note of notes) {
    const key = `${note.tone}:${note.sounding ? 1 : 0}`;
    if (!groups.has(key)) groups.set(key, { tone: note.tone, sounding: note.sounding, notes: [] });
    groups.get(key).notes.push(note);
  }
  return [...groups.values()];
}

// The call at `x` px along a ribbon `width` wide, or the nearest within a few px, as `{ event, index }`, or null. It reads
// the scale the same way `notesOf` draws it.
export function eventAt(events, now, x, width, windowMs = WINDOW_MS) {
  const at = (t) => width * (1 - (now - t) / windowMs);
  let best = null;
  (events ?? []).forEach((event, index) => {
    const [start, , length] = event, end = length == null ? now : Math.min(start + length, now);
    if (start > now || end < now - windowMs) return;
    const from = Math.max(0, at(start)), to = Math.max(from + MIN_NOTE, at(end));
    const off = x < from ? from - x : x > to ? x - to : 0;
    if (off <= HIT_PX && (!best || off < best.off || (off === best.off && from > best.from))) best = { event, index, off, from };
  });
  return best && { event: best.event, index: best.index };
}

// How far along a ribbon `width` wide a press landed, in the app's own pixels, or null when the press has no position.
// A press's `local_position` and `bounds` are both window pixels, which the zoom scales, and `width` is the app's own,
// so the share of `bounds` the press is along carries over at any zoom.
export function pressOffset(localX, boundsWidth, width) {
  if (!Number.isFinite(localX) || !(boundsWidth > 0) || !(width > 0)) return null;
  return Math.max(0, Math.min(width, (localX / boundsWidth) * width));
}

// What an agent is doing, in a word, for how long, and the colour that goes with it. Time asleep, in `gaps`, isn't
// counted.
export function activityOf(row, now, gaps) {
  const say = (word, tone, since) => ({ word, tone, since: since == null ? null : awake(since, now, gaps) });
  if (row.state === "blocked") return say("Needs you", "blocked", null);
  if (row.kind === "process") return say("Running", "running", row.started);
  const open = (row.events ?? []).findLast((e) => e[2] == null);
  if (open?.[1] === "a") return say("Waiting", "wait", open[0]);
  if (open) return say(TOOL_WORD[open[1]] ?? "Working", toneOf(open[1]), open[0]);
  if (row.quiet) return { word: "Quiet", tone: "quiet", since: row.quiet };
  const last = (row.events ?? []).at(-1), ended = last ? last[0] + last[2] : row.last;
  if (row.state === "working") return say("Thinking", "think", ended);
  return say("Idle", "idle", ended);
}

const TWO_DIGITS = (n) => String(n).padStart(2, "0");

export function shortTime(ms) {
  const s = Math.max(0, Math.floor((ms ?? 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${TWO_DIGITS(m % 60)}m`;
}

const LABEL = 96;
const HUB_SHARE = 0.25;
const EDGE = 40;

export function geometry(size) {
  const centre = size / 2;
  return { size, centre, orbit: centre - EDGE, hub: Math.max(56, Math.round(size * HUB_SHARE)) };
}

// Where item `i` of `count` sits. The first is at twelve o'clock, then clockwise.
export function slotPoint(i, count, geo) {
  const angle = (i / Math.max(1, count)) * 2 * Math.PI - Math.PI / 2;
  return { x: geo.centre + geo.orbit * Math.cos(angle), y: geo.centre + geo.orbit * Math.sin(angle), angle };
}

// A node's width in px. It grows with the transcript, which stands in for how much work it has done.
export function nodeSize(bytes) {
  const mb = Math.max(0, bytes ?? 0) / (1024 * 1024);
  return Math.round(Math.max(20, Math.min(30, 20 + Math.sqrt(mb) * 4)));
}

// A label sits outside its node: above one in the top half, below one in the bottom half, never off the map.
export function labelSpot(point, node, geo) {
  const above = point.y < geo.centre - geo.orbit * 0.25;
  const left = Math.max(2, Math.min(geo.size - LABEL - 2, point.x - LABEL / 2));
  return { left, top: above ? point.y - node / 2 - 22 : point.y + node / 2 + 7, width: LABEL };
}

const ORBIT_MS = 40000;

// A moon goes round its parent. `now` turns it, and the pane moves it there smoothly once a second.
export function moonPoint(centre, radius, i, count, now) {
  const angle = (now / ORBIT_MS) * 2 * Math.PI + (i / Math.max(1, count)) * 2 * Math.PI;
  return { x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) };
}

const SAG_PX = 0.25;

// How many straight lines an arc needs to read as round: none strays more than a quarter of a pixel inside the circle.
// A fixed count drew the ring round the middle as a ten-sided shape, and a subagent's arc there as four sharp bends.
export function arcSteps(radius, from, to) {
  const span = Math.abs(to - from);
  if (!(radius > 0) || !(span > 0)) return 1;
  return Math.max(1, Math.ceil(span / (2 * Math.acos(Math.max(-1, 1 - SAG_PX / radius)))));
}

// Points along a circle from one angle to another, for drawing an arc as short straight lines.
export function arcPoints(cx, cy, radius, from, to, steps = arcSteps(radius, from, to)) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    points.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  return points;
}

const TOP = -Math.PI / 2;

// `count` equal arcs round a circle, as [from, to] in radians, each centred on the slot of the same number, so a
// segment of the ring round the hub points at its node. `gap` is the share of each arc left empty.
export function segments(count, gap) {
  const step = (2 * Math.PI) / Math.max(1, count), half = (step * (1 - gap)) / 2;
  return Array.from({ length: count }, (_, i) => [TOP + i * step - half, TOP + i * step + half]);
}

// The stretch of orbit from each slot to the next, as [from, to], stopping short of the nodes.
export function routeArcs(count, geo) {
  const step = (2 * Math.PI) / Math.max(1, count), clear = 14 / Math.max(1, geo.orbit);
  return Array.from({ length: count }, (_, i) => [TOP + i * step + clear, TOP + (i + 1) * step - clear]);
}

// A faint field of stars. The same seed always gives the same sky, so it doesn't shimmer between renders.
export function starField(size, count) {
  const stars = [];
  let v = 7;
  const next = () => { v = (v * 16807) % 2147483647; return v / 2147483647; };
  for (let i = 0; i < count; i++) stars.push({ x: next() * size, y: next() * size, bright: next() > 0.72 });
  return stars;
}

// The first `max` of a list, or when there are more, one fewer than that and how many are left over, so the last place
// can say "and N more".
export function capped(list, max) {
  if (list.length <= max) return { shown: list, more: 0 };
  return { shown: list.slice(0, max - 1), more: list.length - (max - 1) };
}

// Who hangs off each point on the map, and off the middle, as `[{ spot, kids }]`, with `spot` null for the middle. A
// subagent that has a point of its own, for the plan item it's doing, is drawn there and not round its parent as well.
export function hangersOf(groups, spots) {
  const keys = new Set(spots.map((s) => s.key)), out = [];
  for (const { row, kids } of groups) {
    const spot = spots.find((s) => s.key === row.key) ?? null;
    if (spot || row.kind === "root") out.push({ spot, kids: kids.filter((k) => !keys.has(k.key)) });
  }
  return out;
}

// Which spoke a call's spark runs along, as `{ node, inward }`, or null. A worker's call, or one by a subagent under
// it, comes in from the worker. The session's own calls go out to a node that's running. A subagent of the session has
// no spoke, and its arc round the middle is its mark, so its calls send none rather than flying out to some worker.
export function sparkPath(key, spots, groups) {
  const own = spots.find((s) => s.key === key);
  if (own) return { node: own, inward: true };
  const group = groups.find((g) => g.row.key === key || g.kids.some((k) => k.key === key));
  if (!group) return null;
  const owner = spots.find((s) => s.key === group.row.key);
  if (owner) return { node: owner, inward: true };
  if (group.row.kind !== "root" || group.row.key !== key) return null;
  const away = spots.find((s) => s.row && s.state !== "finished");
  return away ? { node: away, inward: false } : null;
}

// Tool calls newer than `since`, oldest first, at most `limit` of them, so a burst doesn't flood the map.
export function freshEvents(rows, since, limit) {
  const found = [];
  for (const row of rows) for (const [at, tool] of row.events ?? []) if (at > since) found.push({ key: row.key, at, tool });
  return found.sort((a, b) => a.at - b.at).slice(-limit);
}
