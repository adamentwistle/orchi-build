// Draws the list: header, source and category filters, project cards and the selection bar.
// `view` is the Tickets view, which owns the state and the actions used here.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { CATEGORIES, SOURCE_ICONS, ago, categoryCounts, filterTickets, rowId, sourceCounts } from "./tickets.js";
import { card, sectionHead, segment, problemLine, monoFont } from "./ui.js";

// A source's logo, tinted with the text.
export const sourceIcon = (source, size, color) => svg(SOURCE_ICONS[source]).size(size).flex_none().text_color(color);

// A plain element, not `Checkbox`: that reports through `on_change` and ignored the `on_click` here,
// and a press has to stop before the row under it opens the ticket. The padding is the press target.
export function tickBox(view, ticket, t) {
  const on = view.ticked.has(ticket.ref);
  return div().id(`tick-${ticket.ref}`).flex_none().p(3).m(-1).cursor_pointer()
    .on_click((_e, cx) => { cx.stop_propagation(); view.tick(ticket.ref, cx); })
    .child(div().size(14).flex().items_center().justify_center().rounded(4).border_1()
      .border_color(on ? t.solid : t.input).when(on, (e) => e.bg(t.solid))
      .when(on, (e) => e.child(div().text_size(10).font_semibold().text_color(t.solid_foreground).child("✓"))));
}

// A ticket in a session can't be ticked again, so its phase takes the box's place. Pressing it opens the session in Orchi.
export function ticketMark(view, ticket, t) {
  const session = view.frame.inSession.get(ticket.ref);
  if (!session) return tickBox(view, ticket, t);
  return div().id(`phase-${ticket.ref}`).flex_none().size(20).m(-1).flex().items_center().justify_center().cursor_pointer()
    .on_click((_e, cx) => { cx.stop_propagation(); view.openSession(session.session); })
    .child(div().size(8).rounded_full().bg(t[session.dot]));
}

// The second line: the session's phase, the state, the labels, the age.
function rowMeta(view, ticket) {
  const session = view.frame.inSession.get(ticket.ref);
  const labels = ticket.source === "legwork" ? [] : ticket.labels.slice(0, 3);
  return [session ? session.phase : null, ticket.state, ...labels, ago(ticket.updated)].filter(Boolean).join(" · ");
}

function row(view, ticket, t) {
  const on = view.ticked.has(ticket.ref), id = rowId(ticket);
  return h_flex().id(`ticket-${ticket.ref}`).flex_none().px(12).py(7).gap(10).items_start().cursor_pointer()
    .border_t(1).border_color(t.border).when(on, (e) => e.bg(t.selected))
    .hover((s) => s.bg(on ? t.selected : t.hover))
    .on_click((_e, cx) => view.open(ticket, cx))
    .child(ticketMark(view, ticket, t))
    .child(v_flex().flex_1().min_w(0)
      .child(h_flex().gap(7).items_center()
        .child(sourceIcon(ticket.source, 14, t.muted))
        .when(Boolean(id), (e) => e.child(div().flex_none().font_family(monoFont()).text_size(12).text_color(t.muted).child(id)))
        .child(div().flex_1().min_w(0).truncate().child(ticket.title)))
      .child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(rowMeta(view, ticket))));
}

function projectCard(view, group, searching, t) {
  const open = searching || !view.closed.has(group.key);
  const ticked = group.tickets.filter((x) => view.ticked.has(x.ref)).length;
  return card(t)
    .child(sectionHead({
      id: group.key, title: group.label, count: group.tickets.length, open, right: ticked ? `${ticked} ticked` : null,
      onToggle: (_e, cx) => { view.toggleCard(group.key); cx.notify(); }, t,
    }))
    .when(open, (e) => e.child(v_flex().flex_none().bg(t.raised).children(group.tickets.map((x) => row(view, x, t)))));
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
    .child(h_flex().min_w(0).gap(10).children(row.tickets.slice(0, 6).map((ref) => {
      const ticket = view.ticket(ref);
      return h_flex().flex_none().gap(5).items_center()
        .when(Boolean(ticket), (e) => e.child(sourceIcon(ticket.source, 12, t.muted)))
        .child(div().font_family(monoFont()).text_size(12).text_color(t.muted).child(ticket ? rowId(ticket) || ticket.title : ref));
    })))
    .child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(row.detail));
}

