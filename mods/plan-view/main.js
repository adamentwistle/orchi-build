// A project's plan as rendered Markdown, in a tab of its own. `props().path` is its tracker file, or a planning board.
import { View, div } from "gpui-kit";
import { v_flex, TextView } from "gpui-base";
import { exec, props, readTextFile, theme } from "herdr";
import { planOf } from "./roadmap.js";

export default class PlanView extends View {
  init(_props, cx) {
    this.plan = null; this.note = null;
    cx.spawn(async (cx) => {
      const path = props()?.path;
      const text = path ? await readTextFile(path).catch(() => null) : null;
      this.plan = text ? planOf(text) : null;
      this.note = this.plan ? null : "No plan";
      cx.notify();
    });
  }

  render() {
    const t = theme();
    return v_flex().id("plan-view").size_full().min_h(0).overflow_y_scrollbar().bg(t.canvas).text_color(t.foreground).text_size(13).px(24).py(20)
      .child(this.plan
        ? div().max_w(760).child(TextView.markdown("plan", this.plan).selectable(true)
          .on_link_click((url) => { if (/^https:\/\//.test(url)) exec("open", ["--", url]).catch(() => {}); }))
        : div().text_color(t.dim).when(Boolean(this.note), (e) => e.child(this.note)));
  }
}
