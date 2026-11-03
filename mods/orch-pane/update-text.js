// Turns an orchestrator's update into a headline and a list. They're written as one dense paragraph, usually
// "What happened: the detail. More detail." No Herdr imports, so `node --test` can load this file.
// A mod can't import from outside its folder, so `mods/orch-pane/update-text.js` is a copy of this file.
const SENTENCE = /(?<=[.;])\s+(?=[A-Z0-9])/;
const LEAD = 64;

const bare = (text) => text.trim().replace(/[.;]+$/, "");

export function splitUpdate(text) {
  const [first = "", ...rest] = String(text ?? "").split(SENTENCE).map(bare).filter(Boolean);
  const colon = first.indexOf(": ");
  if (colon <= 0 || colon > LEAD) return { headline: first, points: rest };
  const detail = first.slice(colon + 2);
  return { headline: first.slice(0, colon), points: [`${detail[0].toUpperCase()}${detail.slice(1)}`, ...rest] };
}
