// The Herd panel, in the side panel beside Linear and Orchi. It follows the session in view: a map of everything it has
// started, and a row per agent saying what it's doing. This file does the reads and holds the state. Working it out is in model.js and score.js, the
// drawing is in view.js, and herd.py reads the transcripts.
import { View } from "gpui-kit";
import { appHome, exec, hc, home, layout, nextCommand, panes, props, readTextFile, run, setShared, settings, shared, theme } from "herdr";
import { buildHerd, parseFanout, rootOf, sessionOf, subtree, terminalName } from "./model.js";
import { WINDOW_MS, freshEvents } from "./score.js";
import { helperFailure, helperReply, missed, noteGap, timed } from "./poll.js";
import { findSession, terminalFacts } from "./session.js";
import { readSettings } from "./settings.js";
import { metersFrom } from "./meters.js";
import { FLIGHT, SLIDE, paneView } from "./view.js";

const REFRESH_MS = 3000;
const CLOCK_MS = 1000;
const FRAME_MS = 40;
const SPARK_GAP_MS = 110;
const MAX_SPARKS = 8;
const SIDE_PX = 368;
const HC_MS = 8000;
const HELPER_MS = 20000;
const USAGE_MS = 15000;
const HELPER = () => `${appHome()}/mods/herd/herd.py`;
// Orchi's settings, read once.
let orchiSettings = null;
const orchi = () => (orchiSettings ??= readSettings(readTextFile, home(), appHome()));

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Nothing is read while the panel can't be seen.
function showing() {
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
  return Boolean(panel) && !panel.hidden && body?.active === "herd";
}

// `{ sessions, error }`. A missing python3, a crash or bad output is named, so the panel can say so.
async function readSessions(sessions, since, sleep) {
  if (!sessions.length) return { sessions: {}, error: null };
  const args = ["-I", "-S", HELPER(), "--since", String(since)];
  for (const s of sessions) args.push("--session", JSON.stringify(s));
  let r;
  try { r = await timed(exec("python3", args), HELPER_MS, "herd.py", sleep); } catch (e) { return { sessions: {}, error: helperFailure(e, "herd.py") }; }
  const { value, error } = helperReply(r, "herd.py", "sessions");
  return { sessions: value && typeof value === "object" ? value : {}, error };
}

// The usage meters from the status line's usage file. A missing or broken file shows none.
async function readUsage() {
  try { return metersFrom(JSON.parse((await readTextFile(`${home()}/.cache/ccstatusline/usage.json`)) || "null"), Date.now()); } catch { return []; }
}

// Every terminal hc knows, finished ones too. A failure says what went wrong rather than looking like an empty list.
async function listTerminals(sleep) {
  const listed = await timed(hc(["ls", "--all", "--json"]), HC_MS, "hc ls", sleep);
  if (listed?.code !== 0) throw new Error(`hc ls stopped with code ${listed?.code}${listed?.stderr ? `: ${String(listed.stderr).trim().split("\n").at(-1)}` : ""}`);
  let list;
  try { list = JSON.parse(listed.stdout).terminals; } catch { throw new Error("hc ls printed something that isn't JSON"); }
  if (!Array.isArray(list)) throw new Error("hc ls gave no list of terminals");
  return list;
}

export default class Herd extends View {
  init(_props, cx) {
    this.ctx = cx;
    // A pane opened before Herd moved to the side panel still has its session in its props.
    this.pinned = props()?.terminal ?? null;
    this.terminal = this.pinned; this.root = null;
    this.model = null; this.problem = "Open a Claude Code session to see what it has running.";
    this.width = 0; this.height = 0; this.reading = false;
    this.selected = null; this.folds = new Map(); this.sparks = []; this.sparkId = 0;
    this.seenUntil = null; this.ended = {}; this.call = null; this.press = null;
    this.misses = 0; this.over = null; this.gaps = []; this.lastTick = null; this.wasShowing = false;
    this.usage = []; this.usageAt = 0; this.readingUsage = false;
    cx.spawn(async () => {
      for (;;) if ((await nextCommand()) === "full") this.toggleFull();
    });
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    // The clocks and moons move once a second. Herdr also stops a render at about 55 ms, and this brings it back. A tick
    // that comes far too late means the machine slept, and that time isn't counted as quiet. Coming back into view reads
    // at once, rather than on the next refresh.
    cx.timer.every(CLOCK_MS, (cx) => {
      const now = Date.now();
      this.gaps = noteGap(this.gaps, this.lastTick, now);
      this.lastTick = now;
      const seen = Boolean(this.pinned) || showing();
      if (this.follow() || (seen && !this.wasShowing)) this.refresh(cx);
      this.wasShowing = seen;
      cx.notify();
    });
  }

