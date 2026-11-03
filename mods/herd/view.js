// Draws the Herd panel: who needs you, the map of the run, what the colours mean, then a row per agent saying what it's
// doing now, over a ribbon of its last 30 minutes. One colour means one thing everywhere.
// `view` is the panel's View. Colours come from `theme()` only. Everything from a file or a terminal is drawn as text.
// Only .transition, .spring, .loop and .spin animate here, so the motion runs natively between the once-a-second renders.
import { div, PathBuilder, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { settings } from "herdr";
import { WINDOW_MS, activityOf, arcPoints, capped, eventAt, geometry, groupNotes, hangersOf, labelSpot, moonPoint, nodeSize, notesOf, pressOffset, routeArcs, segments, shortTime, slotPoint, sparkPath, starField, toneOf } from "./score.js";
import { contextHigh, turnLine } from "./usage.js";
import { meterCells, meterTicks } from "./meters.js";

export const SLIDE = { duration: 240, easing: "ease-out" };
export const FLIGHT = { duration: 1200, easing: "ease-in-out" };
const GLIDE = { response: 420, damping: 0.9 };
const STEP = { duration: 1050, easing: "linear" };

const PADDING = 14, WELL = 8, WIDE = 700, MAP_MIN = 220, MAP_MAX = 340, MAP_MAX_WIDE = 460, MAX_SLOTS = 28, MOON = 7, HIT = 32, RIBBON = 9, THIN = 5;
const EFFORT = ["low", "medium", "high", "xhigh", "max"];
const KEY = [["think", "Thinking"], ["read", "Reading"], ["write", "Writing"], ["shell", "Shell"], ["wait", "Waiting"]];
const ICONS = { think: "think", read: "read", write: "write", shell: "shell", wait: "wait" };
const MAX_DOTS = 12;
const MAX_FINISHED = 40;

const tones = (t) => ({
  write: t.ansi3, shell: t.accent, read: t.ansi6, think: t.working, wait: t.dim, tool: t.muted, mark: t.foreground,
  blocked: t.blocked, quiet: t.ansi1, idle: t.dim, running: t.muted, finished: t.done, queued: t.dim,
});
const mono = () => settings().font_family ?? "JetBrains Mono";
const painted = (path, color, width, height) => window.paint_path(path, color).absolute().top(0).left(0).w(width).h(height);
const small = (t, text) => div().text_size(12).text_color(t.muted).child(text);
const time = (t, text, color) => div().flex_none().font_family(mono()).text_size(12).text_color(color ?? t.muted).child(text);

// On Herdr 0.1.12 a path's numbers are the app's own pixels, as `.w()` and `.left()` are, and the app scales them by the
// zoom itself. Scaling them here as well drew every path, the ribbons' calls among them, 1.2 times too far out at 1.2.
function pen(width, dash) {
  const path = PathBuilder.stroke(width);
  if (dash) path.dash_array(dash);
  return {
    line(x1, y1, x2, y2) { path.move_to(x1, y1).line_to(x2, y2); return this; },
    through(points) {
      points.forEach(([x, y], i) => (i ? path.line_to(x, y) : path.move_to(x, y)));
      return this;
    },
    close() { path.close(); return this; },
    build: () => path.build(),
  };
}

function iconButton(id, icon, label, t, press) {
  return h_flex().id(id).size(28).flex_none().items_center().justify_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
    .accessibility_label(label).on_click(press).child(svg(icon).size(15).text_color(t.muted));
}

function header(view, model, now, t) {
  const going = model.running;
  const facts = [
    model.total ? `Plan ${model.done} of ${model.total}` : null,
    going ? `${going} ${going === 1 ? "agent" : "agents"} running` : null,
    shortTime(now - (model.started ?? now)),
  ].filter(Boolean).join(" · ");
  const full = view.isFull();
  return h_flex().flex_none().pl(PADDING).pr(8).pt(11).pb(9).gap(8).items_start()
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(div().truncate().text_size(15).font_semibold().child(model.name))
      .child(div().truncate().text_size(12).text_color(t.muted).child(facts)))
    .child(iconButton("herd-full", full ? "mods/herd/collapse.svg" : "mods/herd/expand.svg", full ? "Back to the side" : "Full width", t, () => view.toggleFull()));
}

