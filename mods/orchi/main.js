// The Orchi panel: every orchestrator, every decision waiting on Adam, and the usage meters.
// This file reads data and owns view state. Drawing lives in view.js. What a press sends is in actions.js and
// switchboard.js. It reads shared state once per render, into `frame`. Dismissing is kept in this panel.
import { View } from "gpui-kit";
import { InputState, TextareaState } from "gpui-base";
import { exec, hc, home, appHome, readTextFile, writeTextFile, terminals, spaces, theme, run, shared, setShared, focused, watchFolder } from "herdr";
import { boardActivity, liveDecisions, parseProgress, parseItems, parseContext, parseModel, workerPhase } from "./parse.js";
import { metersFrom } from "./usage.js";
import { readyPlan, parseTracker, planTask, planLabel, plannable, visible } from "./plans.js";
import { localSpace, startClaude } from "./launch.js";
import { appendEntry, finishedRun, foundOrchestrators, keptProblems, loadWorld, projectProblems, removeHold, sessionRows, stamp, terminalAgents, terminalName, trustOf } from "./sessions.js";
import { ensureSwitchboard, planningDir, requestLine, sendRequest, writeRunRules } from "./switchboard.js";
import { NOTICE_MS, actionAnswer, answerProblem, answerText, copyText, discussLine, finishRun, noticeExpired, pasteInto, sendAnswer, settlePending } from "./actions.js";
import { PR_HINT, runRules, startOptions } from "./options.js";
import { completeProblem, killFailures, liveWorkers, stopTargets } from "./runs.js";
import { DEFAULT_WORKER_LIMIT, overrideUntil, parseSettings, startHolds, usageHolds } from "./limits.js";
import { orchiView } from "./view.js";
import { legworkDir as settingsLegworkDir, readSettings as readOrchiSettings, switchboardDir } from "./settings.js";

const REFRESH_MS = 15000;
const LOAD_LIMIT_MS = 60000;
const OPEN_KEY = "orchi.open-state";
const DISMISSED_KEY = "orchi.dismissed";
const PENDING = "orchi.pending";
const DISCARDED = "orchi.discarded";
const FOCUS = "orchi.focus";
const SESSION = "linear.session";
const STARTING_MS = 120000;
const PLANNER = { model: "claude-opus-5-5", effort: "high" };

// Frontmatter and the next prompt of every project in a legwork tracker.
const TRACKER = `cd "$1" && awk 'FNR==1{print "@@" FILENAME; fm=1; inp=0; fence=0; next}
fm && /^---$/{fm=0; next}
fm{print; next}
/^## Next prompt/{inp=1; next}
inp && /^\`\`\`/{ if(fence){inp=0; fence=0; print "@@endprompt"} else {fence=1; print "@@prompt"} next}
inp && fence{print}' projects/*.md`;

// Orchi's settings from ~/.config/orchi/settings.json, read once. A load reads them before anything else, so the
// presses that follow find them read.
let orchiSettings = null;
const orchi = async () => (orchiSettings ??= await readOrchiSettings(readTextFile, home()));
const planningFile = (file) => `${planningDir(orchiSettings, home())}/${file}.md`;
const expand = (path) => (path?.startsWith("~/") ? `${home()}${path.slice(1)}` : path);
const attempt = async (job, fallback = null) => { try { return (await job()) ?? fallback; } catch { return fallback; } };
const readText = (path) => attempt(() => readTextFile(path), "");
const hex = (length) => Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join("");
const agents = () => terminalAgents(exec);
const io = async () => ({ exec, hc, home, readTextFile, writeTextFile, terminals, spaces, agents, now: Date.now, random: () => hex(8), discarded: () => shared(DISCARDED) ?? [], orchi: await orchi() });

// Orchi's own settings, such as the worker limit, from `~/.config/herdr-app/orchi.json`.
const readSettings = async () => parseSettings(await readText(`${appHome()}/orchi.json`));

async function readUsage() {
  const text = await readText(`${home()}/.cache/ccstatusline/usage.json`);
  return text ? metersFrom(JSON.parse(text), Date.now()) : [];
}

// The legwork folder from Orchi's settings, else from the Linear panel's config. The API key in that file is never read out.
async function legworkDir() {
  const set = settingsLegworkDir(await orchi(), home());
  if (set) return set;
  const dir = JSON.parse((await readText(`${appHome()}/linear.json`)) || "{}").legwork?.dir;
  return typeof dir === "string" && dir.trim() ? expand(dir.trim()) : null;
}

