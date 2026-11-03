// Finds the Claude Code session behind a terminal. A small copy of what `mods/claude-chat/session.js` does, because a
// mod can't import from outside its folder. No Herdr imports, so `node --test` can load this file.
import { configDirs } from "./settings.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSession(text, dir) {
  try {
    const s = JSON.parse(text);
    if (!SESSION_ID.test(s?.sessionId ?? "") || typeof s.cwd !== "string") return null;
    return { dir, sessionId: s.sessionId, name: s.name ?? null, cwd: s.cwd, updatedAt: s.updatedAt ?? 0 };
  } catch { return null; }
}

// Both folders can hold a file for a pid, because pids come round again. The one written last is the live one.
export const newestSession = (sessions) => sessions.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;

// What `hc get <terminal> --json` says, or null.
export async function terminalFacts({ hc }, terminal) {
  const got = await hc(["get", terminal, "--json"]).catch(() => null);
  if (got?.code !== 0) return null;
  try { return JSON.parse(got.stdout); } catch { return null; }
}

// `orchi` is Orchi's settings, which name the profile folder sessions run under.
export async function findSession({ readTextFile, home, orchi }, facts) {
  const pid = facts?.foreground?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const dirs = configDirs(orchi, home());
  const texts = await Promise.all(dirs.map((dir) => readTextFile(`${dir}/sessions/${pid}.json`).catch(() => null)));
  return newestSession(texts.map((text, i) => text && parseSession(text, dirs[i])));
}

// hc can only name a terminal when it starts one, so bin/herdr-adapter keeps the other names in a label.
export const terminalName = (t) => t?.name ?? t?.labels?.["orchi.name"] ?? "";
