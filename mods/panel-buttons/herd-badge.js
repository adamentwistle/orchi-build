// The red count on the Herd button: how many in the herd of the session in view are blocked. It's worked out from live
// data on every render, so it stays right while the Herd panel is hidden, and before it has been opened at all, which is
// when Herdr hasn't started it yet. No Herdr imports, so `node --test` can load this file. `sessionOf` and the walk up
// and down are small copies of the ones in `mods/herd/model.js`, because a mod can't import from outside its folder.
const CLAUDE = "claude-code";
const MAX_DEPTH = 6;

// The focused pane if it's a session, otherwise the first session in the focused pane's tab.
export function sessionOf(panes) {
  const local = (p) => p.app === CLAUDE && p.terminal && !p.terminal.includes("/");
  const here = panes.find((p) => p.focused);
  if (!here) return null;
  return (local(here) ? here : panes.find((p) => p.tab === here.tab && local(p)))?.terminal ?? null;
}

// `list` is `terminals()`, whose `status` is a plain word. Whoever is in view, the herd is counted from its top.
export function herdBlocked(list, address) {
  if (!address) return 0;
  const byAddress = new Map(list.map((t) => [t.address, t])), seen = new Set();
  let top = byAddress.get(address);
  while (top?.parent && byAddress.has(top.parent) && !seen.has(top.address)) { seen.add(top.address); top = byAddress.get(top.parent); }
  if (!top) return 0;
  const kids = new Map();
  for (const t of list) if (t.parent) kids.set(t.parent, [...(kids.get(t.parent) ?? []), t]);
  let count = 0;
  const walked = new Set();
  const visit = (t, depth) => {
    if (walked.has(t.address) || depth > MAX_DEPTH) return;
    walked.add(t.address);
    if (t.state === "live" && (typeof t.status === "string" ? t.status : t.status?.state) === "blocked") count++;
    for (const kid of kids.get(t.address) ?? []) visit(kid, depth + 1);
  };
  visit(top, 0);
  return count;
}