// The one thing that can't wait goes first.
function needsYou(view, rows, t) {
  return v_flex().flex_none().mx(PADDING).mb(10).gap(6).children(rows.map((row) => h_flex().id(`needs-${row.key}`).px(11).py(8).gap(10).items_center().rounded(8)
    .bg(`${t.blocked.slice(0, 7)}26`).border_1().border_color(`${t.blocked.slice(0, 7)}66`)
    .child(v_flex().flex_1().min_w(0).gap(1)
      .child(div().truncate().font_semibold().child(`${row.name} needs you`))
      .when(Boolean(row.status), (e) => e.child(div().truncate().text_size(12).text_color(t.muted).child(row.status))))
    .when(Boolean(row.address), (e) => e.child(div().id(`needs-show-${row.key}`).flex_none().px(10).py(4).rounded(6).text_size(12).font_medium().cursor_pointer()
      .bg(t.solid).text_color(t.solid_foreground).on_click(() => view.showTerminal(row)).child("Show")))));
}

// With a plan it counts items done. Otherwise it counts agents going, and a session on its own says what it's doing, in
// its colour.
function hub(model, geo, moving, now, tone, t) {
  const planned = model.total > 0, at = geo.centre - geo.hub / 2, c = geo.centre, glow = geo.hub + 30;
  const doing = !planned && model.solo ? activityOf(model.solo, now, model.gaps) : null;
  return [
    ...(moving ? [div().absolute().left(c - glow / 2).top(c - glow / 2).size(glow).rounded_full().bg(t.accent).loop("opacity", { from: 0.03, to: 0.11, period: 3200 })] : []),
    v_flex().absolute().left(at).top(at).w(geo.hub).h(geo.hub).items_center().justify_center().rounded_full().bg(t.raised).border(1).border_color(t.border)
      .child(div().text_size(Math.round(geo.hub * 0.36)).line_height(1.05).font_semibold().child(String(planned ? model.done : model.running)))
      .child(div().text_size(11).line_height(1.1).text_color(t.muted).child(planned ? `of ${model.total} done` : "running"))
      .when(Boolean(doing), (e) => e.child(div().pt(2).text_size(11).line_height(1.1).font_medium().text_color(tone[doing.tone]).child(doing.word))),
  ];
}

// Arcs of one colour share a path. `arcs` is [[from, to], ...] and `colorOf` names each one's colour. A whole circle is
// closed, so it has no notch where it starts and ends.
function arcLayers(arcs, radius, width, colorOf, geo, dashOf) {
  const groups = new Map();
  arcs.forEach(([from, to], i) => {
    const color = colorOf(i), dash = dashOf?.(i), key = `${color}${dash ? "-" : ""}`;
    if (!groups.has(key)) groups.set(key, { color, path: pen(width, dash) });
    const points = arcPoints(geo.centre, geo.centre, radius, from, to);
    if (to - from >= 2 * Math.PI - 1e-9) groups.get(key).path.through(points.slice(0, -1)).close();
    else groups.get(key).path.through(points);
  });
  return [...groups.values()].map((g) => painted(g.path.build(), g.color, geo.size, geo.size));
}

const toneColor = (spot, tone, t) => (spot.state === "queued" ? t.popover : tone[spot.tone]);

// One segment per plan item, pointing at its node, in that node's colour.
function hubRing(spots, geo, tone, t, solo) {
  const radius = geo.hub / 2 + 7;
  if (!spots.length) return arcLayers([[0, 2 * Math.PI]], radius, 3.5, () => (solo ? tone[solo.tone] : t.popover), geo);
  return arcLayers(segments(spots.length, 0.22), radius, 3.5, (i) => toneColor(spots[i], tone, t), geo);
}

// The plan as a route round the orbit: solid where it's been, lit where it's going, dotted for what's left.
function route(spots, geo, tone, t) {
  if (spots.length < 2) return [div().absolute().left(geo.centre - geo.orbit).top(geo.centre - geo.orbit).size(geo.orbit * 2).rounded_full().border(1).border_color(t.border)];
  const color = (i) => (spots[i].state === "queued" ? t.selected : `${tone[spots[i].tone].slice(0, 7)}${spots[i].state === "finished" ? "cc" : "77"}`);
  return arcLayers(routeArcs(spots.length, geo), geo.orbit, 1.6, color, geo, (i) => (spots[i].state === "queued" ? [2, 5] : null));
}

