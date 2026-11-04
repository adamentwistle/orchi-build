// Draws the Orchi panel. `view` is the Orchi view, which owns the state and the actions used here.
// Colours come from `theme()` only.
import { div, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, Popover, Input } from "gpui-base";
import { svg } from "gpui-kit";
import { card, panelBody, sectionHead, problemLine, monoFont } from "./ui.js";
import { ageOf, orchestratorStatus } from "./parse.js";
import { formatLeft, meterTicks, meterCells } from "./usage.js";
import { keptPlan, planReady, elapsed } from "./sessions.js";
import { decisionButton, pasteable, pauseControl } from "./actions.js";
import { startSheet } from "./options-view.js";
import { completeOffered } from "./runs.js";
import { splitUpdate } from "./update-text.js";
import { shortRef } from "./refs.js";

const DASH = "-";
const EFFORT = ["low", "medium", "high", "xhigh", "max"];
const RING_TICKS = 40;

const small = (t, text) => div().text_size(12).text_color(t.muted).child(text);
const dim = (t, text) => div().text_size(12).text_color(t.dim).child(text);

function ghost(id, label, onClick, t) {
  return h_flex().id(id).h(26).px(8).flex_none().items_center().justify_center().rounded(6).cursor_pointer().text_size(12)
    .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick).child(label);
}

// With no onClick the button is drawn off: dim, nothing happens on a press, and `why` is its tooltip.
function outline(id, label, onClick, t, why = null) {
  const base = h_flex().id(id).h(28).px(10).flex_none().items_center().justify_center().rounded(6).text_size(12).border_1().border_color(t.border);
  if (!onClick) return base.text_color(t.dim).when(Boolean(why), (e) => e.tooltip(why)).child(label);
  return base.cursor_pointer().text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click(onClick).child(label);
}

function primary(id, label, enabled, onClick, t) {
  return h_flex().id(id).h(30).px(14).flex_none().items_center().justify_center().rounded(6).font_semibold().text_size(12)
    .bg(t.solid).text_color(t.solid_foreground).when(!enabled, (e) => e.opacity(0.4)).when(enabled, (e) => e.cursor_pointer().on_click(onClick)).child(label);
}

// A single line of text, in the same frame as the panels' other fields.
const lineField = (input, t) => h_flex().h(30).flex_none().px(10).items_center().rounded(6).border_1().border_color(t.border).bg(t.background)
  .child(Input.new(input).h_full().flex_1().text_size(12).text_color(t.foreground));

function arrow(id, label, onClick, t) {
  return h_flex().id(id).size(26).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
    .border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click(onClick).child(label);
}

// A polyline drawn natively, in pixels from the top left of its box.
const stroke = (width, points) => {
  const path = PathBuilder.stroke(width).move_to(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) path.line_to(x, y);
  return path.build();
};

function disc(kind, t) {
  if (kind === "done") {
    return div().size(16).flex_none().relative().rounded_full().bg(t.done)
      .child(window.paint_path(stroke(1.8, [[4.5, 8.2], [7, 10.6], [11.5, 5.6]]), t.background).absolute().top(0).left(0).size(16));
  }
  const ring = div().size(16).flex_none().rounded_full().border(1.5).border_color(kind === "running" ? t.foreground : t.dim)
    .flex().items_center().justify_center();
  return kind === "running" ? ring.child(div().size(6).rounded_full().bg(t.foreground)) : ring;
}

function steps(done, running, total, t) {
  const kinds = Array.from({ length: total }, (_, i) => (i < done ? "done" : i < done + running ? "running" : "todo"));
  return h_flex().h(16).items_center().children(kinds.flatMap((kind, i) => [
    disc(kind, t),
    ...(i < total - 1 ? [div().flex_1().min_w(2).h(1.5).bg(t.popover)] : []),
  ]));
}

