import { test } from "node:test";
import assert from "node:assert/strict";
import { ISSUES_QUERY, DESCRIPTIONS_QUERY, issuesFilter, groupIssues, parseConfig, parseIssues, parseIssuePage, parseDescriptions, descriptionsToFetch, withDescriptions, keptDescriptions, withTimeout, linearError, filterIssues, STATUSES, ago } from "../../mods/linear/linear.js";
import { safeUrl } from "../../mods/linear/urls.js";

const node = (over = {}) => ({
  id: "a1", identifier: "ENG-12", title: "Fix login", url: "https://linear.app/acme/issue/ENG-12/fix-login",
  branchName: "dan/eng-12-fix-login", priority: 2, priorityLabel: "High", updatedAt: "2026-10-29T10:00:00.000Z",
  description: "Users can't log in\nwith SSO.",
  state: { name: "In Progress", type: "started", color: "#f2c94c" },
  team: { key: "ENG", name: "Engineering" },
  labels: { nodes: [{ name: "Bug", color: "#eb5757" }] },
  project: { name: "Login", identifier: "P-ENG-1" },
  ...over,
});

test("the query takes its filter and a page cursor, and asks for the project", () => {
  assert.match(ISSUES_QUERY, /issues\(first: 250, after: \$after, orderBy: updatedAt, filter: \$filter\)/);
  assert.match(ISSUES_QUERY, /pageInfo { hasNextPage endCursor }/);
  assert.match(ISSUES_QUERY, /project { name identifier }/);
  assert.match(ISSUES_QUERY, /branchName/);
  // Descriptions are read apart, only when a ticket has changed.
  assert.doesNotMatch(ISSUES_QUERY, /description/);
  assert.match(DESCRIPTIONS_QUERY, /issues\(first: 50, filter: { id: { in: \$ids } }\)/);
});

test("a page gives its issues and the next cursor, and the last page none", () => {
  const page = (info) => ({ data: { issues: { nodes: [node()], pageInfo: info } } });
  assert.equal(parseIssuePage(page({ hasNextPage: true, endCursor: "c2" })).next, "c2");
  assert.equal(parseIssuePage(page({ hasNextPage: false, endCursor: "c2" })).next, null);
  assert.equal(parseIssuePage(page(undefined)).next, null);
  assert.equal(parseIssuePage(page({ hasNextPage: true })).issues.length, 1);
});

test("attachment urls are kept for comparing, and nothing else of them", () => {
  const [issue] = parseIssues({ data: { issues: { nodes: [node({ attachments: { nodes: [{ url: "https://github.com/a/b/pull/3", title: "x" }, { url: 5 }] } })] } } });
  assert.deepEqual(issue.attachments, ["https://github.com/a/b/pull/3"]);
  assert.deepEqual(parseIssues({ data: { issues: { nodes: [node()] } } })[0].attachments, []);
});

test("only a new or changed ticket's description is fetched again", () => {
  const issues = [{ id: "a", updatedAt: "1" }, { id: "b", updatedAt: "2" }, { id: "c", updatedAt: "3" }];
  const cache = new Map([["a", { updatedAt: "1", description: "kept" }], ["b", { updatedAt: "1", description: "old" }], ["gone", { updatedAt: "0", description: "x" }]]);
  assert.deepEqual(descriptionsToFetch(issues, cache), ["b", "c"]);
  assert.deepEqual(withDescriptions(issues, cache).map((i) => i.description), ["kept", "old", null]);
  assert.deepEqual([...keptDescriptions(cache, issues).keys()], ["a", "b"]);
  const read = parseDescriptions({ data: { issues: { nodes: [{ id: "b", updatedAt: "2", description: "new" }, { id: "c", updatedAt: "3" }] } } });
  assert.deepEqual([...read], [["b", { updatedAt: "2", description: "new" }], ["c", { updatedAt: "3", description: null }]]);
  assert.throws(() => parseDescriptions({ errors: [{ message: "Rate limited" }] }), /Rate limited/);
});

