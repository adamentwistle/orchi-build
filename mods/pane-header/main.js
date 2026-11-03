// Changed from Herdr's shipped `pane` mod (Apache-2.0): see NOTICE.md.
// The shipped `pane` header, with one change: a chat pane reads "Claude Code", and takes its terminal's folder and status.
// It has no buttons. A chat's "N new", from `chat.unseen` in `shared`, shows on the chat's header and its terminal's. It's the layout's header, so a terminal and its chat draw the same strip at the same height, and a swap moves
// nothing. Buttons and status are as the shipped mod has them. Its icons stay in `mods/pane`, which the app always ships.
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, shared, theme, home } from "herdr";
import { UNSEEN_KEY, headerFacts, unseenLabel } from "./facts.js";

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class PaneHeader extends View {
  init() { this.hovered = false; }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane/${icon}.svg`).size(14));
  }

  render() {
    const t = theme();
    const all = panes();
    const p = all.find((x) => x.pane === props()?.pane);
    if (!p) return div();
    const { chat, name, cwd, program, status: st, unseen } = headerFacts(p, all, shared("chatpane.pairs") ?? {}, shared(UNSEEN_KEY) ?? {});
    const fresh = unseenLabel(unseen);
    const pic = icon(program, 14, t.dim);
    const pane = p.pane;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(cwd)))
      .when(Boolean(fresh), (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.accent + "26").text_size(10.5).font_semibold().text_color(t.accent).child(fresh)))
      .when(st === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", (el) => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered && !chat, (el) => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