// 40 ticks around a 36px circle, the used share in `foreground`, with the number in the middle.
function contextRing(percent, t) {
  const used = percent == null ? 0 : Math.round(RING_TICKS * percent / 100), lit = [], rest = [];
  for (let i = 0; i < RING_TICKS; i++) {
    const a = (i / RING_TICKS) * 2 * Math.PI, s = Math.sin(a), c = -Math.cos(a);
    (i < used ? lit : rest).push([[18 + 13.5 * s, 18 + 13.5 * c], [18 + 17.25 * s, 18 + 17.25 * c]]);
  }
  const tickPath = (ticks, color) => {
    if (!ticks.length) return null;
    const path = PathBuilder.stroke(1.5);
    for (const [a, b] of ticks) path.move_to(a[0], a[1]).line_to(b[0], b[1]);
    return window.paint_path(path.build(), color).absolute().top(0).left(0).size(36);
  };
  return div().size(36).flex_none().relative()
    .children([tickPath(rest, t.popover), tickPath(lit, t.foreground)].filter(Boolean))
    .child(div().absolute().top(0).left(0).size(36).flex().items_center().justify_center().text_size(11).font_semibold()
      .child(percent == null ? DASH : String(Math.round(percent))));
}

function effortBars(effort, t) {
  const level = EFFORT.indexOf(effort);
  return h_flex().w(34).h(12).flex_none().items_end().gap(3)
    .children(EFFORT.map((_, i) => div().w(4).h(4 + i * 2).rounded(1).bg(i <= level && level >= 0 ? t.foreground : t.popover)));
}

// A pane worker's route is "pane wGZ:p1", and the id means nothing here.
const routeName = (w) => (w.route?.startsWith("pane") ? "pane" : w.route && w.route !== "-" ? w.route : null);

function workerRow(view, w, kind, t) {
  const done = kind === "completed";
  const detail = [routeName(w), w.state && w.state !== "-" ? w.state : null].filter(Boolean).join(" · ");
  return h_flex().id(`worker-${w.slug}`).min_h(40).flex_none().px(12).py(5).gap(8).items_center().text_size(12)
    .border_t(1).border_color(t.border)
    .when(Boolean(w.address), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => view.focusTerminal(w.address)))
    .child(done
      ? div().size(12).flex_none().relative().rounded_full().bg(t.done)
        .child(window.paint_path(stroke(1.6, [[3.4, 6.2], [5.3, 8], [8.7, 4.2]]), t.background).absolute().top(0).left(0).size(12))
      : div().size(6).mx(3).flex_none().rounded_full().bg(kind === "queued" ? t.dim : t.working))
    .child(v_flex().flex_1().min_w(0).gap(1)
      .child(div().truncate().child(w.slug))
      .when(Boolean(detail), (e) => e.child(div().truncate().text_color(t.dim).child(detail))))
    .when(Boolean(w.pr), (e) => e.child(div().flex_none().text_color(t.muted).child(`#${w.pr}`)))
    .child(div().flex_none().text_color(t.muted).child(w.model ?? DASH))
    .child(effortBars(w.effort, t));
}

function workerList(view, o, kind, rows, t) {
  const key = `${o.name}:${kind}`, open = view.isOpen(key);
  const label = `${rows.length} ${kind}`;
  return v_flex().flex_none()
    .child(h_flex().id(`list-${key}`).h(32).px(12).gap(8).items_center().cursor_pointer().text_size(12)
      .border_t(1).border_color(t.border).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { view.toggle(key); cx.notify(); })
      .child(svg(open ? "mods/files/chevron-down.svg" : "mods/files/chevron-right.svg").size(12).flex_none().text_color(t.dim))
      .child(label))
    .when(open, (e) => e.children(rows.map((w) => workerRow(view, w, kind, t))));
}

