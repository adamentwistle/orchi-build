// Draws one ticket: its tick box and title, the facts about it, then its description.
// `view` is the Linear view, which owns the state and the actions used here.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Popover, TextView } from "gpui-base";
import { ago } from "./linear.js";
import { openUrl } from "./open.js";
import { dotFor } from "./queue.js";
import { ticketMark } from "./queue-view.js";
import { legworkPicker } from "./review-view.js";
import { card, panelBody, monoFont } from "./ui.js";

function barButton(id, label, onClick, t) {
  return div().id(id).px(8).h(26).flex().flex_none().items_center().rounded(6).cursor_pointer().text_size(12).text_color(t.muted)
    .hover((s) => s.bg(t.hover)).on_click(onClick).child(label);
}

// One fact: a label on the left, its value on the right.
const fact = (label, value, t) => h_flex().min_h(24).gap(10).items_center().text_size(12)
  .child(div().w(92).flex_none().text_color(t.dim).child(label))
  .child(h_flex().flex_1().min_w(0).gap(6).items_center().flex_wrap().child(value));

const statusLabel = (issue, state, t) => h_flex().min_w(0).gap(6).items_center()
  .child(div().size(7).flex_none().rounded_full().bg(t[dotFor({ state: state.name, stateType: state.type })]))
  .child(div().min_w(0).truncate().child(state.name));

// Picks the status to send with Update tickets. Nothing reaches Linear until that's pressed.
function statusPicker(view, issue, t) {
  const own = { name: issue.state, type: issue.stateType }, states = view.states[issue.team] ?? [];
  const staged = view.frame.staged[issue.identifier], shown = staged ?? own;
  if (!states.length) return statusLabel(issue, own, t);
  const open = view.statusOpen === issue.id;
  const option = (state) => h_flex().id(`status-${issue.id}-${state.id}`).h(26).flex_none().px(8).items_center().rounded(6).cursor_pointer()
    .when(state.name === shown.name, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => { view.stageStatus(issue, state); view.statusOpen = null; cx.notify(); })
    .child(statusLabel(issue, state, t));
  const trigger = h_flex().id(`status-${issue.id}`).h(24).px(8).gap(6).items_center().rounded(6).cursor_pointer().border_1().border_color(t.border).bg(t.background)
    .child(statusLabel(issue, shown, t))
    .child(svg("mods/files/chevron-down.svg").size(12).flex_none().text_color(t.dim));
  const list = !open ? v_flex() : v_flex().w(200).p(4).rounded(8).bg(t.popover).border_1().border_color(t.border)
    .child(v_flex().id(`status-list-${issue.id}`).h(Math.min(states.length, 8) * 27).flex_none().overflow_y_scrollbar().gap(1).children(states.map(option)));
  return Popover.new(`status-popover-${issue.id}`).open(open).anchor("top_left")
    .on_open_change((o, cx) => { view.statusOpen = o ? issue.id : null; cx.notify(); })
    .trigger(trigger).content(list);
}

function legworkFact(view, issue, t) {
  const note = view.isPicked(issue) ? "Your pick. Update tickets sends it to Linear and the tracker." : null;
  return v_flex().gap(4)
    .child(fact("Legwork project", legworkPicker(view, issue, t), t))
    .when(Boolean(note), (e) => e.child(div().pl(102).text_size(12).text_color(t.dim).child(note)));
}

// Ticket text is someone else's words: links open through `openUrl`, which only allows web addresses.
function description(issue, t) {
  return card(t)
    .child(div().px(12).py(9).text_size(12).text_color(t.dim).child("Description"))
    .child(panelBody(t).p(12).text_size(13)
      .child(TextView.markdown(`description-${issue.id}`, issue.description).selectable(true)
        .on_link_click((url) => openUrl(url))));
}

// Returns the children of the panel's root, top to bottom.
export function detailsView(view, issue, t) {
  const back = (_e, cx) => { view.selected = null; cx.notify(); };
  const priority = issue.priority > 0 ? issue.priorityLabel : null;
  const labels = issue.labels.map((l) => l.name).join(", ");
  return [
    h_flex().h(48).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border)
      .child(barButton("back", "‹ Back", back, t))
      .child(div().font_family(monoFont()).text_size(12).text_color(t.muted).child(issue.identifier))
      .child(div().flex_1())
      .child(barButton("open-linear", "Open in Linear", () => openUrl(issue.url), t)),
    v_flex().id("linear-details").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(10)
      .child(card(t)
        .child(h_flex().px(12).py(10).gap(10).items_start()
          .child(ticketMark(view, issue, t))
          .child(div().flex_1().min_w(0).text_size(14).font_semibold().child(issue.title)))
        .child(panelBody(t).px(12).py(10).gap(4)
          .child(fact("Status", statusPicker(view, issue, t), t))
          .when(Boolean(view.frame.staged[issue.identifier]), (e) => e.child(div().pl(102).text_size(12).text_color(t.dim).child("Waiting for Update tickets.")))
          .when(Boolean(priority), (e) => e.child(fact("Priority", priority, t)))
          .when(Boolean(labels), (e) => e.child(fact("Labels", labels, t)))
          .child(fact("Updated", `${ago(issue.updatedAt)} ago`, t))
          .child(fact("Linear project", issue.project ?? "None", t))
          .child(legworkFact(view, issue, t))))
      .when(Boolean(issue.description), (e) => e.child(description(issue, t))),
  ];
}
