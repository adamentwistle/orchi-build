import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findSession, folderOf, foregroundPid, locateTranscript, newestSession, parseSession, projectSlug, sessionMoved, tail, wakesSession, wakesTranscript,
} from "../../mods/claude-chat/session.js";

const ID = "14fb8fe0-5665-4d83-8861-3d4e4cdfb1e6", OTHER = "c531137b-83df-4b62-a75f-38af96c92b41";
const file = (fields = {}) => JSON.stringify({ pid: 90, sessionId: ID, cwd: "/Users/me/Projects/atlas", name: "x", status: "idle", updatedAt: 5, ...fields });
const home = () => "/Users/me";
const settings = { claude_dir: "~/.claude-alt" };
const gotHc = (pid) => async () => ({ code: 0, stdout: JSON.stringify({ foreground: { pid } }) });

test("the project folder's name comes from the path", () => {
  assert.equal(projectSlug("/Users/me/Projects/atlas-wt/step3"), "-Users-me-Projects-atlas-wt-step3");
  assert.equal(projectSlug("/a/b.c_d"), "-a-b-c-d");
});

test("a session file gives the transcript's path", () => {
  const s = parseSession(file(), "/h/.claude-alt");
  assert.equal(s.transcript, `/h/.claude-alt/projects/-Users-me-Projects-atlas/${ID}.jsonl`);
  assert.equal(folderOf(s.transcript), "/h/.claude-alt/projects/-Users-me-Projects-atlas");
});

test("a bad session file reads as nothing", () => {
  assert.equal(parseSession("{not json", "/h"), null);
  assert.equal(parseSession(file({ sessionId: "../../etc/passwd" }), "/h"), null);
  assert.equal(parseSession(file({ cwd: 3 }), "/h"), null);
});

test("the foreground pid is read safely", () => {
  assert.equal(foregroundPid('{"foreground":{"pid":12}}'), 12);
  assert.equal(foregroundPid('{"foreground":null}'), null);
  assert.equal(foregroundPid('{"foreground":{"pid":"12"}}'), null);
  assert.equal(foregroundPid("nope"), null);
});

test("the file written last wins when both folders have one", () => {
  const old = parseSession(file({ updatedAt: 1 }), "/h/.claude"), live = parseSession(file({ updatedAt: 9 }), "/h/.claude-alt");
  assert.equal(newestSession([old, null, live]), live);
  assert.equal(newestSession([null, null]), null);
});

test("finding: terminal to pid to session, in either folder, the settings' profile first", async () => {
  const read = [];
  const readTextFile = async (path) => { read.push(path); return path.includes(".claude-alt") ? null : file(); };
  const s = await findSession({ hc: gotHc(90), readTextFile, home, settings }, "t2");
  assert.equal(s.sessionId, ID);
  assert.equal(s.dir, "/Users/me/.claude");
  assert.deepEqual(read, ["/Users/me/.claude-alt/sessions/90.json", "/Users/me/.claude/sessions/90.json"]);
});

test("finding: with no settings only the default profile is read", async () => {
  const read = [];
  const readTextFile = async (path) => { read.push(path); return file(); };
  for (const s of [undefined, {}]) {
    read.length = 0;
    assert.equal((await findSession({ hc: gotHc(90), readTextFile, home, settings: s }, "t2")).dir, "/Users/me/.claude");
    assert.deepEqual(read, ["/Users/me/.claude/sessions/90.json"]);
  }
});

test("finding: no process, a failed hc or no session file gives null", async () => {
  const readTextFile = async () => null;
  assert.equal(await findSession({ hc: gotHc(null), readTextFile, home }, "t"), null);
  assert.equal(await findSession({ hc: async () => { throw new Error("x"); }, readTextFile, home }, "t"), null);
  assert.equal(await findSession({ hc: async () => ({ code: 1, stdout: "" }), readTextFile, home }, "t"), null);
  assert.equal(await findSession({ hc: gotHc(90), readTextFile, home }, "t"), null);
});

test("a read of a session file that fails counts as no file", async () => {
  const readTextFile = async () => { throw new Error("gone"); };
  assert.equal(await findSession({ hc: gotHc(90), readTextFile, home }, "t"), null);
});

