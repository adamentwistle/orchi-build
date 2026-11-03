// The same projection and colour limits as ~/.config/ccstatusline/usage-bar.py.
// No Herdr imports, so `node --test` can load this file.
export function formatLeft(seconds) {
  const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function toneFor(kind, used, projected) {
  if (kind === "session") return used < 50 ? "done" : used < 80 ? "ansi3" : "blocked";
  const value = projected ?? used;
  return value < 80 ? "done" : value <= 100 ? "ansi3" : "blocked";
}

export function usageMeter(label, used, resetAt, seconds, now, kind) {
  const left = (Date.parse(resetAt) - now) / 1000;
  const share = Math.max(0, Math.min(1, (seconds - left) / seconds));
  const projected = share >= 0.02 ? used / share : null;
  return { label, used, projected, resetIn: formatLeft(Math.max(0, left)), resetAt: Date.parse(resetAt), tone: toneFor(kind, used, projected) };
}

// Ticks drawn at a 5.5px pitch (1.5 wide, 4 apart). The count is the most a meter's width holds.
// The footer is the panel less its 1px borders and 12px padding, with 16px between meters;
// before the first size report the 320px minimum panel is assumed.
const PITCH = 5.5, MIN_PANEL = 320;
export function meterTicks(panelWidth, meters) {
  const each = ((panelWidth ?? MIN_PANEL) - 2 - 24 - 16 * (meters - 1)) / meters;
  return Math.max(1, Math.floor((each + 4) / PITCH));
}

// The ticks of one meter in order, tagged used, ahead or rest. Fill is round(count times value).
export function meterCells(m, count) {
  const fill = Math.round(count * m.used / 100), ahead = Math.round(count * Math.min(m.projected ?? m.used, 100) / 100);
  return Array.from({ length: count }, (_, i) => ({ part: i < fill ? "used" : i < ahead ? "ahead" : "rest" }));
}

const HOUR = 3600;

// The meters from ~/.cache/orchi/usage.json, which usage-watch keeps fresh. A limit with no reset
// time is one the account doesn't have, such as the 5-hour one on an account without it, so it's left out. Herd's
// copy in `mods/herd/meters.js` does the same.
const meterOf = (label, used, resetAt, seconds, now, kind) => (typeof used === "number" && resetAt ? usageMeter(label, used, resetAt, seconds, now, kind) : null);

export function metersFrom(u, now) {
  return [
    meterOf("5-hour", u?.sessionUsage, u?.sessionResetAt, 5 * HOUR, now, "session"),
    meterOf("Fable", u?.fableUsage, u?.fableResetAt, 168 * HOUR, now, "weekly"),
    meterOf("All", u?.weeklyUsage, u?.weeklyResetAt, 168 * HOUR, now, "weekly"),
  ].filter(Boolean);
}
