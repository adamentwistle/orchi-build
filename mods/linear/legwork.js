// Pure helpers that tie a Linear issue to a legwork project.
// No Herdr imports, so `node --test` can load this file.

// The longest range a `linear:` line may give. A longer one, a backwards one or one across two prefixes is a typo,
// such as `ENG-83 to ENG-9000`, and is left out whole rather than read as thousands of tickets.
export const MAX_RANGE = 200;

// A `linear:` value: `ENG-9, ENG-83 to ENG-90, P-ENG-1027`.
export function linkedIds(value) {
  const ids = new Set();
  for (const part of value.split(",")) {
    const m = /^\s*(\S+)-(\d+)(?:\s+to\s+(\S+)-(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const [, prefix, fromText, toPrefix, toText] = m;
    const from = Number(fromText), to = Number(toText ?? fromText);
    if ((toPrefix && toPrefix !== prefix) || to < from || to - from >= MAX_RANGE) continue;
    for (let n = from; n <= to; n++) ids.add(`${prefix}-${n}`);
  }
  return ids;
}

// Frontmatter blocks, each opened by a line `@@projects/<file>.md`, then the next prompt between `@@prompt` and
// `@@endprompt`. Prompt lines are the tracker's words, so none of them is read as a field.
export function parseProjects(text) {
  const projects = [];
  let prompt = null;
  for (const line of text.split("\n")) {
    const opened = /^@@(.*\/([^/]+)\.md)$/.exec(line), project = projects[projects.length - 1];
    if (opened) { projects.push({ path: opened[1], file: opened[2], name: opened[2], category: "", repo: null, blocked_on: null, prompt: "", ids: new Set() }); prompt = null; continue; }
    if (line === "@@prompt") { prompt = []; continue; }
    if (line === "@@endprompt") { if (project) project.prompt = (prompt ?? []).join("\n"); prompt = null; continue; }
    if (prompt) { prompt.push(line); continue; }
    const field = /^(name|category|repo|linear|blocked_on):\s*(.*?)\s*$/.exec(line);
    if (!field || !project) continue;
    if (field[1] === "linear") project.ids = linkedIds(field[2]);
    else if (field[1] === "repo" || field[1] === "blocked_on") project[field[1]] = field[2] && field[2] !== "none" ? field[2] : null;
    else project[field[1]] = field[2];
  }
  return projects;
}

// Your pick for this ticket ("" for none), then the `linear:` line, then the `Linear project
// identifier: file` map. Never by name: a project's name can be edited in Linear, and the match
// picks the repo the agent starts in.
export function findProject(projects, issue, map = {}, assigned = {}) {
  if (Object.hasOwn(assigned, issue.identifier)) return projects.find((p) => p.file === assigned[issue.identifier]) ?? null;
  const linked = projects.find((p) => p.ids.has(issue.identifier) || p.ids.has(issue.projectIdentifier));
  return linked ?? projects.find((p) => p.file === map[issue.projectIdentifier]) ?? null;
}

// The Linear project tied to a legwork project: a project id on its `linear:` line, else the map.
export function linearProjectOf(project, map = {}) {
  return [...project.ids].find((id) => id.startsWith("P-")) ?? Object.keys(map).find((id) => map[id] === project.file) ?? null;
}

export function filterProjects(projects, text) {
  const needle = text.trim().toLowerCase();
  return needle ? projects.filter((p) => `${p.name} ${p.file}`.toLowerCase().includes(needle)) : projects;
}

// The project's repo on this computer, or null when it has none.
export function projectFolder(project, home) {
  if (!project.repo) return null;
  return project.repo.startsWith("~/") ? `${home}${project.repo.slice(1)}` : project.repo;
}