test("a request that never answers times out, and a quick one doesn't", async () => {
  let release;
  const never = () => new Promise(() => {});
  const sleep = () => new Promise((r) => { release = r; });
  const slow = withTimeout(never, 20000, sleep);
  release();
  await assert.rejects(slow, /Linear didn't answer in 20 s/);
  assert.equal(await withTimeout(async () => "ok", 20000, () => new Promise(() => {})), "ok");
  await assert.rejects(withTimeout(async () => { throw new Error("Linear answered 500"); }, 20000, () => new Promise(() => {})), /answered 500/);
});

test("the timeout calls the request off where the host has an AbortController", async () => {
  let signal = null, release;
  const pending = withTimeout((s) => { signal = s; return new Promise(() => {}); }, 1000, () => new Promise((r) => { release = r; }));
  release();
  await assert.rejects(pending);
  assert.equal(signal?.aborted, true);
});

test("issuesFilter scopes to teams, else to the viewer", () => {
  const open = { type: { nin: ["completed", "canceled"] } };
  assert.deepEqual(issuesFilter(["ENG"]), { state: open, team: { key: { in: ["ENG"] } } });
  assert.deepEqual(issuesFilter([]), { state: open, assignee: { isMe: { eq: true } } });
});

test("parseConfig reads apiKey and expands ~ in team repos", () => {
  const config = parseConfig('{ "apiKey": " lin_api_x ", "repos": { "ENG": "~/dev/app", "OPS": "/srv/ops" } }', "/home/me");
  assert.deepEqual(config, { apiKey: "lin_api_x", repos: { ENG: "/home/me/dev/app", OPS: "/srv/ops" }, teams: [], legwork: null });
});

test("parseConfig reads teams and the legwork folder", () => {
  const config = parseConfig('{ "teams": [" eng "], "legwork": { "dir": "~/legwork", "projects": { "Atlas app": "atlas" } } }', "/home/me");
  assert.deepEqual(config.teams, ["ENG"]);
  assert.deepEqual(config.legwork, { dir: "/home/me/legwork", projects: { "Atlas app": "atlas" } });
});

test("parseConfig tolerates a missing or broken file", () => {
  assert.deepEqual(parseConfig(null, "/h"), { apiKey: null, repos: {}, teams: [], legwork: null });
  assert.deepEqual(parseConfig("not json", "/h"), { apiKey: null, repos: {}, teams: [], legwork: null, error: "linear.json is not valid JSON" });
});

test("parseIssues flattens labels and keeps what rows need", () => {
  const [issue] = parseIssues({ data: { issues: { nodes: [node()] } } });
  assert.equal(issue.identifier, "ENG-12");
  assert.equal(issue.team, "ENG");
  assert.equal(issue.stateType, "started");
  assert.deepEqual(issue.labels, [{ name: "Bug", color: "#eb5757" }]);
  assert.equal(issue.branchName, "dan/eng-12-fix-login");
  assert.equal(issue.project, "Login");
  assert.equal(issue.projectIdentifier, "P-ENG-1");
});

test("parseIssues surfaces GraphQL errors", () => {
  assert.throws(() => parseIssues({ errors: [{ message: "Authentication required, not authenticated" }] }), /Invalid Linear API key/);
  assert.throws(() => parseIssues({ errors: [{ message: "Rate limited" }] }), /Rate limited/);
});

test("linearError explains HTTP failures", () => {
  assert.equal(linearError(401, ""), "Invalid Linear API key");
  assert.equal(linearError(400, '{"errors":[{"message":"Authentication required"}]}'), "Invalid Linear API key");
  assert.equal(linearError(500, "boom"), "Linear answered 500");
});

test("filterIssues by status group and text", () => {
  const issues = parseIssues({ data: { issues: { nodes: [
    node(),
    node({ id: "a2", identifier: "OPS-3", title: "Rotate certs", state: { name: "Todo", type: "unstarted", color: "#ccc" }, team: { key: "OPS", name: "Ops" } }),
    node({ id: "a3", identifier: "ENG-40", title: "Idea", state: { name: "Backlog", type: "backlog", color: "#999" } }),
  ] } } });
  const ids = (list) => list.map((i) => i.identifier);
  assert.deepEqual(STATUSES.map((s) => s.id), ["all", "todo", "doing", "backlog"]);
  assert.deepEqual(ids(filterIssues(issues, { status: "all", text: "" })), ["ENG-12", "OPS-3", "ENG-40"]);
  assert.deepEqual(ids(filterIssues(issues, { status: "doing", text: "" })), ["ENG-12"]);
  assert.deepEqual(ids(filterIssues(issues, { status: "todo", text: "" })), ["OPS-3"]);
  assert.deepEqual(ids(filterIssues(issues, { status: "backlog", text: "" })), ["ENG-40"]);
  assert.deepEqual(ids(filterIssues(issues, { status: "all", text: "ops-3" })), ["OPS-3"]);
  assert.deepEqual(ids(filterIssues(issues, { status: "all", text: "CERTS" })), ["OPS-3"]);
  assert.deepEqual(ids(filterIssues(issues, { status: "all", text: "login" })), ["ENG-12", "OPS-3", "ENG-40"]);
});

test("groupIssues nests status under project, active first, No project last", () => {
  const issue = (identifier, project, state, stateType) => ({ identifier, project, state, stateType });
  const issues = [issue("A-1", "Zed", "Backlog", "backlog"), issue("A-2", "Zed", "In Review", "started"),
    issue("A-3", null, "Todo", "unstarted"), issue("A-4", "Alpha", "Todo", "unstarted"), issue("A-5", "Zed", "In Progress", "started")];
  const groups = groupIssues(issues, (i) => i.project);
  assert.deepEqual(groups.map((g) => g.label), ["Alpha", "Zed", "No project"]);
  assert.deepEqual(groups[1].groups.map((g) => g.label), ["In Progress", "In Review", "Backlog"]);
  const byStatus = groupIssues(issues, (i) => i.project, "status");
  assert.deepEqual(byStatus.map((g) => g.label), ["In Progress", "In Review", "Todo", "Backlog"]);
  assert.deepEqual(byStatus[2].groups.map((g) => g.label), ["Alpha", "No project"]);
});

test("ago counts minutes, hours and days", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  assert.equal(ago("2026-10-30T11:55:00Z", now), "5m");
  assert.equal(ago("2026-10-30T09:00:00Z", now), "3h");
  assert.equal(ago("2026-10-27T12:00:00Z", now), "3d");
});

test("safeUrl lets only https through", () => {
  assert.equal(safeUrl("https://linear.app/x"), "https://linear.app/x");
  assert.equal(safeUrl("http://linear.app/x"), null);
  assert.equal(safeUrl("file:///etc/passwd"), null);
  assert.equal(safeUrl("--help"), null);
});
