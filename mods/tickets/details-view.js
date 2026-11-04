// Draws one ticket: its tick box and title, the facts about it, its actions, then its body, or for a legwork ticket the
// briefing /pickup would give. `view` is the Tickets view, which owns the state and the actions used here.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Popover, TextView } from "gpui-base";
import { actionsFor, ago, rowId } from "./tickets.js";
import { clip } from "./briefing.js";
import { openUrl } from "./open.js";
import { sourceIcon, ticketMark } from "./queue-view.js";
import { legworkPicker } from "./review-view.js";
import { card, panelBody, problemLine, monoFont } from "./ui.js";

function barButton(id, label, onClick, t) {
  return div().id(id).px(8).h(26).flex().flex_none().items_center().rounded(6).cursor_pointer().text_size(12).text_color(t.muted)
    .hover((s) => s.bg(t.hover)).on_click(onClick).child(label);
}

function actionButton(id, text, solid, onClick, t) {
  return h_flex().id(id).h(28).px(12).flex_none().items_center().rounded(7).cursor_pointer().text_size(12.5).font_medium()
    .when(solid, (e) => e.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.88)))
    .when(!solid, (e) => e.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(text);
}

// One fact: a name on the left, its value on the right.
const fact = (label, value, t) => h_flex().min_h(24).gap(10).items_center().text_size(12)
  .child(div().w(92).flex_none().text_color(t.dim).child(label))
  .child(h_flex().flex_1().min_w(0).gap(6).items_center().flex_wrap().child(value));

// Status on a Linear ticket: the team's states, and a press moves it through orchi tickets.
function statusPicker(view, ticket, t) {
  const got = view.states.get(ticket.ref), states = got?.states ?? [], open = view.statusOpen === ticket.ref;
  const shown = view.moving === ticket.ref ? `${ticket.state} …` : ticket.state;
  if (!states.length) return div().child(shown);
  const option = (state) => h_flex().id(`status-${ticket.ref}-${state.name}`).h(26).flex_none().px(8).items_center().rounded(6).cursor_pointer()
    .when(state.name === ticket.state, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => { if (state.name !== ticket.state) view.move(ticket, state.name, cx); view.statusOpen = null; cx.notify(); })
    .child(div().min_w(0).truncate().child(state.name));
  const trigger = h_flex().id(`status-${ticket.ref}`).h(24).px(8).gap(6).items_center().rounded(6).cursor_pointer().border_1().border_color(t.border).bg(t.background)
    .child(div().min_w(0).truncate().child(shown))
    .child(svg("mods/files/chevron-down.svg").size(12).flex_none().text_color(t.dim));
  const list = !open ? v_flex() : v_flex().w(200).p(4).rounded(8).bg(t.popover).border_1().border_color(t.border)
    .child(v_flex().id(`status-list-${ticket.ref}`).h(Math.min(states.length, 8) * 27).flex_none().overflow_y_scrollbar().gap(1).children(states.map(option)));
  return Popover.new(`status-popover-${ticket.ref}`).open(open).anchor("top_left")
    .on_open_change((o, cx) => { view.statusOpen = o ? ticket.ref : null; cx.notify(); })
    .trigger(trigger).content(list);
}

// Ticket text is someone else's words: links open through `openUrl`, which only allows web addresses.
function body(view, ticket, t) {
  const got = view.bodies.get(ticket.ref);
  if (got?.error) return panelBody(t).p(12).child(problemLine(got.error, t));
  if (!got?.body) return null;
  return panelBody(t).p(12).text_size(13)
    .child(TextView.markdown(`body-${ticket.ref}`, got.body).selectable(true).on_link_click((url) => openUrl(url)));
}

const line = (name, value, t) => h_flex().gap(8).items_start()
  .child(div().flex_none().w(52).text_size(11).font_semibold().text_color(t.dim).child(name))
  .child(div().flex_1().min_w(0).text_size(12.5).line_height("18px").child(value));

