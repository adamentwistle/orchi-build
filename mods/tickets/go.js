// What Go starts, built only from shape-checked parts. No Herdr imports, so `node --test` can load this file.
// Ticket text never comes in here: a title or a description can't reach a command, a task, a label or the brief.
import { ABSOLUTE, projectProblems, stamp } from "./sessions.js";
import { isRef, shortRef } from "./refs.js";
import { NAME, claudeChoice } from "./switchboard.js";
import { projectFolder } from "./legwork.js";
import { PR_SUGGESTION } from "./review.js";
import { taskFor } from "./task.js";

const pad = (n) => String(n).padStart(2, "0");

// `s20261030-2240-1f3a`: sortable, and it reads as a date on a board.
export const newSession = (d, random) => `s${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${random}`;

// Where the planner runs. One repo: that project's space, or a new one. Several: a Planning space in the legwork repo.
// A space id Herdr doesn't know opens that space, which moves nothing on screen. `mint` makes one.
export function plannerPlace(repos, legworkDir, spaces, mint) {
  const here = spaces.filter((s) => !s.machine);
  if (repos.length === 1) return { folder: repos[0], space: here.find((s) => s.folder === repos[0])?.id ?? mint(), spaceName: null };
  const planning = here.find((s) => s.name === "Planning");
  return { folder: legworkDir, space: planning?.id ?? mint(), spaceName: planning ? null : "Planning" };
}

export const planLabels = (session, refs) => [`orchi.plan=${session}`, `orchi.session=${session}`, `orchi.tickets=${refs.join(",")}`];

export const planTab = (refs) => (refs.length === 1 ? `Plan ${shortRef(refs[0])}` : `Plan ${refs.length} tickets`);

// The brief, the task and the planner's start for these tickets, or null if a part isn't the shape it should be.
// Each ticket goes by its reference, so the planner reads it with `orchi tickets show <ref>`, whatever its source.
// The planner runs on the Orchestrator choice, because the orchestrator replaces it.
export function goPlan({ session, tickets, projectOf, choices, created, home }) {
  const task = taskFor(session);
  const rows = tickets.map((ticket) => {
    const project = projectOf(ticket);
    return { ref: ticket.ref, project: project?.file, repo: project ? projectFolder(project, home) : null };
  });
  if (!task || !NAME.test(session) || !rows.length || rows.some((r) => !isRef(r.ref) || !NAME.test(r.project ?? "") || !ABSOLUTE.test(r.repo ?? ""))) return null;
  const refs = rows.map((r) => r.ref);
  return {
    brief: { session, created: stamp(created), tickets: rows, choices: { ...choices, prs: choices.prs.trim() || PR_SUGGESTION } },
    task, labels: planLabels(session, refs), tab: planTab(refs), repos: [...new Set(rows.map((r) => r.repo))],
    ...claudeChoice(choices.orchestrator),
  };
}

// Why Go on a legwork ticket can't start: Go's rules for its project's repo (an orchestrator there, another session's
// hold, a start waiting, a block, a next prompt that needs you), and the ticket being in a session already. The folder's
// trust isn't checked, because the session opens in front of you and asks itself. Pickup only reads, so it has none.
export function goProblems(project, ref, { inSession = new Map(), ...context }) {
  return [...(inSession.has(ref) ? [`${shortRef(ref)} is already in a session`] : []), ...projectProblems(project, context)];
}

// What Pickup and Go on a legwork ticket start: Claude Code in the project's repo, with `/pickup <project>` or
// `/go <project>` as its first message. Null when the project has no repo or a name that can't be typed.
export function projectStart(verb, project, home) {
  if (!["pickup", "go"].includes(verb) || !NAME.test(project?.file ?? "")) return null;
  const folder = projectFolder(project, home);
  if (!ABSOLUTE.test(folder ?? "")) return null;
  return { task: `/${verb} ${project.file}`, tab: project.file, folder };
}