  // True when the session in view has just changed.
  follow() {
    const next = this.pinned ?? sessionOf(panes());
    if (!next || next === this.terminal) return false;
    this.terminal = next; this.misses = 0; this.over = null;
    return true;
  }

  now() { return Date.now(); }

  // One read at a time, so a slow read can't be overtaken for ever. Nothing is read while the panel can't be seen, or once
  // the whole herd has ended. The count on the Herd button doesn't need this: panel-buttons works it out itself.
  refresh(cx) {
    this.follow();
    if (!(this.pinned || showing())) return;
    this.refreshUsage(cx);
    if (this.reading || !this.terminal) return;
    if (this.over === this.terminal) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      try { await this.load(cx); } catch (e) { this.problem = String(e?.message ?? e); } finally { this.reading = false; }
      cx.notify();
    });
  }

  // At most every 15 s, and still once the herd has ended, because the limits go on moving.
  refreshUsage(cx) {
    if (this.readingUsage || Date.now() - this.usageAt < USAGE_MS) return;
    this.readingUsage = true;
    cx.spawn(async (cx) => {
      try { this.usage = await readUsage(); } finally { this.usageAt = Date.now(); this.readingUsage = false; }
      cx.notify();
    });
  }

  // A finished terminal never changes, so it's asked about once.
  async facts(address, live, sleep) {
    if (this.ended[address]) return this.ended[address];
    const fact = await terminalFacts({ hc: (args) => timed(hc(args), HC_MS, `hc ${args[0]}`, sleep) }, address);
    if (fact && !live) this.ended[address] = fact;
    return fact;
  }

  async load(cx) {
    const sleep = (ms) => cx.sleep(ms), asked = this.terminal;
    const list = await listTerminals(sleep);
    const me = rootOf(list, asked);
    // A terminal missing from one list can be back in the next, so it takes a few in a row to say it has closed.
    const miss = missed(this.misses, Boolean(me));
    this.misses = miss.count;
    if (!me) {
      if (miss.gone) { this.model = null; this.problem = "That session's terminal has closed."; } else this.problem = "Can't find that session's terminal. Trying again.";
      return;
    }
    if (me.address !== this.root) {
      this.root = me.address; this.seenUntil = null; this.selected = null; this.sparks = []; this.call = null;
      // Addresses come round again, so what a finished terminal said belongs to the herd it was read for.
      this.ended = {};
      for (const key of this.folds.keys()) if (key !== "finished") this.folds.delete(key);
    }
    const root = { address: me.address, name: terminalName(me) || me.where?.split(" / ")[0] || "Session", live: me.state === "live", agent: true };
    const nodes = subtree(list, me.address), everyone = [root, ...nodes];
    const facts = {};
    await Promise.all(everyone.map(async (n) => { facts[n.address] = await this.facts(n.address, n.live, sleep); }));
    const found = {};
    await Promise.all(everyone.filter((n) => n.agent && n.live).map(async (n) => { found[n.address] = await findSession({ readTextFile, home, orchi: await orchi() }, facts[n.address]); }));
    const now = this.now();
    const sessions = Object.entries(found).filter(([, s]) => s).map(([key, s]) => ({ key, dir: s.dir, id: s.sessionId, from: s.startedAt ?? 0 }));
    const reply = await readSessions(sessions, now - WINDOW_MS, sleep);
    const cwd = found[me.address]?.cwd ?? facts[me.address]?.foreground?.cwd ?? me.cwd;
    const plan = cwd ? await readTextFile(`${cwd}/.legwork/fanout-state.md`).then((t) => t ?? "").catch(() => "") : "";
    // The session in view may have changed while this was reading. The next read is for that one.
    if (asked !== this.terminal) return;
    this.problem = reply.error ? `Transcripts can't be read, so this shows terminals only. ${reply.error}` : null;
    this.model = buildHerd({ root, nodes, facts, reply: reply.sessions, fanout: parseFanout(plan), now, gaps: this.gaps });
    this.over = this.model.over ? asked : null;
    this.launch(cx, now);
  }

  // A press on a call in a ribbon names it under the ribbon. A second press on the same call, or on the line, hides it.
  pickCall(key, event) {
    const same = event && this.call?.key === key && this.call.at === event[0] && this.call.tool === event[1];
    this.call = !event || same ? null : { key, at: event[0], tool: event[1] };
    this.ctx.notify();
  }

  // Full width hides the terminals and lets the panel fill their room. The panel's own width comes back with them.
  isFull() { return Boolean(find(layout(), "main")?.hidden); }

  toggleFull() {
    if (this.isFull()) {
      run("layout.show", { id: "main" });
      run("layout.resize", { id: "panel", px: Number(shared("herd.panelWidth")) || SIDE_PX });
      return;
    }
    setShared("herd.panelWidth", find(layout(), "panel")?.size?.px ?? SIDE_PX);
    run("layout.resize", { id: "panel", weight: 1 });
    run("layout.hide", { id: "main" });
  }

  // Each new tool call sends a spark along its spoke. It's drawn once where it starts, then told to go, so the move is
  // the app's own transition.
  launch(cx, now) {
    const since = this.seenUntil;
    this.seenUntil = now;
    if (since == null) return;
    freshEvents(this.model.rows, since, MAX_SPARKS).forEach((event, i) => {
      const spark = { ...event, id: this.sparkId++, flying: false };
      cx.timer.after(i * SPARK_GAP_MS, (cx) => {
        this.sparks.push(spark);
        cx.notify();
        cx.timer.after(FRAME_MS, (cx) => { spark.flying = true; cx.notify(); });
        cx.timer.after(FLIGHT.duration + FRAME_MS * 2, (cx) => { this.sparks = this.sparks.filter((s) => s !== spark); cx.notify(); });
      });
    });
  }

  toggleFold(key) {
    const cx = this.ctx, f = this.folds.get(key);
    if (!f) this.folds.set(key, { entered: false, height: 0 });
    else if (f.entered) {
      f.entered = false;
      cx.timer.after(SLIDE.duration + FRAME_MS, (cx) => { if (this.folds.get(key) === f && !f.entered) { this.folds.delete(key); cx.notify(); } });
    } else this.folds.delete(key);
    cx.notify();
  }

  // The fold reports its size in window pixels, and heights are set in the app's own.
  measured(key, pixels, cx) {
    const f = this.folds.get(key), height = pixels / (settings().zoom || 1);
    if (!f || (f.height === height && f.entered)) return;
    f.height = height;
    if (!f.entered) f.entered = true;
    cx.notify();
  }

  // A press on the map or on a stave: pick it and open its details, and a second press closes them.
  pick(key) {
    const row = this.model?.rows.find((r) => r.key === key);
    const same = this.selected === key;
    this.selected = same ? null : key;
    for (const [other, f] of this.folds) if (other !== "finished" && !other.startsWith("kids:") && other !== key && f.entered) this.toggleFold(other);
    if (row && (same || !this.folds.has(key))) this.toggleFold(key);
    this.ctx.notify();
  }

  showTerminal(row) {
    if (row.address) run("terminal.peek", { terminal: row.address });
  }

  render() {
    return paneView(this, theme());
  }
}
