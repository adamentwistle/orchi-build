// Changed from Herdr's shipped `spaces` and `agents` mods (Apache-2.0): see NOTICE.md.
// Spaces and their agents in one sidebar list, in place of the shipped spaces and agents blocks. Each space folds, and
// under it its agents sit in folds by status, most urgent first. A space keeps what the spaces mod gives it: colored
// worktrees under their checkout, a header per machine, git after the name, right-click menu, drag to reorder.
// Its git reading is that mod's, unchanged. The tree's rules are in tree.js.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, machines, run, openOverlay, exec, hc, theme, shared, setShared, setAgentOrder, settings, playSound, watchFolder, window, layout, appHome, nextCommand } from "herdr";
import { initials, railStatus, railTip } from "./rail.js";
import {
  CONTEXT_WARN, NO_SPACE, RANK, agentNames, agentTree, blockedReason, changedPaths, contextShare, displayOrder, dropTarget, finishedWorkers, fleetCounts,
  foldKey, foldPressed, foldSummary, inbox, kidStatus, nextHeld, pruneFolds, sharedEdits, spaceActive, subtree, terminalName, unseenCount, urgencyOf,
} from "./tree.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

const SPARK = "mods/space-agents/spark.svg";
const TILE = 32;
const BRANCH = "mods/workspace-chrome/branch.svg";
const WORKER_SOUND = "sounds/worker.mp3";
const WORKER_SOUND_GAP_MS = 1500; // Workers finishing together play it once.
// Render looks for finished workers with what it has already read. This catches them when render hasn't run lately.
const WORKER_CHECK_MS = 2000;
// How often each local Claude Code session's context is read, by a helper that reads the end of its transcript.
const CONTEXT_MS = 20000;
const CONTEXT_HELPER = "mods/space-agents/context.py";
const GLOW_MS = 1800;
// Rings stacked behind the icon, faintest and widest first, which fades out softly as there's no blur to use.
const GLOW = [{ size: 30, to: 0.05 }, { size: 26, to: 0.07 }, { size: 22, to: 0.09 }, { size: 18, to: 0.12 }, { size: 14, to: 0.16 }];

// How far in each level sits: a status under its space's name, an agent under its status, a sub-agent under its agent.
const STATUS_INDENT = 30;
const AGENT_INDENT = 38;
const KID_INDENT = 60;

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function lead(tab, all) {
  const mine = all.filter((p) => p.tab === tab.id && p.terminal);
  return mine.find((p) => p.program?.agent) ?? mine.find((p) => p.focused) ?? mine[0];
}

// A terminal's own title, unless it only repeats the program or says where the shell is.
function telling(raw, program) {
  const live = clean(raw);
  const says = live && live !== program?.name && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== program?.key;
  return says ? live : null;
}

