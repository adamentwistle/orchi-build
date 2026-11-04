// The Tickets and Orchi buttons that sit beside the tab bar's Files and Changes buttons, and the chat and terminal toggle.
// Looks like `panelButton` in the shipped `tabs` mod, which stays untouched.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { nextCommand, panes, run, layout, terminals, theme, shared, setShared } from "herdr";
import { SPLIT_MS, splitPending, swapState, swapSteps, tidyPairs } from "./swap.js";
import { closeSteps, newPane, openSteps, openedSteps, progressState } from "./progress.js";
import { herdBlocked, sessionOf } from "./herd-badge.js";

const PANELS = ["files", "changes", "tickets", "orchi", "herd"];
const PANEL_PX = 368;
const PAIRS = "chatpane.pairs";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const nameOf = (address) => {
  const t = terminals().find((x) => x.address === address);
  return t?.name ?? t?.labels?.["orchi.name"] ?? "";
};

export default class PanelButtons extends View {
  init(_props, cx) {
    // The tab bar keeps its per-space memory only for panels listed here.
    const have = shared("workspace.panels");
    if (!Array.isArray(have) || PANELS.some((p) => !have.includes(p))) {
      setShared("workspace.panels", [...new Set([...(Array.isArray(have) ? have : []), ...PANELS])]);
    }
    cx.spawn(async () => {
      for (;;) if ((await nextCommand()) === "swap") this.swap();
    });
  }

  // A first press splits, and the new pane only exists on a later render, so finish the swap there.
  settle(list) {
    const wait = this.waiting;
    if (!wait) return;
    const fresh = list.find((p) => p.mod === "claude-chat" && p.tab === wait.tab && !wait.known.includes(p.pane));
    if (!fresh) return;
    this.waiting = null;
    setShared(PAIRS, { ...tidyPairs(shared(PAIRS), list), [fresh.pane]: wait.terminal });
    run("pane.zoom", { pane: fresh.pane });
    run("pane.focus", { pane: fresh.pane });
  }

  settleProgress(list) {
    const wait = this.opening;
    if (!wait) return;
    const fresh = newPane(list, wait);
    if (!fresh && Date.now() - wait.at >= SPLIT_MS) this.opening = null;
    if (!fresh) return;
    this.opening = null;
    for (const [name, args] of openedSteps(wait, fresh.pane)) run(name, args);
  }

  // Opens the orchestrator's progress pane, or closes it.
  progress() {
    const list = panes(), state = progressState(list, nameOf), here = list.find((p) => p.focused);
    if (!state) return;
    if (state.progressPane) {
      for (const [name, args] of closeSteps(state)) run(name, args);
      return;
    }
    if (splitPending(this.opening, state.tab, Date.now())) return;
    this.opening = { tab: state.tab, known: list.map((p) => p.pane), at: Date.now(), zoomed: Boolean(state.zoomed), from: here.pane };
    for (const [name, args] of openSteps(state)) run(name, args);
  }

  progressButton(t, state) {
    const on = Boolean(state.progressPane);
    return h_flex().id("orch-progress").ml(6).size(28).flex_none().items_center().justify_center().rounded(6)
      .accessibility_label("Orchestrator progress").bg(on ? t.selected : t.chrome).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.progress(); })
      .child(svg("mods/orch-pane/progress.svg").size(15).text_color(on ? t.foreground : t.muted));
  }

  swap(target) {
    const list = panes();
    const state = swapState(list, shared(PAIRS) ?? {});
    if (!state) return;
    const to = target ?? (state.showing === "chat" ? "terminal" : "chat");
    if (to === state.showing) return;
    if (to === "chat" && !state.chatPane) {
      if (splitPending(this.waiting, state.tab, Date.now())) return;
      this.waiting = { tab: state.tab, terminal: state.terminal, known: list.map((p) => p.pane), at: Date.now() };
    }
    for (const [name, args] of swapSteps(state, to, list)) run(name, args);
  }

  toggle(t, state) {
    const on = (side) => state.showing === side;
    // Mouse down, not on_click: in testing a press's mouse down arrived where its click didn't.
    const press = (side) => (_e, cx) => { cx.stop_propagation(); this.swap(side); };
    const cell = (side, icon, label) => h_flex().id(`swap-${side}`).w(30).h(24).flex_none().items_center().justify_center().rounded(12).relative()
      .accessibility_label(label).on_mouse_down("left", press(side))
      .child(svg(icon).size(14).text_color(on(side) ? t.background : t.muted));
    return h_flex().ml(6).p(2).h(30).flex_none().items_center().rounded(15).relative().bg(t.surface).border(1).border_color(t.border)
      .child(div().absolute().top(2).h(24).w(30).rounded(12).bg(t.solid ?? t.foreground)
        .left(state.showing === "terminal" ? 32 : 2).spring("left", { response: 240, damping: 0.86 }))
      .child(cell("chat", "mods/claude-chat/chat.svg", "Chat"))
      .child(cell("terminal", "mods/claude-chat/terminal.svg", "Terminal"));
  }

  render() {
    const list = panes();
    this.settle(list);
    this.settleProgress(list);
    const swap = swapState(list, shared(PAIRS) ?? {});
    const orchestrator = progressState(list, nameOf);
    const t = theme();
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    const stop = (_e, cx) => cx.stop_propagation();
    const open = Number(shared("orchi.open")) || 0;
    const button = (id, label, icon, badge) => {
      const on = Boolean(panel) && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(7).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          // Herd can fill the window. The other panels aren't made for that, and closing it must leave the terminals showing.
          if (find(root, "main")?.hidden && (on || id !== "herd")) {
            run("layout.show", { id: "main" });
            run("layout.resize", { id: "panel", px: Number(shared("herd.panelWidth")) || PANEL_PX });
          }
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        })
        .child(svg(icon).size(14).flex_none().text_color(on ? t.foreground : t.muted)).child(label)
        .when(badge > 0, (e) => e.child(div().min_w(16).h(16).px(4).flex().items_center().justify_center().rounded(8)
          .bg(t.blocked).text_color(t.background).text_size(11).font_semibold().child(String(badge))));
    };
    return h_flex().size_full().min_w(0).pr(10).gap(2).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(button("tickets", "Tickets", "mods/tickets/tickets.svg", 0))
      .child(button("orchi", "Orchi", "mods/orchi/orchi.svg", open))
      .child(button("herd", "Herd", "mods/herd/herd.svg", herdBlocked(terminals(), sessionOf(list))))
      .when(Boolean(swap), (e) => e.child(this.toggle(t, swap)))
      .when(Boolean(orchestrator), (e) => e.child(this.progressButton(t, orchestrator)));
  }
}