// Beside the status: Pause, a spinner while the switchboard works on it, or Play. The press mustn't reach the head under it.
function pauseButton(view, o, pending, t) {
  const control = pauseControl(o, pending);
  if (control === "spinner") {
    return h_flex().size(26).flex_none().items_center().justify_center().child(svg("mods/orchi/spinner.svg").size(14).spin(900).text_color(t.muted));
  }
  const play = control === "play";
  return h_flex().id(`pause-${o.name}`).size(26).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
    .when(play, (e) => e.bg(t.solid).text_color(t.solid_foreground)).when(!play, (e) => e.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
    .on_click((_e, cx) => { cx.stop_propagation(); view.pause(o, play ? "resuming" : "pausing", cx); })
    .child(svg(play ? "mods/orchi/play.svg" : "mods/orchi/pause.svg").size(12).text_color(play ? t.solid_foreground : t.foreground));
}

const ago = (time) => { const age = ageOf(time, Date.now()); return age ? `${age} ago` : null; };

// A small figure with its name above it.
const stat = (name, value, t) => v_flex().flex_none().gap(4).child(dim(t, name)).child(div().h(36).flex().items_center().text_size(15).font_semibold().child(value ?? DASH));

const bullet = (text, t) => h_flex().gap(7).items_start().text_size(12).text_color(t.muted)
  .child(div().size(4).mt(7).flex_none().rounded_full().bg(t.dim))
  .child(div().flex_1().min_w(0).child(text));

// The newest thing the orchestrator wrote, which moves more often than the task count. It shows one line, and a press
// opens the rest as a list with the updates before it. Drawn only when there is an update.
function latestUpdate(view, o, t) {
  const [update, ...earlier] = o.activity.updates;
  const { headline, points } = splitUpdate(update.text), key = `${o.name}:update`, open = view.isOpen(key), more = points.length > 0 || earlier.length > 0;
  return v_flex().id(`update-${o.name}`).flex_none().min_w(0).px(10).py(8).gap(5).rounded(8).bg(t.background).border_1().border_color(t.border)
    .when(more, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { view.toggle(key); cx.notify(); }))
    .child(h_flex().gap(6).items_center()
      .when(more, (e) => e.child(svg(open ? "mods/files/chevron-down.svg" : "mods/files/chevron-right.svg").size(12).flex_none().text_color(t.dim)))
      .child(div().flex_1().min_w(0).font_semibold().when(!open, (e) => e.truncate()).child(headline))
      .child(dim(t, ago(update.time) ?? "").flex_none()))
    .when(open && points.length > 0, (e) => e.child(v_flex().gap(4).children(points.map((p) => bullet(p, t)))))
    .when(open && earlier.length > 0, (e) => e.child(v_flex().gap(3).pt(5).border_t(1).border_color(t.border)
      .children(earlier.map((u) => h_flex().gap(8).min_w(0).text_size(12)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(splitUpdate(u.text).headline))
        .child(div().flex_none().text_color(t.dim).child(ago(u.time) ?? ""))))));
}

// Complete suits a run that has gone quiet, so it's offered only then: no worker live, nothing open for the user, not paused,
// and nothing on its board for a while. It asks first, as Stop does. Stop ends terminals, and it can only reach this app's.
function runActions(view, o, pending, t) {
  if (view.completing === o.name) {
    return v_flex().flex_none().px(12).py(9).gap(6).border_t(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(ghost(`complete-cancel-${o.name}`, "Cancel", (_e, cx) => { view.completing = null; cx.notify(); }, t))
        .child(div().flex_1())
        .child(primary(`complete-yes-${o.name}`, "Mark done and close open items", true, (_e, cx) => view.completeRun(o, cx), t)));
  }
  if (view.stopping === o.name) {
    const workers = o.running.filter((w) => w.address).length;
    return v_flex().flex_none().px(12).py(9).gap(6).border_t(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(ghost(`stop-cancel-${o.name}`, "Cancel", (_e, cx) => { view.stopping = null; cx.notify(); }, t))
        .child(div().flex_1())
        .child(primary(`stop-yes-${o.name}`, workers ? `Stop the run and ${workers} ${workers === 1 ? "worker" : "workers"}` : "Stop the run", true, (_e, cx) => view.stopRun(o, cx), t)));
  }
  const canStop = o.where === "app" && Boolean(o.address);
  return h_flex().flex_none().px(8).py(5).gap(4).items_center().border_t(1).border_color(t.border)
    .when(completeOffered({ ...o, pending }, Date.now()), (e) => e.child(ghost(`complete-${o.name}`, "Mark complete", (_e, cx) => { view.completing = o.name; view.stopping = null; cx.notify(); }, t)))
    .child(div().flex_1())
    .when(canStop, (e) => e.child(ghost(`stop-${o.name}`, "Stop", (_e, cx) => { view.stopping = o.name; view.completing = null; cx.notify(); }, t)));
}

