// Draws the queue: header, filters, project cards and the selection bar.
// `view` is the Linear view, which owns the state and the actions used here.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { filterIssues, ago } from "./linear.js";
import { counts, ticketGroups, staleNote } from "./queue.js";
import { card, sectionHead, segment, statusBand, problemLine, monoFont } from "./ui.js";

// The plain-text second line of a row: labels, then the age.
export const metaLine = (issue) => [...issue.labels.map((l) => l.name).slice(0, 3), ago(issue.updatedAt)].join(" · ");

// A plain element, not `Checkbox`: that reports through `on_change` and ignored the `on_click` here,
// and a press has to stop before the row under it opens the ticket. The padding is the press target.
export function tickBox(view, issue, t) {
  const on = view.ticked.has(issue.id);
  return div().id(`tick-${issue.id}`).flex_none().p(3).m(-1).cursor_pointer()
    .on_click((_e, cx) => { cx.stop_propagation(); view.tick(issue.id, cx); })
    .child(div().size(14).flex().items_center().justify_center().rounded(4).border_1()
      .border_color(on ? t.solid : t.input).when(on, (e) => e.bg(t.solid))
      .when(on, (e) => e.child(div().text_size(10).font_semibold().text_color(t.solid_foreground).child("✓"))));
}

// A ticket in a session can't be ticked again, so its phase takes the box's place. Pressing it opens the session in Orchi.
export function ticketMark(view, issue, t) {
  const session = view.frame.inSession.get(issue.identifier);
  if (!session) return tickBox(view, issue, t);
  return div().id(`phase-${issue.id}`).flex_none().size(20).m(-1).flex().items_center().justify_center().cursor_pointer()
    .on_click((_e, cx) => { cx.stop_propagation(); view.openSession(session.session); })
    .child(div().size(8).rounded_full().bg(t[session.dot]));
}

// The phase, or the new status while it waits to go to Linear, leads the line.
function rowMeta(view, issue) {
  const state = view.frame.staged[issue.identifier], session = view.frame.inSession.get(issue.identifier);
  const links = (view.frame.links[issue.identifier] ?? []).map((l) => `+ PR #${l.number}`);
  const lead = [session ? `In Herdr: ${session.phase.toLowerCase()}` : null, state ? `→ ${state.name}` : null, ...links].filter(Boolean);
  return [...lead, metaLine(issue)].join(" · ");
}

function row(view, issue, t) {
  const on = view.ticked.has(issue.id);
  return h_flex().id(`issue-${issue.id}`).flex_none().px(12).py(7).gap(10).items_start().cursor_pointer()
    .border_t(1).border_color(t.border).when(on, (e) => e.bg(t.selected))
    .hover((s) => s.bg(on ? t.selected : t.hover))
    .on_click((_e, cx) => { view.selected = issue.id; cx.notify(); })
    .child(ticketMark(view, issue, t))
    .child(v_flex().flex_1().min_w(0)
      .child(h_flex().gap(7).items_center()
        .child(div().flex_none().font_family(monoFont()).text_size(12).text_color(t.muted).child(issue.identifier))
        .child(div().flex_1().min_w(0).truncate().child(issue.title)))
      .child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(rowMeta(view, issue))));
}

function projectCard(view, group, searching, t) {
  const key = `project:${group.label}`, open = searching || !view.closed.has(key);
  const ticked = group.issues.filter((i) => view.ticked.has(i.id)).length;
  return card(t)
    .child(sectionHead({
      id: key, title: group.label, count: group.count, open,
      right: ticked ? `${ticked} ticked` : null,
      onToggle: (_e, cx) => { view.toggleCard(key); cx.notify(); }, t,
    }))
    .when(open, (e) => e.children(group.groups.map((inner) =>
      v_flex().flex_none().bg(t.raised).border_t(1).border_color(t.border)
        .child(statusBand({ label: inner.label, count: inner.issues.length, dot: inner.dot, t }))
        .children(inner.issues.map((issue) => row(view, issue, t))))));
}

// One row a session: its phase, where it runs and how long, then its tickets and a line of detail.
function sessionRow(view, row, t) {
  return v_flex().id(`session-${row.session}`).flex_none().px(12).py(9).gap(5).cursor_pointer().bg(t.raised).border_t(1).border_color(t.border)
    .hover((s) => s.bg(t.hover)).on_click(() => view.openSession(row.session))
    .child(h_flex().gap(7).items_center()
      .child(div().size(7).flex_none().rounded_full().bg(t[row.dot]))
      .child(div().flex_none().font_semibold().child(row.phase))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(row.where))
      .child(div().flex_none().text_size(12).text_color(t.dim).child(row.time)))
    .child(div().min_w(0).truncate().font_family(monoFont()).text_size(12).text_color(t.muted).child(row.tickets.join(", ")))
    .child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(row.detail));
}

