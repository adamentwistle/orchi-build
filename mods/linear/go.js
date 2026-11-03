// What Go starts, built only from shape-checked parts. No Herdr imports, so `node --test` can load this file.
// Ticket text never comes in here: a title or a description can't reach a command, a task, a label or the brief.
import { ABSOLUTE, stamp, ticketId } from "./sessions.js";
import { NAME, claudeChoice } from "./switchboard.js";
import { projectFolder } from "./legwork.js";
import { PR_SUGGESTION } from "./review.js";
import { taskFor } from "./task.js";
import { samePath } from "./platform.js";

const pad = (n) => String(n).padStart(2, "0");

// `s20261030-2240-1f3a`: sortable, and it reads as a date on a board.
export const newSession = (d, random) => `s${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${random}`;

// Where the planner runs. One repo: that project's space, or a new one. Several: a Planning space in the legwork repo.
// A space id Herdr doesn't know opens that space, which moves nothing on screen. `mint` makes one.
export function plannerPlace(repos, legworkDir, spaces, mint) {
  const here = spaces.filter((s) => !s.machine);
  if (repos.length === 1) return { folder: repos[0], space: here.find((s) => samePath(s.folder, repos[0]))?.id ?? mint(), spaceName: null };
  const planning = here.find((s) => s.name === "Planning");
  return { folder: legworkDir, space: planning?.id ?? mint(), spaceName: planning ? null : "Planning" };
}

export const planLabels = (session, ids) => [`orchi.plan=${session}`, `orchi.session=${session}`, `orchi.tickets=${ids.join(",")}`];

export const planTab = (ids) => (ids.length === 1 ? `Plan ${ids[0]}` : `Plan ${ids.length} tickets`);

// The brief, the task and the planner's start for these tickets, or null if a part isn't the shape it should be.
// The planner runs on the Orchestrator choice, because the orchestrator replaces it. `source` is "legwork" when the
// tickets are legwork projects, on Windows, and the brief and the task say so.
export function goPlan({ session, tickets, projectOf, choices, created, home, source }) {
  const task = taskFor(session, source);
  const rows = tickets.map((issue) => {
    const project = projectOf(issue);
    return { id: issue.identifier, project: project?.file, repo: project ? projectFolder(project, home) : null };
  });
  if (!task || !NAME.test(session) || !rows.length || rows.some((r) => !ticketId(r.id, source === "legwork") || !NAME.test(r.project ?? "") || !ABSOLUTE.test(r.repo ?? ""))) return null;
  const ids = rows.map((r) => r.id);
  return {
    brief: { session, created: stamp(created), ...(source === "legwork" ? { source } : {}), tickets: rows, choices: { ...choices, prs: choices.prs.trim() || PR_SUGGESTION } },
    task, labels: planLabels(session, ids), tab: planTab(ids), repos: [...new Set(rows.map((r) => r.repo))],
    ...claudeChoice(choices.orchestrator),
  };
}