function orchestratorCard(view, o, t) {
  const pending = view.frame.pending[o.project];
  const [status, dot] = orchestratorStatus({ ...o, pending });
  const p = o.progress, elapsed = o.started ? formatLeft(Math.max(0, (Date.now() - new Date(o.started.replace(" ", "T")).getTime()) / 1000)) : null;
  const counts = [`${o.running.length} running`, o.queued.length ? `${o.queued.length} queued` : null].filter(Boolean).join(" · ");
  return card(t)
    .child(h_flex().id(`orch-${o.name}`).h(42).flex_none().px(12).gap(8).items_center()
      .when(o.where === "app", (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => view.focusTerminal(o.address)))
      .child(div().size(8).flex_none().rounded_full().bg(t[dot]))
      .child(div().flex_none().text_size(14).font_semibold().child(o.project))
      .child(dim(t, o.name).flex_1().min_w(0).truncate())
      .child(div().flex_none().text_size(13).text_color(t.muted).child(status))
      .when(o.where === "app", (e) => e.child(pauseButton(view, o, pending, t))))
    .child(panelBody(t).p(12).gap(12)
      .when(o.activity.updates.length > 0, (e) => e.child(latestUpdate(view, o, t)))
      .child(v_flex().gap(5)
        .child(h_flex().items_baseline().gap(6)
          .child(div().text_size(15).font_semibold().child(p ? `${p.done} of ${p.total}` : DASH))
          .child(div().flex_1())
          .child(small(t, counts)))
        .when(Boolean(p), (e) => e.child(steps(p.done, Math.min(o.running.length, p.total - p.done), p.total, t))))
      .child(h_flex().items_start().gap(12)
        .child(stat("Elapsed", elapsed, t))
        .child(stat("Last entry", ago(o.activity.lastAt), t))
        .child(stat("Decided", String(o.activity.decided), t))
        .child(div().flex_1())
        .child(v_flex().gap(4).items_end().child(dim(t, "Context")).child(contextRing(o.context, t))))
      .when(Boolean(o.model), (e) => e.child(dim(t, o.model))))
    .child(workerList(view, o, "running", o.running, t))
    .when(o.queued.length > 0, (e) => e.child(workerList(view, o, "queued", o.queued, t)))
    .child(workerList(view, o, "completed", o.completed, t))
    .when(Boolean(o.repo), (e) => e.child(runActions(view, o, pending, t)));
}

// The main button takes the whole width, so nothing here depends on how wide the panel is.
function decisionActions(view, d, t) {
  const action = d.kind === "ACTION", reply = action ? view.actionText : view.replyText;
  const { label, enabled } = decisionButton({ kind: d.kind, option: view.option, reply, sending: view.sending });
  return v_flex().gap(4)
    .child(primary(`answer-${d.id}`, label, enabled, (_e, cx) => (action ? view.answerAction(d, cx) : view.sendDecision(d, cx)), t).w_full())
    .child(h_flex().gap(6).items_center().justify_center()
      .child(ghost(`discuss-${d.id}`, "Discuss in chat", (_e, cx) => view.chat(d, cx), t))
      .child(ghost(`dismiss-${d.id}`, "Dismiss", (_e, cx) => { view.dismiss(view.decisionKey(d)); cx.notify(); }, t)));
}

// A named line of a decision: the name in a fixed column, so the text lines up down the card.
const fact = (name, text, t) => h_flex().gap(8).items_start().text_size(12)
  .child(div().w(44).flex_none().text_color(t.dim).child(name))
  .child(div().flex_1().min_w(0).text_color(t.muted).child(text));

function decisionCard(view, t) {
  const { decisions } = view.data, total = decisions.length, key = "decisions", open = view.isOpen(key);
  const d = decisions[view.at];
  const step = (by) => (_e, cx) => { cx.stop_propagation(); view.step(by); cx.notify(); };
  const head = sectionHead({
    id: key, title: "Decisions", count: total, open, onToggle: (_e, cx) => { view.toggle(key); cx.notify(); },
    right: total ? h_flex().gap(6).items_center()
      .child(arrow("decision-prev", "‹", step(-1), t))
      .child(div().min_w(42).text_center().child(`${view.at + 1} of ${total}`))
      .child(arrow("decision-next", "›", step(1), t)) : null, t,
  });
  const { hidden, dismissedDecisions } = view.data;
  const restore = dismissedDecisions ? ghost("restore-decisions", `Show ${dismissedDecisions} dismissed`, (_e, cx) => { view.restore("decision"); cx.notify(); }, t) : null;
  const notes = h_flex().flex_wrap().px(12).py(7).gap(6).items_center().bg(t.raised).border_t(1).border_color(t.border)
    .when(hidden > 0, (e) => e.child(dim(t, `+${hidden} from stopped sessions`)))
    .when(Boolean(restore), (e) => e.child(restore));
  const body = !d ? null : panelBody(t).px(12).pt(9).pb(8).gap(10)
    .child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted)
      .child(div().size(7).flex_none().rounded_full().bg(t.blocked))
      .child(div().flex_none().font_family(monoFont()).text_color(t.foreground).child(d.id))
      .child(div().min_w(0).truncate().font_family(monoFont()).text_color(t.dim).child(d.orch))
      .child(div().flex_1()).child(div().flex_none().child(ago(d.time) ?? d.time)))
    .children(d.kind === "ACTION" ? action(view, d, t) : choice(view, d, t))
    .when(Boolean(view.replyError), (e) => e.child(problemLine(view.replyError, t)))
    .child(decisionActions(view, d, t));
  return card(t).child(head).when(open && Boolean(body), (e) => e.child(body))
    .when(open && (Boolean(restore) || hidden > 0), (e) => e.child(notes));
}

