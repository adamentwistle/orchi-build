import test from "node:test";
import assert from "node:assert/strict";
import { claudeChoice, ensureSwitchboard, holderOf, parseLock, requestFile, requestLine, sendRequest } from "../../mods/orchi/switchboard.js";

const LOCK = '{"terminal": "t7", "herdr": "app", "started": "2026-10-30 22:00"}';
const STARTED = { code: 0, stdout: '{"address":"t9"}' };

const CLAUDE = JSON.stringify({ foreground: { name: "claude.exe", argv: ["claude"] } });
const SHELL = JSON.stringify({ foreground: { name: "zsh", argv: ["/bin/zsh", "-l"] } });
const STASH_LINE = "some output\n                                 › stashed\n──────\n❯ half typed\n";

const world = ({ lock = null, live = [], agents = [], run = STARTED, get = CLAUDE, screen = "❯ half typed\n", send = { code: 0, stdout: "" } } = {}) => {
  const calls = [], writes = [];
  return {
    calls, writes,
    home: () => "/h", orchi: { orchi_dir: "~/src/orchi" }, now: () => 1000, random: () => "ab12",
    exec: async (command, args) => { calls.push([command, ...args]); return { code: 0, stdout: "{}" }; },
    hc: async (args) => {
      calls.push(["hc", ...args]);
      const replies = { run, send, get: { code: 0, stdout: get }, read: { code: 0, stdout: screen } };
      return replies[args[0]] ?? { code: 0, stdout: "" };
    },
    readTextFile: async (path) => (path.endsWith("/lock") ? lock : null),
    writeTextFile: async (path, text, expected) => { writes.push([path, text, expected]); return null; },
    terminals: () => live, spaces: () => [{ id: "sp1", folder: "/h/src/orchi", machine: null }], agents: async () => agents,
  };
};
const liveT7 = [{ address: "t7", state: "live" }];

test("a lock reads with the contract's fields", () => {
  assert.deepEqual(parseLock(LOCK), { terminal: "t7", herdr: "app", started: "2026-10-30 22:00" });
  assert.equal(parseLock('{"terminal": "wGZ:p1", "herdr": "terminal"}').terminal, "wGZ:p1");
});

test("a lock of the wrong shape counts as none", () => {
  for (const text of ["", "not json", "null", '{"terminal": "t7"}', '{"terminal": "t7", "herdr": "cloud"}', '{"terminal": "t7; rm", "herdr": "app"}', '{"terminal": "--force", "herdr": "app"}', '{"herdr": "app"}']) assert.equal(parseLock(text), null);
});

test("a live owner holds it, in the app or terminal Herdr", () => {
  assert.deepEqual(holderOf({ terminal: "t7", herdr: "app" }, liveT7, []), { where: "app", terminal: "t7" });
  assert.deepEqual(holderOf({ terminal: "wG:p1", herdr: "terminal" }, [], [{ name: "x", pane: "wG:p1" }]), { where: "terminal", terminal: "wG:p1" });
});

test("a lock whose terminal is gone is free", () => {
  assert.equal(holderOf({ terminal: "t7", herdr: "app" }, [], []).where, null);
  assert.equal(holderOf({ terminal: "t7", herdr: "app" }, [{ address: "t7", state: "exited" }], []).where, null);
  assert.equal(holderOf({ terminal: "wG:p1", herdr: "terminal" }, [], [{ name: "x", pane: "other" }]).where, null);
});

test("a switchboard that hasn't taken the lock yet still counts", () => {
  assert.deepEqual(holderOf(null, [{ address: "t9", name: "switchboard", state: "live" }], []), { where: "app", terminal: "t9" });
  assert.deepEqual(holderOf(null, [], [{ name: "switchboard", pane: "wG:p1" }]), { where: "terminal", terminal: "wG:p1" });
  assert.equal(holderOf(null, [], []).where, null);
});

test("a model choice becomes claude's flags, and a bad one falls back", () => {
  assert.deepEqual(claudeChoice({ model: "Fable", effort: "Xhigh" }), { model: "fable", effort: "xhigh" });
  assert.deepEqual(claudeChoice({ model: "Auto", effort: "Auto" }), { model: "opus", effort: "high" });
  assert.deepEqual(claudeChoice({ model: "opus --dangerously-skip-permissions", effort: "max" }), { model: "opus", effort: "max" });
  assert.deepEqual(claudeChoice(undefined), { model: "opus", effort: "high" });
});