function inHerdrCard(view, rows, t) {
  const key = "in-herdr", open = !view.closed.has(key);
  return card(t)
    .child(sectionHead({ id: key, title: "In Herdr", count: rows.length, open, onToggle: (_e, cx) => { view.toggleCard(key); cx.notify(); }, t }))
    .when(open, (e) => e.children(rows.map((row) => sessionRow(view, row, t))));
}

// A failed load keeps the list it had, and the reason shows under the title, as Orchi does.
function header(view, t) {
  const note = staleNote(view.error, view.issues.length, view.cut);
  return v_flex().flex_none().px(12).pt(12).pb(10).gap(10).border_b(1).border_color(t.border)
    .child(h_flex().gap(8).items_center()
      .child(div().text_size(15).font_semibold().child("Linear"))
      .child(div().text_size(12).text_color(t.dim).child(`${view.issues.length} open`))
      .child(div().flex_1())
      .child(h_flex().id("refresh").size(26).items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => view.refresh(cx))
        .child(view.loading ? "…" : "↻")))
    .when(Boolean(note), (e) => e.child(view.error ? problemLine(note, t) : div().text_size(12).text_color(t.dim).child(note)))
    .child(segment({
      id: "bucket", value: view.bucket, t,
      items: [["all", "All"], ["active", "Active"], ["backlog", "Backlog"], ["review", "In review"]]
        .map(([id, label]) => ({ id, label: `${label} ${view.counts[id]}` })),
      onPick: (id, cx) => { view.bucket = id; cx.notify(); },
    }))
    .child(h_flex().h(30).px(10).items_center().rounded(8).border_1()
      .border_color(view.text.trim() ? t.accent : t.border)
      .child(Input.new(view.search).h_full().flex_1().text_size(12).text_color(t.foreground)));
}

function selectionBar(view, t) {
  return h_flex().flex_none().px(12).py(10).gap(10).items_center().border_t(1).border_color(t.border).bg(t.background)
    .child(div().font_semibold().child(`${view.ticked.size} selected`))
    .child(h_flex().id("clear-ticks").h(26).px(6).items_center().rounded(6).cursor_pointer().text_color(t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { view.ticked = new Set(); cx.notify(); }).child("Clear"))
    .child(div().flex_1())
    .child(h_flex().id("review").h(32).px(16).items_center().rounded(8).cursor_pointer().font_semibold()
      .bg(t.solid).text_color(t.solid_foreground)
      .on_click((_e, cx) => view.review(cx)).child("Review"));
}

function updateBar(view, count, t) {
  const busy = view.runnerBusy();
  return v_flex().flex_none().px(12).py(10).gap(8).border_t(1).border_color(t.border).bg(t.background)
    .when(Boolean(view.updateError), (e) => e.child(problemLine(view.updateError, t)))
    .child(h_flex().gap(10).items_center()
      .child(div().font_semibold().child(`${count} to update`))
      .child(h_flex().id("discard-changes").h(26).px(6).items_center().rounded(6).cursor_pointer().text_color(t.muted)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => view.discardChanges(cx)).child("Discard"))
      .child(div().flex_1())
      .child(h_flex().id("update-tickets").h(32).px(16).items_center().rounded(8).font_semibold().bg(t.solid).text_color(t.solid_foreground)
        .when(busy, (e) => e.opacity(0.4)).when(!busy, (e) => e.cursor_pointer().on_click((_e, cx) => view.updateTickets(cx)))
        .child(busy ? "Updating" : "Update tickets")));
}

// Returns the children of the panel's root, top to bottom.
export function queueView(view, t) {
  const searching = Boolean(view.text.trim());
  const list = filterIssues(view.issues, { status: "all", text: view.text });
  view.counts = counts(list);
  const { assigned, rows } = view.frame, changes = view.changed();
  const groups = ticketGroups(list, view.bucket, (issue) => view.linked(issue, assigned)?.name ?? issue.project);
  return [
    header(view, t),
    v_flex().id("linear-list").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(10)
      .when(rows.length > 0, (e) => e.child(inHerdrCard(view, rows, t)))
      .children(groups.map((group) => projectCard(view, group, searching, t)))
      .when(!groups.length, (e) => e.child(view.error ? div().p(8).child(problemLine(view.emptyText(), t)) : div().p(8).text_color(t.dim).child(view.emptyText()))),
    ...(view.ticked.size ? [selectionBar(view, t)] : []),
    ...(changes.length ? [updateBar(view, changes.length, t)] : []),
  ];
}