function choice(view, d, t) {
  return [
    div().font_semibold().child(d.question ?? DASH),
    ...(d.blocks ? [fact("Blocks", d.blocks, t)] : []),
    v_flex().gap(4).children(d.options.map((o) => {
      const on = o.key === view.option, best = o.key === d.recommendation;
      return div().id(`option-${o.key}`).min_h(30).px(10).py(5).rounded(6).border_1().border_color(on ? t.solid : t.border).cursor_pointer()
        .when(on, (e) => e.bg(t.popover)).text_color(on || best ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { view.option = on ? null : o.key; view.replyError = null; cx.notify(); })
        .child(`${o.key}. ${best ? o.label.replace(/[.;:,]+$/, "") + ", recommended" : o.label}`);
    })),
    lineField(view.replyInput, t),
  ];
}

function commandButtons(view, d, t) {
  const safe = pasteable(d.run), here = Boolean(d.address);
  return h_flex().gap(6).items_center()
    .child(outline(`copy-${d.id}`, "Copy", (_e, cx) => view.copyCommand(d, cx), t))
    .child(outline(`paste-${d.id}`, "Put in terminal", safe && here ? (_e, cx) => view.putInTerminal(d, cx) : null, t,
      !safe ? "Has a control character" : !here ? "Terminal not in this app" : null));
}

function action(view, d, t) {
  return [
    div().font_semibold().child(d.doing ?? "Needs you"),
    ...(d.run ? [div().px(10).py(9).rounded(6).border_1().border_color(t.border).bg(t.canvas)
      .font_family(monoFont()).text_size(12).child(d.run), commandButtons(view, d, t)] : []),
    ...(d.why || d.place || d.blocks ? [v_flex().gap(4)
      .when(Boolean(d.why), (e) => e.child(fact("Why", d.why, t)))
      .when(Boolean(d.place), (e) => e.child(fact("Where", d.place, t)))
      .when(Boolean(d.blocks), (e) => e.child(fact("Blocks", d.blocks, t)))] : []),
    lineField(view.actionInput, t),
  ];
}

const ticketList = (refs, t) => div().min_w(0).font_family(monoFont()).text_size(12).text_color(t.muted).child(refs.map(shortRef).join(", "));

// One planner: its tickets, what's been answered and what's open. The open question is answered in Decisions.
function planningCard(view, s, t) {
  const key = `planning:${s.session}`, open = view.isOpen(key);
  const row = (id, tail, text) => v_flex().gap(3).child(div().font_family(monoFont()).text_size(12).text_color(t.muted).child(`${id} · ${tail}`)).child(div().child(text ?? DASH));
  return card(t).when(view.frame.focus === s.session, (e) => e.border_color(t.input))
    .child(sectionHead({ id: key, title: "Planning", open, right: s.time, onToggle: (_e, cx) => { view.toggle(key); cx.notify(); }, t }))
    .when(open, (e) => e.child(panelBody(t).p(12).gap(10)
      .child(ticketList(s.tickets, t))
      .children(s.board.answered.map((a) => row(a.id, "answered", a.question).child(dim(t, a.answer))))
      .children(s.board.open.map((d) => div().id(`planning-${d.id}`).cursor_pointer().on_click((_e, cx) => { view.showDecision(d.id); cx.notify(); }).child(row(d.id, "open", d.question))))));
}

