// Open Linear issues as project cards with status bands and tick boxes, then a review screen.
// This file reads data, owns the view state and picks the screen. Drawing lives in the *-view.js files. It reads shared
// state once per render, into `frame`, because a render over the host's short deadline is thrown away.
import { View } from "gpui-kit";
import { v_flex, InputState, TextareaState } from "gpui-base";
import { exec, hc, terminals, spaces, theme, home, appHome, readTextFile, writeTextFile, nextCommand, shared, setShared, run, watchFolder } from "herdr";
import {
  API_URL, ISSUES_QUERY, STATES_QUERY, DESCRIPTIONS_QUERY, MAX_PAGES, DESCRIPTION_BATCH, issuesFilter, parseConfig, parseIssuePage, parseStates, parseDescriptions,
  descriptionsToFetch, withDescriptions, keptDescriptions, withTimeout, linearError,
} from "./linear.js";
import { githubRepo, workerPulls, stagePulls, settleLinks, settleSeen } from "./pulls.js";
import { parseProjects, findProject, projectFolder } from "./legwork.js";
import { toggleTick } from "./queue.js";
import { RUNNER, PROJECT_RUNNER, stage, settle, settledPicks, picksWithSteps, runnerFinished, pickSteps, updateLines, updateTask, projectTask } from "./updates.js";
import { localSpace, startClaude } from "./launch.js";
import { queueView } from "./queue-view.js";
import { PR_SUGGESTION, restoreSession, sessionProblems } from "./review.js";
import { emptyWorld, loadWorld, removeHold, sessionRows, terminalAgents, ticketSessions, trustOf, writeHold } from "./sessions.js";
import { ensureSwitchboard, makeFolder, planningDir, switchboardDir } from "./switchboard.js";
import { readSettings, legworkDir } from "./settings.js";
import { isWindows, winHelper } from "./platform.js";
import { legworkMode, listedProjects, projectRows } from "./legwork-rows.js";
import { goPlan, newSession, plannerPlace } from "./go.js";
import { briefingOf, goLine, pickupLine } from "./briefing.js";
import { reviewView } from "./review-view.js";
import { detailsView } from "./details-view.js";

const REFRESH_MS = 60000;
const UPDATE_POLL_MS = 1000;
const RENDER_RETRY_MS = 1000;
const SESSIONS_MS = 15000;
const FETCH_LIMIT_MS = 20000;
const WORLD_LIMIT_MS = 60000;
const NO_KEY = "No Linear API key. Add it to ~/.config/herdr-app/linear.json or set LINEAR_API_KEY.";
const ASSIGNED = "linear.assignments";
const SESSION = "linear.session";
const STAGED = "linear.staged";
const LINKS = "linear.links";
const PULLS_SEEN = "linear.pulls-seen";
const DISCARDED = "orchi.discarded";
const FOCUS = "orchi.focus";

// On Windows there's no sh, mkdir or awk, so win.py stands in. With no Linear key there, the panel lists legwork projects.
const WINDOWS = isWindows();
const WIN = () => winHelper(appHome(), "linear");

// LINEAR_API_KEY from the shell agents start in, when linear.json has none. Windows has no sh to ask, so only the file counts.
async function envKey() {
  if (WINDOWS) return null;
  const r = await exec("sh", ["-c", 'printf %s "$LINEAR_API_KEY"']).catch(() => null);
  return r?.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function projectMap(text) {
  try {
    const projects = JSON.parse(text)?.legwork?.projects;
    return projects && typeof projects === "object" && !Array.isArray(projects) ? projects : {};
  } catch { return {}; }
}

async function loadConfig() {
  const text = await readTextFile(`${appHome()}/linear.json`).catch(() => null);
  const config = parseConfig(text, home());
  const dir = legworkDir(await orchi(), home());
  // Orchi's legwork_dir wins over linear.json's, and linear.json's project map still applies without its dir.
  if (dir && !config.error) config.legwork = { dir, projects: config.legwork?.projects ?? projectMap(text) };
  if (!config.apiKey && !config.error) config.apiKey = await envKey();
  return config;
}

// One GraphQL read, given up after FETCH_LIMIT_MS. `sleep` is the view's `cx.sleep`, the only timer a mod has.
async function linearCall(apiKey, query, variables, sleep) {
  return withTimeout(async () => {
    const r = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify(variables ? { query, variables } : { query }),
    });
    const body = await r.text();
    if (!r.ok) throw new Error(linearError(r.status, body));
    return JSON.parse(body);
  }, FETCH_LIMIT_MS, sleep);
}

