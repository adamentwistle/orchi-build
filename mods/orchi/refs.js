// Ticket references: `linear:ENG-12`, `gh:owner/repo#12`, `legwork:<project>` and `md:<file>#<anchor>`. A bare
// `ENG-12` reads as Linear. The rules and messages are src/orchi/refs.py's, and tests/tickets/refs.json runs through
// both. Every mod that needs it has its own copy of this file, because mods are installed one folder each; the tests
// check the copies match. No Herdr imports, so `node --test` can load it.
// MD counts characters as code points, with the u flag, as Python does; the other patterns are ASCII only.
const PREFIX = /^([A-Za-z][A-Za-z0-9_-]*):([\s\S]*)$/;
const KEY = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8}$/;
const GH = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,9})$/;
const LEGWORK = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const MD = /^((?:\/|~\/)[^\x00-\x20\x7f-\x9f#,]{0,1000}\.md)#([a-z0-9_-]{1,100})$/u;

const EMPTY = "a ticket reference can't be empty";
const BARE = "a reference with no source is a Linear key, such as ENG-12";
const LINEAR = "a Linear key is written like ENG-12";
const GITHUB = "a GitHub issue is written gh:owner/repo#12";
const LEGWORK_PROJECT = "a legwork project is written legwork:<project file name>";
const MARKDOWN = "a Markdown task is written md:<file from / or ~/>#<anchor>";

const lower = (t) => t.replace(/[A-Z]/g, (c) => c.toLowerCase());
const linear = (key) => ({ source: "linear", id: key, ref: `linear:${key}`, key });

function github(rest) {
  const m = GH.exec(rest);
  if (!m || m[2] === "." || m[2] === "..") return { error: GITHUB };
  const repo = lower(`${m[1]}/${m[2]}`), number = Number(m[3]);
  return { source: "github", id: `${repo}#${number}`, ref: `gh:${repo}#${number}`, repo, number };
}

const legwork = (rest) => (LEGWORK.test(rest) ? { source: "legwork", id: rest, ref: `legwork:${rest}`, project: rest } : { error: LEGWORK_PROJECT });

function markdown(rest) {
  const m = MD.exec(rest);
  if (!m || m[1].split("/").some((part) => part === "." || part === "..")) return { error: MARKDOWN };
  return { source: "markdown", id: rest, ref: `md:${rest}`, file: m[1], anchor: m[2] };
}

// What a ticket reference names: its source (as settings name it), id, the reference written out in full, and the
// parts its source needs. Anything else is `{ error }`, a plain message.
export function parseRef(value) {
  const text = typeof value === "string" ? value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "") : "";
  if (!text) return { error: EMPTY };
  const m = PREFIX.exec(text);
  if (!m) return KEY.test(text) ? linear(text) : { error: BARE };
  const [, prefix, rest] = m;
  if (prefix === "linear") return KEY.test(rest) ? linear(rest) : { error: LINEAR };
  if (prefix === "gh") return github(rest);
  if (prefix === "legwork") return legwork(rest);
  if (prefix === "md") return markdown(rest);
  return { error: `${prefix} is not a ticket source: use linear, gh, legwork or md` };
}

// A reference written out in full, exactly as orchi tickets writes it: the only shape that reaches a command, a label
// or a brief.
export const isRef = (value) => typeof value === "string" && parseRef(value).ref === value;

// The bare key of a Linear reference, `ENG-12` for `linear:ENG-12` or `ENG-12`, or null for anything else.
export const linearKey = (value) => { const r = parseRef(value); return r.source === "linear" ? r.key : null; };

// Only a bare Linear key, exactly as written: the shape that may reach a Linear request or a runner's task.
export const isLinearKey = (value) => typeof value === "string" && linearKey(value) === value;

// A reference as a panel shows it beside its source's logo: `ENG-12`, `app#12` (the repo's name), the legwork project,
// or the Markdown task's anchor. Anything that isn't a reference comes back as it was.
export function shortRef(value) {
  const r = parseRef(value);
  if (r.error) return String(value ?? "");
  if (r.source === "linear") return r.key;
  if (r.source === "github") return `${r.repo.split("/")[1]}#${r.number}`;
  return r.source === "legwork" ? r.project : r.anchor;
}
