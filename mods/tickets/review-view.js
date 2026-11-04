// Draws the review screen: the tickets, the session instructions and the Go footer.
// `view` is the Tickets view, which owns the state and the actions used here.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Popover, Input, Textarea } from "gpui-base";
import { EFFORTS, MODELS, pickModel, pickEffort } from "./review.js";
import { filterProjects } from "./legwork.js";
import { card, panelBody, sectionHead, segment, problemLine, monoFont } from "./ui.js";
import { rowId } from "./tickets.js";
import { sourceIcon } from "./queue-view.js";

const FLAT = "popover";

// One model choice: the name, the effort label and five rising bars, then a segment of models.
// `models` is MODELS, or ["Auto", ...MODELS] for Workers. `onChange(choice, cx)` gets the new choice.
export function modelSelector({ id, name, choice, models, onChange, t }) {
  const auto = choice.effort === "Auto";
  const level = EFFORTS.indexOf(choice.effort);
  const bar = (effort, i) => div().id(`effort-${id}-${effort}`).flex_none().w(9).h(16).flex().items_end().justify_center().cursor_pointer()
    .on_click((_e, cx) => onChange(pickEffort(choice, effort), cx))
    .child(div().w(5).h(6 + i * 2).rounded(2).bg(!auto && i <= level ? t.solid : t[FLAT]));
  return v_flex().flex_none().gap(6)
    .child(h_flex().gap(7).items_center()
      .child(svg("mods/tickets/role.svg").size(13).flex_none().text_color(t.muted))
      .child(div().font_semibold().child(name))
      .child(div().flex_1())
      .child(div().text_size(12).text_color(t.muted).child(choice.effort))
      .child(h_flex().children(EFFORTS.map(bar))))
    .child(segment({
      id, value: choice.model, t,
      items: models.map((m) => ({ id: m, label: m })),
      onPick: (m, cx) => onChange(pickModel(choice, m), cx),
    }));
}

const field = (t) => h_flex().h(32).px(10).items_center().rounded(8).border_1().border_color(t.border).bg(t.background);

const PICKER_ROW = 27, PICKER_ROWS = 8;

// The legwork project picker: a search field over a list that scrolls. The list scrolls itself because
// a `Popover` draws its `content` in its own layer, and scrolling on that element did nothing.
export function legworkPicker(view, ticket, t) {
  const project = view.linked(ticket, view.frame.picks), open = view.pickerOpen === ticket.ref;
  const shown = filterProjects(view.projects, view.pickerText);
  const option = (key, label, file, chosen) => h_flex().id(`pick-${ticket.ref}-${key}`).h(26).flex_none().px(8).items_center().rounded(6)
    .cursor_pointer().when(chosen, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => { view.pick(ticket, file); view.pickerOpen = null; view.checkTrust(cx); cx.notify(); })
    .child(div().flex_1().min_w(0).truncate().text_color(chosen ? t.foreground : t.muted).child(label));
  const trigger = h_flex().id(`picker-${ticket.ref}`).h(24).px(8).gap(6).items_center().rounded(6).cursor_pointer().border_1()
    .border_color(t.border).bg(t.background).text_color(project ? t.foreground : t.dim)
    .child(div().max_w(150).truncate().child(project?.name ?? "None"))
    .child(svg("mods/files/chevron-down.svg").size(12).flex_none().text_color(t.dim));
  const rows = Math.min(shown.length + 1, PICKER_ROWS);
  // The search field exists only while this popover is open, because every ticket shares its state.
  const list = !open ? v_flex() : v_flex().w(240).p(4).gap(4).rounded(8).bg(t.popover).border_1().border_color(t.border)
    .child(h_flex().h(28).flex_none().px(8).items_center().rounded(6).border_1().border_color(t.border).bg(t.background)
      .child(Input.new(view.picker).h_full().flex_1().text_size(12).text_color(t.foreground)))
    .child(v_flex().id(`picker-list-${ticket.ref}`).h(rows * PICKER_ROW).flex_none().overflow_y_scrollbar().gap(1)
      .child(option("none", "None", "", !project))
      .children(shown.map((p) => option(p.file, p.name, p.file, project?.file === p.file))));
  return Popover.new(`popover-${ticket.ref}`).open(open).anchor("top_left")
    .on_open_change((o, cx) => { view.pickerOpen = o ? ticket.ref : null; view.picker.set_value(""); view.pickerText = ""; if (o) view.picker.focus(); cx.notify(); })
    .trigger(trigger).content(list);
}

