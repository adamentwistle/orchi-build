// The progress pane, beside an orchestrator's terminal: its plan, its workers and subagents, how long each has run and
// about how long is left. This file does the reads and holds the state. Working it out is in plan.js and lane.js, the
// drawing is in view.js, and agents.py reads the subagent files.
import { View, div } from "gpui-kit";
import { appHome, exec, focused, hc, home, panes, props, readTextFile, run, terminals, theme } from "herdr";
import { buildRows, latestUpdate, parseFanout, progressOf, sortRows } from "./plan.js";
import { helperFailure, helperReply, missed, noteGap, paneShowing, timed } from "./poll.js";
import { findSession, terminalFacts, terminalName } from "./session.js";
import { readSettings } from "./settings.js";
import { paneView } from "./view.js";

const REFRESH_MS = 5000;
const CLOCK_MS = 1000;
const HC_MS = 8000;
const HELPER_MS = 20000;
const SEEN = "orch-pane.seen";
const HELPER = () => `${appHome()}/mods/orch-pane/agents.py`;
const text = (path) => readTextFile(path).then((t) => t ?? "").catch(() => "");
// Orchi's settings, read once.
let orchiSettings = null;
const orchi = () => (orchiSettings ??= readSettings(readTextFile, home(), appHome()));

// `{ agents, error }`. A missing python3, a crash or bad output is named, so the pane can say so.
async function readAgents(session, title, since, sleep) {
  const args = ["-I", "-S", HELPER(), "--config", session.dir, "--session", session.sessionId];
  if (title && since) args.push("--title", title, "--since", String(since));
  let r;
  try { r = await timed(exec("python3", args), HELPER_MS, "agents.py", sleep); } catch (e) { return { agents: [], error: helperFailure(e, "agents.py") }; }
  const { value, error } = helperReply(r, "agents.py", "agents");
  return { agents: Array.isArray(value) ? value : [], error };
}

export default class OrchPane extends View {
  init(_props, cx) {
    this.terminal = props()?.terminal ?? null;
    this.model = null; this.problem = this.terminal ? null : "No orchestrator"; this.width = 0;
    this.beat = false; this.reading = false; this.updateOpen = false;
    this.misses = 0; this.closed = false; this.wasShowing = true; this.lastTick = null;
    // Each orchestrator keeps its own, so two panes can't overwrite each other's workers.
    this.key = `${SEEN}:${this.terminal}`;
    this.store = { stamp: null, workers: {}, gaps: [] };
    try {
      const kept = JSON.parse(localStorage.getItem(this.key) ?? "null");
      if (kept?.workers && typeof kept.workers === "object") this.store = { stamp: kept.stamp ?? null, workers: kept.workers, gaps: Array.isArray(kept.gaps) ? kept.gaps : [] };
    } catch { /* start with none */ }
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    // Herdr stops a render at about 55 ms and keeps the last frame under a banner, and the clocks need a tick anyway. A
    // tick that comes far too late means the machine slept, and that time is left out of every estimate.
    cx.timer.every(CLOCK_MS, (cx) => {
      const now = Date.now(), gaps = noteGap(this.store.gaps, this.lastTick, now);
      this.lastTick = now;
      if (gaps !== this.store.gaps) { this.store.gaps = gaps; this.save(); }
      const seen = this.showing();
      if (seen && !this.wasShowing) this.refresh(cx);
      this.wasShowing = seen;
      this.beat = !this.beat; cx.notify();
    });
  }

  now() { return Date.now(); }

  get gaps() { return this.store.gaps; }

  save() {
    try { localStorage.setItem(this.key, JSON.stringify(this.store)); } catch { /* not remembered */ }
  }

  showing() { return paneShowing(panes(), focused(), this.terminal); }

