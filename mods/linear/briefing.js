// What /pickup briefs from a legwork project's file, read without a model: what the project is, where it stands, the last
// thing that happened and the next prompt. A Legwork card shows it when opened. No Herdr imports, so `node --test` can
// load this file.

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---/;
const DATED = /^- (\d{4}-\d{2}-\d{2})(?:\s*\(([^)]*)\))?:\s*/;

function frontmatter(text) {
  const out = {};
  for (const line of (FRONT.exec(text)?.[1] ?? "").split(/\r?\n/)) {
    const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

// The lines under a `## <name>` heading, up to the next `## `.
function section(lines, name) {
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${name}`);
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? lines.length : end);
}

// The next prompt is the first fenced block under its heading.
function promptOf(lines) {
  const body = section(lines, "next prompt"), open = body.findIndex((l) => /^```/.test(l.trim()));
  if (open < 0) return "";
  const close = body.findIndex((l, i) => i > open && /^```/.test(l.trim()));
  return body.slice(open + 1, close < 0 ? body.length : close).join("\n").trim();
}

// A `Label:` line and the lines after it, up to a blank line or the next label.
function field(prompt, label) {
  const lines = prompt.split("\n"), at = lines.findIndex((l) => l.toLowerCase().startsWith(`${label.toLowerCase()}:`));
  if (at < 0) return null;
  const out = [lines[at].slice(label.length + 1).trim()];
  for (const l of lines.slice(at + 1)) {
    if (!l.trim() || /^[A-Z][A-Za-z ]{1,20}:/.test(l)) break;
    out.push(l.trim());
  }
  return out.join(" ").trim() || null;
}

// Log entries are `- <date>: text`, with any lines under one carried with it. Most files put the newest first, but not
// all, so the latest date wins.
function lastEntry(lines) {
  const entries = [];
  for (const line of section(lines, "log")) {
    const m = DATED.exec(line);
    if (m) entries.push({ date: m[1], time: m[2] ?? null, text: line.slice(m[0].length).trim() });
    else if (entries.length && line.trim() && /^\s/.test(line)) entries.at(-1).text += ` ${line.trim()}`;
  }
  return entries.reduce((best, e) => (!best || e.date > best.date ? e : best), null);
}

export function briefingOf(text) {
  const source = String(text ?? "").replace(/\r\n/g, "\n"), lines = source.split("\n"), front = frontmatter(source);
  const prompt = promptOf(lines);
  return {
    name: front.name || null,
    description: front.description || null,
    status: front.status || null,
    category: front.category || null,
    energy: front.energy || null,
    updated: front.updated || null,
    blockedOn: front.blocked_on || null,
    repo: front.repo || null,
    last: lastEntry(lines),
    task: field(prompt, "Task"),
    doneWhen: field(prompt, "Done when"),
    model: field(prompt, "Model"),
    effort: field(prompt, "Effort"),
    prompt,
  };
}

// Long text clipped at a word, so a card stays readable.
export const clip = (text, max) => {
  const s = String(text ?? "").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max), space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

// What Pickup and Go type into the new session. The argument is the project's file name, which /pickup and /go read.
export const pickupLine = (file) => `/pickup ${file}`;
export const goLine = (file) => `/go ${file}`;