function comet(geo, moving, t) {
  if (!moving) return [];
  const size = geo.orbit * 2 * (200 / 196), at = geo.centre - size / 2;
  return [svg("mods/herd/orbit.svg").absolute().left(at).top(at).size(size).text_color(t.foreground).opacity(0.55).spin(11000)];
}

function sky(geo, t) {
  const dim = pen(1.2), bright = pen(1.6);
  for (const star of starField(geo.size, 46)) (star.bright ? bright : dim).line(star.x, star.y, star.x + 1, star.y);
  const c = geo.centre;
  return [
    ...[0.92, 0.66, 0.42].map((share) => { const d = geo.size * share; return div().absolute().left(c - d / 2).top(c - d / 2).size(d).rounded_full().bg(`${t.accent.slice(0, 7)}06`); }),
    painted(dim.build(), t.popover, geo.size, geo.size),
    painted(bright.build(), t.dim, geo.size, geo.size),
  ];
}

// Brighter towards the node, so the eye follows the spoke out to who's working.
function spokes(geo, spots, tone) {
  const out = [], c = geo.centre, skip = geo.hub / 2 + 11;
  for (const s of spots) {
    if (!s.row || s.state === "finished") continue;
    const dx = s.x - c, dy = s.y - c, length = Math.hypot(dx, dy), at = (share) => [c + (dx / length) * (skip + (length - skip) * share), c + (dy / length) * (skip + (length - skip) * share)];
    const color = tone[s.tone].slice(0, 7);
    [[0, 0.4, "33"], [0.4, 0.75, "66"], [0.75, 1, "99"]].forEach(([from, to, alpha]) => out.push(painted(pen(1.5).line(...at(from), ...at(to)).build(), `${color}${alpha}`, geo.size, geo.size)));
  }
  return out;
}

// A ring of short arcs round a node, one for each subagent under it, in the colour of what it's doing.
function kidRing(at, radius, kids, tone, now, geo, gaps) {
  if (!kids.length) return [];
  const groups = new Map();
  segments(Math.min(kids.length, 24), kids.length > 1 ? 0.3 : 0.5).forEach(([from, to], i) => {
    const color = tone[activityOf(kids[i], now, gaps).tone];
    if (!groups.has(color)) groups.set(color, pen(2.5));
    groups.get(color).through(arcPoints(at.x, at.y, radius, from, to));
  });
  return [...groups].map(([color, path]) => painted(path.build(), color, geo.size, geo.size));
}

function tick(size, color) {
  const o = size * 0.28, c = size / 2;
  const path = pen(1.8).line(c - o, c, c - o * 0.2, c + o * 0.7).line(c - o * 0.2, c + o * 0.7, c + o, c - o * 0.6);
  return painted(path.build(), color, size, size);
}

function node(view, spot, tone, t) {
  const size = spot.size, live = spot.row && spot.state !== "finished" && spot.state !== "queued";
  const fill = spot.state === "queued" ? t.canvas : tone[spot.tone], edge = spot.state === "queued" ? t.dim : fill;
  const selected = view.selected === spot.key, middle = (s) => HIT / 2 - s / 2;
  return div().id(`node-${spot.key}`).absolute().w(HIT).h(HIT).flex().items_center().justify_center().rounded_full().cursor_pointer()
    .left(spot.x - HIT / 2).top(spot.y - HIT / 2).spring("left", GLIDE).spring("top", GLIDE)
    .accessibility_label(spot.label).on_click(() => view.pick(spot.key))
    .when(live, (e) => e.child(div().absolute().top(middle(size + 12)).left(middle(size + 12)).size(size + 12).rounded_full().bg(fill)
      .loop("opacity", { from: 0.06, to: spot.state === "blocked" ? 0.6 : 0.3, period: spot.state === "blocked" ? 800 : 2400 })))
    .when(selected, (e) => e.child(div().absolute().top(middle(size + 8)).left(middle(size + 8)).size(size + 8).rounded_full().border(1.5).border_color(t.foreground)))
    .child(div().relative().w(size).h(size).flex().flex_none().items_center().justify_center().rounded_full().bg(fill).border(1.5).border_color(edge)
      .spring("width", GLIDE).spring("height", GLIDE)
      .when(spot.state === "blocked", (e) => e.text_color(t.background).text_size(Math.round(size * 0.62)).font_bold().child("!"))
      .when(spot.state === "finished", (e) => e.child(tick(size, t.background)))
      .when(spot.more > 0, (e) => e.text_color(t.muted).text_size(9).font_semibold().child(`+${spot.more}`))
      .when(live && Boolean(ICONS[spot.tone]), (e) => e.child(svg(`mods/herd/tone-${ICONS[spot.tone]}.svg`).size(Math.round(size * 0.58)).text_color(t.canvas))));
}

