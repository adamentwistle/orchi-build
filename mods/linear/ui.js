// Shared drawing for the Linear and Orchi panels. Colours come from `theme()` only.
// Every function takes the theme as `t`, so a panel passes the one it already read.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { settings } from "herdr";

// Mono is for ticket IDs, code and the status band labels only.
export const monoFont = () => settings().font_family ?? "JetBrains Mono";

// The frame of a card: border, radius 10, `background`. Children stack in a column.
export const card = (t) => v_flex().flex_none().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border);

// The lifted area inside a card: `raised`, with a top hairline.
export const panelBody = (t) => v_flex().bg(t.raised).border_t(1).border_color(t.border);

// A problem in plain text. The dot carries the red, because red text is hard to read at this size.
export const problemLine = (text, t) => h_flex().min_w(0).gap(7).items_start().text_size(12).text_color(t.foreground)
  .child(div().size(7).mt(5).flex_none().rounded_full().bg(t.blocked))
  .child(div().min_w(0).child(text));

// A small count pill.
export const pill = (text, t) => div().flex_none().min_w(22).h(18).px(6).flex().items_center().justify_center().rounded(9)
  .bg(t.raised).text_size(11).text_color(t.foreground).child(String(text));

// A 38px card header with a chevron. Pressing anywhere on it calls `onToggle`.
export function sectionHead({ id, title, count, open, onToggle, right, t }) {
  return h_flex().id(`head-${id}`).h(38).flex_none().px(12).gap(8).items_center().cursor_pointer()
    .hover((s) => s.bg(t.hover)).on_click(onToggle)
    .child(svg(open ? "mods/files/chevron-down.svg" : "mods/files/chevron-right.svg").size(14).flex_none().text_color(t.dim))
    .child(div().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(title))
    .child(div().flex_1())
    .when(right != null, (e) => e.child(div().flex_none().text_size(12).text_color(t.muted).child(right)))
    .when(count != null, (e) => e.child(pill(count, t)));
}

// A row of choices. The chosen one fills with `popover`.
export function segment({ id, items, value, onPick, t }) {
  return h_flex().id(`segment-${id}`).flex_none().gap(2).p(2).rounded(8).bg(t.background).text_size(12)
    .children(items.map((item) => {
      const on = item.id === value;
      return h_flex().id(`segment-${id}-${item.id}`).flex_1().min_w(0).h(26).items_center().justify_center().rounded(6).cursor_pointer()
        .when(on, (e) => e.bg(t.popover)).text_color(on ? t.foreground : t.muted)
        .hover((s) => (on ? s : s.bg(t.hover)))
        .on_click((e, cx) => onPick(item.id, cx, e)).child(item.label);
    }));
}

// A labelled band inside a card: a status dot, the label in mono capitals, the count.
// `dot` is a theme colour name, such as "working", "done" or "dim".
export function statusBand({ label, count, dot, t }) {
  return h_flex().h(28).flex_none().px(12).gap(7).items_center()
    .child(div().size(7).flex_none().rounded_full().bg(t[dot] ?? t.dim))
    .child(div().font_family(monoFont()).text_size(11).text_color(t.muted).child(String(label).toUpperCase()))
    .when(count != null, (e) => e.child(div().text_size(11).text_color(t.dim).child(String(count))));
}
