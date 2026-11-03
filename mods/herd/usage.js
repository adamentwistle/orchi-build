// What an agent's last turn came to, and how full its context window is. No Herdr imports, so `node --test` can load this
// file, and it imports nothing at all, so it can be copied into another mod as it is.
export const CONTEXT_WARN = 60;
const LARGE = 1000000;
const SMALL = 200000;
const USABLE = 0.8;

// The context window a model has, in tokens. The same rule as `contextWindow` in `mods/space-agents/tree.js`, so the
// sidebar and Herd give one number: the transcript names the model but not its window, so it's 1M for a model from
// generation 5 on (claude-haiku-5-5 read 9.2% at 73.9k in the status line, so 1M), for one marked [1m], or for one seen
// past 200k in any session (`big`), and 200k otherwise.
export function contextWindow(tokens, model, big = new Set()) {
  const generation = Number(/^claude-[a-z]+-(\d+)/.exec(model ?? "")?.[1] ?? 0);
  return tokens > SMALL || big.has(model) || /\[1m\]/i.test(model ?? "") || generation >= 5 ? LARGE : SMALL;
}

// `{ tokens, model }` from herd.py as a whole percent, as the status line's `context:` shows it: of the usable 80% of
// the window. Null when there's nothing to go on.
export function contextPercent(context, big = new Set()) {
  const tokens = Number(context?.tokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  return Math.min(100, Math.round((tokens / (contextWindow(tokens, context.model, big) * USABLE)) * 100));
}

// Models seen past 200k tokens in any of these contexts, which must have the large window.
export const bigModels = (contexts) => new Set(contexts.filter((c) => Number(c?.tokens) > SMALL).map((c) => c.model));

export const contextHigh = (percent) => percent != null && percent >= CONTEXT_WARN;

const pad = (n) => String(n).padStart(2, "0");

// "42s", "4m 10s" or "1h 05m".
export function turnTime(ms) {
  const s = Math.max(0, Math.round((ms ?? 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

// One line on the last finished turn, such as "4m 10s, 12 tools, 1 failed", or null.
export function turnLine(turn) {
  if (!turn || !Number.isFinite(turn.ms)) return null;
  const tools = Number(turn.tools) || 0, failed = Number(turn.failed) || 0;
  return [turnTime(turn.ms), tools ? `${tools} ${tools === 1 ? "tool" : "tools"}` : "no tools", failed ? `${failed} failed` : null].filter(Boolean).join(", ");
}