function label(view, spot, geo, t) {
  const live = spot.row && spot.state !== "finished";
  if (!live && view.selected !== spot.key) return null;
  const at = labelSpot(spot, spot.size, geo);
  return h_flex().absolute().left(at.left).top(at.top).w(at.width).justify_center()
    .child(div().min_w(0).px(5).rounded(4).truncate().bg(`${t.canvas.slice(0, 7)}d9`).text_size(12).font_medium()
      .text_color(spot.state === "blocked" ? t.blocked : t.foreground).child(spot.label));
}

// A subagent shows as a segment of the ring round its parent, and a process as a small square going round it.
function moons(model, spots, tone, geo, now) {
  const out = [], mid = { x: geo.centre, y: geo.centre };
  for (const { spot, kids } of hangersOf(model.groups, spots)) {
    const at = spot ?? mid, size = spot ? spot.size + 12 : geo.hub + 28;
    const agents = kids.filter((k) => k.kind !== "process"), processes = kids.filter((k) => k.kind === "process");
    out.push(...kidRing(at, size / 2 - 1, agents, tone, now, geo, model.gaps));
    processes.forEach((row, i) => {
      const p = moonPoint(at, size / 2 + 8, i, processes.length, now);
      out.push(div().id(`moon-${row.key}`).absolute().size(MOON).left(p.x - MOON / 2).top(p.y - MOON / 2).rounded(1.5).bg(tone.running).transition("left", STEP).transition("top", STEP));
    });
  }
  return out;
}

// A spark and a smaller one chasing it, along its spoke to the middle. The session's own calls go the other way.
function spark(s, spots, groups, tone, geo) {
  const path = sparkPath(s.key, spots, groups);
  if (!path) return [];
  const color = tone[toneOf(s.tool)], away = path.node;
  const dot = (size, delay, id) => {
    const far = { x: away.x - size / 2, y: away.y - size / 2 }, near = { x: geo.centre - size / 2, y: geo.centre - size / 2 };
    const [from, to] = path.inward ? [far, near] : [near, far], at = s.flying ? to : from, go = { ...FLIGHT, delay };
    return div().id(`spark-${s.id}-${id}`).absolute().size(size).rounded_full().bg(color).left(at.x).top(at.y).opacity(s.flying ? 0.1 : id ? 0.5 : 1)
      .transition("left", go).transition("top", go).transition("opacity", go);
  };
  return [dot(4, 90, 1), dot(6, 0, 0)];
}

function mapView(view, model, size, now, tone, t) {
  // Past the room on the orbit, the last place says how many more there are, rather than dropping them.
  const geo = geometry(size), { shown, more } = capped(model.slots, MAX_SLOTS);
  const slots = more ? [...shown, { key: "more", label: `${more} more`, row: null, state: "queued", more }] : shown;
  const spots = slots.map((slot, i) => {
    const live = slot.row && slot.state !== "finished";
    const size = slot.more ? 18 : live ? nodeSize(slot.row.size) : slot.state === "queued" ? 10 : 15;
    return { ...slot, ...slotPoint(i, slots.length, geo), size, tone: live ? activityOf(slot.row, now, model.gaps).tone : slot.state };
  });
  const moving = model.rows.some((r) => r.state === "working");
  const solo = model.total ? null : model.solo && activityOf(model.solo, now, model.gaps);
  return div().id("herd-map").relative().w(size).h(size).flex_none()
    .children(sky(geo, t))
    .children(route(spots, geo, tone, t))
    .children(comet(geo, moving, t))
    .children(spokes(geo, spots, tone))
    .children(view.sparks.flatMap((s) => spark(s, spots, model.groups, tone, geo)))
    .children(hub(model, geo, moving, now, tone, t))
    .children(hubRing(spots, geo, tone, t, solo))
    .children(moons(model, spots, tone, geo, now))
    .children(spots.map((s) => node(view, s, tone, t)))
    .children(spots.map((s) => label(view, s, geo, t)).filter(Boolean));
}