test("a free lock starts the switchboard exactly as the contract says", async () => {
  const io = world();
  assert.deepEqual(await ensureSwitchboard(io, { model: "Sonnet", effort: "Low" }), { where: "app", terminal: "t9", started: true });
  const run = io.calls.find((c) => c[1] === "run");
  assert.equal(run[run.indexOf("--name") + 1], "switchboard");
  assert.equal(run[run.indexOf("--cwd") + 1], "/h/src/orchi");
  assert.deepEqual(run.slice(-5), ["--model", "sonnet", "--effort", "low", "/switchboard resume"]);
});

test("a live lock never starts a second one", async () => {
  const io = world({ lock: LOCK, live: liveT7 });
  assert.deepEqual(await ensureSwitchboard(io, {}), { where: "app", terminal: "t7", started: false });
  assert.ok(!io.calls.some((c) => c[1] === "run"));
});

test("a switchboard in terminal Herdr is left alone", async () => {
  const io = world({ lock: '{"terminal": "wG:p1", "herdr": "terminal"}', agents: [{ name: "x", pane: "wG:p1" }] });
  assert.equal((await ensureSwitchboard(io, {})).where, "terminal");
  assert.ok(!io.calls.some((c) => c[1] === "run"));
});

test("a start that loses a race finds the winner", async () => {
  const io = world({ run: { code: 1, stdout: "name in use" } });
  let reads = 0;
  io.terminals = () => (reads++ ? [{ address: "t5", name: "switchboard", state: "live" }] : []);
  assert.deepEqual(await ensureSwitchboard(io, {}), { where: "app", terminal: "t5", started: false });
});

test("a start that fails with nobody running says so", async () => {
  await assert.rejects(ensureSwitchboard(world({ run: { code: 1, stdout: "" } }), {}));
});

test("a request is one of four verbs on a plain name", () => {
  assert.equal(requestLine("start", "s1"), "start s1");
  assert.equal(requestLine("run", "atlas-1_a"), "run atlas-1_a");
  assert.equal(requestLine("pause", "atlas"), "pause atlas");
  assert.equal(requestLine("resume", "atlas"), "resume atlas");
  for (const [verb, name] of [["stop", "atlas"], ["run", "atlas; rm"], ["run", "a b"], ["run", "../atlas"], ["run", "a\nb"], ["run", ""], ["run", null]]) assert.equal(requestLine(verb, name), null);
});

test("a request file has the contract's name", () => {
  assert.equal(requestFile({}, "/h", 1730000000000, "ab12"), "/h/.claude/switchboard/requests/1730000000000-ab12.req");
  assert.equal(requestFile({ claude_dir: "/p" }, "/h", 1, "ab12"), "/p/switchboard/requests/1-ab12.req");
});

test("with a switchboard running the request is written, then it's woken", async () => {
  const io = world({ lock: LOCK, live: liveT7 });
  await sendRequest(io, "pause atlas", {});
  assert.deepEqual(io.writes, [["/h/.claude/switchboard/requests/1000-ab12.req", "pause atlas\n", null]]);
  assert.deepEqual(io.calls.at(-1), ["hc", "send", "t7", "SWITCHBOARD REQUESTS"]);
  assert.ok(io.calls.findIndex((c) => c[0] === "mkdir") < io.calls.findIndex((c) => c[1] === "send"));
});

const hcCalls = (io) => io.calls.filter((c) => c[0] === "hc").map((c) => c.slice(1).join(" "));
const ASIDE = "keys t7 ctrl+s", WAKE = "send t7 SWITCHBOARD REQUESTS";

test("a half-typed line is set aside before the wake, so the wake goes alone", async () => {
  const io = world({ lock: LOCK, live: liveT7 });
  await sendRequest(io, "pause atlas", {});
  assert.deepEqual(hcCalls(io), ["get --json t7", "read t7", ASIDE, WAKE]);
});

test("a stash already held stays, because ctrl+s would bring it back or replace it", async () => {
  const io = world({ lock: LOCK, live: liveT7, screen: STASH_LINE });
  await sendRequest(io, "pause atlas", {});
  assert.ok(!hcCalls(io).includes(ASIDE));
  assert.equal(hcCalls(io).at(-1), WAKE);
});

