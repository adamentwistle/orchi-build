// Guards for the reads a panel makes on a timer, and the gaps a sleep leaves in its clock. No Herdr imports, so
// `node --test` can load this file. Everything above paneShowing is a copy of `mods/herd/poll.js`, because a mod can't
// import from outside its folder.
export const SLEEP_MS = 120000;
export const MISSES = 3;
const MAX_GAPS = 40;

// Rejects once `ms` has passed with no answer, so one hung call can't hold the panel. `sleep` is `cx.sleep`.
export function timed(promise, ms, what, sleep) {
  const late = sleep(ms).then(() => { throw new Error(`${what} didn't answer within ${Math.round(ms / 1000)} s`); });
  return Promise.race([promise, late]);
}

// What a helper printed, as `{ value, error }`. A crash or bad output is named, not passed off as nothing to show.
export function helperReply(result, name, key) {
  if (result?.code !== 0) {
    const why = String(result?.stderr ?? "").trim().split("\n").at(-1)?.slice(0, 160);
    return { value: null, error: `${name} stopped with code ${result?.code ?? "unknown"}${why ? `: ${why}` : ""}` };
  }
  try {
    return { value: JSON.parse(result.stdout)?.[key] ?? null, error: null };
  } catch {
    return { value: null, error: `${name} printed something that isn't JSON` };
  }
}

// Why a helper couldn't run at all: it didn't answer, or python3 couldn't start it.
export const helperFailure = (e, name) => {
  const why = String(e?.message ?? e);
  return /didn't answer/.test(why) ? why : `python3 couldn't start ${name}: ${why}`;
};

// A terminal missing from one read may be back on the next, so only `MISSES` in a row mean it has gone.
export function missed(count, found) {
  const next = found ? 0 : count + 1;
  return { count: next, gone: next >= MISSES };
}

// The clock ticks once a second. A tick far later than that means the machine slept, and that stretch is kept as a gap,
// `[from, to]` in ms, newest last.
export function noteGap(gaps, last, now) {
  if (last == null || now - last < SLEEP_MS) return gaps;
  return [...gaps, [last, now]].slice(-MAX_GAPS);
}

// How long the machine was awake between `from` and `to`, in ms.
export function awake(from, to, gaps) {
  let ms = to - from;
  for (const [a, b] of gaps ?? []) ms -= Math.max(0, Math.min(b, to) - Math.max(a, from));
  return Math.max(0, ms);
}

// The pane sits in its orchestrator's tab. It can be seen when that tab is the one in view and nothing else there is
// zoomed. `here` is `focused()`. When the terminal isn't in a pane, there's no telling, so it counts as seen.
export function paneShowing(panes, here, terminal) {
  const mine = panes.find((p) => p.terminal === terminal);
  if (!mine) return true;
  if (here?.tab && here.tab !== mine.tab) return false;
  const zoomed = panes.find((p) => p.tab === mine.tab && p.zoomed);
  return !zoomed || zoomed.mod === "orch-pane";
}
