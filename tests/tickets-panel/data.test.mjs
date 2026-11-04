// What the tickets panel asks `orchi tickets` and what it makes of the answers. The panel calls no source's API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { listArgv, showArgv, statesArgv, moveArgv, parseList, parseShow, parseStates, failure } from "../../mods/tickets/data.js";

const PATH = "PATH=/h/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
const answer = {
  tickets: [
    { ref: "legwork:birch", source: "legwork", id: "birch", title: "Birch", state: "queued", open: true, url: "file:///h/legwork/projects/birch.md", updated: "2026-10-31", project: null, labels: ["work"], body: null },
    { ref: "gh:acme/app#7", source: "github", id: "acme/app#7", title: "Crash on start", state: "open", open: true, url: "https://github.com/acme/app/issues/7", updated: "2026-11-01T00:00:00Z", project: "acme/app", labels: ["bug"], body: null },
    { ref: "linear:ENG-12", source: "linear", id: "ENG-12", title: "Fix login", state: "In Progress", open: true, url: "https://linear.app/acme/issue/ENG-12", updated: "2026-11-02T00:00:00Z", project: "Login", labels: [], body: null },
    { ref: "md:~/notes/todo.md#buy-milk", source: "markdown", id: "~/notes/todo.md#buy-milk", title: "Buy milk", state: "open", open: true, url: null, updated: null, project: null, labels: [], body: null },
  ],
  problems: [{ source: "linear", message: "showing the first 2000 open issues" }],
  sources: ["legwork", "github", "linear", "markdown"],
};

test("the panel runs orchi tickets with ~/.local/bin first on PATH, every value its own argument", () => {
  assert.deepEqual(listArgv("/h"), [PATH, "orchi", "tickets", "--json"]);
  assert.deepEqual(showArgv("/h", "gh:acme/app#7"), [PATH, "orchi", "tickets", "show", "gh:acme/app#7", "--json"]);
  assert.deepEqual(statesArgv("/h", "linear:ENG-12"), [PATH, "orchi", "tickets", "states", "linear:ENG-12", "--json"]);
});

test("a Linear status change is a move with --yes, because the press is the yes, and --back, because you chose it", () => {
  assert.deepEqual(moveArgv("/h", "linear:ENG-12", "In Review"),
    [PATH, "orchi", "tickets", "move", "linear:ENG-12", "In Review", "--back", "--yes", "--json"]);
});

test("only a reference written in full reaches a command, and a move only on Linear", () => {
  for (const bad of ["ENG-12", "linear:eng-12", "gh:Acme/App#7", "--yes", "", null]) assert.equal(showArgv("/h", bad), null, String(bad));
  assert.equal(statesArgv("/h", "gh:acme/app#7"), null);
  assert.equal(moveArgv("/h", "gh:acme/app#7", "closed"), null);
  for (const state of ["", "  ", "--yes", "Done\n--back", "a".repeat(81)]) assert.equal(moveArgv("/h", "linear:ENG-12", state), null, state);
});

test("the list keeps every source's tickets, the problems and the sources read", () => {
  const got = parseList(JSON.stringify(answer));
  assert.deepEqual(got.tickets.map((t) => t.ref), ["legwork:birch", "gh:acme/app#7", "linear:ENG-12", "md:~/notes/todo.md#buy-milk"]);
  assert.deepEqual(got.problems, ["linear: showing the first 2000 open issues"]);
  assert.deepEqual(got.sources, ["legwork", "github", "linear", "markdown"]);
});

test("a ticket that isn't the shape orchi tickets gives is left out, and text fields are text", () => {
  const odd = { ...answer, tickets: [
    { ref: "ENG-1", source: "linear", id: "ENG-1", title: "bare key" },
    { ref: "linear:ENG-2", source: "github", id: "ENG-2", title: "wrong source" },
    { ref: "gh:acme/app#8", source: "github", id: "acme/app#8", title: 8, state: null, labels: "x", url: 3 },
    "nope",
  ] };
  const got = parseList(JSON.stringify(odd));
  assert.deepEqual(got.tickets.map((t) => t.ref), ["gh:acme/app#8"]);
  assert.deepEqual([got.tickets[0].title, got.tickets[0].state, got.tickets[0].labels, got.tickets[0].url], ["8", "", [], null]);
});

test("a source the panel doesn't know isn't offered as a filter", () => {
  assert.deepEqual(parseList(JSON.stringify({ ...answer, sources: ["legwork", "jira"] })).sources, ["legwork"]);
});

test("an answer that isn't orchi tickets' JSON is an error", () => {
  assert.throws(() => parseList("not json"), /orchi tickets/);
  assert.throws(() => parseList("[]"), /orchi tickets/);
});

test("a failed run says why in one line: not installed, or orchi's own first line", () => {
  assert.equal(failure({ code: 127, stdout: "", stderr: "env: orchi: No such file or directory\n" }), "orchi isn't installed");
  assert.equal(failure({ code: 2, stdout: "", stderr: "orchi tickets: bad\nmore\n" }), "orchi tickets: bad");
  assert.equal(failure({ code: 1, stdout: "", stderr: "" }), "orchi tickets failed");
});

test("one ticket read on its own has its body", () => {
  const one = { ...answer.tickets[2], body: "Steps\n\n1. log in" };
  assert.equal(parseShow(JSON.stringify(one)).body, "Steps\n\n1. log in");
  assert.equal(parseShow("{}"), null);
});

test("a Linear ticket's states come in board order, by name and kind", () => {
  const text = JSON.stringify({ ref: "linear:ENG-12", state: "In Progress", states: [{ name: "Todo", type: "unstarted" }, { name: "In Progress", type: "started" }, { name: 3 }] });
  assert.deepEqual(parseStates(text), { state: "In Progress", states: [{ name: "Todo", type: "unstarted" }, { name: "In Progress", type: "started" }] });
  assert.equal(parseStates("x"), null);
});

test("no file in the panel reaches a source's API or reads a key", () => {
  const dir = new URL("../../mods/tickets/", import.meta.url);
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    const text = readFileSync(new URL(name, dir), "utf8");
    for (const banned of ["api.linear.app", "api.github.com", "fetch(", "LINEAR_API_KEY", "Authorization", "mcp__claude_ai_Linear"]) {
      assert.ok(!text.includes(banned), `${name} has ${banned}`);
    }
  }
});
