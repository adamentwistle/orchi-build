import { test } from "node:test";
import assert from "node:assert/strict";
import { headerFacts, unseenLabel } from "../../mods/pane-header/facts.js";

const claude = { name: "Claude Code", agent: true, icon: "icons/claude.svg" };
const terminal = { pane: "p1", terminal: "t1", title: "x", cwd: "/repo", program: claude, status: "working" };
const chat = { pane: "p2", terminal: null, mod: "claude-chat", title: "claude-chat" };

test("a chat pane takes its name, folder and status from its terminal", () => {
  assert.deepEqual(headerFacts(chat, [terminal, chat], { p2: "t1" }), { chat: true, name: "Claude Code", cwd: "/repo", program: claude, status: "working", unseen: 0 });
});

test("a chat pane shows Needs you while its session is blocked", () => {
  assert.equal(headerFacts(chat, [{ ...terminal, status: "blocked" }, chat], { p2: "t1" }).status, "blocked");
  assert.equal(headerFacts(chat, [{ ...terminal, status: undefined }, chat], { p2: "t1" }).status, null);
});

test("a chat pane with no pair still reads Claude Code", () => {
  assert.deepEqual(headerFacts(chat, [chat], {}), { chat: true, name: "Claude Code", cwd: null, program: null, status: null, unseen: 0 });
});

test("a terminal reads as the shipped header does", () => {
  assert.deepEqual(headerFacts(terminal, [terminal], {}), { chat: false, name: "Claude Code", cwd: "/repo", program: claude, status: "working", unseen: 0 });
  const plain = { pane: "p3", terminal: "t2", title: "vim", cwd: "/x", program: { name: "Neovim" }, status: null };
  assert.equal(headerFacts(plain, [plain], {}).name, "vim");
  const shell = { pane: "p4", terminal: "t3", title: "x", cwd: "/x", program: { name: "zsh", shell: true } };
  assert.equal(headerFacts(shell, [shell], {}).name, "zsh");
  assert.equal(headerFacts({ pane: "p5" }, [], {}).name, "shell");
});

test("a chat's N new shows on its own header and on its terminal's, and nowhere else", () => {
  const unseen = { t1: 3, t9: 5 };
  assert.equal(headerFacts(chat, [terminal, chat], { p2: "t1" }, unseen).unseen, 3);
  assert.equal(headerFacts(terminal, [terminal, chat], { p2: "t1" }, unseen).unseen, 3);
  assert.equal(headerFacts({ ...terminal, terminal: "t9" }, [terminal], {}, unseen).unseen, 0);
  assert.equal(headerFacts(chat, [terminal, chat], { p2: "t1" }, { t1: "3" }).unseen, 0);
  assert.equal(headerFacts(chat, [chat], {}, unseen).unseen, 0);
  assert.equal(unseenLabel(3), "3 new");
  assert.equal(unseenLabel(0), null);
});

test("another mod's pane keeps its own title", () => {
  const other = { pane: "p6", terminal: null, mod: "files", title: "files" };
  assert.equal(headerFacts(other, [other], {}).name, "files");
});

test("the plan pane is called Plan, not by its mod's folder name", () => {
  const plan = { pane: "p7", terminal: null, mod: "plan-view", title: "plan-view" };
  assert.equal(headerFacts(plan, [plan], {}).name, "Plan");
});

test("the progress pane has a plain name, not its mod's", () => {
  assert.deepEqual(headerFacts({ mod: "orch-pane", title: "orch-pane" }, [], {}), { chat: false, name: "Orchestrator progress", cwd: null, program: null, status: null, unseen: 0 });
});
