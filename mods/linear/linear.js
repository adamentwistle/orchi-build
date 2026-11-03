// Pure helpers for the Linear panel: the GraphQL query, config and response parsing, filters.
// No Herdr imports, so `node --test` can load this file.

export const API_URL = "https://api.linear.app/graphql";

// Open issues: anything not completed or canceled, most recently updated first, a page at a time. Descriptions come
// from DESCRIPTIONS_QUERY, only for tickets whose `updatedAt` moved. Attachment urls are only compared, never shown or sent.
export const ISSUES_QUERY = `query OpenIssues($filter: IssueFilter, $after: String) {
  issues(first: 250, after: $after, orderBy: updatedAt, filter: $filter) {
    nodes {
      id identifier title url branchName priority priorityLabel updatedAt
      state { name type color }
      team { key name }
      project { name identifier }
      labels { nodes { name color } }
      attachments(first: 25) { nodes { url } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

// More pages than this and the list is cut short, which `complete: false` says, so nothing staged is dropped for it.
export const MAX_PAGES = 8;
export const DESCRIPTION_BATCH = 50;

export const DESCRIPTIONS_QUERY = `query Descriptions($ids: [ID!]) {
  issues(first: ${DESCRIPTION_BATCH}, filter: { id: { in: $ids } }) { nodes { id updatedAt description } }
}`;

// One page of ISSUES_QUERY: its issues, and the cursor of the next page or null.
export function parseIssuePage(json) {
  const issues = parseIssues(json), info = json?.data?.issues?.pageInfo;
  return { issues, next: info?.hasNextPage && typeof info.endCursor === "string" ? info.endCursor : null };
}

// Descriptions by issue id, each with the `updatedAt` it was read at.
export function parseDescriptions(json) {
  const message = json?.errors?.[0]?.message;
  if (message) throw new Error(isAuthError(message) ? "Invalid Linear API key" : message);
  return new Map((json?.data?.issues?.nodes ?? []).filter((n) => typeof n?.id === "string").map((n) => [n.id, { updatedAt: n.updatedAt, description: n.description ?? null }]));
}

// The ids whose description isn't held, or was read before the ticket last changed.
export const descriptionsToFetch = (issues, cache) => issues.filter((i) => cache.get(i.id)?.updatedAt !== i.updatedAt).map((i) => i.id);

export const withDescriptions = (issues, cache) => issues.map((i) => ({ ...i, description: cache.get(i.id)?.description ?? null }));

// Only the descriptions of tickets still listed are kept.
export const keptDescriptions = (cache, issues) => new Map(issues.filter((i) => cache.has(i.id)).map((i) => [i.id, cache.get(i.id)]));

// `fetch` here has no timeout, so a request that never answers is raced against `sleep(ms)`. Where the host has an
// AbortController, `start(signal)` gets its signal and the request is called off too.
export async function withTimeout(start, ms, sleep, what = "Linear") {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timedOut = false;
  const timer = sleep(ms).then(() => { timedOut = true; controller?.abort(); throw new Error(`${what} didn't answer in ${Math.round(ms / 1000)} s`); });
  timer.catch(() => {});
  const work = start(controller?.signal);
  work.catch(() => {});
  return Promise.race([work, timer]).catch((e) => { throw timedOut ? new Error(`${what} didn't answer in ${Math.round(ms / 1000)} s`) : e; });
}

// Each team's workflow states, for the status picker. The panel's key only reads them.
export const STATES_QUERY = `query TeamStates {
  teams(first: 50) { nodes { key states(first: 50) { nodes { id name type position } } } }
}`;

export function parseStates(json) {
  const teams = {};
  for (const team of json?.data?.teams?.nodes ?? []) {
    const states = (team.states?.nodes ?? []).filter((s) => /^[\w-]+$/.test(s.id ?? "")).sort((a, b) => a.position - b.position);
    teams[team.key] = states.map(({ id, name, type }) => ({ id, name, type }));
  }
  return teams;
}