test("locating a transcript passes the id as an argument, never in the script", async () => {
  const calls = [];
  const exec = async (...a) => { calls.push(a); return { code: 0, stdout: `/h/projects/x/${ID}.jsonl\n` }; };
  assert.equal(await locateTranscript({ exec }, { dir: "/h", sessionId: ID }), `/h/projects/x/${ID}.jsonl`);
  assert.deepEqual(calls[0][1].slice(2), ["sh", "/h", ID]);
  assert.equal(await locateTranscript({ exec }, { dir: "/h", sessionId: "$(boom)" }), null);
  assert.equal(calls.length, 1);
});

test("/clear and /resume count as a move, and a first find doesn't", () => {
  const a = parseSession(file(), "/h"), b = parseSession(file({ sessionId: OTHER }), "/h");
  assert.equal(sessionMoved(a, b), true);
  assert.equal(sessionMoved(a, a), false);
  assert.equal(sessionMoved(null, a), false);
  assert.equal(sessionMoved(a, null), false);
});

test("other sessions' changes wake nothing", () => {
  const s = parseSession(file(), "/h");
  assert.equal(wakesTranscript([s.transcript], s.transcript), true);
  assert.equal(wakesTranscript(["/h/projects/x/other.jsonl"], s.transcript), false);
  assert.equal(wakesSession(["/h/sessions/90.json"], s), true);
  assert.equal(wakesSession(["/h/sessions/91.json"], s), false);
});

test("tail runs the helper with no shell and reads its JSON", async () => {
  const calls = [];
  const exec = async (...a) => { calls.push(a); return { code: 0, stdout: '{"rows":[]}' }; };
  assert.deepEqual(await tail({ exec }, "/m/tail.py", "/p.jsonl", "--from", 4), { rows: [] });
  assert.deepEqual(calls[0], ["python3", ["-I", "-S", "/m/tail.py", "/p.jsonl", "--from", "4"]]);
});

test("tail reads a failure as nothing", async () => {
  assert.equal(await tail({ exec: async () => ({ code: 1, stdout: "" }) }, "t", "p"), null);
  assert.equal(await tail({ exec: async () => ({ code: 0, stdout: "not json" }) }, "t", "p"), null);
  assert.equal(await tail({ exec: async () => { throw new Error("x"); } }, "t", "p"), null);
});

test("a session's waitingFor is kept, and absent when the file has none", () => {
  assert.equal(parseSession(file({ status: "waiting", waitingFor: "dialog open" }), "/d").waitingFor, "dialog open");
  assert.equal(parseSession(file(), "/d").waitingFor, null);
  assert.equal(parseSession(file({ waitingFor: 5 }), "/d").waitingFor, null);
});

import { latest } from "../../mods/claude-chat/session.js";

test("only the newest of several overlapping reads counts", () => {
  const next = latest();
  const first = next(), second = next();
  assert.equal(first(), false);
  assert.equal(second(), true);
  assert.equal(next()(), true);
});

import { readLoop } from "../../mods/claude-chat/session.js";

test("a read that throws lets go of reading and says why, so the next wake reads again", async () => {
  const state = { reading: true, dirty: false };
  const errors = [];
  await readLoop(state, { once: async () => { throw new Error("land broke"); }, current: () => true, failed: (e) => errors.push(e.message) });
  assert.equal(state.reading, false);
  assert.deepEqual(errors, ["land broke"]);
});

test("a wake during a read reads again, and a clean loop lets go of reading", async () => {
  const state = { reading: true, dirty: false };
  let reads = 0;
  await readLoop(state, { once: async () => { reads++; if (reads === 1) state.dirty = true; }, current: () => true, failed: () => assert.fail() });
  assert.equal(reads, 2);
  assert.equal(state.reading, false);
});

test("a loop for a thread that's gone leaves reading to the new thread's loop", async () => {
  const state = { reading: true, dirty: false };
  let live = true;
  const errors = [];
  await readLoop(state, { once: async () => { live = false; }, current: () => live, failed: () => {} });
  assert.equal(state.reading, true);
  live = true;
  await readLoop(state, { once: async () => { live = false; throw new Error("late"); }, current: () => live, failed: (e) => errors.push(e) });
  assert.equal(state.reading, true);
  assert.deepEqual(errors, []);
});