function colourKey(tone, t, width) {
  const entry = ([kind, word]) => h_flex().gap(4).items_center()
    .child(svg(`mods/herd/tone-${ICONS[kind]}.svg`).size(12).text_color(tone[kind])).child(small(t, word));
  const line = (list) => h_flex().justify_center().gap(11).children(list.map(entry));
  return width >= 340 ? line(KEY) : v_flex().gap(3).items_center().child(line(KEY.slice(0, 3))).child(line(KEY.slice(3)));
}

// What the agent did, left to right, with now at the right. Gaps are thinking. A press on a call names it under the
// ribbon, and the call picked is marked.
function ribbon(view, row, width, now, tone, t, height) {
  const grid = pen(1).line(width / 3, 0, width / 3, height).line((width * 2) / 3, 0, (width * 2) / 3, height);
  const layers = [painted(grid.build(), t.border, width, height)];
  if (row.kind === "process") {
    const from = row.started != null ? Math.max(0, width * (1 - (now - row.started) / WINDOW_MS)) : 0;
    layers.push(painted(pen(height, [3, 2]).line(from, height / 2, width, height / 2).build(), t.dim, width, height));
  }
  for (const group of groupNotes(notesOf(row.events, now, width))) {
    const mark = group.tone === "mark", path = pen(mark ? 2 : height), color = tone[group.tone];
    for (const n of group.notes) {
      if (mark) path.line(n.from + 1, 0, n.from + 1, height);
      else path.line(n.from, height / 2, n.to, height / 2);
    }
    layers.push(painted(path.build(), group.sounding ? color : `${color.slice(0, 7)}a8`, width, height));
  }
  const picked = view.call?.key === row.key ? pickedCall(row, view.call, now, width) : null;
  if (picked) layers.push(painted(pen(1.5).line(picked.x, 0, picked.x, height).build(), t.foreground, width, height));
  // The press lands on the row too, so a call found here stops it there, and the row only opens on a press elsewhere.
  return div().id(`ribbon-${row.key}`).relative().w(width).h(height).flex_none().overflow_hidden().rounded(height / 2).bg(t.canvas)
    .on_mouse_down("left", (e) => {
      const x = pressOffset(e.local_position?.x, e.bounds?.width, width);
      view.press = x == null ? null : { key: row.key, x };
    })
    .on_click((_e, cx) => {
      const press = view.press;
      if (press?.key !== row.key) return;
      const found = eventAt(row.events, view.now(), press.x, width);
      if (!found) return;
      cx.stop_propagation();
      view.pickCall(row.key, found.event);
    })
    .children(layers);
}

// The call picked on a ribbon, found again by its start and kind, and where it sits on the ribbon now.
function pickedCall(row, call, now, width) {
  const event = (row.events ?? []).find((e) => e[0] === call.at && e[1] === call.tool);
  if (!event) return null;
  const end = event[2] == null ? now : event[0] + event[2], middle = (event[0] + end) / 2;
  return { event, x: Math.max(1, Math.min(width - 1, width * (1 - (now - middle) / WINDOW_MS))) };
}