function title(tab, l) {
  const live = telling(l?.title, l?.program);
  return tab.name === l?.program?.name && live ? live : tab.name;
}

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class SpaceAgents extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.machinesFolded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]"));
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.held = null;
    this.workers = new Map(); // address -> status at the last look
    this.workerSoundAt = 0;
    this.workersAt = 0; // when finished workers were last looked for
    this.foldPressAt = null; // when a chevron last took a press
    this.context = {}; // agent address -> { tokens, model }
    this.bigModels = new Set(JSON.parse(localStorage.getItem("context.big") ?? "[]")); // models seen past 200k
    this.refreshMachines(cx);
    cx.timer.every(15000, (cx) => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
    cx.timer.every(WORKER_CHECK_MS, () => {
      if (Date.now() - this.workersAt >= WORKER_CHECK_MS) this.checkWorkers(Date.now(), terminals(), agents());
    });
    cx.timer.every(30000, (cx) => cx.notify());
    this.readContext(cx);
    cx.timer.every(CONTEXT_MS, (cx) => this.readContext(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "oldest-blocked") this.jumpToOldest();
        cx.notify();
      }
    });
  }

  // The key's jump: the agent that has waited on you longest.
  jumpToOldest() {
    const first = inbox(agents(), terminals(), (a) => this.since(a))[0];
    if (first) this.focusEntry(first);
  }

  focusEntry(e) {
    if (e.pane) run("pane.focus", { pane: e.pane });
    else run("agent.focus", { terminal: e.address });
  }

  // Each local Claude Code session's latest usage, through a helper that reads the end of its transcript.
  readContext(cx) {
    if (this.readingContext) return;
    const all = terminals();
    const pids = {};
    for (const a of agents()) {
      if (a.address.includes("/") || (a.app !== "claude-code" && a.program?.key !== "claude")) continue;
      const pid = all.find((t) => t.address === a.address)?.foreground?.pid;
      if (pid) pids[pid] = a.address;
    }
    if (!Object.keys(pids).length) { this.context = {}; return; }
    this.readingContext = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", ["-I", "-S", `${appHome()}/${CONTEXT_HELPER}`, ...Object.keys(pids)]);
        if (r.code !== 0) return;
        const seen = JSON.parse(r.stdout);
        const next = {};
        for (const [pid, usage] of Object.entries(seen)) {
          if (pids[pid]) next[pids[pid]] = usage;
          if (usage.tokens > 200000 && usage.model && !this.bigModels.has(usage.model)) {
            this.bigModels.add(usage.model);
            localStorage.setItem("context.big", JSON.stringify([...this.bigModels]));
          }
        }
        this.context = next;
      } catch {} finally {
        this.readingContext = false;
        cx.notify();
      }
    });
  }

  // The app has sounds for an agent that needs you or finishes, and none for a worker, so that one's played here.
  // `all` and `list`: terminals() and agents(), as the caller read them.
  checkWorkers(now, all, list) {
    this.workersAt = now;
    const { current, finished } = finishedWorkers(this.workers, all, new Set(list.map((a) => a.address)));
    this.workers = current;
    if (!finished.length || settings().sounds?.enabled === false || now - this.workerSoundAt < WORKER_SOUND_GAP_MS) return;
    this.workerSoundAt = now;
    playSound(WORKER_SOUND);
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.machinesFolded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async (cx) => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      this.prune();
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      // Paths from the checkout's top, not the folder, so two spaces' changed files compare.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "status.relativePaths=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = {
        name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git`,
        top: top.stdout.trim(), files: changedPaths(r.stdout),
      };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  toggle(key) {
    this.folded.has(key) ? this.folded.delete(key) : this.folded.add(key);
    this.prune(true);
  }

  // Folds of spaces that have gone. Another machine's only once it's connected and its layout has been read.
  prune(changed = false) {
    const connected = new Set(this.machines.filter((m) => m.state === "connected").map((m) => m.name));
    const docs = machines();
    const ready = docs.filter((m) => m.name && m.layout === "ready" && connected.has(m.name)).map((m) => m.name);
    // Before this computer's layout is read its spaces aren't listed yet, and every fold would look gone.
    const kept = docs.some((m) => m.name === null && m.layout === "ready")
      ? pruneFolds([...this.folded], spaces().map((s) => s.id), ready) : [...this.folded];
    if (!changed && kept.length === this.folded.size) return;
    this.folded = new Set(kept);
    localStorage.setItem("folded", JSON.stringify(kept));
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null })).filter((r) => this.shown.has(r.w.id));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    return out;
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed, rows, tree) {
    const draw = (r) => (collapsed ? this.compact(r, t, tree) : this.spaceWithAgents(r, t, tree));
    const remote = [...new Set([...rows.map((r) => r.w.machine).filter(Boolean), ...this.machines.map((m) => m.name)])].sort();
    const loading = (m) => {
      const layout = machines().find((k) => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some((k) => k.name === m && k.state === "connected"))
        || spaces().some((s) => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = (m) => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.flatMap(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const machine = this.machines.find((k) => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.machinesFolded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, (el) => el.mt(6).justify_center().tooltip(m ?? "This computer"))
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.machinesFolded.delete(m) : this.machinesFolded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.machinesFolded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, (el) => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected, (el) => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(connected, (el) => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", m ? { machine: m } : {}); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", m ? { machine: m } : {}))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, (el) => el.child("New space there"));
      return [head, ...(folded ? [] : mine.length ? mine.flatMap(draw) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  // Only what's unusual, after the name: "herdr · spike ↑2 ↓1". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" · ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`↑${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`↓${g.behind}`)));
  }

  // The fold control on a row that presses for something else. Acts on the press, and stops it, so the row underneath
  // doesn't select or start a drag. Folded, it says how many and the most urgent status, unless that's idle.
  foldToggle(key, { count, top }, t) {
    const open = !this.folded.has(key);
    return h_flex()
      .id(`fold-${key}`)
      .flex_none()
      .h(20)
      .px(4)
      .gap(5)
      .items_center()
      .rounded(4)
      .text_size(11)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => {
        cx.stop_propagation();
        // Stopping the press should keep it from the row, and the time is there in case it doesn't (see foldPressed).
        this.foldPressAt = Date.now();
        this.toggle(key);
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => cx.stop_propagation())
      .when(!open && Boolean(top) && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
      .when(!open, (el) => el.child(String(count)))
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none());
  }

  spaceWithAgents(r, t, tree) {
    const groups = tree.get(r.w.id) ?? [];
    const open = !this.folded.has(foldKey.space(r.w.id));
    return [this.row(r, t, groups), ...(open ? this.statusRows(r.w.id, groups, t) : [])];
  }

  // A space's icon, in the theme's accent with a slow glow behind it while an agent in the space is working.
  mark(path, active, t) {
    return div()
      .relative()
      .size(18)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .when(active, (el) => el
        .children(GLOW.map(({ size, to }) => div().absolute().left((18 - size) / 2).top((18 - size) / 2).size(size).rounded_full().bg(t.accent)
          .loop("opacity", { from: to / 4, to, period: GLOW_MS }))))
      .child(svg(path).size(14).text_color(active ? t.accent : t.dim));
  }

  // A drag that ends anywhere but on a row: released elsewhere in the list, or the pointer left the list.
  endDrag(cx) {
    if (this.pressed === null && this.over === null) return;
    this.pressed = null;
    this.over = null;
    cx.notify();
  }

  // The drag holds space ids, not places in the list, so a space that closes mid-drag can't move the wrong one.
  row({ w, i, g, tree }, t, groups) {
    const on = w.active;
    const active = spaceActive(groups, this.all, this.listed);
    const from = this.pressed === null ? -1 : this.spaceIds.indexOf(this.pressed);
    const clash = this.clashes?.get(w.id) ?? [];
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(from >= 0 && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(from < i, (line) => line.bottom(0))
          .when(from > i, (line) => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        if (foldPressed(this.foldPressAt, Date.now())) return;
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        if (this.pressed === null) return;
        const source = spaces().find((s) => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        const move = from !== null && over === w.id ? dropTarget(spaces().map((s) => s.id), from, w.id) : null;
        if (move) run("space.move", move);
        else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), (el) => el.pl(22))
          .child(this.mark(tree ? BRANCH : SPARK, active, t))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1())
          .when(clash.length > 0, (el) => el.child(h_flex().id(`clash-${w.id}`).flex_none().gap(3).items_center().text_size(11).text_color(t.ansi3)
            .tooltip(`Also changed in another worktree: ${clash.slice(0, 6).join(", ")}${clash.length > 6 ? ` and ${clash.length - 6} more` : ""}`)
            .child(svg("mods/workspace-chrome/git-compare.svg").size(12).flex_none()).child(String(clash.length))))
          .when(groups.length > 0, (el) => el.child(this.foldToggle(foldKey.space(w.id), foldSummary(groups), t))),
      );
  }

  // A space's status groups: a header that folds, and the agents under it.
  statusRows(id, groups, t) {
    return groups.flatMap((g) => {
      const key = foldKey.status(id, g.key);
      const open = !this.folded.has(key);
      const head = h_flex()
        .id(`status-${key}`)
        .pl(STATUS_INDENT)
        .pr(12)
        .h(24)
        .flex_none()
        .gap(6)
        .items_center()
        .rounded(6)
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          this.toggle(key);
          cx.notify();
        })
        .child(div().truncate().text_color(g.key === "idle" ? t.dim : t[g.key] ?? t.dim).child(g.label))
        .child(div().text_color(t.dim).child(String(g.members.length)))
        .child(div().flex_1())
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim));
      return [head, ...(open ? g.members.flatMap((a) => this.agentWithKids(id, a, t)) : [])];
    });
  }

  agentWithKids(id, a, t) {
    const subs = subtree(this.all, a.address);
    const key = foldKey.kids(id, a.address);
    const row = this.agentRow(a, t, subs, key);
    return this.folded.has(key) ? [row] : [row, ...subs.map((s) => this.subRow(t, s))];
  }

  agentRow(a, t, subs, key) {
    const pic = icon(a.program, 16, t.foreground);
    const when = this.since(a);
    const idle = a.status === "idle" && !a.focused;
    const kids = subs.map((s) => kidStatus(s.t, this.listed));
    const top = kids.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
    const reason = a.status === "blocked" ? this.reasons.get(a.address) : null;
    const name = div().min_w(0).truncate().text_color(idle ? t.muted : t.foreground).child(this.agentNames.get(a.address));
    return h_flex()
      .id(`ag-${a.address}`)
      .pl(AGENT_INDENT)
      .pr(8)
      .h(reason ? 40 : 28)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(8)
      .when(a.focused, (el) => el.bg(t.selected))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        if (!foldPressed(this.foldPressAt, Date.now())) run("pane.focus", { pane: a.pane });
      })
      .when(Boolean(pic), (el) => el.child(pic))
      .child(reason
        ? v_flex().flex_1().min_w(0).child(name).child(div().min_w(0).truncate().text_size(11).text_color(t.blocked).child(reason))
        : name.flex_1())
      .when(subs.length > 0, (el) => el.child(this.foldToggle(key, { count: subs.length, top }, t)))
      .child(this.contextTag(a, t))
      .when(Boolean(when), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(this.now - when))))
      .child(this.status(t, a, true));
  }

  // How full the session's context is, from 60% in the warning colour: the point to wrap up and start fresh.
  contextTag(a, t) {
    const c = this.context[a.address];
    const share = c ? contextShare(c.tokens, c.model, this.bigModels) : null;
    if (!share) return div().flex_none();
    return div().id(`ctx-${a.address}`).flex_none().text_size(11).text_color(share.pct >= CONTEXT_WARN ? t.ansi3 : t.dim)
      .tooltip(`${Math.round(c.tokens / 1000)}k of ${share.window / 1000}k context`).child(`${share.pct}%`);
  }

  // Every agent waiting on you, oldest first, with what it's waiting on. A press goes to it; nothing here answers.
  inboxRows(entries, t) {
    if (!entries.length) return [];
    const head = h_flex().id("inbox-head").h(26).flex_none().px(8).gap(6).items_center().text_size(11).font_medium()
      .child(div().text_color(t.blocked).child("Needs you")).child(div().text_color(t.dim).child(String(entries.length)));
    const rows = entries.map((e) => {
      const a = e.agent;
      const name = a ? this.agentNames.get(a.address) : e.term.name || e.term.template || e.term.program?.name || e.address;
      const where = a?.space_name ?? (e.term.labels?.where ?? "").split(" / ")[0];
      const pic = icon(a?.program ?? e.term.program, 16, t.foreground);
      return h_flex().id(`inbox-${e.address}`).h(40).flex_none().pl(12).pr(8).gap(8).items_center().rounded(8)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => this.focusEntry(e))
        .when(Boolean(pic), (el) => el.child(pic))
        .child(v_flex().flex_1().min_w(0)
          .child(h_flex().min_w(0).gap(6).child(div().min_w(0).truncate().text_color(t.foreground).child(name))
            .when(Boolean(where), (el) => el.child(div().flex_none().max_w(90).truncate().text_size(11).text_color(t.dim).child(where))))
          .child(div().min_w(0).truncate().text_size(11).text_color(t.blocked).child(e.reason ?? "needs you")))
        .when(e.at > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(this.now - e.at))));
    });
    return [head, ...rows, div().h(1).mx(8).my(4).flex_none().bg(t.border)];
  }

  // Working, waiting on you and done across every space, and the chat's unseen rows when it has any.
  // `n`: fleetCounts, taken from the same tree and inbox the list draws.
  fleet(t, n) {
    const unseen = unseenCount(shared("chat.unseen"));
    const count = (key, color, mark) => h_flex().id(`fleet-${key}`).flex_none().gap(3).items_center().text_color(n[key] ? color : t.dim)
      .tooltip({ working: "working", blocked: "waiting on you", done: "done" }[key]).child(mark).child(String(n[key]));
    return h_flex().flex_1().min_w(0).gap(9).items_center().justify_end().pr(4)
      .child(count("working", t.working, div().size(6).rounded(3).bg(n.working ? t.working : t.dim)))
      .child(count("blocked", t.blocked, div().text_size(10.5).font_bold().child("!")))
      .child(count("done", t.done, div().size(6).rounded(3).border(1.5).border_color(n.done ? t.done : t.dim)))
      .when(unseen > 0, (el) => el.child(div().id("chat-unseen").flex_none().px(6).h(17).rounded(9).bg(t.accent).text_color(t.accent_foreground)
        .text_size(10.5).font_semibold().flex().items_center().tooltip("unseen in chat").child(String(unseen))));
  }

  subRow(t, s) {
    const k = s.t;
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === this.shownAgent;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(KID_INDENT)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("terminal.peek", { terminal: k.address }))
      .children(s.lines.map((l) => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), (el) => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", (el) => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), (el) => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: kidStatus(k, this.listed) }, true));
  }

  // compact: a ! for blocked, because the status header above says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  // On the rail: a tile a space, with two letters from its name in its colour, the most urgent status in its corner and
  // its name on hover. Its agents follow, each its program's icon with a status mark, whatever's folded, because a rail
  // has no room for folds. Everything is centred, since the rail is only a tile wide.
  compact({ w, i }, t, tree) {
    const groups = tree.get(w.id) ?? [], members = groups.flatMap((g) => g.members);
    const status = railStatus(members, spaceActive(groups, this.all, this.listed));
    const color = t[(shared("space.colors") ?? {})[w.id]] ?? t.accent;
    const key = window()?.platform === "windows" ? "Alt" : "Ctrl";
    const tile = div().id(`space-${w.id}`).relative().mt(i ? 8 : 2).size(TILE).flex_none().self_center().flex().items_center().justify_center()
      .rounded(8).cursor_pointer().bg(w.active ? t.selected : t.raised).border_1().border_color(w.active ? color : t.border)
      .hover((s) => s.bg(t.hover)).tooltip(railTip(w.name, i, key)).accessibility_label(w.name)
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_size(12).font_semibold().text_color(w.active ? t.foreground : color).child(initials(w.name)))
      .when(Boolean(status), (el) => el.child(this.corner(t, status, TILE)));
    return [tile, ...members.map((a) => this.compactAgent(a, t))];
  }

  // A status in a corner: ! for blocked, a spinner for working, a dot for done. A space's sits top right, an agent's
  // bottom right, so an agent's mark doesn't read as the tile's above it.
  corner(t, status, size, low = false) {
    const at = (s) => div().absolute().top(low ? size - s + 3 : -4).left(size - s + 3).size(s).flex().items_center().justify_center().rounded_full();
    if (status === "blocked") return at(14).bg(t.blocked).border_2().border_color(t.chrome).text_size(9).font_bold().text_color(t.background).child("!");
    if (status === "working") return at(14).bg(t.chrome).child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working).spin(900));
    return at(10).bg(t.done ?? t.ansi2).border_2().border_color(t.chrome);
  }

  compactAgent(a, t) {
    const pic = icon(a.program, 14, t.foreground);
    const status = a.status === "idle" ? null : a.status;
    return div().id(`ag-${a.address}`).relative().mt(3).size(26).flex_none().self_center().flex().items_center().justify_center()
      .rounded(6).cursor_pointer().when(a.focused, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .tooltip(this.agentNames.get(a.address) || a.program?.name || a.address)
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .child(pic ?? div().size(6).rounded_full().bg(t.dim))
      .when(Boolean(status), (el) => el.child(this.corner(t, status, 26, true)));
  }

  // Agents no listed space holds, so none goes missing.
  noSpaceRows(t, collapsed, tree) {
    const groups = tree.get(NO_SPACE) ?? [];
    if (!groups.length) return [];
    if (collapsed) return groups.flatMap((g) => g.members).map((a) => this.compactAgent(a, t));
    return [div().px(8).pt(8).h(28).flex_none().text_size(11).text_color(t.dim).child("No space"), ...this.statusRows(NO_SPACE, groups, t)];
  }

  names(list) {
    const tabs = spaces().flatMap((s) => s.tabs);
    const all = panes();
    const labelOf = (a) => {
      const tab = tabs.find((tab) => tab.id === a.tab);
      return tab ? title(tab, lead(tab, all)) : a.title || a.program?.name || "";
    };
    const terms = new Map((this.all ?? []).map((k) => [k.address, k]));
    return agentNames(list, labelOf, (a) => telling(a.title, a.program) || a.program?.name || null, (a) => terminalName(terms.get(a.address)));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    // Space colors stay assigned because the space picker still draws them.
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map((p) => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = (c) => Object.values(kept).filter((v) => v === c).length;
      kept[p.id] = palette.reduce((best, c) => (uses(c) < uses(best) ? c : best));
      changed = true;
    }
    if (changed) setShared("space.colors", kept);

    const list = agents();
    this.now = Date.now();
    this.all = terminals();
    this.checkWorkers(this.now, this.all, list);
    this.spaceIds = sp.map((s) => s.id);
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    this.reasons = new Map(this.all.filter((k) => k.status === "blocked").map((k) => [k.address, blockedReason(k)]));
    this.shownAgent = focused()?.agent;
    this.track(list, this.now);
    this.held = nextHeld(list, this.held);
    this.agentNames = this.names(list);
    const tree = agentTree(list, sp, urgencyOf(list, this.all, this.held), (a) => this.since(a));
    const rows = this.ordered();
    setAgentOrder(displayOrder(rows.map((r) => r.w.id), tree));
    this.clashes = sharedEdits(rows.map((r) => ({ id: r.w.id, repo: r.g?.repo, top: r.g?.top, files: r.g?.files })));
    const waiting = collapsed ? [] : inbox(list, this.all, (a) => this.since(a));

    return v_flex().id("space-agents").size_full().min_h(0).bg(t.chrome).text_size(13)
      // A drag released outside a row, or outside the list, ends there.
      .on_hover((hovered, cx) => { if (!hovered) this.endDrag(cx); })
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .on_mouse_down_out((_e, cx) => this.endDrag(cx))
      .child(h_flex().h(31).pl(collapsed ? 0 : 16).pr(collapsed ? 0 : 10).flex_none().items_center().when(collapsed, (el) => el.justify_center()).when(!collapsed, (el) => el.justify_between()).gap(6).text_size(11.5).text_color(t.dim)
        .when(!collapsed, (el) => el.child(div().flex_none().child("Spaces")).child(this.fleet(t, fleetCounts(tree, waiting, this.all, this.listed))))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().id("space-list").flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always")
        .children([...this.inboxRows(waiting, t), ...this.grouped(t, collapsed, rows, tree), ...this.noSpaceRows(t, collapsed, tree)]))
      .when(collapsed, (el) => el.child(h_flex().h(28).flex_none().items_center().justify_center()
        .child(div().id("collapse").text_size(13).text_color(t.dim).hover((s) => s.text_color(t.foreground)).on_click(toggleSidebar).child("»"))));
  }
}