// What /pickup would say: what the project is, what blocks it, the last thing that happened and what's next. Its
// status and date are the facts above.
function briefing(view, ticket, t) {
  const got = view.briefings.get(ticket.id), b = got?.brief;
  // While a new read is out the last one stays, so the card doesn't blink on each refresh.
  if (!got || (got.loading && !b)) return null;
  if (!b) return panelBody(t).p(12).child(problemLine(`${ticket.title} can't be read`, t));
  const run = [b.model, b.effort].filter(Boolean).join(" · ");
  return panelBody(t).px(14).py(12).gap(9)
    .when(Boolean(b.description), (e) => e.child(div().text_size(13).line_height("19px").child(clip(b.description, 320))))
    .when(Boolean(b.blockedOn), (e) => e.child(line("Blocked", div().text_color(t.blocked).child(clip(b.blockedOn, 200)), t)))
    .when(Boolean(b.last), (e) => e.child(line("Last", v_flex().gap(2)
      .child(div().text_size(11.5).text_color(t.dim).child(b.last.date))
      .child(div().child(clip(b.last.text, 360))), t)))
    .when(Boolean(b.task || b.prompt), (e) => e.child(line("Next", v_flex().gap(4)
      .child(div().child(clip(b.task ?? b.prompt, 360)))
      .when(Boolean(b.doneWhen), (x) => x.child(div().text_color(t.muted).child(clip(b.doneWhen, 240))))
      .when(Boolean(run), (x) => x.child(div().text_size(11.5).text_color(t.dim).child(run))), t)));
}

function actions(view, ticket, t) {
  const note = view.projectNote?.ref === ticket.ref ? view.projectNote.text : null;
  const buttons = actionsFor(ticket).filter((a) => a !== "Status").map((action) => {
    const id = `action-${action.toLowerCase().replace(/\s+/g, "-")}`;
    if (action.startsWith("Open in")) return actionButton(id, action, false, () => openUrl(ticket.url), t);
    return actionButton(id, action, action === "Send to Orchi", (cx) => view.act(action, ticket, cx), t);
  });
  return v_flex().px(12).py(10).gap(8).border_t(1).border_color(t.border)
    .when(Boolean(note), (e) => e.child(problemLine(note, t)))
    .child(h_flex().gap(8).items_center().children(buttons.slice(0, -1)).child(div().flex_1()).child(buttons.at(-1)));
}

// Returns the children of the panel's root, top to bottom.
export function detailsView(view, ticket, t) {
  const back = (_e, cx) => { view.selected = null; cx.notify(); };
  const project = view.linked(ticket, view.frame.picks), labels = ticket.source === "legwork" ? "" : ticket.labels.join(", ");
  const status = ticket.source === "linear" ? statusPicker(view, ticket, t) : div().child(ticket.state);
  const id = rowId(ticket);
  return [
    h_flex().h(48).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border)
      .child(barButton("back", "‹ Back", back, t))
      .child(sourceIcon(ticket.source, 14, t.muted))
      .when(Boolean(id), (e) => e.child(div().font_family(monoFont()).text_size(12).text_color(t.muted).child(id))),
    v_flex().id("ticket-details").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(10)
      .child(card(t)
        .child(h_flex().px(12).py(10).gap(10).items_start()
          .child(ticketMark(view, ticket, t))
          .child(div().flex_1().min_w(0).text_size(14).font_semibold().child(ticket.title)))
        .child(panelBody(t).px(12).py(10).gap(4)
          .when(Boolean(ticket.state), (e) => e.child(fact("Status", status, t)))
          .when(view.moveError?.ref === ticket.ref, (e) => e.child(problemLine(view.moveError.text, t)))
          .when(Boolean(view.states.get(ticket.ref)?.error), (e) => e.child(problemLine(view.states.get(ticket.ref).error, t)))
          .when(Boolean(labels), (e) => e.child(fact("Labels", labels, t)))
          .when(Boolean(ago(ticket.updated)), (e) => e.child(fact("Updated", ago(ticket.updated), t)))
          .when(Boolean(ticket.project) && ticket.source !== "legwork", (e) => e.child(fact(ticket.source === "github" ? "Repo" : "Project", ticket.project, t)))
          .when(ticket.source !== "legwork", (e) => e.child(fact("Legwork", legworkPicker(view, ticket, t), t)))
          .when(ticket.source === "legwork" && Boolean(project?.category), (e) => e.child(fact("Category", project.category, t))))
        .child(actions(view, ticket, t)))
      .when(true, (e) => { const b = ticket.source === "legwork" ? briefing(view, ticket, t) : body(view, ticket, t); return b ? e.child(card(t).child(b)) : e; }),
  ];
}