// Every open issue, a page at a time. `complete` is false when the list stopped at the page limit.
async function fetchIssues(apiKey, teams, sleep) {
  const issues = [];
  let after = null, pages = 0;
  do {
    const page = parseIssuePage(await linearCall(apiKey, ISSUES_QUERY, { filter: issuesFilter(teams), after }, sleep));
    issues.push(...page.issues);
    after = page.next; pages++;
  } while (after && pages < MAX_PAGES);
  return { issues, complete: !after };
}

async function fetchDescriptions(apiKey, ids, sleep) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += DESCRIPTION_BATCH) {
    for (const [id, entry] of parseDescriptions(await linearCall(apiKey, DESCRIPTIONS_QUERY, { ids: ids.slice(i, i + DESCRIPTION_BATCH) }, sleep))) found.set(id, entry);
  }
  return found;
}

// Workflow states change rarely, and the panel works without them, so a failure keeps the last ones.
async function fetchStates(apiKey, sleep) {
  return parseStates(await linearCall(apiKey, STATES_QUERY, null, sleep));
}

// Frontmatter and the next prompt of every project in a legwork tracker.
const TRACKER = `cd "$1" && awk 'FNR==1{print "@@" FILENAME; fm=1; inp=0; fence=0; next}
fm && /^---$/{fm=0; next}
fm{print; next}
/^## Next prompt/{inp=1; next}
inp && /^\`\`\`/{ if(fence){inp=0; fence=0; print "@@endprompt"} else {fence=1; print "@@prompt"} next}
inp && fence{print}' projects/*.md`;

// The projects in a legwork tracker: the work ones for Linear tickets, or every one a legwork panel lists.
async function legworkProjects(dir, every = false) {
  const r = WINDOWS ? await exec("python", ["-I", "-S", WIN(), "tracker", dir]) : await exec("sh", ["-c", TRACKER, "sh", dir]);
  if (r.code !== 0) throw new Error(`Could not read legwork projects in ${dir}`);
  const projects = parseProjects(r.stdout);
  return every ? listedProjects(projects) : projects.filter((p) => p.category === "work");
}

const assignments = () => shared(ASSIGNED) ?? {};
const hex = (length) => Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join("");
const agents = () => terminalAgents(exec, WINDOWS);
// Orchi's settings, read once. They say where the switchboard's files are.
let orchiSettings = null;
const orchi = () => (orchiSettings ??= readSettings(readTextFile, home()));
const io = async () => ({ exec, hc, home, readTextFile, writeTextFile, terminals, spaces, agents, now: Date.now, random: () => hex(8), discarded: () => shared(DISCARDED) ?? [], orchi: await orchi(), windows: WINDOWS, win: WIN() });

// A stored value read back, or `fallback` when it's missing or not JSON.
function stored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
}

