// What /pickup briefs from a legwork project's file, read without a model: what the project is, where it stands, the last
// thing that happened and the next prompt. A legwork ticket shows it when opened. No Herdr imports, so `node --test` can
// load this file.

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---/;
const DATED = /^- (\d{4}-\d{2}-\d{2})(?:\s*\(([^)]*)\))?:\s*/;

function frontmatter(text) {
  const out = {};
  for (const line of (FRONT.exec(text)?.[1] ?? "").split(/\r?\n/)) {
    const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    // Only a pair of quotes around the whole value is taken off, as parseProjects does.
    if (m) out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

// The lines under a heading starting `## <name>`, as the tracker's own reader matches it, up to the next `## ` outside a
// fenced block.
function section(lines, name) {
  const start = lines.findIndex((l) => l.trim().toLowerCase().startsWith(`## ${name}`));
  if (start < 0) return [];
  let fenced = false, end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^```/.test(lines[i].trim())) fenced = !fenced;
    else if (!fenced && /^## /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end);
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

// Log entries are `- <date>: text` or `- <date> (<time>): text`, with any lines under one carried with it. The latest
// date wins. On that day, the latest time wins when every entry has one; otherwise the file's own order does: most
// files put the newest first, and one whose dates run oldest first puts it last.
function lastEntry(lines) {
  const entries = [];
  for (const line of section(lines, "log")) {
    const m = DATED.exec(line);
    if (m) entries.push({ date: m[1], time: m[2] ?? null, text: line.slice(m[0].length).trim() });
    else if (entries.length && line.trim() && /^\s/.test(line)) entries.at(-1).text += ` ${line.trim()}`;
  }
  if (!entries.length) return null;
  const latest = entries.reduce((d, e) => (e.date > d ? e.date : d), ""), day = entries.filter((e) => e.date === latest);
  const clock = (e) => { const m = /^(\d{1,2}):(\d{2})/.exec(e.time ?? ""); return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null; };
  if (day.every(clock)) return day.reduce((best, e) => (clock(e) > clock(best) ? e : best));
  return entries[0].date < entries.at(-1).date ? day.at(-1) : day[0];
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
    blockedOn: front.blocked_on && front.blocked_on.toLowerCase() !== "none" ? front.blocked_on : null,
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