  // One read at a time, so a slow read can't be overtaken for ever. Nothing is read while the pane can't be seen, or once
  // its orchestrator has gone.
  refresh(cx) {
    if (this.reading || !this.terminal) return;
    if (this.closed && !terminals().some((t) => t.address === this.terminal)) return;
    if (!this.showing()) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      try { await this.load((ms) => cx.sleep(ms)); } catch (e) { this.problem = String(e?.message ?? e); } finally { this.reading = false; }
      cx.notify();
    });
  }

  // A closed worker's terminal has gone, so its times are kept here once seen. One that ended while the pane wasn't
  // reading gets its real end from `hc get`, once.
  async workers(live, stamp, facts) {
    if (this.store.stamp !== stamp) this.store = { ...this.store, stamp, workers: {} };
    const seen = this.store.workers;
    const names = await Promise.all(live.map(async (t) => {
      const slug = terminalName(t).slice(3), fact = await facts(t.address);
      seen[slug] = { started: fact?.created_ms ?? seen[slug]?.started ?? null, ended: Date.now(), address: t.address, final: false };
      return slug;
    }));
    const gone = Object.entries(seen).filter(([slug, s]) => !names.includes(slug) && !s.final && s.address);
    await Promise.all(gone.map(async ([, s]) => {
      const fact = await facts(s.address);
      if (fact?.finished_ms) { s.ended = fact.finished_ms; s.final = true; }
    }));
    this.save();
    return Object.entries(seen).map(([slug, s]) => ({
      slug, started: s.started, ended: s.ended, live: names.includes(slug), address: live.find((t) => terminalName(t) === `fw-${slug}`)?.address ?? null,
    }));
  }

  async load(sleep) {
    const all = terminals(), me = all.find((t) => t.address === this.terminal);
    const miss = missed(this.misses, Boolean(me));
    this.misses = miss.count;
    if (!me) {
      this.closed = miss.gone;
      this.problem = miss.gone ? "Orchestrator closed" : "Orchestrator not found. Retrying";
      return;
    }
    this.closed = false;
    const facts = (address) => terminalFacts({ hc: (args) => timed(hc(args), HC_MS, `hc ${args[0]}`, sleep) }, address);
    const mine = await facts(this.terminal);
    const session = await findSession({ readTextFile, home, orchi: await orchi() }, mine);
    const cwd = session?.cwd ?? me.cwd, name = session?.name ?? (terminalName(me) || me.title || "orchestrator");
    if (!cwd) { this.problem = "Folder unknown"; return; }
    const [fanout, board] = await Promise.all([text(`${cwd}/.legwork/fanout-state.md`), text(`${cwd}/.legwork/switchboard.md`)]);
    const plan = parseFanout(fanout);
    const { agents, error } = session ? await readAgents(session, name, plan.started, sleep) : { agents: [], error: null };
    // Only this orchestrator's own workers. Another run's fw- terminals belong to its own pane.
    const live = all.filter((t) => t.state === "live" && t.parent === this.terminal && terminalName(t).startsWith("fw-"));
    const workers = await this.workers(live, `${name}:${plan.started ?? "none"}`, facts);
    const rows = buildRows({ items: plan.items, agents, workers, records: mine?.records });
    const sorted = sortRows(rows);
    const starts = rows.map((r) => r.started).filter(Boolean);
    this.problem = error ? `Subagents unreadable: ${error}` : null;
    this.model = {
      plan, name: name.replace(/^orch-/, ""), update: latestUpdate(board), sorted, progress: progressOf(plan, sorted),
      runStart: plan.started ?? (starts.length ? Math.min(...starts) : mine?.created_ms ?? null),
    };
  }

  // Only a pane worker has a terminal to go to.
  rowShell(row, t, inner) {
    const go = row.address;
    return div().id(`row-${row.key}`).flex_none().px(12).py(7).border_t(1).border_color(t.border)
      .when(Boolean(go), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => run("pane.focus", { terminal: go })))
      .child(inner);
  }

  render() {
    return paneView(this, theme());
  }
}