export default class Linear extends View {
  init(_props, cx) {
    this.issues = []; this.projects = []; this.text = ""; this.pickerText = "";
    this.generation = 0; this.loading = false; this.selected = null;
    this.bucket = "active"; this.screen = "queue"; this.ticked = new Set(); this.counts = { all: 0, active: 0, backlog: 0, review: 0 };
    const closed = stored("groups.closed", []);
    this.closed = new Set(Array.isArray(closed) ? closed : []);
    this.descriptions = new Map(); this.cut = false; this.remotes = new Map(); this.worldSince = 0; this.worldAgain = false;
    this.openProjects = new Set(); this.briefings = new Map(); this.projectNote = null;
    this.search = InputState.new({ placeholder: "Filter by id, title or project" });
    this.search.on("change", (_e, cx) => { this.text = this.search.value(); cx.notify(); });
    this.picker = InputState.new({ placeholder: "Search projects" });
    this.picker.on("change", (_e, cx) => { this.pickerText = this.picker.value(); cx.notify(); });
    this.pickerOpen = null; this.states = {}; this.statusOpen = null;
    this.starting = false; this.updating = null; this.updateError = null; this.creating = null;
    this.world = emptyWorld(); this.trust = {}; this.going = false; this.goError = null; this.sessionsGeneration = 0;
    this.newProject = InputState.new({ placeholder: "New legwork project name" });
    const saved = this.session();
    this.prsInput = InputState.new({ placeholder: PR_SUGGESTION, value: saved.prs });
    this.prsInput.on("change", (_e, cx) => this.setSession({ prs: this.prsInput.value() }, cx));
    this.extraInput = TextareaState.new({ placeholder: "Anything this session should know", value: saved.extra });
    this.extraInput.on("change", (_e, cx) => this.setSession({ extra: this.extraInput.value() }, cx));
    this.refresh(cx);
    this.refreshSessions(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    cx.timer.every(UPDATE_POLL_MS, (cx) => this.watchUpdate(cx));
    // Herdr stops a render at about 55 ms and keeps the last frame under a banner. Code that has just loaded runs far
    // slower than that, so the first render with tickets can be stopped, and nothing would ask for another.
    cx.timer.every(RENDER_RETRY_MS, (cx) => { if (this.drawing) cx.notify(); });
    cx.timer.every(SESSIONS_MS, (cx) => this.refreshSessions(cx));
    cx.spawn(async (cx) => {
      for (;;) { await watchFolder(switchboardDir(await orchi(), home())); this.refreshSessions(cx); }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh") this.refresh(cx);
        cx.notify();
      }
    });
  }

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
        const trust = this.ticked.size ? await trustOf(exec, home(), this.sessionFolders(), await orchi(), WINDOWS) : {};
        if (generation !== this.sessionsGeneration) return;
        this.world = world; this.trust = { ...this.trust, ...trust };
        await this.readRemotes(world);
        this.stagePullRequests();
      } catch { /* keep the last good data */ }
      if (generation !== this.sessionsGeneration) return;
      this.worldSince = 0;
      cx.notify();
      if (this.worldAgain) { this.worldAgain = false; this.refreshSessions(cx); }
    });
  }

  // The GitHub `owner/name` of each repo with a worker pull request, read once from its remote.
  async readRemotes(world) {
    const repos = new Set(world.sessions.flatMap((s) => (s.runs ?? []).filter((r) => r.prs?.length).map((r) => r.repo)));
    for (const repo of repos) {
      if (this.remotes.has(repo)) continue;
      const r = await exec("git", ["-C", repo, "remote", "get-url", "origin"]).catch(() => null);
      this.remotes.set(repo, r?.code === 0 ? githubRepo(r.stdout) : null);
    }
  }

  // A worker's new pull request is staged as a link on its ticket and In review, for Update tickets to send. Each is
  // staged once, so Discard holds. Nothing goes to Linear without that press.
  stagePullRequests() {
    if (!this.issues.length || !Object.keys(this.states).length) return;
    const pulls = workerPulls(this.world.sessions, this.remotes);
    if (!pulls.length) return;
    const seen = shared(PULLS_SEEN) ?? {};
    const next = stagePulls({ pulls, issues: this.issues, staged: this.staged(), links: this.links(), seen, statesFor: (issue) => this.states[issue.team] ?? [] });
    if (JSON.stringify(next.seen) === JSON.stringify(seen)) return;
    setShared(STAGED, next.staged); setShared(LINKS, next.links); setShared(PULLS_SEEN, next.seen);
  }

  // Every folder a session on the ticked tickets would start in.
  sessionFolders() {
    const repos = this.tickedIssues().map((issue) => this.linked(issue)).filter((p) => p?.repo).map((p) => projectFolder(p, home()));
    const planning = this.config?.legwork?.dir;
    return new Set(repos).size > 1 && planning ? [...repos, planning] : repos;
  }

  tickedIssues() { return this.issues.filter((issue) => this.ticked.has(issue.id)); }

  checkTrust(cx) {
    cx.spawn(async (cx) => {
      this.trust = { ...this.trust, ...await trustOf(exec, home(), this.sessionFolders(), await orchi(), WINDOWS) };
      cx.notify();
    });
  }

  review(cx) { this.screen = "review"; this.checkTrust(cx); cx.notify(); }

  // ---- a Legwork card: its briefing, and Pickup, Go and Send to Orchi ----

  // Cards start closed. Opening one reads its project file, once per change to the file's `updated` line.
  toggleProject(issue, cx) {
    const file = issue.identifier;
    if (this.openProjects.has(file)) this.openProjects.delete(file);
    else { this.openProjects.add(file); this.loadBriefing(issue, cx); }
    cx.notify();
  }

  loadBriefing(issue, cx) {
    const file = issue.identifier, have = this.briefings.get(file), dir = this.config?.legwork?.dir;
    if (!dir || (have && have.updated === issue.updatedAt)) return;
    this.briefings.set(file, { updated: issue.updatedAt, brief: null, loading: true });
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${dir}/projects/${file}.md`).catch(() => null);
      this.briefings.set(file, { updated: issue.updatedAt, brief: text ? briefingOf(text) : null, loading: false });
      cx.notify();
    });
  }

  briefing(file) { return this.briefings.get(file) ?? null; }

  // Pickup and Go open a tab in the project's own space, a new one named after it when there's none, show it, and start
  // Claude Code there with /pickup or /go as its first message.
  startProject(issue, line, cx) {
    const project = this.projects.find((p) => p.file === issue.identifier);
    const folder = project?.repo ? projectFolder(project, home()) : null;
    if (!folder) { this.projectNote = { file: issue.identifier, text: "This project has no repo folder to open." }; cx.notify(); return; }
    this.projectNote = { file: issue.identifier, text: "Opening…" };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const place = plannerPlace([folder], this.config?.legwork?.dir, spaces(), () => `sp${hex(32)}`);
        const known = spaces().some((s) => s.id === place.space);
        await startClaude({ exec, hc, home, windows: WINDOWS, win: WIN() }, {
          model: null, effort: null, task: line, tab: issue.title, folder, space: place.space,
          spaceName: known ? null : issue.title, focus: true,
        });
        this.projectNote = null;
      } catch (e) {
        this.projectNote = { file: issue.identifier, text: String(e?.message ?? e) };
      }
      cx.notify();
    });
  }

  pickupProject(issue, cx) { this.startProject(issue, pickupLine(issue.identifier), cx); }
  goProject(issue, cx) { this.startProject(issue, goLine(issue.identifier), cx); }

  // The planning session: the project joins any others ticked, and the review screen opens, as Review does.
  sendToOrchi(issue, cx) {
    if (!this.ticked.has(issue.id)) this.ticked = toggleTick(this.ticked, issue.id);
    this.review(cx);
  }

  // The rules for Go, on the data a frame or a press passes in.
  problems(tickets, assigned, rows, world, trust) {
    return sessionProblems(tickets, (issue) => this.linked(issue, assigned), {
      inSession: ticketSessions(rows), busy: world.busy, held: world.held, requested: world.requested, trust, planning: this.config?.legwork?.dir ?? null, folderOf: (p) => projectFolder(p, home()),
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
    const tickets = this.tickedIssues(), assigned = assignments(), choices = this.session(), now = new Date();
    const world = await loadWorld(await io()), trust = await trustOf(exec, home(), this.sessionFolders(), await orchi(), WINDOWS);
    const rows = sessionRows(world.sessions, now.getTime(), shared(DISCARDED) ?? []);
    const [problem] = this.problems(tickets, assigned, rows, world, trust);
    if (problem) throw new Error(problem);
    const session = newSession(now, hex(4));
    const plan = goPlan({ session, tickets, projectOf: (issue) => this.linked(issue, assigned), choices, created: now, home: home(), source: this.legwork ? "legwork" : undefined });
    if (!plan) throw new Error("A ticket or project has a name the panel can't use");
    const dir = planningDir(await orchi(), home());
    await makeFolder(await io(), dir);
    await writeTextFile(`${dir}/${session}.json`, `${JSON.stringify(plan.brief, null, 2)}\n`, null);
    // The hold goes in before anything starts, so a second Go sees these repos as taken while this planner plans.
    await writeHold(await io(), session, plan.repos);
    try {
      await ensureSwitchboard(await io(), choices.switchboard);
      const place = plannerPlace(plan.repos, this.config?.legwork?.dir, spaces(), () => `sp${hex(32)}`);
      await startClaude({ exec, hc, home, windows: WINDOWS, win: WIN() }, { model: plan.model, effort: plan.effort, task: plan.task, tab: plan.tab, labels: plan.labels, ...place });
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

  refresh(cx) {
    const generation = ++this.generation;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const config = await loadConfig();
        this.config = config;
        if (config.error) throw new Error(config.error);
        this.legwork = legworkMode(config, WINDOWS);
        if (!config.apiKey && !this.legwork) throw new Error(NO_KEY);
        const sleep = (ms) => cx.sleep(ms);
        let issues, states, projects, complete = true;
        if (this.legwork) {
          projects = await legworkProjects(config.legwork.dir, true);
          issues = projectRows(projects); states = {};
        } else {
          let listed;
          [{ issues: listed, complete }, states] = await Promise.all([fetchIssues(config.apiKey, config.teams, sleep), fetchStates(config.apiKey, sleep).catch(() => this.states)]);
          // Descriptions only for tickets that changed since they were read. A failure leaves the ones held.
          const wanted = descriptionsToFetch(listed, this.descriptions);
          if (wanted.length) {
            try { for (const [id, entry] of await fetchDescriptions(config.apiKey, wanted, sleep)) this.descriptions.set(id, entry); } catch { /* shown next time */ }
          }
          this.descriptions = keptDescriptions(this.descriptions, listed);
          issues = withDescriptions(listed, this.descriptions);
          projects = config.legwork ? await legworkProjects(config.legwork.dir) : [];
        }
        if (generation === this.generation) {
          this.issues = issues; this.projects = projects; this.states = states; this.error = null; this.cut = !complete;
          setShared(STAGED, settle(this.staged(), issues, complete));
          setShared(LINKS, settleLinks(this.links(), issues, complete));
          setShared(PULLS_SEEN, settleSeen(shared(PULLS_SEEN) ?? {}, issues, complete));
          this.stagePullRequests();
          setShared(ASSIGNED, settledPicks(assignments(), issues, (issue) => this.linked(issue, {})?.file ?? ""));
          // A ticked ticket that left the list is no longer ticked.
          const ids = new Set(issues.map((i) => i.id));
          this.ticked = new Set([...this.ticked].filter((id) => ids.has(id)));
          if (!this.ticked.size) this.screen = "queue";
        }
      } catch (e) { if (generation === this.generation) this.error = String(e.message ?? e); }
      finally {
        if (generation === this.generation) {
          this.loading = false;
          if (this.updating?.settling) this.updating = null;
        }
        cx.notify();
      }
    });
    cx.notify();
  }

  // The legwork project a ticket belongs to; your pick in the details beats any link. A legwork row is its project.
  linked(issue, assigned = assignments()) {
    if (issue.legwork) return this.projects.find((p) => p.file === issue.identifier) ?? null;
    return findProject(this.projects, issue, this.config?.legwork?.projects, assigned);
  }

  // The card a row sits in: its legwork project, or for a legwork row its category.
  groupOf(issue, assigned) { return issue.legwork ? issue.title : this.linked(issue, assigned)?.name ?? issue.project; }

  title() { return this.legwork ? "Legwork" : "Linear"; }

  // A press on a row opens a ticket's details. A legwork row has no ticket to show, so the press ticks it.
  open(issue, cx) {
    if (issue.legwork) { this.tick(issue.id, cx); return; }
    this.selected = issue.id; cx.notify();
  }

  // Picking what the links already say clears the pick, so no change is asked of the agent.
  pick(issue, file) {
    const { [issue.identifier]: _old, ...rest } = assignments();
    const linkedFile = this.linked(issue, {})?.file ?? "";
    setShared(ASSIGNED, file === linkedFile ? rest : { ...rest, [issue.identifier]: file });
  }

  // The session choices, remembered between sessions in shared state.
  session() { return restoreSession(shared(SESSION)); }

  setSession(change, cx) {
    setShared(SESSION, { ...this.session(), ...change });
    cx.notify();
  }

  isPicked(issue) { return Object.hasOwn(this.frame.assigned, issue.identifier); }

  // Status changes waiting to go to Linear, by ticket ID.
  staged() { return shared(STAGED) ?? {}; }

  stageStatus(issue, state) { setShared(STAGED, stage(this.staged(), issue, state)); }

  // Pull request links waiting to go to Linear, by ticket ID.
  links() { return shared(LINKS) ?? {}; }

  // Tickets with a status, link or legwork change waiting for Update tickets.
  changed() {
    const { staged, assigned, links } = this.frame;
    return this.issues.filter((issue) => staged[issue.identifier] || links[issue.identifier]?.length || Object.hasOwn(assigned, issue.identifier));
  }

  discardChanges(cx) {
    setShared(STAGED, {}); setShared(ASSIGNED, {}); setShared(LINKS, {});
    this.updateError = null;
    cx.notify();
  }

  // A runner is busy until it stops working. Its tab stays open afterwards, to read what it did.
  runnerBusy() {
    if (this.starting || this.updating) return true;
    const live = (() => { try { return terminals(); } catch { return []; } })();
    return live.some((t) => t.labels?.["linear.runner"] && t.state === "live" && !["idle", "done"].includes(t.status));
  }

  startRunner(runner, task, tab, cx, started = () => {}) {
    this.starting = true; this.updateError = null;
    cx.spawn(async (cx) => {
      const folder = this.config?.legwork?.dir ?? home();
      try { started(await startClaude({ exec, hc, home, windows: WINDOWS, win: WIN() }, { ...runner, task, tab, folder, space: localSpace(spaces(), folder) })); }
      catch (e) { this.updating = null; this.updateError = String(e.message ?? e); }
      finally { this.starting = false; cx.notify(); }
    });
    cx.notify();
  }

  updateTickets(cx) {
    const { dir, projects: map } = this.config?.legwork ?? {};
    const options = { dir, map, projects: this.projects };
    const stepsFor = (issue) => (this.isPicked(issue) ? pickSteps(this.linked(issue), issue, options) : []);
    const lines = updateLines(this.issues, this.staged(), (issue) => this.states[issue.team] ?? [], stepsFor, this.links());
    if (this.runnerBusy()) return;
    setShared(ASSIGNED, picksWithSteps(assignments(), this.issues, stepsFor));
    if (!lines.length) { cx.notify(); return; }
    this.updating = { terminal: null, settling: false };
    this.startRunner(RUNNER, updateTask(lines), "Update tickets", cx, (terminal) => { this.updating.terminal = terminal; });
  }

  // The button reads Updating until the runner has finished and a refresh has settled the count, which would otherwise
  // keep offering a second press for up to a minute.
  watchUpdate(cx) {
    if (!this.updating?.terminal || this.updating.settling) return;
    const live = (() => { try { return terminals(); } catch { return []; } })();
    if (!live.length || !runnerFinished(live, this.updating.terminal)) return;
    this.updating.settling = true;
    this.refresh(cx);
  }

  createProject(issue, cx) {
    const task = projectTask(this.newProject.value(), [issue.identifier]);
    if (!task) { this.updateError = "Use a plain project name: letters, numbers and spaces."; cx.notify(); return; }
    if (this.runnerBusy()) return;
    this.creating = null; this.newProject.set_value("");
    this.startRunner(PROJECT_RUNNER, task, "New project", cx);
  }

  // Takes a ticket out of the session; with none left, back to the queue.
  untick(id, cx) {
    this.ticked = toggleTick(this.ticked, id);
    if (!this.ticked.size) this.screen = "queue";
    cx.notify();
  }

  tick(id, cx) { this.ticked = toggleTick(this.ticked, id); cx.notify(); }

  toggleCard(key) {
    this.closed.has(key) ? this.closed.delete(key) : this.closed.add(key);
    try { localStorage.setItem("groups.closed", JSON.stringify([...this.closed])); } catch { /* not remembered */ }
  }

  emptyText() {
    if (this.error) return this.error;
    if (this.loading) return "Loading…";
    if (this.legwork) return this.issues.length ? "No projects match these filters" : "No projects in the legwork tracker";
    if (this.issues.length) return "No issues match these filters";
    return this.config?.teams?.length ? "No open issues in this team" : "No open issues assigned to you";
  }

  render() {
    this.drawing = true;
    const t = theme();
    const rows = sessionRows(this.world.sessions, Date.now(), shared(DISCARDED) ?? []);
    this.frame = { assigned: assignments(), staged: this.staged(), links: this.links(), session: this.session(), rows, inSession: ticketSessions(rows) };
    const issue = this.issues.find((i) => i.id === this.selected);
    const view = v_flex().id("linear").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.canvas).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .children(issue ? detailsView(this, issue, t) : this.screen === "review" && this.ticked.size ? reviewView(this, t) : queueView(this, t));
    this.drawing = false;
    return view;
  }
}
