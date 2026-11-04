// One tickets panel: every chosen source's open tickets in one list, read through `orchi tickets --json`, then a review
// screen that hands the ticked ones to a planner. This file reads data, owns the view state and picks the screen.
// Drawing lives in the *-view.js files. It reads shared state once per render, into `frame`, because a render over the
// host's short deadline is thrown away. See docs/adr/0006-tickets-panel.md.
import { View } from "gpui-kit";
import { v_flex, InputState, TextareaState } from "gpui-base";
import { exec, hc, terminals, spaces, theme, home, appHome, readTextFile, writeTextFile, nextCommand, shared, setShared, run, watchFolder } from "herdr";
import { Latest, limitFor, listArgv, showArgv, statesArgv, moveArgv, moveFailure, parseList, parseShow, parseStates, failure, withTimeout } from "./data.js";
import { actionsFor, changedSince, filterTickets, keepFailed, projectGroups, withState } from "./tickets.js";
import { TRACKER, parseProjects, projectOf, projectFolder, githubRepo, remotesToRead } from "./legwork.js";
import { briefingOf } from "./briefing.js";
import { startClaude } from "./launch.js";
import { queueView } from "./queue-view.js";
import { PR_SUGGESTION, restoreSession, sessionProblems } from "./review.js";
import { emptyWorld, loadWorld, removeHold, sessionRows, terminalAgents, ticketSessions, trustOf, writeHold } from "./sessions.js";
import { ensureSwitchboard, planningDir, switchboardDir } from "./switchboard.js";
import { readSettings } from "./settings.js";
import { goPlan, goProblems, newSession, plannerPlace, projectStart } from "./go.js";
import { reviewView } from "./review-view.js";
import { detailsView } from "./details-view.js";
import { dumpFile, scriptFile, scriptSteps, testing } from "./test-hook.js";

const REFRESH_MS = 60000;
const RENDER_RETRY_MS = 1000;
const SESSIONS_MS = 15000;
const REMOTE_RETRY_MS = 10 * 60000;
const WORLD_LIMIT_MS = 60000;
const PICKS = "tickets.assignments";
const SESSION = "tickets.session";
const DISCARDED = "orchi.discarded";
const FOCUS = "orchi.focus";

async function legworkProjects(dir) {
  const r = await exec("sh", ["-c", TRACKER, "sh", dir]);
  if (r.code !== 0) throw new Error(`Could not read legwork projects in ${dir}`);
  return parseProjects(r.stdout);
}

// One `orchi tickets` call, given up after its limit, if it has one. A list exits 1 when a source had a problem, and
// still prints JSON, so the answer is read whenever there is one.
async function orchiTickets(argv, sleep) {
  const limit = limitFor(argv);
  return limit ? withTimeout(() => exec("/usr/bin/env", argv), limit, sleep, "orchi tickets") : exec("/usr/bin/env", argv);
}

const picks = () => shared(PICKS) ?? {};
const hex = (length) => Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join("");
const agents = () => terminalAgents(exec);
// Orchi's settings: read at the start, and again on each refresh, so an edit to them counts within a minute.
let orchiSettings = null;
const orchi = () => (orchiSettings ??= readSettings(readTextFile, home(), appHome()));
const io = async () => ({ exec, hc, home, readTextFile, writeTextFile, terminals, spaces, agents, now: Date.now, random: () => hex(8), discarded: () => shared(DISCARDED) ?? [], orchi: await orchi() });

function stored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
}