// Everything open in `teams`, assigned or not; with no teams, the viewer's own issues.
export function issuesFilter(teams) {
  const open = { state: { type: { nin: ["completed", "canceled"] } } };
  return teams.length ? { ...open, team: { key: { in: teams } } } : { ...open, assignee: { isMe: { eq: true } } };
}

// Status chips, by Linear's workflow state types.
export const STATUSES = [
  { id: "all", label: "All", types: null },
  { id: "todo", label: "Todo", types: ["unstarted"] },
  { id: "doing", label: "In progress", types: ["started"] },
  { id: "backlog", label: "Backlog", types: ["backlog", "triage"] },
];

// The Linear API key, from linear.json in Herdr's app home, until setup moves it to the keychain. It is the only thing
// the panel reads out of that file itself: its teams, repos and legwork folder and projects come from Orchi's settings
// (settings.js), which never read the key.
export const keyFile = (appHome) => `${appHome}/linear.json`;
export const NO_KEY = "No Linear API key. Add it to ~/.config/herdr-app/linear.json or set LINEAR_API_KEY.";

export function parseKey(text) {
  if (text == null) return { apiKey: null };
  let raw;
  try { raw = JSON.parse(text); } catch { return { apiKey: null, error: "linear.json is not valid JSON" }; }
  return { apiKey: typeof raw?.apiKey === "string" && raw.apiKey.trim() ? raw.apiKey.trim() : null };
}

const isAuthError = (message) => /authenticat/i.test(message ?? "");

// A short reason for a failed request, from its status and body.
export function linearError(status, body) {
  if (status === 401) return "Invalid Linear API key";
  try {
    const message = JSON.parse(body)?.errors?.[0]?.message;
    if (message) return isAuthError(message) ? "Invalid Linear API key" : message;
  } catch { /* not JSON */ }
  return `Linear answered ${status}`;
}

export function parseIssues(json) {
  const message = json?.errors?.[0]?.message;
  if (message) throw new Error(isAuthError(message) ? "Invalid Linear API key" : message);
  return (json?.data?.issues?.nodes ?? []).map((n) => ({
    id: n.id, identifier: n.identifier, title: n.title, url: n.url, branchName: n.branchName ?? null,
    priority: n.priority ?? 0, priorityLabel: n.priorityLabel ?? "", updatedAt: n.updatedAt,
    description: n.description ?? null,
    state: n.state?.name ?? "", stateType: n.state?.type ?? "", stateColor: n.state?.color ?? null,
    team: n.team?.key ?? "", teamName: n.team?.name ?? "",
    project: n.project?.name ?? null, projectIdentifier: n.project?.identifier ?? null,
    labels: (n.labels?.nodes ?? []).map((l) => ({ name: l.name, color: l.color })),
    attachments: (n.attachments?.nodes ?? []).map((a) => a?.url).filter((url) => typeof url === "string"),
  }));
}

export function filterIssues(issues, { status, text }) {
  const types = STATUSES.find((s) => s.id === status)?.types ?? null;
  const needle = (text ?? "").trim().toLowerCase();
  return issues.filter((i) => (!types || types.includes(i.stateType))
    && (!needle || `${i.identifier} ${i.title} ${i.project ?? ""}`.toLowerCase().includes(needle)));
}

const STATE_RANK = { started: 0, unstarted: 1, backlog: 2, triage: 3 };

function groupBy(issues, labelOf, rankOf) {
  const groups = new Map();
  for (const issue of issues) {
    const label = labelOf(issue);
    if (!groups.has(label)) groups.set(label, { label, rank: rankOf(issue), issues: [] });
    groups.get(label).issues.push(issue);
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

// Two levels: project then status, or status then project. Projects sort by name, `No project`
// last; statuses from active to backlog.
export function groupIssues(issues, projectOf, by = "project") {
  const project = [(i) => projectOf(i) ?? "No project", (i) => (projectOf(i) ? 0 : 1)];
  const status = [(i) => i.state, (i) => STATE_RANK[i.stateType] ?? 9];
  const [outer, inner] = by === "status" ? [status, project] : [project, status];
  return groupBy(issues, ...outer).map((group) => ({ ...group, groups: groupBy(group.issues, ...inner) }));
}

export function ago(iso, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}
