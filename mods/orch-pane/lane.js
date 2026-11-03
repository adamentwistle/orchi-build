// The time scale behind every task's lane. No Herdr imports, so `node --test` can load this file.
export const PITCH = 5;
const MIN_SPAN = 60000;

// The run's start to now, or on to the estimated end when there is one.
export function axisOf(start, now, leftMs) {
  const from = Math.min(start ?? now, now), to = now + Math.max(0, leftMs ?? 0);
  return { from, now, to: Math.max(to, from + MIN_SPAN) };
}

export const tickCount = (width) => Math.max(8, Math.floor(width / PITCH));

const spot = (time, axis, count) => Math.max(0, Math.min(count - 1, Math.floor(((time - axis.from) / (axis.to - axis.from)) * count)));

// One lane in tick numbers: `lit` is the time it ran and `ghost` the estimate after it, each `[first, last]` or null.
// `now` is where the run is. A task always lights at least one tick.
export function laneOf(row, axis, count, leftMs) {
  const now = spot(axis.now, axis, count);
  if (row.started == null) return { lit: null, ghost: null, now };
  const first = spot(row.started, axis, count);
  const last = Math.max(first, row.phase === "active" ? now : spot(row.ended ?? axis.now, axis, count));
  const ghostEnd = leftMs > 0 ? spot(axis.now + leftMs, axis, count) : last;
  return { lit: [first, last], ghost: ghostEnd > last ? [last + 1, ghostEnd] : null, now };
}

// The ring in ticks: done, then active, and the rest.
export function ringShares(done, active, total, ticks) {
  if (!total) return { done: 0, active: 0 };
  const lit = Math.round(ticks * Math.min(done, total) / total);
  const on = active ? Math.max(1, Math.round(ticks * active / total)) : 0;
  return { done: lit, active: Math.min(on, ticks - lit) };
}