// What Go's rules say about starting this, or Start's error, under the buttons. When a usage meter is one of the
// holds, Start anyway lets every held meter go until it resets. It doesn't lift the worker limit or Go's rules.
function problemsList(view, id, problems, t) {
  const lines = problems.map((p) => problemLine(p, t));
  if (!view.usageHeld().some((h) => problems.includes(h.text))) return lines;
  return [...lines, h_flex().gap(8).items_center()
    .child(div().flex_1())
    .child(ghost(`anyway-${id}`, "Start anyway", (_e, cx) => view.overrideUsage(cx), t))];
}

function planReadyCard(view, s, t) {
  const key = `ready:${s.session}`, open = view.isOpen(key), problems = view.sessionProblems(s, view.frame.rows), starting = view.isStarting(`start:${s.session}`);
  return card(t).when(view.frame.focus === s.session, (e) => e.border_color(t.input))
    .child(sectionHead({ id: key, title: "Plan ready", open, right: elapsed(s.created, new Date(s.board.ready.replace(" ", "T")).getTime()), onToggle: (_e, cx) => { view.toggle(key); cx.notify(); }, t }))
    .when(open, (e) => e.child(panelBody(t).p(12).gap(9)
      .child(ticketList(s.tickets, t))
      .children(s.board.plans.map((p) => h_flex().gap(8).items_baseline()
        .child(div().flex_none().font_semibold().child(p.project))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(`orch-${p.project}`))
        .child(small(t, `${p.tickets.length} ${p.tickets.length === 1 ? "ticket" : "tickets"}`))))
      .child(h_flex().id(`read-${s.session}`).h(30).px(10).gap(8).items_center().rounded(6).cursor_pointer().border_1().border_color(t.border).hover((h) => h.bg(t.hover))
        .on_click(() => view.readSaved(s))
        .child(div().child("Open plan")).child(div().flex_1()).child(dim(t, "›")))
      .children(problemsList(view, `ready-${s.session}`, problems, t))
      .child(h_flex().gap(6).items_center()
        .child(ghost(`keep-${s.session}`, "Keep", (_e, cx) => view.keepPlan(s, cx), t))
        .child(div().flex_1())
        .child(primary(`start-${s.session}`, starting ? "Starting…" : "Start", !problems.length && !starting, (_e, cx) => { view.askStartSession(s); cx.notify(); }, t))))
      .when(view.startFor?.key === `start:${s.session}`, (e) => e.child(startSheet(view, t))));
}

// Choosing a project starts nothing. New plan does.
function newPlan(view, t) {
  const { projects } = view.data, chosen = projects.find((p) => p.file === view.planFor), open = view.planOpen;
  const search = view.planSearch.trim().toLowerCase();
  const shown = search ? projects.filter((p) => `${p.name} ${p.file}`.toLowerCase().includes(search)) : projects;
  const option = (p) => h_flex().id(`new-plan-${p.file}`).h(26).flex_none().px(8).items_center().rounded(6).cursor_pointer()
    .when(p.file === view.planFor, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => { view.pickPlanProject(p.file); cx.notify(); })
    .child(div().flex_1().min_w(0).truncate().child(p.name));
  const trigger = h_flex().id("new-plan-project").h(30).flex_1().min_w(0).px(8).gap(6).items_center().rounded(6).cursor_pointer().border_1().border_color(t.border).bg(t.background)
    .text_color(chosen ? t.foreground : t.dim)
    .child(div().flex_1().min_w(0).truncate().child(chosen?.name ?? "Project"))
    .child(svg("mods/files/chevron-down.svg").size(12).flex_none().text_color(t.dim));
  const list = !open ? v_flex() : v_flex().w(240).p(4).gap(4).rounded(8).bg(t.popover).border_1().border_color(t.border)
    .child(h_flex().h(28).flex_none().px(8).items_center().rounded(6).border_1().border_color(t.border).bg(t.background)
      .child(Input.new(view.planInput).h_full().flex_1().text_size(12).text_color(t.foreground)))
    .child(v_flex().id("new-plan-list").h(Math.max(1, Math.min(shown.length, 8)) * 27).flex_none().overflow_y_scrollbar().gap(1).children(shown.map(option)));
  const picker = Popover.new("new-plan-popover").open(open).anchor("bottom_left")
    .on_open_change((o, cx) => { view.planOpen = o; view.planInput.set_value(""); view.planSearch = ""; if (o) view.planInput.focus(); cx.notify(); })
    .trigger(trigger).content(list);
  return v_flex().flex_none().px(12).py(9).gap(6).bg(t.raised).border_t(1).border_color(t.border)
    .child(h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).child(picker))
      .child(h_flex().id("new-plan-go").h(30).px(12).flex_none().items_center().rounded(8).font_semibold().text_size(12).bg(t.solid).text_color(t.solid_foreground)
        .when(!chosen, (e) => e.opacity(0.4)).when(Boolean(chosen), (e) => e.cursor_pointer().on_click((_e, cx) => view.createPlan(cx)))
        .child("New plan")))
    .when(Boolean(view.planError), (e) => e.child(problemLine(view.planError, t)));
}

