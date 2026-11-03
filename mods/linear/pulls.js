// A worker's pull request, linked on its Linear ticket and the ticket moved to In review, through Update tickets.
// No Herdr imports, so `node --test` can load this file.
//
// Only ids reach a runner's task: the ticket's ID, a state id from the team's list, and a pull url built here from the
// repo's own git remote and the PR number in the run's fanout state. Nothing a ticket says is read for this.
import { PULL_URL } from "./updates.js";
import { linearKey } from "./refs.js";

const OWNER_REPO = /^[A-Za-z0-9][\w.-]{0,99}\/[\w.-]{1,100}$/;
const DONE_TYPES = ["completed", "canceled"];

// `owner/name` from a GitHub remote url, or null for anything else.
export function githubRepo(remote) {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(String(remote ?? "").trim());
  return m && OWNER_REPO.test(m[1]) ? m[1] : null;
}

// The number in a fanout state's PR cell: `42`, `#42`, or this repo's pull url. Null for anything else.
export function pullNumber(cell, repo) {
  const text = String(cell ?? "").trim();
  const bare = /^#?(\d{1,7})$/.exec(text);
  if (bare) return bare[1];
  const url = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d{1,7})\/?$/.exec(text);
  return url && url[1].toLowerCase() === repo.toLowerCase() ? url[2] : null;
}

// The ticket a worker's pull request is for. A run on one ticket is that ticket. A run on several needs exactly one of
// them named in the worker's slug, such as `eng-12-fix`, or it isn't linked at all.
export function ticketOf(slug, tickets) {
  const ids = [...new Set(tickets.map(linearKey).filter(Boolean))];
  if (ids.length === 1) return ids[0];
  const named = ids.filter((id) => new RegExp(`(^|[^a-z0-9])${id.toLowerCase()}($|[^0-9])`).test(String(slug ?? "").toLowerCase()));
  return named.length === 1 ? named[0] : null;
}

// Every worker pull request in Go's sessions that can be tied to one ticket. `remotes` maps a repo folder to its
// `owner/name`. A ticket has to be in the session's own brief as well as on the planner's plan.
export function workerPulls(sessions, remotes) {
  const pulls = new Map();
  for (const s of sessions) {
    for (const run of s.runs ?? []) {
      const repo = remotes.get(run.repo);
      if (!repo) continue;
      for (const { slug, pr } of run.prs ?? []) {
        const number = pullNumber(pr, repo), identifier = ticketOf(slug, (run.tickets ?? []).filter((id) => s.tickets.includes(id)));
        const url = number && `https://github.com/${repo}/pull/${number}`;
        if (identifier && url && PULL_URL.test(url)) pulls.set(`${identifier} ${url}`, { identifier, url, number });
      }
    }
  }
  return [...pulls.values()];
}

// The team's In review state, by name, else a started state with review in its name. Null if the team has none.
export const reviewState = (states) => states.find((s) => /^in review$/i.test(s.name)) ?? states.find((s) => s.type === "started" && /review/i.test(s.name)) ?? null;

// Stages each new pull request once: a link waiting to go, and In review unless the ticket is already there, has a
// change of yours staged, or is closed. `seen` remembers what was staged, so Discard isn't undone by the next load. A
// ticket not in the list is left for a later load. A link already on the ticket is only remembered.
export function stagePulls({ pulls, issues, staged, links, seen, statesFor }) {
  const byId = new Map(issues.map((i) => [i.identifier, i]));
  const next = { staged: { ...staged }, links: { ...links }, seen: { ...seen } };
  for (const p of pulls) {
    const key = `${p.identifier} ${p.url}`, issue = byId.get(p.identifier);
    if (next.seen[key] || !issue) continue;
    next.seen[key] = true;
    if ((issue.attachments ?? []).includes(p.url)) continue;
    next.links[p.identifier] = [...(next.links[p.identifier] ?? []).filter((l) => l.url !== p.url), { url: p.url, number: p.number }];
    const state = reviewState(statesFor(issue));
    if (state && !next.staged[p.identifier] && !/review/i.test(issue.state ?? "") && !DONE_TYPES.includes(issue.stateType)) next.staged[p.identifier] = state;
  }
  return next;
}

// A link is finished once the ticket shows it, or the ticket has left a list that wasn't cut short.
export function settleLinks(links, issues, complete = true) {
  const byId = new Map(issues.map((i) => [i.identifier, i]));
  const out = {};
  for (const [id, list] of Object.entries(links)) {
    const issue = byId.get(id);
    if (!issue) { if (!complete) out[id] = list; continue; }
    const left = (Array.isArray(list) ? list : []).filter((l) => !(issue.attachments ?? []).includes(l.url));
    if (left.length) out[id] = left;
  }
  return out;
}

// What was staged is forgotten once its ticket has left a full list, so `seen` doesn't grow for ever.
export function settleSeen(seen, issues, complete = true) {
  if (!complete) return seen;
  const ids = new Set(issues.map((i) => i.identifier));
  return Object.fromEntries(Object.entries(seen).filter(([key]) => ids.has(key.split(" ")[0])));
}
