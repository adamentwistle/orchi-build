// The sheet Start opens under a plan. `view` is the Orchi view, which owns `startFor` and the two text fields.
// Colours come from `theme()` only.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, Textarea } from "gpui-base";
import { EFFORTS, MODELS, pickEffort, pickModel } from "./options.js";
import { problemLine, segment } from "./ui.js";

// One model choice, as on the Linear panel's review screen: the name, the effort, five rising bars, then the models.
function modelSelector({ id, name, choice, models, onChange, t }) {
  const auto = choice.effort === "Auto", level = EFFORTS.indexOf(choice.effort);
  const bar = (effort, i) => div().id(`start-effort-${id}-${effort}`).flex_none().w(9).h(16).flex().items_end().justify_center().cursor_pointer()
    .on_click((_e, cx) => onChange(pickEffort(choice, effort), cx))
    .child(div().w(5).h(6 + i * 2).rounded(2).bg(!auto && i <= level ? t.solid : t.popover));
  return v_flex().flex_none().gap(6)
    .child(h_flex().gap(7).items_center()
      .child(svg("mods/orchi/role.svg").size(13).flex_none().text_color(t.muted))
      .child(div().font_semibold().child(name))
      .child(div().flex_1())
      .child(div().text_size(12).text_color(t.muted).child(choice.effort))
      .child(h_flex().children(EFFORTS.map(bar))))
    .child(segment({ id: `start-${id}`, value: choice.model, t, items: models.map((m) => ({ id: m, label: m })), onPick: (m, cx) => onChange(pickModel(choice, m), cx) }));
}

const label = (text) => div().flex_none().font_semibold().child(text);

// The switchboard's choice only counts when Start has to start one, so it shows only then.
export function startSheet(view, t) {
  const { options, label: title, error } = view.startFor, starting = view.isStarting(view.startFor.key);
  const role = (id, name, models) => modelSelector({ id, name, choice: options[id], models, t, onChange: (choice, cx) => view.setStartOption({ [id]: choice }, cx) });
  return v_flex().flex_none().px(12).py(11).gap(13).bg(t.raised).border_t(1).border_color(t.border)
    .child(v_flex().gap(1).min_w(0)
      .child(div().truncate().font_semibold().child(`How should ${title} run?`))
      .child(div().text_size(12).text_color(t.dim).child("These win over what the plan says.")))
    .when(!view.data.holder.where, (e) => e.child(role("switchboard", "Switchboard", MODELS)))
    .child(role("orchestrator", "Orchestrator", MODELS))
    .child(role("workers", "Workers", ["Auto", ...MODELS]))
    .child(v_flex().flex_none().gap(6).child(label("How should this run handle PRs"))
      .child(h_flex().h(32).px(10).items_center().rounded(8).border_1().border_color(t.border).bg(t.background)
        .child(Input.new(view.startPrs).h_full().flex_1().text_size(13).text_color(t.foreground))))
    .child(v_flex().flex_none().gap(6).child(label("Extra instructions"))
      .child(div().h(72).p(8).rounded(8).border_1().border_color(t.border).bg(t.background)
        .child(Textarea.new(view.startExtra).size_full().text_size(13).text_color(t.foreground))))
    .when(Boolean(error), (e) => e.child(problemLine(error, t)))
    .child(h_flex().gap(6).items_center()
      .child(h_flex().id("start-cancel").h(30).px(10).flex_none().items_center().rounded(6).cursor_pointer().text_size(12).text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { view.closeStart(); cx.notify(); }).child("Cancel"))
      .child(h_flex().id("start-go").h(30).flex_1().min_w(0).items_center().justify_center().rounded(6).font_semibold().text_size(12).bg(t.solid).text_color(t.solid_foreground)
        .when(starting, (e) => e.opacity(0.4)).when(!starting, (e) => e.cursor_pointer().on_click((_e, cx) => view.confirmStart(cx)))
        .child(starting ? "Starting…" : "Start")));
}
