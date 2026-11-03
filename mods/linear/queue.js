// Pure helpers for the queue: which filter a ticket falls in, ticks and grouping.
// No Herdr imports, so `node --test` can load this file.
import { groupIssues } from "./linear.js";

// A failed load keeps the list it had, and says so above it, as Orchi does. With no list, the error is the empty text.
// `cut` is a list that stopped at the page limit.
export function staleNote(error, count, cut = false) {
  if (error && count) return `Out of date. ${error}`;
  if (!error && cut) return `Showing the first ${count} open tickets. Older ones aren't listed.`;
  return null;
}

export function bucketOf(issue) {
  if (/review/i.test(issue.state ?? "")) return "review";
  return ["backlog", "triage"].includes(issue.stateType) ? "backlog" : "active";
}

export function counts(issues) {
  const totals = { all: issues.length, active: 0, backlog: 0, review: 0 };
  for (const issue of issues) totals[bucketOf(issue)]++;
  return totals;
}

export function toggleTick(ticked, id) {
  const next = new Set(ticked);
  if (!next.delete(id)) next.add(id);
  return next;
}

export function dotFor(issue) {
  const bucket = bucketOf(issue);
  if (bucket === "review") return "done";
  return issue.stateType === "started" ? "working" : "dim";
}

export function ticketGroups(issues, bucket, nameOf) {
  const shown = bucket === "all" ? issues : issues.filter((issue) => bucketOf(issue) === bucket);
  return groupIssues(shown, nameOf, "project").map((group) => ({
    ...group,
    count: group.issues.length,
    groups: group.groups.map((inner) => ({ ...inner, dot: dotFor(inner.issues[0]) })),
  }));
}
