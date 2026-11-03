// Picks the plan out of a legwork tracker file. No Herdr imports, so `node --test` can load this file.
const section = (lines, heading) => {
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start, end < 0 ? undefined : end).join("\n").trim();
};

// A planning board's PLAN entries, for a kept plan whose planner has gone.
function savedPlan(lines) {
  const plans = lines.flatMap((line, i) => (/^## \S+ PLAN\b/.test(line) ? [section(lines.slice(i), /^## /)] : []));
  return plans.length ? plans.join("\n\n") : null;
}

// The newest `## Roadmap` section, which is the first in the file. A project planned without one
// has only its next prompt.
export function planOf(text) {
  const lines = text.split("\n");
  return section(lines, /^## Roadmap\b/) ?? section(lines, /^## Next prompt\b/) ?? savedPlan(lines);
}