async function readTracker(dir) {
  if (!dir) return [];
  const r = await exec("sh", ["-c", TRACKER, "sh", dir]);
  return r.code === 0 ? parseTracker(r.stdout).filter((p) => p.category === "work") : [];
}

async function screenOf(o) {
  const screen = o.where === "app"
    ? (await attempt(() => hc(["read", o.address])))?.stdout
    : (await attempt(() => exec("herdr", ["agent", "read", o.pane, "--source", "visible", "--lines", "6"])))?.stdout;
  return screen ?? "";
}

async function load() {
  await orchi();
  const dir = await attempt(legworkDir);
  const [world, usage, tracker, settings] = await Promise.all([loadWorld(await io()), attempt(readUsage, []), attempt(() => readTracker(dir), []), readSettings()]);
  const { state, live, agents: herdrAgents, found, holder, sessions, busy, held, requested } = world;
  const byFile = new Map(tracker.map((p) => [p.file, p]));
  const repoOf = (project, cwd) => state.watching.find((w) => w.project === project)?.repo ?? cwd ?? expand(byFile.get(project)?.repo) ?? null;

  // Switchboard files: the repo of every orchestrator, watched project and work project in the tracker.
  const repos = new Set(found.map((o) => repoOf(o.project, o.cwd)).filter(Boolean));
  for (const w of state.watching) repos.add(w.repo);
  for (const p of tracker) if (expand(p.repo)) repos.add(expand(p.repo));
  const boards = new Map(await Promise.all([...repos].map(async (repo) => [repo, await readText(`${repo}/.legwork/switchboard.md`)])));

  // A finished run that has stopped is history, not an orchestrator.
  const running = found.filter((o) => !finishedRun(o.status, boards.get(repoOf(o.project, o.cwd)) ?? ""));
  // The switchboard's watch list counts too: a pane loses its name when Claude Code restarts in it.
  const owners = new Map(state.watching.map((w) => [w.repo, { name: `orch-${w.project}`, pane: w.pane, where: live.some((t) => t.address === w.pane) ? "app" : "terminal" }]));
  // A finished run can leave an action for Adam, such as merging, and its session can still take the reply.
  for (const o of found) owners.set(repoOf(o.project, o.cwd), { name: o.name, address: o.address ?? null, pane: o.pane ?? o.address, where: o.where, finished: !running.includes(o) });
  // A planner's questions are on its own board, and a board with no planner running is ignored.
  const planners = live.filter((t) => t.state === "live" && planLabel(t));
  await Promise.all(planners.map(async (t) => {
    const file = planLabel(t), path = planningFile(file);
    boards.set(path, await readText(path));
    owners.set(path, { name: `plan-${file}`, terminal: t.address });
  }));
  const { decisions, hidden } = liveDecisions(boards, owners);

  // Terminals named fw-<slug> are the live workers, from the app and from terminal Herdr.
  const fw = new Map(live.filter((t) => terminalName(t).startsWith("fw-")).map((t) => [terminalName(t), t.address]));
  const liveNames = new Set([...fw.keys(), ...herdrAgents.map((a) => a.name).filter((n) => n.startsWith("fw-"))]);
  const orchestrators = await Promise.all(running.map(async (o) => {
    const repo = repoOf(o.project, o.cwd);
    const [fanout, screen] = await Promise.all([repo ? readText(`${repo}/.legwork/fanout-state.md`) : "", screenOf(o)]);
    const workers = parseItems(fanout).filter((i) => i.route !== "orchestrator")
      .map((i) => ({ ...i, address: fw.get(`fw-${i.slug}`) ?? null, phase: workerPhase(i, liveNames) }));
    const started = state.started[o.project] ?? /\(started (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(fanout)?.[1] ?? null;
    return {
      ...o, repo, progress: parseProgress(fanout), started, activity: boardActivity(boards.get(repo) ?? "", started),
      running: workers.filter((w) => w.phase === "running"), completed: workers.filter((w) => w.phase === "completed"), queued: workers.filter((w) => w.phase === "queued"),
      liveWorkers: liveWorkers(live, herdrAgents, workers.map((w) => w.slug).filter(Boolean)),
      paused: state.paused.includes(o.project), waiting: decisions.some((d) => d.orch === o.name),
      context: parseContext(screen), model: parseModel(screen),
    };
  }));

  const plans = tracker.map((p) => ({ ...p, ...readyPlan(p, p.prompt) })).filter((p) => p.ready);
  const projects = tracker.filter(plannable).map(({ file, name, repo }) => ({ file, name, repo: expand(repo) }));
  const trust = await trustOf(exec, home(), planFolders(plans, sessions), await orchi());
  return {
    usage, orchestrators, decisions, hidden, plans, projects, planners, holder, sessions, tracker, busy, held, requested, trust, paused: state.paused,
    terminalsRead: live.length > 0, dir, workerLimit: settings.workerLimit,
  };
}

// Every folder a plan on show would start in, for Start's rules.
const planFolders = (plans, sessions) => [
  ...plans.map((p) => expand(p.repo)).filter(Boolean),
  ...sessions.filter((s) => s.phase === "Planned").flatMap((s) => s.board.plans.map((p) => p.repo)),
];

export default class Orchi extends View {
  init(_props, cx) {
    this.loaded = { decisions: [], plans: [] };
    this.data = { usage: [], orchestrators: [], decisions: [], hidden: 0, plans: [], projects: [], planners: [], dismissedDecisions: 0, dismissedPlans: 0, holder: { where: null, terminal: null }, sessions: [], tracker: [], busy: new Set(), held: new Map(), requested: { start: new Set(), run: new Set() }, trust: {}, paused: [], dir: null, workerLimit: DEFAULT_WORKER_LIMIT };
    this.dismissed = new Set();
    try { this.dismissed = new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]")); } catch { /* start with none */ }
    this.planFor = null; this.planOpen = false; this.planSearch = ""; this.planError = null;
    this.planInput = InputState.new({ placeholder: "Search projects" });
    this.planInput.on("change", (_e, cx) => { this.planSearch = this.planInput.value(); cx.notify(); });
    this.replyInput = InputState.new({ placeholder: "Or type a reply" });
    this.replyInput.on("change", (_e, cx) => { this.replyText = this.replyInput.value(); this.replyError = null; cx.notify(); });
    this.actionInput = InputState.new({ placeholder: "Details, a response or feedback" });
    this.actionInput.on("change", (_e, cx) => { this.actionText = this.actionInput.value(); this.replyError = null; cx.notify(); });
    this.replyText = ""; this.actionText = ""; this.option = null; this.pinned = null; this.sending = false; this.replyError = null;
    this.note = null; this.actionError = null; this.noticeAt = null; this.starting = {}; this.usageOverrides = new Map(); this.seenFocus = null; this.focusSession = null;
    this.startFor = null; this.stopping = null; this.completing = null;
    this.startPrs = InputState.new({ placeholder: PR_HINT });
    this.startPrs.on("change", (_e, cx) => this.setStartOption({ prs: this.startPrs.value() }, cx));
    this.startExtra = TextareaState.new({ placeholder: "Anything this run should know" });
    this.startExtra.on("change", (_e, cx) => this.setStartOption({ extra: this.startExtra.value() }, cx));
    this.at = 0; this.generation = 0; this.loadingSince = 0; this.again = false; this.stale = false; this.size = null; this.opened = {};
    try { this.opened = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}"); } catch { /* start with defaults */ }
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      const dir = switchboardDir(await orchi(), home());
      for (;;) { await watchFolder(dir); this.refresh(cx); }
    });
  }

  // One load at a time, and a press during one runs another straight after. A load that took longer than the timer
  // used to be dropped by the next tick, so on a busy machine nothing ever landed. One stuck past the limit is given up.
  refresh(cx) {
    if (Date.now() - this.loadingSince < LOAD_LIMIT_MS) { this.again = true; return; }
    const generation = ++this.generation;
    this.loadingSince = Date.now();
    cx.spawn(async (cx) => {
      let data = null;
      try { data = await load(); } catch { /* keep the last good data */ }
      if (generation !== this.generation) return;
      this.loadingSince = 0;
      this.stale = !data;
      if (data) {
        this.loaded = data;
        this.applyDismissed();
        this.settle(data);
      }
      cx.notify();
      if (this.again) { this.again = false; this.refresh(cx); }
    });
  }

  // Dismissing hides an entry in this panel only. The files, and anyone waiting on them, don't change.
  decisionKey(d) { return `decision:${d.orch}:${d.id}`; }

  // A dismissed plan returns when its tracker file next changes.
  planKey(p) { return `plan:${p.file}:${p.updated}`; }

  applyDismissed() {
    const decisions = visible(this.loaded.decisions, (d) => this.decisionKey(d), this.dismissed);
    const plans = visible(this.loaded.plans, (p) => this.planKey(p), this.dismissed);
    this.data = { ...this.loaded, decisions: decisions.shown, plans: plans.shown, dismissedDecisions: decisions.dismissed, dismissedPlans: plans.dismissed };
    // The card stays on the decision on show, wherever a refresh puts it.
    const pinned = decisions.shown.findIndex((d) => this.decisionKey(d) === this.pinned);
    this.at = pinned >= 0 ? pinned : Math.min(this.at, Math.max(0, decisions.shown.length - 1));
    this.syncReply();
    setShared("orchi.open", decisions.shown.length);
  }

  // A reply belongs to one decision, so moving to another clears it and it can't go to the wrong one.
  syncReply() {
    const d = this.data.decisions[this.at], key = d ? this.decisionKey(d) : null;
    if (key === this.pinned) return;
    this.pinned = key; this.option = null; this.replyError = null;
    if (this.replyText) { this.replyText = ""; this.replyInput.set_value(""); }
    if (this.actionText) { this.actionText = ""; this.actionInput.set_value(""); }
  }

  // Pending presses clear once state.md shows them done. A failed load gets here with nothing, so it can't clear one.
  settle(data) {
    const pending = shared(PENDING) ?? {};
    const next = settlePending(pending, data.paused, data.orchestrators.map((o) => o.project), { terminalsRead: data.terminalsRead });
    if (Object.keys(next).length !== Object.keys(pending).length) setShared(PENDING, next);
  }

  saveDismissed() {
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...this.dismissed])); } catch { /* not remembered */ }
    this.applyDismissed();
  }

  dismiss(key) { this.dismissed.add(key); this.saveDismissed(); }

  // Shows every dismissed entry of one kind again, "decision" or "plan".
  restore(kind) { this.dismissed = new Set([...this.dismissed].filter((k) => !k.startsWith(`${kind}:`))); this.saveDismissed(); }

  switchboardChoice() { return shared(SESSION)?.switchboard; }

  // Runs a press that does several things, and shows what stopped it. What it says clears itself after NOTICE_MS, unless
  // a later press has put up its own.
  act(job, cx) {
    this.dismissNotice();
    cx.spawn(async (cx) => {
      try { await job(); } catch (e) { this.actionError = String(e.message ?? e); }
      if (this.note || this.actionError) {
        const at = Date.now();
        this.noticeAt = at;
        cx.timer.after(NOTICE_MS, (cx) => { if (this.noticeAt === at) { this.dismissNotice(); cx.notify(); } });
      }
      this.refresh(cx);
      cx.notify();
    });
    cx.notify();
  }

  dismissNotice() { this.note = null; this.actionError = null; this.noticeAt = null; }

  // The header's note or error, while it has time left.
  noticeShown() { return !noticeExpired(this.noticeAt, Date.now()); }

  // Open chat with no decision, Discuss in chat with one. The switchboard starts only if the lock is free. A decision is
  // left in its prompt, with no Enter. A switchboard started just now isn't ready for that, so it goes on the clipboard.
  chat(d, cx) {
    if (d?.planner) { run("agent.focus", { terminal: d.terminal }); return; }
    this.act(async () => {
      const holder = await ensureSwitchboard(await io(), this.switchboardChoice());
      if (holder.where === "terminal") { this.note = "The switchboard is in terminal Herdr, so it can't be shown from here."; return; }
      const line = d ? discussLine(d) : null;
      if (line && holder.started) {
        await copyText(exec, line);
        this.note = "Copied. Paste it once the switchboard is up.";
      }
      if (line && !holder.started) {
        if (!await pasteInto({ exec, run, focused }, holder.terminal, line)) this.note = "Copied, but that terminal didn't take the keyboard, so nothing was pasted.";
        return;
      }
      run("agent.focus", { terminal: holder.terminal });
    }, cx);
  }

  send(d, text, cx) {
    const problem = answerProblem(text);
    if (problem) { this.replyError = problem; cx.notify(); return; }
    if (this.sending) return;
    this.sending = true; this.replyError = null;
    cx.spawn(async (cx) => {
      try {
        await sendAnswer(exec, home(), d, text, await orchi());
        this.option = null;
        if (this.replyText) { this.replyText = ""; this.replyInput.set_value(""); }
        if (this.actionText) { this.actionText = ""; this.actionInput.set_value(""); }
      } catch (e) { this.replyError = String(e.message ?? e); }
      this.sending = false;
      this.refresh(cx);
      cx.notify();
    });
    cx.notify();
  }

  sendDecision(d, cx) { this.send(d, answerText(this.option, this.replyText), cx); }

  answerAction(d, cx) { this.send(d, actionAnswer(this.actionText), cx); }

  copyCommand(d, cx) { this.act(async () => { await copyText(exec, d.run); this.note = "Copied."; }, cx); }

  // Never presses Enter. The permission check wants Adam's own action in that session.
  putInTerminal(d, cx) {
    this.act(async () => {
      if (!await pasteInto({ exec, run, focused }, d.address, d.run)) this.note = "Copied, but that terminal didn't take the keyboard, so nothing was pasted.";
    }, cx);
  }

  // Asks the switchboard, and shows the spinner until state.md says it's done. The pending state is shared, so a
  // window restart keeps it.
  pause(o, next, cx) {
    const line = requestLine(next === "pausing" ? "pause" : "resume", o.project);
    if (!line) return;
    setShared(PENDING, { ...shared(PENDING), [o.project]: next });
    this.act(async () => {
      try { await sendRequest(await io(), line, this.switchboardChoice()); }
      catch (e) {
        const { [o.project]: _gone, ...rest } = shared(PENDING) ?? {};
        setShared(PENDING, rest);
        throw e;
      }
    }, cx);
  }

  // Complete says the run is over and leaves its terminal to read. It's for a run that has gone quiet, so the card offers
  // it only then, asks first, and the press checks the board, the terminal and the workers once more before writing the DONE.
  completeRun(o, cx) {
    this.completing = null;
    this.act(async () => {
      const [board, fanout, world] = await Promise.all([readText(`${o.repo}/.legwork/switchboard.md`), readText(`${o.repo}/.legwork/fanout-state.md`), loadWorld(await io())]);
      const now = foundOrchestrators(world.live, world.agents).find((x) => x.name === o.name);
      const slugs = parseItems(fanout).filter((i) => i.route !== "orchestrator").map((i) => i.slug).filter(Boolean);
      const workers = liveWorkers(world.live, world.agents, slugs);
      const problem = completeProblem({ board, status: now?.status ?? o.status, paused: world.state.paused.includes(o.project), workers }, Date.now());
      if (problem) throw new Error(problem);
      await finishRun(exec, home(), o.repo, "Marked complete by Adam from the Orchi panel.", await orchi());
    }, cx);
  }

  // Stop also ends the terminals, so it asks first. The DONE goes in first, so a failed stop leaves nothing half ended.
  // The terminals are read again at the press, not taken from a load up to 15 s old, and a kill that fails is shown.
  stopRun(o, cx) {
    this.stopping = null;
    this.act(async () => {
      await finishRun(exec, home(), o.repo, "Stopped by Adam from the Orchi panel.", await orchi());
      const fanout = o.repo ? await readText(`${o.repo}/.legwork/fanout-state.md`) : "";
      const live = (() => { try { return terminals(); } catch { return []; } })();
      const targets = stopTargets(live, o.name, parseItems(fanout).map((i) => i.slug).filter(Boolean));
      const results = [];
      for (const target of targets) {
        try { results.push({ target, reply: await hc(["kill", target.address]) }); } catch (error) { results.push({ target, error }); }
      }
      const failed = killFailures(results);
      if (failed) throw new Error(failed);
    }, cx);
  }

  // A start is held back for a while after the press, and for as long as its request waits in the switchboard's
  // requests folder, which a window restart doesn't forget.
  isStarting(key) {
    if (Date.now() - (this.starting[key] ?? 0) < STARTING_MS) return true;
    const [verb, name] = key.split(":");
    return Boolean(this.data.requested?.[verb === "start" ? "start" : "run"]?.has(name));
  }

  projectOf = (file) => this.data.tracker.find((p) => p.file === file);

  ruleContext(busy, trust, held = this.data.held, requested = this.data.requested) { return { busy, trust, held, requested, folderOf: (p) => expand(p.repo) }; }

  // The usage meters let go by Start anyway, each until it resets. Kept in memory, so a window restart holds them again.
  overrides() {
    const now = Date.now();
    for (const [label, until] of this.usageOverrides) if (until <= now) this.usageOverrides.delete(label);
    return new Set(this.usageOverrides.keys());
  }

  // What holds Start for every plan: the worker limit across all runs, and every usage meter not let go.
  holds() { return startHolds({ usage: this.data.usage, orchestrators: this.data.orchestrators, limit: this.data.workerLimit, overrides: this.overrides() }); }

  // The usage holds on show, which Start anyway can let go.
  usageHeld() { return usageHolds(this.data.usage, this.overrides()); }

  // Start anyway: every usage meter holding Start now is let go until it resets. The worker limit still holds.
  overrideUsage(cx) {
    for (const [label, until] of overrideUntil(this.data.usage, this.usageHeld(), Date.now())) this.usageOverrides.set(label, until);
    cx.notify();
  }

  sessionProblems(s, rows) { return [...this.holds(), ...keptProblems(s, this.projectOf, rows, this.ruleContext(this.data.busy, this.data.trust))]; }

  queuedProblems(p) { return [...this.holds(), ...projectProblems(p, this.ruleContext(this.data.busy, this.data.trust))]; }

  // Start opens the sheet of choices, and starting the plan waits for the sheet's own Start. `saved` seeds it: a brief's
  // choices, or those last used on the review screen for a plan with no brief.
  askStart(key, name, label, saved, go) {
    if (this.isStarting(key)) return;
    const options = startOptions(saved);
    this.startFor = { key, name, label, options, go, error: null };
    this.startPrs.set_value(options.prs);
    this.startExtra.set_value(options.extra);
  }

  closeStart() { this.startFor = null; }

  setStartOption(patch, cx) {
    if (!this.startFor) return;
    this.startFor = { ...this.startFor, options: { ...this.startFor.options, ...patch } };
    cx.notify();
  }

  confirmStart(cx) {
    const { go, options } = this.startFor;
    this.startFor = null;
    go(options, cx);
  }

  // Start runs Go's rules again on fresh data, then asks the switchboard. A kept plan is `start <session>`, and
  // a project queued in legwork is `run <project>`, which runs its next prompt under the run rules.
  startPlan(key, name, line, options, problemsWith, cx) {
    if (this.isStarting(key)) return;
    this.starting = { ...this.starting, [key]: Date.now() };
    this.act(async () => {
      try {
        // The usage meters are read fresh. The worker count is the last load's, at most 15 s old.
        const usage = await attempt(readUsage, this.data.usage);
        const [hold] = startHolds({ usage, orchestrators: this.data.orchestrators, limit: this.data.workerLimit, overrides: this.overrides() });
        if (hold) throw new Error(hold);
        const [problem] = await problemsWith(await loadWorld(await io()));
        if (problem) throw new Error(problem);
        await writeRunRules(await io(), name, runRules(options));
        await sendRequest(await io(), line, options.switchboard);
      } catch (e) {
        const { [key]: _gone, ...rest } = this.starting;
        this.starting = rest;
        throw e;
      }
    }, cx);
  }

  askStartSession(s) {
    this.askStart(`start:${s.session}`, s.session, s.board.plans.map((p) => p.project).join(", ") || s.session, s.choices, (options, cx) => this.startSession(s, options, cx));
  }

  askStartQueued(p) {
    this.askStart(`run:${p.file}`, p.file, p.name, shared(SESSION), (options, cx) => this.startQueued(p, options, cx));
  }

  startSession(s, options, cx) {
    this.startPlan(`start:${s.session}`, s.session, requestLine("start", s.session), options, async (world) => {
      const rows = sessionRows(world.sessions, Date.now(), shared(DISCARDED) ?? []);
      const trust = await trustOf(exec, home(), s.board.plans.map((p) => p.repo), await orchi());
      return keptProblems(s, this.projectOf, rows, this.ruleContext(world.busy, trust, world.held, world.requested));
    }, cx);
  }

  startQueued(p, options, cx) {
    this.startPlan(`run:${p.file}`, p.file, requestLine("run", p.file), options, async (world) => {
      const trust = await trustOf(exec, home(), [expand(p.repo)].filter(Boolean), await orchi());
      return projectProblems(p, this.ruleContext(world.busy, trust, world.held, world.requested));
    }, cx);
  }

  // Marks the plan kept on its board, and settles the planner's tab so it stays open out of the way.
  keepPlan(s, cx) {
    this.act(async () => {
      const path = planningFile(s.session), entry = (text) => appendEntry(text, `${s.session}-kept`, "KEPT", stamp(new Date()));
      const text = (await readTextFile(path)) ?? "";
      // The planner or the switchboard may have written since, so a stale snapshot reads once more.
      await writeTextFile(path, entry(text), text).catch(async () => {
        const again = (await readTextFile(path)) ?? "";
        await writeTextFile(path, entry(again), again);
      });
      if (s.planner?.tab) run("tab.settle", { id: s.planner.tab });
    }, cx);
  }

  // Shared, so In Herdr drops it too. The board and the tracker's Roadmap section stay as they are.
  // Discarding also lets go of the repos Go held for it.
  discardPlan(s, cx) {
    setShared(DISCARDED, [...(shared(DISCARDED) ?? []), s.session]);
    this.act(async () => removeHold(await io(), s.session), cx);
  }

  // Jumps to the planner's terminal, else opens the saved plan in a new tab.
  readSaved(s) {
    if (s.planner) run("agent.focus", { terminal: s.planner.address });
    else run("tab.new", { name: `Plan ${s.tickets[0] ?? s.session}`, mod: "plan-view", props: { path: planningFile(s.session) } });
  }

  pickPlanProject(file) { this.planFor = file; this.planOpen = false; }

  // A planner already running for the project is shown, not started twice.
  createPlan(cx) {
    const project = this.data.projects.find((p) => p.file === this.planFor);
    if (!project) return;
    const running = this.data.planners.find((t) => planLabel(t) === project.file);
    if (running) { run("agent.focus", { terminal: running.address }); return; }
    const folder = project.repo ?? this.data.dir ?? home();
    const space = localSpace(spaces(), folder);
    this.planError = null;
    cx.spawn(async (cx) => {
      try {
        const terminal = await startClaude({ exec, hc, home }, {
          ...PLANNER, task: planTask(project.name, planningFile(project.file), project.file), tab: `Plan ${project.name}`, folder, space, labels: [`orchi.plan=${project.file}`],
        });
        run("agent.focus", { terminal });
        this.planFor = null;
      } catch (e) { this.planError = String(e.message ?? e); }
      cx.notify();
    });
  }

  // Every section is open unless stored otherwise. Finished and queued workers and an update's detail start closed.
  isOpen(key) { return this.opened[key] ?? !/:(completed|queued|update)$/.test(key); }

  toggle(key) {
    this.opened = { ...this.opened, [key]: !this.isOpen(key) };
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(this.opened)); } catch { /* not remembered */ }
  }

  step(by) {
    const total = this.data.decisions.length;
    if (total) { this.at = (this.at + by + total) % total; this.syncReply(); }
  }

  // Shows the first open entry on a session's boards.
  showSession(session) {
    const s = this.data.sessions.find((x) => x.session === session);
    const boards = [planningFile(session), ...(s?.runs ?? []).map((r) => r.repo)];
    const at = this.data.decisions.findIndex((d) => boards.includes(d.board));
    if (at >= 0) { this.at = at; this.syncReply(); }
  }

  showDecision(id) {
    const at = this.data.decisions.findIndex((d) => d.id === id);
    if (at >= 0) { this.at = at; this.syncReply(); }
  }

  focusTerminal(address) { if (address) run("pane.focus", { terminal: address }); }

  // Opens a project's plan in a new tab, rendered by the plan-view mod.
  readPlan(p) { run("tab.new", { name: p.name, mod: "plan-view", props: { path: `${this.data.dir}/projects/${p.file}.md` } }); }

  render() {
    const focus = shared(FOCUS), discarded = shared(DISCARDED) ?? [];
    this.frame = { pending: shared(PENDING) ?? {}, rows: sessionRows(this.data.sessions, Date.now(), discarded), focus: focus?.session ?? null };
    if (focus && focus.at !== this.seenFocus) { this.seenFocus = focus.at; this.showSession(focus.session); }
    return orchiView(this, theme());
  }
}
