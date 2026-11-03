// Which legwork projects an orchestrator could pick up.
// No Herdr imports, so `node --test` can load this file.
const PLAN_FILE = /^[\w-]+$/;
const PLAIN_NAME = /^[A-Za-z0-9][\w .&'()-]{0,59}$/;
const HUMAN = /^(Human action, not a Claude session\.|DECISION NEEDED)/;

export function readyPlan(frontmatter, prompt) {
  const text = prompt ?? "";
  const first = text.split("\n")[0] ?? "";
  const shaped = first.includes("switchboard-protocol") || /(^|\n)\s*\/fanout\b/.test(text);
  return {
    ready: frontmatter.status === "queued" && shaped,
    needsAdam: Boolean(frontmatter.blocked_on) || HUMAN.test(first) || /\bAdam runs\b/.test(text),
  };
}

// What a new planning session is told. Questions stay in its terminal, and go to the planning file too
// so Orchi can show them.
export const planTask = (name, path, file) => `run planning session for ${PLAIN_NAME.test(name) ? name : file}

Put your questions to Adam in this terminal as usual. Also write each one to ${path} as a DECISION entry in the switchboard-protocol format, with ids plan-1, plan-2 and so on, so the Orchi panel shows it. Start that file fresh. When he answers, add a line ANSWERED <id>.`;

export const plannable = (project) => PLAN_FILE.test(project.file);

// The project a planner's terminal is labelled with. It builds a file path, so the shape is checked.
export function planLabel(terminal) {
  const value = terminal.labels?.["orchi.plan"];
  return PLAN_FILE.test(value ?? "") ? value : null;
}

// What's left once dismissed entries are hidden, and how many were.
export function visible(items, keyOf, dismissed) {
  const shown = items.filter((item) => !dismissed.has(keyOf(item)));
  return { shown, dismissed: items.length - shown.length };
}

// The tracker text `main.js` builds: per project a line `@@projects/<file>.md`, its frontmatter
// lines, then the next prompt between `@@prompt` and `@@endprompt`.
export function parseTracker(text) {
  const projects = [];
  let prompt = null;
  for (const line of text.split("\n")) {
    const opened = /^@@(?:.*\/)?([^/]+)\.md$/.exec(line);
    if (opened) { projects.push({ file: opened[1], name: opened[1], category: "", status: "", repo: null, blocked_on: null, updated: null, prompt: "" }); prompt = null; continue; }
    const project = projects[projects.length - 1];
    if (!project) continue;
    if (line === "@@prompt") { prompt = []; continue; }
    if (line === "@@endprompt") { project.prompt = (prompt ?? []).join("\n"); prompt = null; continue; }
    if (prompt) { prompt.push(line); continue; }
    const field = /^(name|category|status|repo|blocked_on|updated):\s*(.*?)\s*$/.exec(line);
    if (!field) continue;
    const value = field[2] && field[2] !== "none" ? field[2] : null;
    if (field[1] === "name" || field[1] === "category" || field[1] === "status") project[field[1]] = field[2];
    else project[field[1]] = value;
  }
  return projects;
}