// One row in Plans: its name and age, then its buttons, then why it can't start. A row stacks because three buttons and
// a name don't fit across the panel.
function planRow(view, { id, title, meta, buttons, problems, focused: on, sheet }, t) {
  return v_flex().id(id).flex_none()
    .child(v_flex().px(12).py(9).gap(6).bg(on ? t.selected : t.raised).border_t(1).border_color(t.border)
      .child(h_flex().min_w(0).gap(8).items_baseline()
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(title))
        .when(Boolean(meta), (e) => e.child(div().flex_none().text_size(12).text_color(t.dim).child(meta))))
      .child(h_flex().gap(4).items_center().children(buttons))
      .children(problemsList(view, id, problems, t)))
    .when(Boolean(sheet), (e) => e.child(sheet));
}

const startButton = (id, starting, problems, onClick, t) => (problems.length || starting
  ? h_flex().id(id).h(26).px(8).flex_none().items_center().rounded(6).text_size(12).text_color(t.dim).opacity(0.6).child(starting ? "Starting…" : "Start")
  : ghost(id, "Start", onClick, t));

function keptRow(view, s, t) {
  const problems = view.sessionProblems(s, view.frame.rows), age = ageOf(s.board.kept, Date.now());
  return planRow(view, {
    id: `kept-${s.session}`, title: s.tickets.map(shortRef).join(", "), focused: view.frame.focus === s.session, problems,
    sheet: view.startFor?.key === `start:${s.session}` ? startSheet(view, t) : null,
    meta: ["Kept", s.board.plans.map((p) => p.project).join(", "), age].filter(Boolean).join(" · "),
    buttons: [
      ghost(`read-${s.session}`, "Open plan", () => view.readSaved(s), t),
      startButton(`start-${s.session}`, view.isStarting(`start:${s.session}`), problems, (_e, cx) => { view.askStartSession(s); cx.notify(); }, t),
      ghost(`discard-${s.session}`, "Discard", (_e, cx) => view.discardPlan(s, cx), t),
    ],
  }, t);
}

function queuedRow(view, p, t) {
  const problems = view.queuedProblems(p), age = ageOf(p.updated ? `${p.updated} 00:00` : null, Date.now());
  return planRow(view, {
    id: `plan-${p.file}`, title: p.name, problems,
    sheet: view.startFor?.key === `run:${p.file}` ? startSheet(view, t) : null,
    meta: [p.needsYou ? "Needs you" : null, age].filter(Boolean).join(" · "),
    buttons: [
      ghost(`read-${p.file}`, "Open plan", () => view.readPlan(p), t),
      startButton(`start-plan-${p.file}`, view.isStarting(`run:${p.file}`), problems, (_e, cx) => { view.askStartQueued(p); cx.notify(); }, t),
      ghost(`dismiss-plan-${p.file}`, "Dismiss", (_e, cx) => { view.dismiss(view.planKey(p)); cx.notify(); }, t),
    ],
  }, t);
}

function plansCard(view, t) {
  const { plans, dismissedPlans } = view.data, key = "plans", open = view.isOpen(key);
  const kept = view.frame.rows.filter(keptPlan), count = plans.length + kept.length;
  return card(t)
    .child(sectionHead({ id: key, title: "Plans", count, open, onToggle: (_e, cx) => { view.toggle(key); cx.notify(); }, t }))
    .when(open, (e) => e.children([...kept.map((s) => keptRow(view, s, t)), ...plans.map((p) => queuedRow(view, p, t))])
      .when(dismissedPlans > 0, (e) => e.child(h_flex().px(8).py(4).bg(t.raised).border_t(1).border_color(t.border)
        .child(ghost("restore-plans", `Show ${dismissedPlans} dismissed`, (_e, cx) => { view.restore("plan"); cx.notify(); }, t))))
      .child(newPlan(view, t)));
}