// What the picked call was for, how long it took and how long ago, in the colour of its kind. A press closes it.
function callLine(view, row, now, tone, t) {
  const picked = pickedCall(row, view.call, now, 1);
  if (!picked) return null;
  const [at, tool, length, label] = picked.event;
  const took = length == null ? "running" : shortTime(length);
  return h_flex().id(`call-${row.key}`).min_w(0).gap(6).items_center().cursor_pointer()
    .on_click((_e, cx) => { cx.stop_propagation(); view.pickCall(row.key, null); })
    .child(div().size(7).flex_none().rounded_full().bg(tone[toneOf(tool)]))
    .child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(11).text_color(t.foreground).child(label ?? "A call"))
    .child(time(t, `${took} · ${shortTime(now - at)} ago`));
}

function effortBars(effort, t) {
  const level = EFFORT.indexOf(String(effort ?? "").toLowerCase());
  return h_flex().w(26).h(11).flex_none().items_end().gap(2)
    .children(EFFORT.map((_, i) => div().w(3).h(3 + i * 2).rounded(1).bg(i <= level && level >= 0 ? t.foreground : t.popover)));
}

// Opens by sliding its height, and the rows under it move with it. Its height comes from measuring it.
function fold(view, key, inner) {
  const f = view.folds.get(key);
  if (!f) return null;
  return div().id(`fold-${key}`).w_full().overflow_hidden().h(f.entered ? f.height : 0).opacity(f.entered ? 1 : 0)
    .transition("height", SLIDE).transition("opacity", SLIDE)
    .child(v_flex().id(`fold-in-${key}`).w_full().flex_none().on_size_change((size, cx) => view.measured(key, size.height, cx)).child(inner));
}

function details(view, row, now, t) {
  return v_flex().w_full().gap(7).pt(1)
    .when(Boolean(row.status), (e) => e.child(div().text_size(12).text_color(t.foreground).child(row.status)))
    .when(Boolean(row.command), (e) => e.child(div().font_family(mono()).text_size(11).text_color(t.muted).child(row.command)))
    .child(h_flex().min_w(0).gap(8).items_center()
      .when(Boolean(row.model), (e) => e.child(small(t, row.model)))
      .when(Boolean(row.effort), (e) => e.child(effortBars(row.effort, t)))
      .when(row.started != null, (e) => e.child(small(t, `${shortTime(now - row.started)} so far`)))
      .when(Boolean(turnLine(row.turn)), (e) => e.child(small(t, `Last turn ${turnLine(row.turn)}`)))
      .child(div().flex_1())
      .when(Boolean(row.address), (e) => e.child(div().id(`show-${row.key}`).flex_none().px(9).py(4).rounded(6).text_size(12).font_medium().cursor_pointer().bg(t.raised).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); view.showTerminal(row); }).child("Show terminal"))));
}

// The last turn's summary waits until the turn is over, because a turn still going has no total yet.
const summaryOf = (row) => (row.state === "working" || row.state === "blocked" ? null : turnLine(row.turn));

// How full its context window is. From 60% it takes the warning colour.
const contextFigure = (row, t) => time(t, `${row.context}%`, contextHigh(row.context) ? t.ansi3 : t.dim);

function agentRow(view, row, width, now, tone, t, nested) {
  const doing = activityOf(row, now, view.model?.gaps), open = view.folds.has(row.key), color = tone[doing.tone];
  const summary = nested ? null : summaryOf(row), call = view.call?.key === row.key ? callLine(view, row, now, tone, t) : null;
  const name = h_flex().min_w(0).gap(7).items_center().w_full()
    .child(div().flex_1().min_w(0).truncate().text_size(nested ? 12 : 13).font_semibold().child(row.title))
    .child(div().flex_none().text_size(12).font_medium().text_color(color).child(doing.word))
    .when(doing.since != null, (e) => e.child(time(t, shortTime(doing.since))))
    .when(row.context != null, (e) => e.child(contextFigure(row, t)));
  const line = !open && !nested && (row.status || summary) ? h_flex().w_full().min_w(0).gap(8).items_center()
    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(row.status ?? ""))
    .when(Boolean(summary), (e) => e.child(time(t, summary))) : null;
  return v_flex().id(`row-${row.key}`).flex_none().px(PADDING).pt(nested ? 5 : 9).pb(nested ? 6 : 8).gap(nested ? 4 : 6).cursor_pointer()
    .when(view.selected === row.key, (e) => e.bg(t.hover)).hover((s) => s.bg(t.hover))
    .on_click(() => view.pick(row.key))
    .child(name)
    .child(ribbon(view, row, width, now, tone, t, nested ? THIN : RIBBON))
    .when(Boolean(call), (e) => e.child(call))
    .when(Boolean(line), (e) => e.child(line))
    .when(open, (e) => e.child(fold(view, row.key, details(view, row, now, t))));
}