function inHerdrCard(view, rows, t) {
  const key = "in-herdr", open = !view.closed.has(key);
  return card(t)
    .child(sectionHead({ id: key, title: "In Herdr", count: rows.length, open, onToggle: (_e, cx) => { view.toggleCard(key); cx.notify(); }, t }))
    .when(open, (e) => e.children(rows.map((row) => sessionRow(view, row, t))));
}

// The source filter: All, then each source read, as its logo and a count.
function sourceChips(view, counts, t) {
  const chip = (id, content) => {
    const on = view.source === id;
    return h_flex().id(`source-${id}`).flex_1().min_w(0).h(26).gap(5).items_center().justify_center().rounded(6).cursor_pointer()
      .when(on, (e) => e.bg(t.popover)).text_color(on ? t.foreground : t.muted)
      .hover((s) => (on ? s : s.bg(t.hover)))
      .on_click((_e, cx) => { view.source = id; cx.notify(); })
      .children(content(on));
  };
  return h_flex().id("sources").flex_none().gap(2).p(2).rounded(8).bg(t.background).text_size(12)
    .child(chip("all", () => [div().child(`All ${counts.all}`)]))
    .children(view.sources.map((s) => chip(s, (on) => [sourceIcon(s, 13, on ? t.foreground : t.muted), div().child(String(counts[s] ?? 0))])));
}

// A failed load keeps the list it had, and the reason shows under the title.
function header(view, t) {
  const categoryOf = (x) => view.categoryOf(x);
  const bySource = sourceCounts(filterTickets(view.tickets, { category: view.category, text: view.text }, categoryOf), view.sources);
  const byCategory = categoryCounts(filterTickets(view.tickets, { source: view.source, text: view.text }, categoryOf), categoryOf);
  const lines = [...(view.error && view.tickets.length ? [view.error] : []), ...view.problemsSeen];
  return v_flex().flex_none().px(12).pt(12).pb(10).gap(10).border_b(1).border_color(t.border)
    .child(h_flex().gap(8).items_center()
      .child(div().text_size(15).font_semibold().child("Tickets"))
      .child(div().text_size(12).text_color(t.dim).child(String(view.tickets.length)))
      .child(div().flex_1())
      .child(h_flex().id("refresh").size(26).items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => view.refresh(cx))
        .child(view.loading ? "…" : "↻")))
    .children(lines.map((line) => problemLine(line, t)))
    .child(sourceChips(view, bySource, t))
    .child(segment({
      id: "category", value: view.category, t,
      items: CATEGORIES.map(([id, label]) => ({ id, label: `${label} ${byCategory[id] ?? 0}` })),
      onPick: (id, cx) => { view.category = id; cx.notify(); },
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

// Returns the children of the panel's root, top to bottom.
export function queueView(view, t) {
  const searching = Boolean(view.text.trim());
  const groups = view.shown(), { rows } = view.frame;
  return [
    header(view, t),
    v_flex().id("tickets-list").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(10)
      .when(rows.length > 0, (e) => e.child(inHerdrCard(view, rows, t)))
      .children(groups.map((group) => projectCard(view, group, searching, t)))
      .when(!groups.length, (e) => e.child(view.error && !view.tickets.length ? div().p(8).child(problemLine(view.emptyText(), t)) : div().p(8).text_color(t.dim).child(view.emptyText()))),
    ...(view.ticked.size ? [selectionBar(view, t)] : []),
  ];
}