test("the word stashed in the transcript isn't a held stash", async () => {
  const io = world({ lock: LOCK, live: liveT7, screen: "I stashed the change\n> stashed\n❯ \n" });
  await sendRequest(io, "pause atlas", {});
  assert.ok(hcCalls(io).includes(ASIDE));
});

test("a shell left after Claude Code exits gets no ctrl+s, which would freeze it", async () => {
  const io = world({ lock: LOCK, live: liveT7, get: SHELL });
  await sendRequest(io, "pause atlas", {});
  assert.ok(!hcCalls(io).includes(ASIDE));
  assert.equal(hcCalls(io).at(-1), WAKE);
});

test("a terminal that can't be read is still woken", async () => {
  const io = world({ lock: LOCK, live: liveT7, get: "not json" });
  await sendRequest(io, "pause atlas", {});
  assert.deepEqual(hcCalls(io), ["get --json t7", WAKE]);
});

test("a wake that fails puts the line back", async () => {
  for (const send of [{ code: 1, stdout: "" }, Promise.reject(new Error("blocked"))]) {
    send.catch?.(() => null);
    const io = world({ lock: LOCK, live: liveT7, send });
    await sendRequest(io, "pause atlas", {});
    assert.deepEqual(hcCalls(io), ["get --json t7", "read t7", ASIDE, WAKE, ASIDE]);
  }
});

test("a wake that fails with nothing set aside presses nothing", async () => {
  const io = world({ lock: LOCK, live: liveT7, screen: STASH_LINE, send: { code: 1, stdout: "" } });
  await sendRequest(io, "pause atlas", {});
  assert.deepEqual(hcCalls(io), ["get --json t7", "read t7", WAKE]);
});

test("with the lock free the switchboard starts first, and the request waits for it", async () => {
  const io = world();
  const holder = await sendRequest(io, "start s1", { model: "Opus", effort: "High" });
  assert.equal(holder.started, true);
  assert.equal(io.writes.length, 1);
  assert.ok(!io.calls.some((c) => c[1] === "send"));
});

test("a switchboard in terminal Herdr finds the request from its wait, so nothing is sent", async () => {
  const io = world({ lock: '{"terminal": "wG:p1", "herdr": "terminal"}', agents: [{ name: "x", pane: "wG:p1" }] });
  await sendRequest(io, "run atlas", {});
  assert.equal(io.writes.length, 1);
  assert.ok(!io.calls.some((c) => c[1] === "send"));
});

test("a failed wake keeps the request", async () => {
  const io = world({ lock: LOCK, live: liveT7 });
  const hc = io.hc;
  io.hc = async (args) => { if (args[0] === "send") throw new Error("blocked"); return hc(args); };
  await sendRequest(io, "run atlas", {});
  assert.equal(io.writes.length, 1);
});

test("a line the switchboard would refuse is never written", async () => {
  const io = world({ lock: LOCK, live: liveT7 });
  await assert.rejects(sendRequest(io, null, {}));
  assert.equal(io.writes.length, 0);
});

test("a start that fails writes no request", async () => {
  const io = world({ run: { code: 1, stdout: "" } });
  await assert.rejects(sendRequest(io, "run atlas", {}));
  assert.equal(io.writes.length, 0);
});

import { runRulesFile, writeRunRules } from "../../mods/orchi/switchboard.js";

test("run rules land where the switchboard reads them, replacing the last ones", async () => {
  const files = new Map([["/h/.claude-alt/switchboard/run-rules/atlas.json", "old"]]), made = [];
  const io = {
    home: () => "/h", orchi: { claude_dir: "~/.claude-alt" },
    exec: async (cmd, args) => { made.push([cmd, ...args]); return { code: 0 }; },
    readTextFile: async (p) => { if (!files.has(p)) throw new Error("missing"); return files.get(p); },
    writeTextFile: async (p, text, expected) => {
      if ((files.get(p) ?? null) !== expected) throw new Error("changed");
      files.set(p, text);
    },
  };
  assert.equal(await writeRunRules(io, "atlas", { prs: "merge when clear" }), runRulesFile(io.orchi, "/h", "atlas"));
  assert.deepEqual(JSON.parse(files.get(runRulesFile(io.orchi, "/h", "atlas"))), { prs: "merge when clear" });
  await writeRunRules(io, "new", { prs: "" });
  assert.deepEqual(made[0], ["mkdir", "-p", "/h/.claude-alt/switchboard/run-rules"]);
  await assert.rejects(writeRunRules(io, "../atlas", {}), /file name/);
});
