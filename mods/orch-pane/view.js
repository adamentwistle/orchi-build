// Draws the progress pane: the run at the top, then one lane per task on a shared time scale, like parts in a score.
// `view` is the pane's View. Colours come from `theme()` only. Everything from a file is drawn as text.
import { div, PathBuilder, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { settings } from "herdr";
import { PITCH, axisOf, laneOf, ringShares, tickCount } from "./lane.js";
import { aboutLeft, ageText, duration, rowEstimate, runEstimate } from "./plan.js";
import { splitUpdate } from "./update-text.js";

const DASH = "-";
const EFFORT = ["low", "medium", "high", "xhigh", "max"];
const RING_TICKS = 60, RING = 88;
const WIDE = 560, TIGHT = 300, TITLE_WIDTH = 240, PADDING = 12;
const STEP_LIMIT = 14;

const mono = () => settings().font_family ?? "JetBrains Mono";
const dim = (t, text) => div().text_size(12).text_color(t.dim).child(text);
const numbers = (t, text, color) => div().flex_none().font_family(mono()).text_size(12).text_color(color ?? t.muted).child(text);

// A read that went wrong, over what was read before it, so a stale pane says it's stale.
const problemLine = (text, t) => div().flex_none().mx(PADDING).mt(10).px(10).py(6).rounded(6).text_size(12)
  .bg(`${t.blocked.slice(0, 7)}1f`).text_color(t.foreground).child(text);

function ticks(from, to, top, bottom) {
  const path = PathBuilder.stroke(1.5);
  for (let i = from; i <= to; i++) { const x = i * PITCH + 1; path.move_to(x, top).line_to(x, bottom); }
  return path.build();
}

const painted = (path, color, width, height) => window.paint_path(path, color).absolute().top(0).left(0).w(width).h(height);

// A lane: the whole scale faintly, the time the task ran, the estimate after it, and a head that beats while it runs.
function lane(row, axis, count, left, beat, t, height) {
  const { lit, ghost } = laneOf(row, axis, count, left), width = count * PITCH, active = row.phase === "active";
  const tone = active ? t.working : t.done;
  const parts = [painted(ticks(0, count - 1, height * 0.3, height * 0.7), t.popover, width, height)];
  if (ghost) parts.push(painted(ticks(ghost[0], ghost[1], height * 0.15, height * 0.85), t.dim, width, height));
  if (lit) {
    parts.push(painted(ticks(lit[0], lit[1], 0, height), tone, width, height));
    if (active) parts.push(painted(ticks(lit[1], lit[1], 0, height), beat ? t.foreground : tone, width, height));
  }
  return div().w(width).h(height).flex_none().relative().children(parts);
}

function effortBars(effort, t) {
  const level = EFFORT.indexOf(String(effort ?? "").toLowerCase());
  return h_flex().w(26).h(11).flex_none().items_end().gap(2)
    .children(EFFORT.map((_, i) => div().w(3).h(3 + i * 2).rounded(1).bg(i <= level && level >= 0 ? t.foreground : t.popover)));
}

function ring(p, t) {
  const shares = ringShares(p.done, p.active, p.total, RING_TICKS), lit = [[], [], []], c = RING / 2;
  for (let i = 0; i < RING_TICKS; i++) {
    const a = (i / RING_TICKS) * 2 * Math.PI, s = Math.sin(a), k = -Math.cos(a);
    const bucket = i < shares.done ? 0 : i < shares.done + shares.active ? 1 : 2;
    lit[bucket].push([c + (c - 7) * s, c + (c - 7) * k, c + (c - 1) * s, c + (c - 1) * k]);
  }
  const draw = (segments, color) => {
    if (!segments.length) return null;
    const path = PathBuilder.stroke(1.8);
    for (const [x1, y1, x2, y2] of segments) path.move_to(x1, y1).line_to(x2, y2);
    return painted(path.build(), color, RING, RING);
  };
  return div().size(RING).flex_none().relative()
    .children([draw(lit[2], t.popover), draw(lit[1], t.working), draw(lit[0], t.foreground)].filter(Boolean))
    .child(div().absolute().top(0).left(0).size(RING).flex().items_center().justify_center()
      .child(v_flex().items_center()
        .child(div().text_size(21).line_height(1.1).font_semibold().child(String(p.done)))
        .child(div().text_size(10).line_height(1.1).text_color(t.dim).child(`of ${p.total}`))));
}

// A figure with its label over it.
const figure = (t, label, value) => v_flex().flex_none().gap(1).child(dim(t, label)).child(div().text_size(15).font_semibold().child(value));

function runHead(model, now, t) {
  const { plan, name, progress: p, sorted, runStart } = model;
  const left = runEstimate(sorted, now, model.gaps);
  return h_flex().flex_none().px(PADDING).pt(14).pb(12).gap(14).items_center()
    .child(ring(p, t))
    .child(v_flex().flex_1().min_w(0).gap(7)
      .child(h_flex().min_w(0).gap(8).items_baseline()
        .child(div().flex_none().text_size(16).font_semibold().child(name))
        .when(Boolean(plan.title), (e) => e.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(plan.title))))
      .child(h_flex().flex_wrap().gap(18)
        .child(figure(t, "Elapsed", runStart ? duration(now - runStart) : DASH))
        .when(left != null && left > 0, (e) => e.child(figure(t, "Left, estimate", aboutLeft(left))))));
}

