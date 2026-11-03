// Orchi's settings, from ~/.config/orchi/settings.json, with a default for every value. The keys, defaults and checks
// are those of src/orchi/settings.py and its settings.schema.json, and a test runs one set of fixtures through both
// readers. A value that can't be used reads as unset; `orchi doctor` names it.
// Until setup moves them, orchi.json's workerLimit and linear.json's teams, repos, legwork.dir and legwork.projects, in
// Herdr's app home, fill in what settings.json leaves out. linear.json's apiKey is never read here.
// Every mod that needs settings has its own copy of this file, because mods are installed one folder each;
// tests/settings checks the copies match. No Herdr imports, so `node --test` can load it.
export const SOURCES = ["legwork", "github", "linear", "markdown"];
export const WORKER_LIMIT = { low: 1, high: 50, default: 6 };
export const USAGE_GUARD_PERCENT = { low: 1, high: 100, default: 95 };

export const settingsFile = (home) => `${home}/.config/orchi/settings.json`;
export const oldFile = (appHome, name) => `${appHome}/${name}.json`;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const parse = (text) => {
  if (text == null) return {};
  try { const v = JSON.parse(text); return isObject(v) ? v : {}; } catch { return {}; }
};
const has = (o, k) => Object.hasOwn(o, k);
const trim = (v) => (typeof v === "string" ? v.trim() : "");
const expand = (home, t) => t.replace(/^~(?=\/|$)/, () => home).replace(/\/+$/, "") || "/";
// A full path, from / or ~/, ~ expanded. A relative one would mean a different folder from each working folder.
const folder = (home, v) => { const t = trim(v); const path = t ? expand(home, t) : null; return path?.startsWith("/") ? path : null; };
const whole = (v, { low, high }) => (typeof v === "number" && Number.isInteger(v) && v >= low && v <= high ? v : null);
const first = (...values) => values.find((v) => v != null) ?? null;
// What `item` makes of each entry of a list, once each, or null when it isn't a list.
const list = (v, item) => (Array.isArray(v) ? [...new Set(v.map(item).filter((x) => x != null))] : null);
// An object with its names and values made over by `name` and `item`, or null when it isn't an object. When two names
// come out the same, as " eng " and "ENG" do, the one Object.entries lists last wins; settings.py lists them the same.
const map = (v, name, item) => (isObject(v)
  ? Object.fromEntries(Object.entries(v).map(([k, x]) => [name(k), item(x)]).filter(([k, x]) => k && x != null))
  : null);
const group = (s, key) => (isObject(s[key]) ? s[key] : {});
const at = (o, key) => (has(o, key) ? o[key] : undefined);

// Only A to Z change case: owners, repos and team keys are ASCII, and other letters would lean on the Unicode tables
// of each runtime, which differ between Python and Node versions.
const lower = (t) => t.replace(/[A-Z]/g, (c) => c.toLowerCase());
const upper = (t) => t.replace(/[a-z]/g, (c) => c.toUpperCase());
const owner = (v) => lower(trim(v)) || null;
const repo = (v) => { const t = lower(trim(v)); return /^[a-z0-9-]+\/[a-z0-9._-]+$/.test(t) ? t : null; };
const team = (v) => upper(trim(v)) || null;
const text = (v) => trim(v) || null;
// A source is one of the schema's names, exactly, as the schema's enum has it.
const source = (v) => (SOURCES.includes(v) ? v : null);

// Every setting from the text of settings.json, orchi.json and linear.json (null for a file that isn't there).
export function resolveSettings({ settings, orchi, linear } = {}, home) {
  const s = parse(settings), o = parse(orchi), l = parse(linear);
  const oldLegwork = isObject(l.legwork) ? l.legwork : {};
  const place = (v) => folder(home, v);
  const own = (key) => (has(s, key) ? folder(home, s[key]) : null);
  const number = (key, old, limits) => first(has(s, key) ? whole(s[key], limits) : null, whole(old, limits), limits.default);
  const chosen = has(s, "sources") ? list(s.sources, source) : null;
  const gh = group(s, "github"), ln = group(s, "linear"), md = group(s, "markdown");
  return {
    claude_dir: own("claude_dir"),
    orchi_dir: first(own("orchi_dir"), expand(home, "~/orchi-build")),
    legwork_dir: first(own("legwork_dir"), folder(home, oldLegwork.dir)),
    worker_limit: number("worker_limit", o.workerLimit, WORKER_LIMIT),
    usage_guard_percent: number("usage_guard_percent", null, USAGE_GUARD_PERCENT),
    sources: SOURCES.filter((x) => x === "legwork" || (chosen ?? []).includes(x)),
    github: {
      own_owners: first(list(at(gh, "own_owners"), owner), []),
      repos: first(list(at(gh, "repos"), repo), []),
    },
    linear: {
      teams: first(list(at(ln, "teams"), team), list(l.teams, team), []),
      projects: first(list(at(ln, "projects"), text), []),
      repos: first(map(at(ln, "repos"), team, place), map(l.repos, team, place), {}),
      legwork_projects: first(map(at(ln, "legwork_projects"), text, text), map(oldLegwork.projects, text, text), {}),
    },
    markdown: { paths: first(list(at(md, "paths"), place), []) },
  };
}

// Every setting. `appHome` is Herdr's, where the old files are.
export async function readSettings(readTextFile, home, appHome = `${home}/.config/herdr-app`) {
  const read = async (path) => { try { return (await readTextFile(path)) ?? null; } catch { return null; } };
  const [settings, orchi, linear] = await Promise.all([read(settingsFile(home)), read(oldFile(appHome, "orchi")), read(oldFile(appHome, "linear"))]);
  return resolveSettings({ settings, orchi, linear }, home);
}

// These take read settings, or a raw settings object.
// The Claude Code profile the settings set, or null. Sessions the panels start get it as CLAUDE_CONFIG_DIR.
export const profileDir = (s, home) => folder(home, s?.claude_dir);
// The Claude Code profile folder sessions run under.
export const claudeDir = (s, home) => profileDir(s, home) ?? expand(home, "~/.claude");
// Where Orchi's scripts live: bin/ under it.
export const orchiDir = (s, home) => folder(home, s?.orchi_dir) ?? expand(home, "~/orchi-build");
// The legwork tracker, or null when there is none.
export const legworkDir = (s, home) => folder(home, s?.legwork_dir);
// The switchboard's files sit in the profile folder.
export const switchboardDir = (s, home) => `${claudeDir(s, home)}/switchboard`;
// Folders that can hold a session's files: the profile in the settings, then the default one.
export const configDirs = (s, home) => [...new Set([claudeDir(s, home), expand(home, "~/.claude")])];
