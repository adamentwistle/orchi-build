import test from "node:test";
import assert from "node:assert/strict";
import { NOTICE_MS, actionAnswer, finishRun, answerArgv, answerProblem, answerText, copyText, decisionButton, discussLine, noticeExpired, pasteable, pasteInto, pauseControl, sendAnswer, settlePending } from "../../mods/orchi/actions.js";

const PATH = "PATH=/h/.local/libexec/orchi-app:/h/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
const SCRIPT = "/h/orchi-build/bin/switchboard-answer";
const decision = { id: "atlas-2", orch: "orch-atlas", board: "/r/atlas", pane: "t3", where: "app", planner: false };

test("an answer is the option, the reply, or both", () => {
  assert.equal(answerText("A", ""), "A");
  assert.equal(answerText(null, " keep them apart "), "keep them apart");
  assert.equal(answerText("B", "but later"), "B: but later");
  assert.equal(answerText(null, "  "), "");
});

test("Mark as completed always has the contract's form", () => {
  assert.equal(actionAnswer("  "), "completed: done");
  assert.equal(actionAnswer(" not yet, the path is wrong "), "not yet, the path is wrong");
});

test("an empty or multi-line reply doesn't send", () => {
  assert.equal(answerProblem("A"), null);
  assert.match(answerProblem(""), /Choose an option/);
  for (const text of ["a\nb", "a\rb", "a\u0003b", "a\u001b[2Jb", "a\u2028b"]) assert.match(answerProblem(text), /one plain line/);
});

test("Send goes through env to the app with the launcher first on PATH", () => {
  assert.deepEqual(answerArgv("/h", decision, "A"), ["ORCHI_HERDR=app", PATH, SCRIPT, "/r/atlas", "t3", "atlas-2", "A"]);
});

test("the script comes from Orchi's checkout as the settings name it", () => {
  assert.equal(answerArgv("/h", decision, "A", { orchi_dir: "~/src/orchi" })[2], "/h/src/orchi/bin/switchboard-answer");
});

test("an orchestrator still in terminal Herdr is answered there", () => {
  assert.deepEqual(answerArgv("/h", { ...decision, pane: "wGZ:p1", where: "terminal" }, "A"), ["ORCHI_HERDR=terminal", PATH, SCRIPT, "/r/atlas", "wGZ:p1", "atlas-2", "A"]);
});

test("a planner board goes by --board", () => {
  const d = { id: "plan-1", orch: "plan-s1", board: "/h/planning/s1.md", pane: "t9", planner: true, where: "app" };
  assert.deepEqual(answerArgv("/h", d, "A"), ["ORCHI_HERDR=app", PATH, SCRIPT, "--board", "/h/planning/s1.md", "t9", "plan-1", "A"]);
});

test("a hostile reply stays one argument", () => {
  const text = `"; rm -rf ~; echo "$(id)`;
  assert.equal(answerArgv("/h", decision, text).at(-1), text);
});

test("nothing runs on a bad shape", () => {
  assert.equal(answerArgv("/h", decision, "a\nb"), null);
  assert.equal(answerArgv("/h", { ...decision, id: "atlas-2; rm" }, "A"), null);
  assert.equal(answerArgv("/h", { ...decision, pane: null }, "A"), null);
  assert.equal(answerArgv("/h", { ...decision, pane: "t3 --force" }, "A"), null);
  assert.equal(answerArgv("/h", { ...decision, pane: "--force" }, "A"), null);
  assert.equal(answerArgv("/h", { ...decision, id: "--grant" }, "A"), null);
  assert.equal(answerArgv("/h", { ...decision, board: "relative" }, "A"), null);
});

