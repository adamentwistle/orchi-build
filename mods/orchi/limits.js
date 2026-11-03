// What holds Start back for the whole Herdr: too many workers already running across every run, or a usage meter
// heading past its limit. No Herdr imports, so `node --test` can load this file.

// `~/.config/herdr-app/orchi.json` may set `{ "workerLimit": 8 }`. Without it, or with a value that isn't a whole number
// from 1 to 50, the default holds.
export const DEFAULT_WORKER_LIMIT = 6;
const MAX_WORKER_LIMIT = 50;

export function parseSettings(text) {
  let raw = null;
  try { raw = JSON.parse(text ?? ""); } catch { /* defaults */ }
  const limit = raw?.workerLimit;
  return { workerLimit: Number.isInteger(limit) && limit >= 1 && limit <= MAX_WORKER_LIMIT ? limit : DEFAULT_WORKER_LIMIT };
}

// Workers running now, across every orchestrator on show.
export const liveWorkers = (orchestrators) => orchestrators.reduce((n, o) => n + (o.running?.length ?? 0), 0);

// A usage meter holds Start at 95 percent used, or once its pace says it ends its window past 100. Early in a window
// the pace swings on very little, so it counts only from 25 percent used. Every meter the account has counts: the
// 5-hour one, the Fable weekly one and the all-models weekly one. A press on Start anyway lets a meter's hold go until
// that meter resets, and `overrides` holds the labels let go. A meter whose reset time has passed holds nothing: the
// cache still has the old window's figure, and Start anyway couldn't let it go, because it would already be over.
export const SESSION_LABEL = "5-hour";
const NEAR = 95, PACE_FROM = 25;
const NAMES = { "5-hour": "The 5-hour limit", Fable: "The Fable weekly limit", All: "The all-models weekly limit" };

export function usageHolds(usage, overrides = new Set(), now = Date.now()) {
  const holds = [];
  for (const m of usage) {
    if (typeof m?.used !== "number" || overrides.has(m.label)) continue;
    if (Number.isFinite(m.resetAt) && m.resetAt <= now) continue;
    const name = NAMES[m.label] ?? `The ${m.label} limit`;
    const used = Math.round(m.used), projected = m.projected == null ? null : Math.round(m.projected);
    if (m.used >= NEAR) holds.push({ label: m.label, text: `${name} is at ${used}%, so Start waits until it resets in ${m.resetIn}` });
    else if (projected != null && projected > 100 && m.used >= PACE_FROM) holds.push({ label: m.label, text: `${name} is at ${used}% and heading for ${projected}%, so Start waits until it resets in ${m.resetIn}` });
  }
  return holds;
}

// The first usage hold's reason, or null.
export const usageHold = (usage, overrides, now) => usageHolds(usage, overrides, now)[0]?.text ?? null;

// When each held meter resets, in ms, so a press on Start anyway lasts until then. A meter with no reset time is let go
// for 5 hours.
export function overrideUntil(usage, holds, now) {
  const until = new Map();
  for (const h of holds) {
    const m = usage.find((u) => u.label === h.label);
    until.set(h.label, Number.isFinite(m?.resetAt) ? m.resetAt : now + 5 * 3600 * 1000);
  }
  return until;
}

// Every reason Start is held right now, for any plan.
export function startHolds({ usage, orchestrators, limit, overrides, now }) {
  const holds = [], workers = liveWorkers(orchestrators);
  if (workers >= limit) holds.push(`${workers} ${workers === 1 ? "worker is" : "workers are"} running, and the limit across all runs is ${limit}`);
  holds.push(...usageHolds(usage, overrides, now).map((h) => h.text));
  return holds;
}