// One line, and a press opens the rest as a list.
function latest(view, update, now, t) {
  const { headline, points } = splitUpdate(update.text), open = view.updateOpen, more = points.length > 0;
  return v_flex().id("latest-update").flex_none().mx(PADDING).mb(12).px(10).py(8).gap(5).rounded(8).bg(t.raised).border_1().border_color(t.border)
    .when(more, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { view.updateOpen = !view.updateOpen; cx.notify(); }))
    .child(h_flex().gap(6).items_center()
      .when(more, (e) => e.child(svg(open ? "mods/files/chevron-down.svg" : "mods/files/chevron-right.svg").size(12).flex_none().text_color(t.dim)))
      .child(dim(t, "Latest update").flex_1().min_w(0).truncate()).child(dim(t, ageText(now - update.time)).flex_none()))
    .child(div().min_w(0).font_semibold().when(!open, (e) => e.truncate()).child(headline))
    .when(open && more, (e) => e.child(v_flex().gap(4).children(points.map((p) => h_flex().gap(7).items_start().text_size(12).text_color(t.muted)
      .child(div().size(4).mt(7).flex_none().rounded_full().bg(t.dim))
      .child(div().flex_1().min_w(0).child(p))))));
}

// The run's own scale: when it started, now and when it should end.
function scale(axis, estimated, t) {
  const clock = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  return [
    div().flex_none().child(clock(axis.from)), div().flex_1(),
    div().flex_none().child(estimated ? `about ${clock(axis.to)}` : clock(axis.now)),
  ];
}

function facts(row, t, { tight, left }) {
  const state = /^running$/i.test(row.state) ? "" : row.state;
  return h_flex().min_w(0).gap(6).items_center().text_size(12).text_color(t.muted)
    .when(Boolean(row.model), (e) => e.child(div().flex_none().child(row.model)))
    .when(Boolean(row.effort), (e) => e.child(effortBars(row.effort, t)))
    .when(!tight, (e) => e.child(div().flex_none().text_color(t.dim).child(row.via === "pane" ? "pane" : "subagent")))
    .when(Boolean(row.pr), (e) => e.child(div().flex_none().child(`#${row.pr}`)))
    .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(state))
    .when(Boolean(left), (e) => e.child(div().min_w(0).truncate().text_color(t.foreground).child(left)));
}

// Every lane's room is the same, so one report sizes them all, and nothing can run past the padding.
const laneBox = (view, row, inner) => h_flex().id(`lane-${row.key}`).flex_1().min_w(0).overflow_hidden()
  .on_size_change((size, cx) => { if (size.width !== view.laneWidth) { view.laneWidth = size.width; cx.notify(); } })
  .child(inner);

function activeRow(view, row, ctx, t) {
  const { axis, count, done, now, wide, tight, beat, gaps } = ctx;
  const estimate = rowEstimate(row, done, now, gaps);
  const left = estimate?.over ? "running long" : estimate ? aboutLeft(estimate.left) : null;
  const words = v_flex().min_w(0).gap(3)
    .child(h_flex().min_w(0).gap(8).items_center()
      .child(div().size(6).flex_none().rounded_full().bg(t.working))
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(row.title))
      .child(numbers(t, row.started != null ? duration(now - row.started) : DASH, t.foreground)))
    .child(facts(row, t, { tight, left }));
  const track = laneBox(view, row, lane(row, axis, count, estimate?.left ?? 0, beat, t, 14));
  return view.rowShell(row, t, wide ? h_flex().gap(16).items_center().child(words.w(TITLE_WIDTH).flex_none()).child(track) : v_flex().gap(6).child(words).child(track));
}