// A legwork ticket is its own project. Any other can be given one here, for this panel's sessions.
function ticketRow(view, ticket, t) {
  const id = rowId(ticket);
  return v_flex().flex_none().px(12).py(8).gap(5).border_t(1).border_color(t.border)
    .child(h_flex().gap(7).items_center()
      .child(sourceIcon(ticket.source, 13, t.muted))
      .when(Boolean(id), (e) => e.child(div().flex_none().font_family(monoFont()).text_size(12).text_color(t.muted).child(id)))
      .child(div().flex_1().min_w(0).truncate().child(ticket.title))
      .child(h_flex().id(`remove-${ticket.ref}`).flex_none().size(18).items_center().justify_center().rounded(4).cursor_pointer()
        .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => view.untick(ticket.ref, cx)).child("×")))
    .when(ticket.source !== "legwork", (e) => e.child(h_flex().gap(8).items_center().text_size(12).text_color(t.dim)
      .child("Legwork").child(legworkPicker(view, ticket, t))));
}

function ticketsCard(view, tickets, t) {
  const key = "review:tickets", open = !view.closed.has(key);
  return card(t)
    .child(sectionHead({ id: key, title: "Tickets", count: tickets.length, open, onToggle: (_e, cx) => { view.toggleCard(key); cx.notify(); }, t }))
    .when(open, (e) => e.child(panelBody(t).id("review-tickets").max_h(240).overflow_y_scrollbar().children(tickets.map((ticket) => ticketRow(view, ticket, t)))));
}

function label(text) { return div().flex_none().font_semibold().child(text); }

function instructionsCard(view, t) {
  const key = "review:session", open = !view.closed.has(key), s = view.frame.session;
  const role = (id, name, models) => modelSelector({
    id, name, choice: s[id], models, t,
    onChange: (choice, cx) => view.setSession({ [id]: choice }, cx),
  });
  return card(t).flex_1().min_h(0).flex_shrink(open ? 1 : 0)
    .child(sectionHead({ id: key, title: "Session instructions", open, onToggle: (_e, cx) => { view.toggleCard(key); cx.notify(); }, t }))
    .when(open, (e) => e.child(panelBody(t).flex_1().min_h(0).p(12).gap(13)
      .child(role("switchboard", "Switchboard", MODELS))
      .child(role("orchestrator", "Orchestrator", MODELS))
      .child(role("workers", "Workers", ["Auto", ...MODELS]))
      .child(v_flex().flex_none().gap(6).child(label("Pull requests"))
        .child(field(t).child(Input.new(view.prsInput).h_full().flex_1().text_size(13).text_color(t.foreground))))
      .child(v_flex().flex_none().gap(6).child(label("After planning"))
        .child(segment({
          id: "after", value: s.after, t,
          items: [{ id: "start", label: "Start" }, { id: "wait", label: "Wait" }],
          onPick: (after, cx) => view.setSession({ after }, cx),
        })))
      .child(v_flex().flex_1().min_h(72).gap(6).child(label("Instructions"))
        .child(div().flex_1().min_h(0).p(8).rounded(8).border_1().border_color(t.border).bg(t.background)
          .child(Textarea.new(view.extraInput).size_full().text_size(13).text_color(t.foreground))))));
}

function footer(view, problems, t) {
  const lines = [...problems, ...(view.goError ? [view.goError] : [])];
  const blocked = problems.length > 0 || view.going;
  return h_flex().flex_none().px(12).py(10).gap(10).items_center().border_t(1).border_color(t.border).bg(t.background)
    .child(div().flex_1().min_w(0).when(lines.length > 0, (e) => e.child(problemLine(lines.join(". "), t))))
    .child(h_flex().id("go").flex_none().h(36).px(24).items_center().justify_center().rounded(8).font_semibold()
      .bg(t.solid).text_color(t.solid_foreground).when(blocked, (e) => e.opacity(0.4))
      .when(!blocked, (e) => e.cursor_pointer().on_click((_e, cx) => view.go(cx)))
      .child(view.going ? "Starting…" : "Go"));
}

// Returns the children of the panel's root, top to bottom.
export function reviewView(view, t) {
  const tickets = view.tickedTickets(), { picks, rows } = view.frame;
  const problems = view.problems(tickets, picks, rows, view.world, view.trust);
  return [
    h_flex().h(48).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(h_flex().id("review-back").h(26).px(6).items_center().rounded(6).cursor_pointer().text_color(t.muted)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { view.screen = "queue"; cx.notify(); }).child("‹ Back"))
      .child(div().text_size(15).font_semibold().child("Review session"))
      .child(div().flex_1())
      .child(div().text_size(12).text_color(t.dim).child(`${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`)),
    v_flex().flex_1().min_h(0).p(10).gap(10)
      .child(ticketsCard(view, tickets, t))
      .child(instructionsCard(view, t)),
    footer(view, problems, t),
  ];
}