function orchestratorsCard(view, t) {
  const { orchestrators } = view.data, key = "orchestrators", open = view.isOpen(key);
  return card(t)
    .child(sectionHead({ id: key, title: "Orchestrators", count: orchestrators.length, open, onToggle: (_e, cx) => { view.toggle(key); cx.notify(); }, t }))
    .when(open && orchestrators.length > 0, (e) => e.child(panelBody(t).p(8).gap(8).children(orchestrators.map((o) => orchestratorCard(view, o, t)))));
}

const HOLDERS = { app: "Running", terminal: "Running in terminal" };

function header(view, t) {
  const { where } = view.data.holder;
  return v_flex().flex_none().border_b(1).border_color(t.border)
    .child(h_flex().h(48).px(12).gap(8).items_center()
      .child(div().text_size(15).font_semibold().child("Orchi"))
      .child(div().size(7).flex_none().rounded_full().bg(where ? t.done : t.dim))
      .child(small(t, HOLDERS[where] ?? "Stopped"))
      .child(div().flex_1())
      .when(view.stale, (e) => e.child(dim(t, "Out of date")))
      .child(ghost("open-chat", "Open chat", (_e, cx) => view.chat(null, cx), t)))
    .when(Boolean(view.note || view.actionError) && view.noticeShown(), (e) => e.child(notice(view, t)));
}

// A press's note or error, with Dismiss. It clears itself after a while too, so it doesn't hold every card down.
function notice(view, t) {
  return h_flex().pl(12).pr(8).pb(8).gap(8).items_start()
    .child(v_flex().flex_1().min_w(0).gap(4).pt(4)
      .when(Boolean(view.note), (e) => e.child(dim(t, view.note)))
      .when(Boolean(view.actionError), (e) => e.child(problemLine(view.actionError, t))))
    .child(ghost("dismiss-notice", "Dismiss", (_e, cx) => { view.dismissNotice(); cx.notify(); }, t));
}

function meter(m, count, t) {
  const cells = meterCells(m, count).map((c) => div().w(1.5).h(16).flex_none().bg(c.part === "used" ? t[m.tone] : c.part === "ahead" ? t.dim : t.popover));
  return v_flex().flex_1().min_w(0).gap(3)
    .child(h_flex().min_w(0).items_baseline().gap(6).text_size(12)
      .child(div().min_w(0).truncate().text_color(t.dim).child(m.label)).child(div().flex_1())
      .child(div().flex_none().font_semibold().child(`${Math.round(m.used)}%`)))
    .child(h_flex().h(24).gap(4).items_center().overflow_hidden().children(cells))
    .child(h_flex().min_w(0).gap(6).text_size(12).text_color(t.dim)
      .child(div().min_w(0).truncate().child(`↻ ${m.resetIn}`)).child(div().flex_1())
      .child(div().flex_none().child(`→ ${m.projected == null ? DASH : `${Math.round(m.projected)}%`}`)));
}

function footer(view, t) {
  const { usage } = view.data, count = meterTicks(view.size?.width, usage.length);
  return h_flex().flex_none().px(12).pt(10).pb(11).gap(16).border_t(1).border_color(t.border).bg(t.background)
    .children(usage.map((m) => meter(m, count, t)));
}

export function orchiView(view, t) {
  const { rows } = view.frame;
  const planning = rows.filter((s) => s.planner && !s.board.ready && !s.board.kept && !s.board.started);
  const ready = rows.filter((s) => planReady(s, Date.now()));
  return v_flex().id("orchi").on_size_change((size, cx) => { if (size.width !== view.size?.width) { view.size = size; cx.notify(); } }).size_full().min_h(0).rounded(10).overflow_hidden().bg(t.canvas).border_1().border_color(t.border)
    .text_color(t.foreground).text_size(13)
    .child(header(view, t))
    .child(v_flex().id("orchi-list").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(10)
      .children(planning.map((s) => planningCard(view, s, t)))
      .children(ready.map((s) => planReadyCard(view, s, t)))
      .child(decisionCard(view, t))
      .child(plansCard(view, t))
      .child(orchestratorsCard(view, t)))
    .when(view.data.usage.length > 0, (e) => e.child(footer(view, t)));
}
