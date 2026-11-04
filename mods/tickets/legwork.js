// Pure helpers that tie a ticket to its legwork project, whatever its source.
// No Herdr imports, so `node --test` can load this file.
import { parseRef } from "./refs.js";

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

// What `sh -c` runs, with the tracker folder as $1, to print every project's frontmatter and next prompt for
// parseProjects. The tracker says what a project is: its repo, category and `linear:` line. Tickets themselves come only
// from orchi tickets. A tracker with no projects folder or no project files prints nothing.
export const TRACKER = `cd "$1" 2>/dev/null || exit 0
set -- projects/*.md
[ -e "$1" ] || exit 0
awk 'FNR==1{print "@@" FILENAME; fm=1; inp=0; fence=0; next}
fm && /^---$/{fm=0; next}
fm{print; next}
/^## Next prompt/{inp=1; next}
inp && /^\`\`\`/{ if(fence){inp=0; fence=0; print "@@endprompt"} else {fence=1; print "@@prompt"} next}
inp && fence{print}' "$@"`;

// Frontmatter blocks, each opened by a line `@@projects/<file>.md`, then the next prompt between `@@prompt` and
// `@@endprompt`. Prompt lines are the tracker's words, so none of them is read as a field. A file starting `_`, such as
// `_template.md`, is not a project.
export function parseProjects(text) {
  const projects = [];
  let prompt = null;
  for (const line of text.split("\n")) {
    const opened = /^@@(.*\/([^/]+)\.md)$/.exec(line), project = projects[projects.length - 1];
    if (opened) { projects.push({ path: opened[1], file: opened[2], name: opened[2], category: "", status: "", updated: null, repo: null, blocked_on: null, prompt: "", ids: new Set() }); prompt = null; continue; }
    if (line === "@@prompt") { prompt = []; continue; }
    if (line === "@@endprompt") { if (project) project.prompt = (prompt ?? []).join("\n"); prompt = null; continue; }
    if (prompt) { prompt.push(line); continue; }
    const field = /^(name|category|status|updated|repo|linear|blocked_on):\s*(.*?)\s*$/.exec(line);
    if (!field || !project) continue;
    // A value in quotes is the value inside them, as the Python reader and briefing.js read it.
    field[2] = field[2].replace(/^(["'])(.*)\1$/, "$2");
    if (field[1] === "category") field[2] = field[2].toLowerCase();
    if (field[1] === "linear") project.ids = linkedIds(field[2]);
    else if (field[1] === "repo" || field[1] === "blocked_on") project[field[1]] = field[2] && field[2] !== "none" ? field[2] : null;
    else if (field[1] === "updated") project.updated = field[2] || null;
    else project[field[1]] = field[2];
  }
  return projects.filter((p) => !p.file.startsWith("_"));
}

// `owner/repo` from a GitHub remote url, in lower case as references write it, or null for anything else. An SSH host
// alias with github in its name, such as `git@github-personal:`, is GitHub, as ~/.ssh/config sets it up.
export function githubRepo(remote) {
  const m = /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|git@[\w.-]*github[\w.-]*:|ssh:\/\/git@[\w.-]*github[\w.-]*\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(String(remote ?? "").trim());
  return m && /^[A-Za-z0-9][\w.-]{0,99}\/[\w.-]{1,100}$/.test(m[1]) ? m[1].toLowerCase() : null;
}

const expand = (path, home) => (path.startsWith("~/") ? `${home}${path.slice(1)}` : path);

// A ticket's project, the first that holds: your pick ("" for none); a legwork ticket's own project; for Linear, the
// project whose `linear:` line names it; for GitHub, the project whose repo's origin is that repo (`remotes` maps a
// repo folder to its `owner/repo`); for Markdown, the project whose repo holds the file.
export function projectOf(ticket, projects, { picks = {}, remotes = new Map(), home = "" } = {}) {
  if (Object.hasOwn(picks, ticket.ref)) return projects.find((p) => p.file === picks[ticket.ref]) ?? null;
  const ref = parseRef(ticket.ref);
  if (ref.source === "legwork") return projects.find((p) => p.file === ref.project) ?? null;
  if (ref.source === "linear") return projects.find((p) => p.ids.has(ref.key)) ?? null;
  if (ref.source === "github") return projects.find((p) => remotes.get(projectFolder(p, home)) === ref.repo) ?? null;
  if (ref.source === "markdown") {
    const file = expand(ref.file, home);
    return projects.find((p) => { const folder = projectFolder(p, home); return folder && file.startsWith(`${folder}/`); }) ?? null;
  }
  return null;
}

// The repo folders whose origin isn't known yet. Only a read that worked is kept, so one that failed is tried again.
export const remotesToRead = (projects, remotes, home) =>
  [...new Set(projects.map((p) => projectFolder(p, home)).filter((f) => f && !remotes.has(f)))];

export function filterProjects(projects, text) {
  const needle = text.trim().toLowerCase();
  return needle ? projects.filter((p) => `${p.name} ${p.file}`.toLowerCase().includes(needle)) : projects;
}

// The project's repo on this computer, or null when it has none. A trailing slash is dropped, so one folder is one
// string wherever it's compared.
export function projectFolder(project, home) {
  if (!project.repo) return null;
  return expand(project.repo, home).replace(/(.)\/+$/, "$1");
}
