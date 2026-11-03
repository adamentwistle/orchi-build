// Orchi's settings, from ~/.config/orchi/settings.json. Only the values the mods need are read here, and each has a
// default, so a missing or broken file reads as no settings. Every mod that needs them has its own copy of this file,
// because mods are installed one folder each; tests/settings checks the copies match. No Herdr imports, so `node --test`
// can load it.
export const settingsFile = (home) => `${home}/.config/orchi/settings.json`;

export function parseSettings(text) {
  try {
    const s = JSON.parse(text);
    return s && typeof s === "object" && !Array.isArray(s) ? s : {};
  } catch { return {}; }
}

export async function readSettings(readTextFile, home) {
  return parseSettings(await readTextFile(settingsFile(home)).catch(() => null));
}

const folder = (home, v) => (typeof v === "string" && v.trim() ? v.trim().replace(/^~(?=\/|$)/, home).replace(/\/+$/, "") || "/" : null);

// The Claude Code profile folder sessions run under.
export const claudeDir = (s, home) => folder(home, s?.claude_dir) ?? `${home}/.claude`;
// Where Orchi's scripts live: bin/ under it.
export const orchiDir = (s, home) => folder(home, s?.orchi_dir) ?? `${home}/orchi-build`;
// The legwork tracker, or null when it isn't set here.
export const legworkDir = (s, home) => folder(home, s?.legwork_dir);
// The switchboard's files sit in the profile folder.
export const switchboardDir = (s, home) => `${claudeDir(s, home)}/switchboard`;
// Folders that can hold a session's files: the profile in the settings, then the default one.
export const configDirs = (s, home) => [...new Set([claudeDir(s, home), `${home}/.claude`])];