test("sendAnswer runs /usr/bin/env, and a refusal comes back as its first line", async () => {
  const calls = [];
  await sendAnswer(async (c, a) => { calls.push([c, ...a]); return { code: 0, stdout: "", stderr: "" }; }, "/h", decision, "A");
  assert.equal(calls[0][0], "/usr/bin/env");
  await assert.rejects(sendAnswer(async () => ({ code: 1, stdout: "", stderr: "switchboard-answer: atlas-2 is not open\nmore" }), "/h", decision, "A"), /atlas-2 is not open$/);
  await assert.rejects(sendAnswer(async () => ({ code: 0 }), "/h", { ...decision, pane: null }, "A"), /Can't reply/);
});

test("a control character or newline disables Put in terminal", () => {
  assert.equal(pasteable("! gh pr merge 65 --squash"), true);
  for (const bad of ["a\nb", "a\rb", "a\tb", "\u0003", "a\u001b[2J", "a\u007fb", "a\u0085b", "a\u2028b", "a\u2029b", "", null, undefined]) assert.equal(pasteable(bad), false);
});

test("copy pipes through a fixed script, with the text as an argument", async () => {
  const calls = [];
  const text = `$(rm -rf ~) "quoted"`;
  await copyText(async (c, a) => { calls.push([c, ...a]); return { code: 0 }; }, text);
  assert.deepEqual(calls[0], ["sh", "-c", 'printf %s "$1" | pbcopy', "sh", text]);
  await assert.rejects(copyText(async () => ({ code: 1 }), "x"));
});

test("Put in terminal copies, focuses and pastes, and never presses Enter", async () => {
  const log = [];
  const pasted = await pasteInto({
    exec: async (c, a) => { log.push([c, ...a]); return { code: 0 }; }, run: (name, args) => log.push(["run", name, args]), focused: () => ({ terminal: "t3" }),
  }, "t3", "! gh pr merge 65");
  assert.equal(pasted, true);
  assert.deepEqual(log.map((l) => l[0] === "run" ? l[1] : l[0]), ["sh", "pane.focus", "terminal.paste"]);
  assert.deepEqual(log[1][2], { terminal: "t3" });
  assert.ok(!JSON.stringify(log).includes("\\n"));
  assert.ok(!log.some((l) => ["hc", "keys", "send"].includes(l[0])));
});

test("it waits for focus to arrive", async () => {
  let checks = 0;
  const run = [];
  const pasted = await pasteInto({ exec: async () => ({ code: 0 }), run: (name) => run.push(name), focused: () => (++checks > 2 ? { terminal: "t3" } : { terminal: "t1" }) }, "t3", "ls");
  assert.equal(pasted, true);
  assert.deepEqual(run, ["pane.focus", "terminal.paste"]);
});

test("it never pastes into the wrong terminal", async () => {
  const run = [];
  const pasted = await pasteInto({ exec: async () => ({ code: 0 }), run: (name) => run.push(name), focused: () => ({ terminal: "t1" }) }, "t3", "ls");
  assert.equal(pasted, false);
  assert.deepEqual(run, ["pane.focus"]);
});

test("a command with a control character is refused before anything happens", async () => {
  const log = [];
  await assert.rejects(pasteInto({ exec: async (c) => { log.push(c); return { code: 0 }; }, run: (n) => log.push(n), focused: () => null }, "t3", "ls\nrm -rf ~"));
  assert.deepEqual(log, []);
});

test("Discuss in chat leaves a checked line", () => {
  assert.equal(discussLine({ id: "atlas-2", orch: "orch-atlas" }), "Let's talk through atlas-2 from orch-atlas before I answer.");
  assert.equal(discussLine({ id: "atlas-2\nrm", orch: "orch-atlas" }), null);
  assert.equal(pasteable(discussLine({ id: "atlas-2", orch: "orch-atlas" })), true);
});

test("a pending press clears only when state.md shows it done", () => {
  assert.deepEqual(settlePending({ atlas: "pausing" }, [], ["atlas"]), { atlas: "pausing" });
  assert.deepEqual(settlePending({ atlas: "pausing" }, ["atlas"], ["atlas"]), {});
  assert.deepEqual(settlePending({ atlas: "resuming" }, ["atlas"], ["atlas"]), { atlas: "resuming" });
  assert.deepEqual(settlePending({ atlas: "resuming" }, [], ["atlas"]), {});
});

test("a pending press for an orchestrator that has gone clears", () => {
  assert.deepEqual(settlePending({ atlas: "pausing", b: "pausing" }, [], ["b"]), { b: "pausing" });
});
test("a window that has just started reads no terminals, which isn't every orchestrator gone", () => {
  const pending = { atlas: "pausing", b: "resuming" };
  assert.deepEqual(settlePending(pending, ["b"], [], { terminalsRead: false }), pending);
  assert.deepEqual(settlePending(pending, ["b"], [], { terminalsRead: true }), {});
});

test("what state.md shows still settles a press before the terminals are read", () => {
  assert.deepEqual(settlePending({ atlas: "pausing", b: "pausing" }, ["atlas"], [], { terminalsRead: false }), { b: "pausing" });
});


test("a running orchestrator can pause, a paused one can play, and a pending one spins", () => {
  assert.equal(pauseControl({ where: "app" }, undefined), "pause");
  assert.equal(pauseControl({ where: "app", paused: true }, undefined), "play");
  assert.equal(pauseControl({ where: "app", paused: true }, "resuming"), "spinner");
  assert.equal(pauseControl({ where: "app" }, "pausing"), "spinner");
});

test("a terminal Herdr orchestrator stays read-only", () => {
  assert.equal(pauseControl({ where: "terminal" }, undefined), null);
});

test("an action's button reads Send once there are words to send", () => {
  const press = (over) => decisionButton({ kind: "ACTION", option: null, reply: "", sending: false, ...over });
  assert.deepEqual(press({}), { label: "Mark as completed", enabled: true });
  assert.deepEqual(press({ reply: "use the other vault" }), { label: "Send", enabled: true });
  assert.deepEqual(press({ reply: "   " }), { label: "Mark as completed", enabled: true });
  assert.deepEqual(press({ sending: true }), { label: "Sending…", enabled: false });
});

test("a decision needs an option or a reply", () => {
  const press = (over) => decisionButton({ kind: "DECISION", option: null, reply: "", sending: false, ...over });
  assert.deepEqual(press({}), { label: "Send", enabled: false });
  assert.deepEqual(press({ option: "A" }), { label: "Send", enabled: true });
  assert.deepEqual(press({ reply: "neither" }), { label: "Send", enabled: true });
});

test("finishing a run keeps each value its own argument", async () => {
  const calls = [];
  const exec = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: "", stderr: "" }; };
  await finishRun(exec, "/h", "/r/atlas", "Marked complete; don't $(run) this");
  assert.equal(calls[0][0], "/usr/bin/env");
  assert.deepEqual(calls[0].slice(2), [SCRIPT, "--finish", "/r/atlas", "Marked complete; don't $(run) this"]);
  await finishRun(exec, "/h", "/r/atlas", "why", { orchi_dir: "/src/orchi" });
  assert.equal(calls[1][2], "/src/orchi/bin/switchboard-answer");
});

test("a run with no repo, or a script that refuses, says so", async () => {
  const exec = async () => ({ code: 1, stdout: "", stderr: "switchboard-answer: reason is empty\nmore" });
  await assert.rejects(finishRun(exec, "/h", null, "why"), /no repo/);
  await assert.rejects(finishRun(exec, "/h", "/r/atlas", "why"), /reason is empty$/);
});

test("a press's note or error has NOTICE_MS in the header, then clears", () => {
  const at = 1_000_000;
  assert.equal(noticeExpired(null, at), false);
  assert.equal(noticeExpired(at, at), false);
  assert.equal(noticeExpired(at, at + NOTICE_MS - 1), false);
  assert.equal(noticeExpired(at, at + NOTICE_MS), true);
  assert.ok(NOTICE_MS >= 10000 && NOTICE_MS <= 60000);
});