export default class Tickets extends View {
  init(_props, cx) {
    this.tickets = []; this.problemsSeen = []; this.sources = []; this.projects = []; this.remotes = new Map(); this.remoteFailed = new Map();
    this.generation = 0; this.loading = false; this.error = null; this.legworkDir = null;
    this.source = "all"; this.category = "all"; this.text = ""; this.pickerText = "";
    this.selected = null; this.screen = "queue"; this.ticked = new Set();
    const closed = stored("groups.closed", []);
    this.closed = new Set(Array.isArray(closed) ? closed : []);
    this.bodies = new Map(); this.briefings = new Map(); this.states = new Map(); this.latest = new Latest();
    this.statusOpen = null; this.moving = null; this.moveError = null; this.projectNote = null; this.startingProject = null;
    this.search = InputState.new({ placeholder: "Filter" });
    this.search.on("change", (_e, cx) => { this.text = this.search.value(); cx.notify(); });
    this.picker = InputState.new({ placeholder: "Search projects" });
    this.picker.on("change", (_e, cx) => { this.pickerText = this.picker.value(); cx.notify(); });
    this.pickerOpen = null;
    this.world = emptyWorld(); this.trust = {}; this.going = false; this.goError = null; this.sessionsGeneration = 0;
    this.worldSince = 0; this.worldAgain = false;
    const saved = this.session();
    this.prsInput = InputState.new({ placeholder: PR_SUGGESTION, value: saved.prs });
    this.prsInput.on("change", (_e, cx) => this.setSession({ prs: this.prsInput.value() }, cx));
    this.extraInput = TextareaState.new({ placeholder: "", value: saved.extra });
    this.extraInput.on("change", (_e, cx) => this.setSession({ extra: this.extraInput.value() }, cx));
    this.refresh(cx);
    this.refreshSessions(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    // Herdr stops a render at about 55 ms and keeps the last frame under a banner. Code that has just loaded runs far
    // slower than that, so the first render with tickets can be stopped, and nothing would ask for another.
    cx.timer.every(RENDER_RETRY_MS, (cx) => { if (this.drawing) cx.notify(); });
    cx.timer.every(SESSIONS_MS, (cx) => this.refreshSessions(cx));
    // A switchboard folder that isn't there yet is looked for again later, rather than ending the watch.
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(switchboardDir(await orchi(), home())); } catch { await cx.sleep(SESSIONS_MS); }
        this.refreshSessions(cx);
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh") this.refresh(cx);
        else if (command === "script" && testing(appHome())) await this.runScript(cx);
        else if (command === "dump" && testing(appHome())) await this.dump();
        cx.notify();
      }
    });
  }

  // ---- reading ----

  // One list read at a time: the timer, a move and the refresh button can all ask, and asking during a read runs one
  // more straight after, since orchi tickets can't be stopped once started.
  refresh(cx) {
    if (this.loading) { this.refreshAgain = true; return; }
    const generation = ++this.generation;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const s = await readSettings(readTextFile, home(), appHome());
        orchiSettings = Promise.resolve(s);
        const sleep = (ms) => cx.sleep(ms);
        // orchi tickets names a tracker it can't read, so a failure here keeps the projects last read and the list still loads.
        const [r, projects] = await Promise.all([orchiTickets(listArgv(home()), sleep), s.legwork_dir ? legworkProjects(s.legwork_dir).catch(() => this.projects) : []]);
        let list;
        try { list = parseList(r.stdout); } catch { throw new Error(r.code === 0 ? "orchi tickets gave an answer the panel can't read" : failure(r)); }
        if (generation === this.generation) {
          this.legworkDir = s.legwork_dir;
          this.tickets = keepFailed(this.tickets, list.tickets, list.failed); this.problemsSeen = list.problems; this.sources = list.sources; this.projects = projects;
          this.error = null;
          if (this.source !== "all" && !this.sources.includes(this.source)) this.source = "all";
          // A ticked ticket that left the list is no longer ticked.
          const refs = new Set(this.tickets.map((t) => t.ref));
          this.ticked = new Set([...this.ticked].filter((ref) => refs.has(ref)));
          if (!this.ticked.size) this.screen = "queue";
          if (this.selected && !refs.has(this.selected)) this.selected = null;
          this.readAgain(cx);
          // The list shows first; GitHub tickets find their projects once the repos' origins are read.
          cx.spawn(async (cx) => {
            const remotes = await this.readRemotes(projects);
            if (generation !== this.generation || !remotes.size) return;
            for (const [folder, repo] of remotes) this.remotes.set(folder, repo);
            cx.notify();
          });
        }
      } catch (e) { if (generation === this.generation) this.error = String(e.message ?? e); }
      finally {
        if (generation === this.generation) this.loading = false;
        cx.notify();
        if (this.refreshAgain) { this.refreshAgain = false; this.refresh(cx); }
      }
    });
    cx.notify();
  }

  // The GitHub `owner/repo` of each project's repo, read from its `origin`, so a GitHub ticket finds its project. Known
  // ones aren't read again, and the refresh keeps these only if it is still the newest. A folder whose read failed, such
  // as a repo not cloned here, is tried again after REMOTE_RETRY_MS.
  async readRemotes(projects) {
    const now = Date.now(), folders = remotesToRead(projects, this.remotes, home()).filter((f) => !(now - (this.remoteFailed.get(f) ?? -Infinity) < REMOTE_RETRY_MS));
    const read = await Promise.all(folders.map(async (folder) => [folder, await exec("git", ["-C", folder, "remote", "get-url", "origin"]).catch(() => null)]));
    for (const [folder, r] of read) if (r?.code !== 0) this.remoteFailed.set(folder, now);
    return new Map(read.filter(([, r]) => r?.code === 0).map(([folder, r]) => [folder, githubRepo(r.stdout)]));
  }

  ticket(ref) { return this.tickets.find((t) => t.ref === ref) ?? null; }

  // The legwork project a ticket belongs to; your pick in the panel beats any link.
  // A render asks for each ticket's project several times, so the frame keeps the answers.
  linked(ticket, assigned = picks()) {
    const cache = assigned === this.frame?.picks ? this.frame.projects : null;
    if (cache?.has(ticket.ref)) return cache.get(ticket.ref);
    const project = projectOf(ticket, this.projects, { picks: assigned, remotes: this.remotes, home: home() });
    cache?.set(ticket.ref, project);
    return project;
  }

  categoryOf(ticket) { return this.linked(ticket, this.frame?.picks)?.category || null; }

  // The tickets the filters show, in their project cards.
  shown() {
    const list = filterTickets(this.tickets, { source: this.source, category: this.category, text: this.text }, (t) => this.categoryOf(t));
    return projectGroups(list, (t) => this.linked(t, this.frame?.picks));
  }

  // ---- one ticket ----

  open(ticket, cx) {
    this.selected = ticket.ref; this.moveError = null; this.projectNote = null;
    if (ticket.source === "legwork") this.loadBriefing(ticket, cx);
    else this.loadBody(ticket, cx);
    if (ticket.source === "linear") this.loadStates(ticket, cx);
    cx.notify();
  }

  // The open ticket's body or briefing again, when the list shows it changed since they were read.
  readAgain(cx) {
    const ticket = this.selected ? this.ticket(this.selected) : null;
    if (!ticket) return;
    // A project file's `updated:` is a date, so a change the same day doesn't move it: the briefing is read each time.
    if (ticket.source === "legwork") this.loadBriefing(ticket, cx);
    else if (changedSince(this.bodies.get(ticket.ref), ticket)) this.loadBody(ticket, cx);
  }

  // The body, read with orchi tickets show, once per change to the ticket.
  loadBody(ticket, cx) {
    const have = this.bodies.get(ticket.ref), argv = showArgv(home(), ticket.ref);
    if (!argv || (!changedSince(have, ticket) && !have.error)) return;
    const key = `body ${ticket.ref}`, asked = this.latest.begin(key);
    this.bodies.set(ticket.ref, { updated: ticket.updated, body: have?.body ?? null, loading: true });
    cx.spawn(async (cx) => {
      let got = null, error = null;
      try {
        const r = await orchiTickets(argv, (ms) => cx.sleep(ms));
        got = r.code === 0 ? parseShow(r.stdout) : null;
        if (!got) throw new Error(failure(r));
      } catch (e) { error = String(e.message ?? e); }
      if (!this.latest.current(key, asked)) return;
      this.bodies.set(ticket.ref, error ? { updated: ticket.updated, body: null, loading: false, error } : { updated: ticket.updated, body: got.body ?? "", loading: false });
      cx.notify();
    });
  }

  // A legwork ticket briefs like /pickup, from its project file. The file is small, so it's read each time it's asked for.
  loadBriefing(ticket, cx) {
    const file = ticket.id, have = this.briefings.get(file), dir = this.legworkDir;
    if (!dir || have?.loading) return;
    const key = `briefing ${file}`, asked = this.latest.begin(key);
    this.briefings.set(file, { updated: ticket.updated, brief: have?.brief ?? null, loading: true });
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${dir}/projects/${file}.md`).catch(() => null);
      if (!this.latest.current(key, asked)) return;
      this.briefings.set(file, { updated: ticket.updated, brief: text ? briefingOf(text) : null, loading: false });
      cx.notify();
    });
  }

  // A Linear ticket's team states, for Status.
  loadStates(ticket, cx) {
    const argv = statesArgv(home(), ticket.ref);
    if (!argv) return;
    const key = `states ${ticket.ref}`, asked = this.latest.begin(key);
    this.states.set(ticket.ref, { ...(this.states.get(ticket.ref) ?? { states: [] }), loading: true, error: null });
    cx.spawn(async (cx) => {
      let got = null, error = null;
      try {
        const r = await orchiTickets(argv, (ms) => cx.sleep(ms));
        got = r.code === 0 ? parseStates(r.stdout) : null;
        if (!got) throw new Error(failure(r));
      } catch (e) { error = String(e.message ?? e); }
      if (!this.latest.current(key, asked)) return;
      if (error) this.states.set(ticket.ref, { states: this.states.get(ticket.ref)?.states ?? [], loading: false, error });
      else {
        this.states.set(ticket.ref, { states: got.states, loading: false, error: null });
        // Its state now, not the one from the last list, so a move never starts from an old state.
        this.tickets = withState(this.tickets, ticket.ref, got.state);
      }
      cx.notify();
    });
  }

  // Status on a Linear ticket: the press is the yes, so the move is made at once.
  move(ticket, state, cx) {
    const argv = moveArgv(home(), ticket.ref, state);
    if (!argv || this.moving) return;
    this.moving = ticket.ref; this.moveError = null; this.statusOpen = null;
    // A states read still out from before the move would put the old state back.
    this.latest.begin(`states ${ticket.ref}`);
    cx.spawn(async (cx) => {
      try {
        const r = await orchiTickets(argv, (ms) => cx.sleep(ms));
        if (r.code !== 0) throw new Error(moveFailure(r));
        this.tickets = withState(this.tickets, ticket.ref, state);
      } catch (e) { this.moveError = { ref: ticket.ref, text: String(e.message ?? e) }; }
      // Its states again, since the move called off any read that was out, then the list.
      finally { this.moving = null; this.loadStates(ticket, cx); this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // Pickup and Go open a tab in the project's own space, a new one named after it when there's none, show it, and
  // start Claude Code there with /pickup or /go as its first message.
  startProject(ticket, verb, cx) {
    const project = this.linked(ticket), start = project && projectStart(verb, project, home());
    if (!start) { this.projectNote = { ref: ticket.ref, text: `${project?.name ?? ticket.title} has no repo` }; cx.notify(); return; }
    // A second press while the first is still starting would open a second session on the same repo.
    if (this.startingProject) return;
    if (verb === "go") {
      const { busy, held, requested } = this.world;
      const [problem] = goProblems(project, ticket.ref, { inSession: this.frame?.inSession, busy, held, requested, folderOf: (p) => projectFolder(p, home()) });
      if (problem) { this.projectNote = { ref: ticket.ref, text: problem }; cx.notify(); return; }
    }
    this.projectNote = null; this.startingProject = ticket.ref;
    cx.spawn(async (cx) => {
      // Go holds the repo, as a session's Go does, until its orchestrator shows or the hold's grace runs out, so a
      // second Go on that repo can't get through meanwhile.
      const hold = verb === "go" ? `go-${start.tab}-${hex(4)}` : null;
      try {
        if (hold) await writeHold(await io(), hold, [start.folder]);
        const space = spaces().find((s) => !s.machine && s.folder === start.folder);
        await startClaude({ exec, hc, home, orchi: await orchi() }, {
          model: null, effort: null, task: start.task, tab: start.tab, folder: start.folder, space: space?.id ?? `sp${hex(32)}`,
          spaceName: space ? null : start.tab, focus: true,
        });
      } catch (e) {
        if (hold) await removeHold(await io(), hold);
        this.projectNote = { ref: ticket.ref, text: String(e?.message ?? e) };
      }
      finally { this.startingProject = null; this.refreshSessions(cx); }
      cx.notify();
    });
  }

  // The planning session: the ticket joins any others ticked, and the review screen opens.
  sendToOrchi(ticket, cx) {
    if (!this.ticked.has(ticket.ref)) this.ticked = new Set([...this.ticked, ticket.ref]);
    this.selected = null;
    this.review(cx);
  }

  act(action, ticket, cx) {
    if (action === "Pickup") this.startProject(ticket, "pickup", cx);
    else if (action === "Go") this.startProject(ticket, "go", cx);
    else if (action === "Send to Orchi") this.sendToOrchi(ticket, cx);
  }

  // ---- sessions ----

  // Sessions, orchestrators and folder trust. Go's rules read these, and In Herdr draws them. One load at a time: the
  // timer, the folder watch and a Go can all ask, and a call during a load runs one more straight after. A load stuck
  // past the limit is given up, so a hung read can't stop them for good.
  refreshSessions(cx) {
    if (Date.now() - this.worldSince < WORLD_LIMIT_MS) { this.worldAgain = true; return; }
    const generation = ++this.sessionsGeneration;
    this.worldSince = Date.now();
    cx.spawn(async (cx) => {
      try {
        const world = await loadWorld(await io());
        const trust = this.ticked.size ? await trustOf(exec, home(), this.sessionFolders(), await orchi()) : {};
        if (generation !== this.sessionsGeneration) return;
        this.world = world; this.trust = { ...this.trust, ...trust };
      } catch { /* keep the last good data */ }
      if (generation !== this.sessionsGeneration) return;
      this.worldSince = 0;
      cx.notify();
      if (this.worldAgain) { this.worldAgain = false; this.refreshSessions(cx); }
    });
  }

  tickedTickets() { return this.tickets.filter((t) => this.ticked.has(t.ref)); }

  // Every folder a session on the ticked tickets would start in.
  sessionFolders() {
    const repos = this.tickedTickets().map((t) => this.linked(t)).filter((p) => p?.repo).map((p) => projectFolder(p, home()));
    return new Set(repos).size > 1 && this.legworkDir ? [...repos, this.legworkDir] : repos;
  }

  checkTrust(cx) {
    cx.spawn(async (cx) => {
      this.trust = { ...this.trust, ...await trustOf(exec, home(), this.sessionFolders(), await orchi()) };
      cx.notify();
    });
  }

  review(cx) { if (this.ticked.size) { this.screen = "review"; this.checkTrust(cx); } cx.notify(); }

  // The rules for Go, on the data a frame or a press passes in.
  problems(tickets, assigned, rows, world, trust) {
    return sessionProblems(tickets, (t) => this.linked(t, assigned), {
      inSession: ticketSessions(rows), busy: world.busy, held: world.held, requested: world.requested, trust, planning: this.legworkDir, folderOf: (p) => projectFolder(p, home()),
    });
  }

  // Go: the rules once more on fresh data, then the brief, the switchboard if the lock is free, and the planner.
  go(cx) {
    if (this.going) return;
    this.going = true; this.goError = null;
    cx.spawn(async (cx) => {
      try { await this.startSession(); }
      catch (e) { this.goError = String(e.message ?? e); }
      finally { this.going = false; this.refreshSessions(cx); cx.notify(); }
    });
    cx.notify();
  }

  async startSession() {
    const tickets = this.tickedTickets(), assigned = picks(), choices = this.session(), now = new Date();
    const world = await loadWorld(await io()), trust = await trustOf(exec, home(), this.sessionFolders(), await orchi());
    const rows = sessionRows(world.sessions, now.getTime(), shared(DISCARDED) ?? []);
    const [problem] = this.problems(tickets, assigned, rows, world, trust);
    if (problem) throw new Error(problem);
    const session = newSession(now, hex(4));
    const plan = goPlan({ session, tickets, projectOf: (t) => this.linked(t, assigned), choices, created: now, home: home() });
    if (!plan) throw new Error("A ticket or project has a name the panel can't use");
    const dir = planningDir(await orchi(), home());
    await exec("mkdir", ["-p", dir]);
    await writeTextFile(`${dir}/${session}.json`, `${JSON.stringify(plan.brief, null, 2)}\n`, null);
    // The hold goes in before anything starts, so a second Go sees these repos as taken while this planner plans.
    await writeHold(await io(), session, plan.repos);
    try {
      await ensureSwitchboard(await io(), choices.switchboard);
      const place = plannerPlace(plan.repos, this.legworkDir, spaces(), () => `sp${hex(32)}`);
      await startClaude({ exec, hc, home, orchi: await orchi() }, { model: plan.model, effort: plan.effort, task: plan.task, tab: plan.tab, labels: plan.labels, ...place });
    } catch (e) {
      await removeHold(await io(), session);
      throw e;
    }
    this.ticked = new Set(); this.screen = "queue";
    this.openOrchi();
  }

  openOrchi() {
    run("layout.select", { stack: "panel-body", child: "orchi" });
    run("layout.show", { id: "panel" });
  }

  // Opens one session in Orchi. `at` makes a second press on the same row count.
  openSession(session) {
    setShared(FOCUS, { session, at: Date.now() });
    this.openOrchi();
  }

  // Picking what the links already say clears the pick.
  pick(ticket, file) {
    const { [ticket.ref]: _old, ...rest } = picks();
    const linkedFile = this.linked(ticket, {})?.file ?? "";
    setShared(PICKS, file === linkedFile ? rest : { ...rest, [ticket.ref]: file });
  }

  // The session choices, remembered between sessions in shared state.
  session() { return restoreSession(shared(SESSION)); }

  setSession(change, cx) {
    setShared(SESSION, { ...this.session(), ...change });
    cx.notify();
  }

  // Takes a ticket out of the session; with none left, back to the queue.
  untick(ref, cx) {
    this.ticked = new Set([...this.ticked].filter((r) => r !== ref));
    if (!this.ticked.size) this.screen = "queue";
    cx.notify();
  }

  tick(ref, cx) {
    const next = new Set(this.ticked);
    if (!next.delete(ref)) next.add(ref);
    this.ticked = next;
    cx.notify();
  }

  toggleCard(key) {
    this.closed.has(key) ? this.closed.delete(key) : this.closed.add(key);
    try { localStorage.setItem("groups.closed", JSON.stringify([...this.closed])); } catch { /* not remembered */ }
  }

  emptyText() {
    if (this.error) return this.error;
    if (this.loading && !this.tickets.length) return "Loading…";
    return this.tickets.length ? "No tickets match" : "No open tickets";
  }

  // ---- a private window's test hook ----

  async runScript(cx) {
    const steps = scriptSteps(await readTextFile(scriptFile(appHome())).catch(() => null));
    for (const step of steps) {
      const ticket = step.ref ? this.ticket(step.ref) : null;
      if (step.do === "source") this.source = step.value;
      else if (step.do === "category") this.category = step.value;
      else if (step.do === "open" && ticket) this.open(ticket, cx);
      else if (step.do === "back") { this.selected = null; this.screen = "queue"; }
      else if (step.do === "tick" && ticket) this.tick(ticket.ref, cx);
      else if (step.do === "send" && ticket) this.sendToOrchi(ticket, cx);
      else if (step.do === "move" && ticket) this.move(ticket, step.value, cx);
      else if (step.do === "act" && ticket && actionsFor(ticket).includes(step.value)) this.act(step.value, ticket, cx);
      else if (step.do === "review") this.review(cx);
      else if (step.do === "go") this.go(cx);
      else if (step.do === "refresh") this.refresh(cx);
      cx.notify();
    }
  }

  async dump() {
    const rows = sessionRows(this.world.sessions, Date.now(), shared(DISCARDED) ?? []);
    this.frame = { picks: picks(), session: this.session(), rows, inSession: ticketSessions(rows), projects: new Map() };
    const selected = this.selected ? this.ticket(this.selected) : null;
    const state = {
      screen: selected ? "ticket" : this.screen, source: this.source, category: this.category, sources: this.sources,
      error: this.error, problems: this.problemsSeen, loading: this.loading,
      cards: this.shown().map((g) => ({ label: g.label, tickets: g.tickets.map((t) => t.ref) })),
      selected: selected?.ref ?? null, actions: selected ? actionsFor(selected) : [],
      states: selected ? (this.states.get(selected.ref)?.states ?? []).map((s) => s.name) : [],
      ticked: [...this.ticked], going: this.going, goError: this.goError,
      reviewProblems: this.ticked.size ? this.problems(this.tickedTickets(), this.frame.picks, rows, this.world, this.trust) : [],
    };
    const path = dumpFile(appHome()), before = await readTextFile(path).catch(() => null);
    await writeTextFile(path, `${JSON.stringify(state, null, 2)}\n`, before);
  }

  render() {
    this.drawing = true;
    const t = theme();
    const rows = sessionRows(this.world.sessions, Date.now(), shared(DISCARDED) ?? []);
    this.frame = { picks: picks(), session: this.session(), rows, inSession: ticketSessions(rows), projects: new Map() };
    const ticket = this.selected ? this.ticket(this.selected) : null;
    const view = v_flex().id("tickets").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.canvas).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .children(ticket ? detailsView(this, ticket, t) : this.screen === "review" && this.ticked.size ? reviewView(this, t) : queueView(this, t));
    this.drawing = false;
    return view;
  }
}