const counted = (n, one, many) => (n ? `${n} ${n === 1 ? one : many}` : null);

// A worker's subagents and processes fold away into one line. Each dot is one of them, in the colour of what it's doing.
function kidsBand(view, group, width, now, tone, t) {
  const key = `kids:${group.row.key}`, open = view.folds.has(key), kids = group.kids;
  const agents = kids.filter((k) => k.kind !== "process").length;
  const words = [counted(agents, "subagent", "subagents"), counted(kids.length - agents, "process", "processes")].filter(Boolean).join(", ");
  const dots = kids.slice(0, MAX_DOTS).map((k) => div().size(7).flex_none().rounded(k.kind === "process" ? 1.5 : 7).bg(tone[activityOf(k, now, view.model?.gaps).tone]));
  return v_flex().flex_none()
    .child(h_flex().id(`band-${group.row.key}`).h(26).px(PADDING).gap(7).items_center().cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => view.toggleFold(key))
      .child(svg(open ? "mods/files/chevron-down.svg" : "mods/files/chevron-right.svg").size(12).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(words))
      .child(h_flex().flex_none().gap(3).items_center().children(dots))
      .when(kids.length > MAX_DOTS, (e) => e.child(time(t, `+${kids.length - MAX_DOTS}`))))
    .when(open, (e) => e.child(fold(view, key, v_flex().w_full().pb(4).children(kids.map((k) => agentRow(view, k, width, now, tone, t, true))))));
}

function agentGroup(view, group, width, now, tone, t) {
  return v_flex().flex_none().border_t(1).border_color(t.border).pb(1)
    .child(agentRow(view, group.row, width, now, tone, t, false))
    .when(group.kids.length > 0, (e) => e.child(kidsBand(view, group, width, now, tone, t)));
}

function finishedRows(model, width, t) {
  const longest = Math.max(1, ...model.finished.map((r) => (r.ended ?? r.last ?? 0) - (r.started ?? 0)));
  const room = Math.max(40, width * 0.26);
  const { shown, more } = capped(model.finished, MAX_FINISHED);
  return v_flex().w_full().pb(6).children(shown.map((row) => {
    const took = Math.max(0, (row.ended ?? row.last ?? 0) - (row.started ?? 0));
    return h_flex().id(`done-${row.key}`).h(26).px(PADDING).gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(row.name))
      .child(div().w(room).h(4).flex_none().rounded(2).bg(t.border).child(div().h(4).rounded(2).bg(row.failed ? t.blocked : t.done).w(`${Math.max(3, (took / longest) * 100)}%`)))
      .child(div().w(46).flex_none().text_right().font_family(mono()).text_size(12).text_color(t.muted).child(shortTime(took)));
  })).when(more > 0, (e) => e.child(h_flex().h(26).px(PADDING).items_center().child(small(t, `and ${more} more, older`))));
}

function finishedBand(view, model, width, t) {
  const open = view.folds.has("finished");
  return v_flex().flex_none().border_t(1).border_color(t.border)
    .child(h_flex().id("finished-band").h(34).px(PADDING).gap(7).items_center().cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => view.toggleFold("finished"))
      .child(svg(open ? "mods/files/chevron-down.svg" : "mods/files/chevron-right.svg").size(12).flex_none().text_color(t.dim))
      .child(div().flex_1().text_size(12).text_color(t.muted).child("Finished agents"))
      .child(time(t, String(model.finished.length))))
    .when(open, (e) => e.child(fold(view, "finished", finishedRows(model, width, t))));
}

const axis = (t) => h_flex().h(20).flex_none().px(PADDING).items_center().justify_between().text_size(11).text_color(t.dim)
  .child(div().child("30m ago")).child(div().child("20m")).child(div().child("10m")).child(div().child("Now"));