function doneRow(view, row, ctx, t) {
  const { axis, count, wide, tight, beat } = ctx;
  const took = row.started != null && row.ended != null ? duration(row.ended - row.started) : DASH;
  const words = v_flex().min_w(0).gap(2)
    .child(h_flex().min_w(0).gap(8).items_baseline()
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(row.title))
      .child(numbers(t, took)))
    .child(facts(row, t, { tight }));
  if (row.started == null) return view.rowShell(row, t, words);
  const track = laneBox(view, row, lane(row, axis, count, 0, beat, t, 8));
  return view.rowShell(row, t, wide ? h_flex().gap(16).items_center().child(words.w(TITLE_WIDTH).flex_none()).child(track) : v_flex().gap(5).child(words).child(track));
}

const waitingRow = (row, t) => h_flex().h(26).flex_none().px(PADDING).gap(8).items_center().border_t(1).border_color(t.border).text_size(12).text_color(t.muted)
  .child(div().flex_1().min_w(0).truncate().child(row.title))
  .when(Boolean(row.model), (e) => e.child(div().flex_none().text_color(t.dim).child(row.model)));

function band(label, count, dot, t) {
  return h_flex().h(26).flex_none().px(PADDING).gap(7).items_center()
    .child(div().size(7).flex_none().rounded_full().bg(t[dot]))
    .child(div().font_family(mono()).text_size(11).text_color(t.muted).child(label.toUpperCase()))
    .child(div().text_size(11).text_color(t.dim).child(String(count)));
}

function steps(p, t) {
  if (!p.total || p.total > STEP_LIMIT) return null;
  const kinds = Array.from({ length: p.total }, (_, i) => (i < p.done ? "done" : i < p.done + p.active ? "active" : "todo"));
  return h_flex().flex_none().mx(PADDING).mb(12).h(10).items_center()
    .children(kinds.flatMap((kind, i) => [
      div().size(10).flex_none().rounded_full()
        .when(kind === "done", (e) => e.bg(t.foreground))
        .when(kind === "active", (e) => e.bg(t.working))
        .when(kind === "todo", (e) => e.border(1.5).border_color(t.dim)),
      ...(i < p.total - 1 ? [div().flex_1().min_w(2).h(1.5).bg(t.popover)] : []),
    ]));
}

function empty(view, t) {
  const text = view.problem ?? "Waiting for this orchestrator's session.";
  return v_flex().size_full().items_center().justify_center().p(20).child(dim(t, text));
}

export function paneView(view, t) {
  const model = view.model, now = view.now();
  const root = v_flex().id("orch-pane").size_full().min_h(0).min_w(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
    .on_size_change((size, cx) => { if (size.width !== view.width) { view.width = size.width; cx.notify(); } });
  if (!model) return root.child(empty(view, t));
  const { sorted, progress, update, runStart } = model;
  const width = Math.max(120, view.width || 320), wide = width >= WIDE;
  const count = tickCount(view.laneWidth || (wide ? width - PADDING * 2 - TITLE_WIDTH - 16 : width - PADDING * 2));
  const left = runEstimate(sorted, now, view.gaps), axis = axisOf(runStart, now, left);
  const ctx = { axis, count, now, wide, tight: width < TIGHT, done: sorted.done, beat: view.beat, gaps: view.gaps };
  const anyTask = sorted.active.length + sorted.done.length + sorted.waiting.length > 0;
  return root
    .when(Boolean(view.problem), (e) => e.child(problemLine(view.problem, t)))
    .child(runHead({ ...model, gaps: view.gaps }, now, t))
    .when(Boolean(steps(progress, t)), (e) => e.child(steps(progress, t)))
    .child(v_flex().id("orch-pane-list").flex_1().min_h(0).overflow_y_scrollbar()
      .when(Boolean(update), (e) => e.child(latest(view, update, now, t)))
      .when(!anyTask, (e) => e.child(div().p(PADDING).child(dim(t, "No workers yet. They show here once the orchestrator starts them."))))
      .when(anyTask, (e) => e.child(h_flex().flex_none().px(PADDING).pb(4).font_family(mono()).text_size(11).text_color(t.dim)
        .when(wide, (x) => x.pl(PADDING + TITLE_WIDTH + 16)).children(scale(axis, left > 0, t))))
      .when(sorted.active.length > 0, (e) => e.child(band("Active", sorted.active.length, "working", t)).children(sorted.active.map((row) => activeRow(view, row, ctx, t))))
      .when(sorted.done.length > 0, (e) => e.child(band("Done", sorted.done.length, "done", t)).children(sorted.done.map((row) => doneRow(view, row, ctx, t))))
      .when(sorted.waiting.length > 0, (e) => e.child(band("Not started", sorted.waiting.length, "dim", t)).children(sorted.waiting.map((row) => waitingRow(row, t))))
      .when(anyTask, (e) => e.child(div().flex_none().p(PADDING).child(dim(t, left == null ? "A time left shows once a task has finished." : "Times left are estimates, from the tasks finished in this run.")))))
    ;
}
