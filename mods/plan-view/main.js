// A project's plan as rendered Markdown, in a tab of its own. `props().path` is its tracker file, or a planning board.
import { View, div } from "gpui-kit";
import { v_flex, TextView } from "gpui-base";
import { exec, props, readTextFile, theme } from "herdr";
import { planOf } from "./roadmap.js";
import { isWindows } from "./platform.js";

// `open` on the Mac. On Windows, the shell's handler for a URL, which takes it whole, with no command line to quote.
const openLink = (url) => (isWindows() ? exec("rundll32", ["url.dll,FileProtocolHandler", url]) : exec("open", ["--", url])).catch(() => {});

export default class PlanView extends View {
  init(_props, cx) {
    this.plan = null; this.note = "Loading…";
    cx.spawn(async (cx) => {
      const path = props()?.path;
      const text = path ? await readTextFile(path).catch(() => null) : null;
      this.plan = text ? planOf(text) : null;
      this.note = this.plan ? null : "This project has no plan to show.";
      cx.notify();
    });
  }

  render() {
    const t = theme();
    return v_flex().id("plan-view").size_full().min_h(0).overflow_y_scrollbar().bg(t.canvas).text_color(t.foreground).text_size(13).px(24).py(20)
      .child(this.plan
        ? div().max_w(760).child(TextView.markdown("plan", this.plan).selectable(true)
          .on_link_click((url) => { if (/^https:\/\//.test(url)) openLink(url); }))
        : div().text_color(t.dim).child(this.note));
  }
}
