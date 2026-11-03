// On Windows, with no Linear key, the panel lists legwork projects in the tickets' place: each project is a row
// shaped like a ticket, and tick, review and Go work on it unchanged. No Herdr imports, so `node --test` can load this file.

// A tracker status as the panel's filters read a ticket's state: Active, Backlog or In review. Done projects aren't listed.
const STATES = {
  running: { state: "Running", stateType: "started" },
  queued: { state: "Queued", stateType: "unstarted" },
  escalated: { state: "Escalated", stateType: "unstarted" },
  review: { state: "In review", stateType: "started" },
  icebox: { state: "Icebox", stateType: "backlog" },
};

const title = (word) => (word ? word[0].toUpperCase() + word.slice(1) : "No category");

// Whether the panel lists legwork projects: on Windows, with a legwork folder and no Linear key.
export const legworkMode = (config, windows) => Boolean(windows && config?.legwork?.dir && !config.apiKey);

// The projects a legwork panel lists. A file starting `_`, such as `_template.md`, isn't a project, and a done or iceboxed
// one (/shelve puts a project in the icebox) is left out.
export const listedProjects = (projects) => projects.filter((p) => !p.file.startsWith("_") && p.status !== "done" && p.status !== "icebox");

// A project as a ticket. Its file name is its id, its category is the filter it falls in, and its name is the card.
export function projectRow(project) {
  const { state, stateType } = STATES[project.status] ?? STATES.queued;
  const updated = /^\d{4}-\d{2}-\d{2}$/.test(project.updated ?? "") ? `${project.updated}T00:00:00` : null;
  return {
    id: `lw:${project.file}`, identifier: project.file, title: project.name || project.file, url: null, branchName: null,
    priority: 0, priorityLabel: "", updatedAt: updated, description: null, state, stateType, stateColor: null,
    team: "", teamName: "", project: title(project.category), projectIdentifier: null,
    labels: project.category ? [{ name: project.category, color: null }] : [], legwork: true, category: project.category ?? "",
  };
}

export const projectRows = (projects) => listedProjects(projects).map(projectRow);
