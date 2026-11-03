import test from "node:test";
import assert from "node:assert/strict";
import { findSession, parseSession, terminalFacts, terminalName } from "../../mods/orch-pane/session.js";

const ID = "a2b2dc13-3b6d-4730-999d-54e86d5d9dfe";

test("a session file is read only with a real session id", () => {
  assert.deepEqual(parseSession(JSON.stringify({ sessionId: ID, cwd: "/r", name: "orch-atlas", updatedAt: 5 }), "/d"), { dir: "/d", sessionId: ID, name: "orch-atlas", cwd: "/r", updatedAt: 5 });
  assert.equal(parseSession(JSON.stringify({ sessionId: "../x", cwd: "/r" }), "/d"), null);
  assert.equal(parseSession("nope", "/d"), null);
});

test("the session is found from the terminal's foreground process, newest file first", async () => {
  const files = {
    "/h/.claude-alt/sessions/7.json": JSON.stringify({ sessionId: ID, cwd: "/work", updatedAt: 9 }),
    "/h/.claude/sessions/7.json": JSON.stringify({ sessionId: ID, cwd: "/old", updatedAt: 1 }),
  };
  const io = { home: () => "/h", orchi: { claude_dir: "~/.claude-alt" }, readTextFile: async (p) => { if (!files[p]) throw new Error("gone"); return files[p]; } };
  assert.equal((await findSession(io, { foreground: { pid: 7 } })).cwd, "/work");
  assert.equal(await findSession(io, { foreground: { pid: 8 } }), null);
  assert.equal(await findSession(io, {}), null);
  assert.equal(await findSession(io, null), null);
  // With no profile in the settings, only ~/.claude is read.
  assert.equal((await findSession({ ...io, orchi: {} }, { foreground: { pid: 7 } })).cwd, "/old");
});

test("a failed terminal read is null", async () => {
  assert.equal(await terminalFacts({ hc: async () => ({ code: 1, stdout: "" }) }, "t1"), null);
  assert.equal(await terminalFacts({ hc: async () => { throw new Error("x"); } }, "t1"), null);
  assert.deepEqual(await terminalFacts({ hc: async () => ({ code: 0, stdout: '{"name":"a"}' }) }, "t1"), { name: "a" });
});

test("a terminal's name comes from its name or the adapter's label", () => {
  assert.equal(terminalName({ name: "orch-atlas" }), "orch-atlas");
  assert.equal(terminalName({ name: null, labels: { "orchi.name": "fw-a" } }), "fw-a");
  assert.equal(terminalName(undefined), "");
});
