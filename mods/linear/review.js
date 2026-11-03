// Pure rules for the review screen. No Herdr imports, so `node --test` can load this file.
import { folderProblem, projectProblems } from "./sessions.js";
import { isLinearKey } from "./refs.js";
import { NAME } from "./switchboard.js";

export const MODELS = ["Fable", "Opus", "Sonnet", "Haiku"];
export const EFFORTS = ["Low", "Medium", "High", "Xhigh", "Max"];
const DEFAULT_EFFORT = "High";
export const PR_SUGGESTION = "Leave them open for me to merge";

export const defaultSession = () => ({
  switchboard: { model: "Opus", effort: DEFAULT_EFFORT },
  orchestrator: { model: "Opus", effort: DEFAULT_EFFORT },
  workers: { model: "Auto", effort: "Auto" },
  prs: "",
  after: "start",
  extra: "",
});

// Sessions saved before the field became optional hold the suggestion as their value.
export function restoreSession(saved) {
  const session = { ...defaultSession(), ...saved };
  return session.prs === PR_SUGGESTION ? { ...session, prs: "" } : session;
}

export function pickModel(choice, model) {
  if (model === "Auto") return { model, effort: "Auto" };
  return { model, effort: choice.effort === "Auto" ? DEFAULT_EFFORT : choice.effort };
}

export function pickEffort(choice, effort) {
  if (choice.model === "Auto") return choice;
  if (effort === "Auto") return choice;
  return { ...choice, effort };
}

// Why Go can't run, one line each. `context` is what's live now: `inSession` maps ticket IDs to their sessions,
// `busy` holds repos with an orchestrator, `trust` maps folders to their flag, `folderOf` gives a project's folder on
// this Mac, and `planning` is where a planner for several repos runs. With no `trust`, folders aren't checked. `held`
// maps a repo to the session Go started on it, and `requested` holds starts still waiting on the switchboard, so a
// second Go on a repo whose planner is still planning doesn't get through.
export function sessionProblems(tickets, projectOf, context = {}) {
  const { inSession = new Map(), busy, trust = null, planning = null, folderOf = (p) => p.repo, held, requested } = context;
  const problems = [], seen = new Set();
  for (const ticket of tickets) {
    if (!isLinearKey(ticket.identifier)) { problems.push("A ticket has an ID the panel can't use"); continue; }
    if (inSession.has(ticket.identifier)) problems.push(`${ticket.identifier} is already in a session`);
    const project = projectOf(ticket);
    if (!project) { problems.push(`${ticket.identifier} has no legwork project`); continue; }
    if (seen.has(project.name)) continue;
    seen.add(project.name);
    if (!NAME.test(project.file ?? project.name)) problems.push(`${project.name} has a file name the panel can't use`);
    problems.push(...projectProblems(project, { folderOf, busy, trust, held, requested }));
  }
  const repos = new Set(tickets.map(projectOf).filter((p) => p?.repo).map(folderOf));
  if (trust && repos.size > 1) problems.push(...(planning ? folderProblem(trust, planning, "the legwork folder") : ["There's no legwork folder to plan several repos in"]));
  return problems;
}