function agents(view, model, width, now, tone, t) {
  const inner = Math.max(120, Math.floor(width - PADDING * 2));
  return v_flex().flex_1().min_w(0).min_h(0)
    .child(axis(t))
    .child(v_flex().id("herd-list").flex_1().min_h(0).overflow_y_scrollbar()
      .children(model.groups.map((group) => agentGroup(view, group, inner, now, tone, t)))
      .when(model.rows.length <= 1, (e) => e.child(div().px(PADDING).py(10).border_t(1).border_color(t.border).child(small(t, "Nothing else running yet. Workers show here once this session starts them."))))
      .when(model.finished.length > 0, (e) => e.child(finishedBand(view, model, width, t))));
}

// The usage meters, drawn as Orchi draws them, so the status line doesn't have to. Nothing shows until the status line
// has written its usage file.
function meter(m, count, t) {
  const cells = meterCells(m, count).map((c) => div().w(1.5).h(16).flex_none().bg(c.part === "used" ? t[m.tone] : c.part === "ahead" ? t.dim : t.popover));
  return v_flex().flex_1().min_w(0).gap(3)
    .child(h_flex().min_w(0).items_baseline().gap(6).text_size(12)
      .child(div().min_w(0).truncate().text_color(t.dim).child(m.label)).child(div().flex_1())
      .child(div().flex_none().font_semibold().child(`${Math.round(m.used)}%`))
      .child(div().flex_none().text_color(t.muted).child(`→ ${m.projected == null ? "-" : `${Math.round(m.projected)}%`}`)))
    .child(h_flex().h(24).gap(4).items_center().overflow_hidden().children(cells))
    .child(div().truncate().text_size(12).text_color(t.dim).child(`Resets in ${m.resetIn}`));
}

function usageFooter(usage, width, t) {
  const count = meterTicks(width, usage.length);
  return h_flex().id("herd-usage").flex_none().px(12).pt(10).pb(11).gap(16).border_t(1).border_color(t.border).bg(t.background)
    .children(usage.map((m) => meter(m, count, t)));
}

// A read that went wrong, over what was read before it, so a stale panel says it's stale.
const problemLine = (text, t) => div().flex_none().mx(PADDING).mb(10).px(11).py(7).rounded(8).text_size(12)
  .bg(`${t.blocked.slice(0, 7)}1f`).text_color(t.foreground).child(text);

const message = (text, t) => v_flex().size_full().items_center().justify_center().p(20).text_center().child(small(t, text));

export function paneView(view, t) {
  const model = view.model, now = view.now(), tone = tones(t);
  const zoom = settings().zoom || 1, width = Math.max(120, (view.width || 368 * zoom) / zoom), height = Math.max(120, (view.height || 700 * zoom) / zoom);
  const root = v_flex().id("herd").size_full().min_h(0).min_w(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
    .on_size_change((size, cx) => { if (size.width !== view.width || size.height !== view.height) { view.width = size.width; view.height = size.height; cx.notify(); } });
  if (!model) return root.child(message(view.problem ?? "Reading this session.", t));
  const wide = width >= WIDE, blocked = model.rows.filter((r) => r.state === "blocked");
  const room = wide ? Math.min(MAP_MAX_WIDE, height - 150, width * 0.42) : Math.min(MAP_MAX, width - WELL * 2, Math.max(MAP_MIN, height * 0.42));
  const size = Math.max(MAP_MIN, Math.floor(room));
  const well = v_flex().flex_none().mx(WELL).mb(8).pt(2).pb(9).gap(3).items_center().rounded(12).bg(t.canvas).overflow_hidden()
    .child(mapView(view, model, size, now, tone, t)).child(colourKey(tone, t, size));
  const body = wide
    ? h_flex().flex_1().min_h(0).items_start().child(well).child(agents(view, model, width - size - WELL * 2, now, tone, t).h_full())
    : v_flex().flex_1().min_h(0).child(well).child(agents(view, model, width, now, tone, t));
  return root.child(header(view, model, now, t))
    .when(Boolean(view.problem), (e) => e.child(problemLine(view.problem, t)))
    .when(blocked.length > 0, (e) => e.child(needsYou(view, blocked, t))).child(body)
    .when(view.usage.length > 0, (e) => e.child(usageFooter(view.usage, width, t)));
}
