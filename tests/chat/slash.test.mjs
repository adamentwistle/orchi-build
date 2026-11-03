import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEY_CONTEXT, LIST_KEYS, SEND_ACTION, buildList, folderTrusted, cachedList, completing, ensureList, fallbackList, filterList, GROUPS, HEADLESS, HEADLESS_S, SCRIPT, keyAction, keyBindings, keysWanted, nameParts, parseStream, resetCache, runHeadless, step } from "../../mods/claude-chat/slash.js";

// The shape `claude -p` 2.1.316 prints: the init message, and a commands_changed message cut down to 30 commands. The
// skill and plugin names are made up.
const stream = readFileSync(new URL("./fixtures/headless-init.jsonl", import.meta.url), "utf8");
const parsed = parseStream(stream);
const list = buildList(parsed);
const by = (name) => list.find((c) => c.name === name);

test("the init message gives the command names and the commands_changed message the descriptions", () => {
  assert.equal(parsed.names.length, 214);
  assert.equal(parsed.terminal.length, 4);
  assert.equal(parsed.skills.length, 150);
  assert.equal(parsed.version, "2.1.316");
  assert.match(parsed.described.clear.description, /^Start a new session/);
});

test("lines that aren't JSON, and other messages, are skipped", () => {
  const noisy = `welcome to zsh\n\u001b[0m\n${stream}{"type":"assistant"}\n{broken\n`;
  assert.equal(parseStream(noisy).names.length, 214);
  assert.deepEqual(parseStream("").names, []);
  assert.deepEqual(parseStream(null).names, []);
  assert.deepEqual(parseStream('{"type":"system","subtype":"init"}').names, []);
});

test("every group of the spec is used, in its order", () => {
  assert.deepEqual(GROUPS, ["This session", "In the chat", "Skills", "Opens the terminal", "End"]);
  const used = new Set(list.map((c) => c.group));
  for (const g of GROUPS) assert.ok(used.has(g), g);
});

test("the table's commands are in the list even though a headless start doesn't name them", () => {
  assert.ok(!parsed.names.includes("tui"));
  assert.ok(!parsed.names.includes("permissions"));
  for (const name of ["/tui", "/terminal", "/permissions", "/memory", "/status", "/hooks", "/plugin", "/resume", "/rewind", "/add-dir", "/ide", "/statusline", "/login", "/logout", "/vim"]) {
    assert.equal(by(name)?.group, "Opens the terminal", name);
    assert.ok(by(name).desc.length > 0, name);
  }
  assert.equal(by("/exit").group, "End");
  assert.equal(list.filter((c) => c.name === "/usage").length, 1);
});

test("what the chat handles itself is grouped as In the chat, with the chat's words", () => {
  for (const name of ["/usage", "/model", "/effort"]) assert.equal(by(name).group, "In the chat");
  assert.equal(by("/model").desc, "Change the model and effort");
});

test("Claude Code's own commands are This session", () => {
  for (const name of ["/clear", "/compact", "/context", "/init", "/rename", "/mcp"]) assert.equal(by(name).group, "This session", name);
});

test("skills, user commands and plugin commands are Skills", () => {
  for (const name of ["/fanout", "/herdr", "/go", "/wrap", "/pickup", "/bugbot", "/superpowers:brainstorming", "/feature-dev:feature-dev", "/slack:standup", "/1on1-notes"]) assert.equal(by(name)?.group, "Skills", name);
});

test("terminal-only commands from Claude Code are in Opens the terminal", () => {
  assert.equal(by("/doctor").group, "Opens the terminal");
  assert.equal(by("/color").group, "Opens the terminal");
});

test("names that can't be typed are left out", () => {
  assert.equal(by("/__remote-workflow"), undefined);
  assert.ok(!list.some((c) => /\s/.test(c.name)));
  assert.ok(!list.some((c) => c.name.startsWith("/__")));
});

test("a description loses its source marker", () => {
  assert.equal(by("/wrap").desc, "Close out this session. Update the legwork tracker and mint the next prompt.");
  assert.ok(!list.some((c) => /\((?:user|claude\.ai sync)\)$/.test(c.desc)));
});

test("filtering with nothing typed keeps every command, grouped in order", () => {
  const { sections, flat } = filterList(list, "/");
  assert.deepEqual(sections.map((s) => s.title), GROUPS);
  assert.equal(flat.length, list.length);
  assert.equal(flat[0].hit, null);
  const names = sections[0].items.map((c) => c.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test("a prefix ranks before a match inside the name, and the match is marked", () => {
  const { flat } = filterList(list, "/br");
  assert.ok(flat[0].name.startsWith("/br") || flat[0].hit[0] > 1);
  const inside = flat.find((c) => c.name === "/superpowers:brainstorming");
  assert.deepEqual(inside.hit, [13, 15]);
  assert.deepEqual(nameParts(inside), { before: "/superpowers:", match: "br", after: "ainstorming" });
  const first = filterList(list, "/cl").flat[0];
  assert.equal(first.name, "/clear");
  assert.deepEqual(first.hit, [1, 3]);
  assert.deepEqual(nameParts(first), { before: "/", match: "cl", after: "ear" });
});

test("a prefix match comes before an inside match in the same group", () => {
  const items = filterList(list, "/co").sections.find((s) => s.title === "This session").items.map((c) => c.name);
  const firstInside = items.findIndex((n) => !n.startsWith("/co"));
  const lastPrefix = items.map((n) => n.startsWith("/co")).lastIndexOf(true);
  assert.ok(lastPrefix >= 0);
  if (firstInside >= 0) assert.ok(lastPrefix < firstInside);
});

test("filtering ignores case and drops empty sections", () => {
  const { sections } = filterList(list, "/USA");
  const chat = sections.find((s) => s.title === "In the chat");
  assert.equal(chat.items[0].name, "/usage");
  assert.equal(sections.some((s) => s.title === "End"), false);
  assert.deepEqual(filterList(list, "/zzzzzz"), { sections: [], flat: [] });
});

test("the list shows for a slash and a name only", () => {
  for (const text of ["/", "/cl", "/superpowers:brain"]) assert.equal(completing(text), true, text);
  for (const text of ["", "hello", "/clear now", "/Users/me", " /x", "/ "]) assert.equal(completing(text), false, text);
  assert.equal(completing(null), false);
});

test("the selection wraps at both ends", () => {
  assert.equal(step(0, -1, 5), 4);
  assert.equal(step(4, 1, 5), 0);
  assert.equal(step(2, 1, 5), 3);
  assert.equal(step(0, 1, 0), 0);
});

test("without a read the table's commands still work", () => {
  const f = fallbackList();
  assert.ok(f.length >= 19);
  assert.ok(f.some((c) => c.name === "/permissions"));
  assert.equal(f.some((c) => c.group === "Skills"), false);
});

// ---- the headless start ----

const ok = (stdout) => ({ code: 0, stdout, stderr: "" });

test("the headless call is a login zsh that pipes one user message into claude -p", async () => {
  let call;
  const exec = async (cmd, args, opts) => { call = { cmd, args, opts }; return ok(stream); };
  await runHeadless(exec, "/work/x", "/usage", true);
  assert.equal(call.cmd, "zsh");
  assert.equal(call.args[0], "-ic");
  assert.match(call.args[1], /\| claude "\$@"/);
  assert.deepEqual(JSON.parse(call.args[3]), { type: "user", message: { role: "user", content: "/usage" } });
  assert.deepEqual(call.args.slice(4), HEADLESS);
  assert.ok(HEADLESS.includes("--no-session-persistence"));
  assert.deepEqual(call.opts, { cwd: "/work/x" });
});

test("a message with quotes and dollar signs stays one argument", async () => {
  let call;
  await runHeadless(async (c, a) => { call = a; return ok(stream); }, "/x", `/usage "$(touch no)" ; \`x\``, true);
  assert.equal(call.length, 4 + HEADLESS.length);
  assert.equal(JSON.parse(call[3]).message.content, `/usage "$(touch no)" ; \`x\``, true);
});

test("a failed run with no init message throws, and one that exits non-zero after init is kept", async () => {
  await assert.rejects(runHeadless(async () => ({ code: 1, stdout: "", stderr: "boom" }), "/x", "/usage", true));
  assert.ok(await runHeadless(async () => ({ code: 1, stdout: stream, stderr: "" }), "/x", "/usage", true));
});

test("the list is read once per folder, however many ask", async () => {
  resetCache();
  let calls = 0;
  const exec = async () => { calls++; return ok(stream); }, trusted = () => true;
  const [a, b] = await Promise.all([ensureList("/a", { exec, trusted }), ensureList("/a", { exec, trusted })]);
  assert.equal(a, b);
  await ensureList("/a", { exec, trusted });
  assert.equal(calls, 1);
  assert.equal(cachedList("/a").length, list.length);
  assert.equal(cachedList("/b"), null);
  await ensureList("/b", { exec, trusted });
  assert.equal(calls, 2);
});

test("a failed read is tried again only after a minute", async () => {
  resetCache();
  let calls = 0, clock = 1_000_000;
  const exec = async () => { calls++; throw new Error("timed out"); };
  const io = { exec, trusted: () => true, now: () => clock };
  assert.equal(await ensureList("/f", io), null);
  assert.equal(await ensureList("/f", io), null);
  assert.equal(calls, 1);
  clock += 59_000;
  await ensureList("/f", io);
  assert.equal(calls, 1);
  clock += 2_000;
  await ensureList("/f", io);
  assert.equal(calls, 2);
  assert.equal(cachedList("/f"), null);
});

test("a headless start that never answers gives up, and the next ask after a minute starts again", async () => {
  resetCache();
  let calls = 0, clock = 1_000_000;
  const hang = async () => { calls++; return new Promise(() => {}); };
  const io = { exec: hang, trusted: () => true, now: () => clock, limitMs: 20 };
  assert.equal(await ensureList("/h", io), null);
  assert.equal(await ensureList("/h", io), null);
  assert.equal(calls, 1);
  clock += 61_000;
  assert.equal(await ensureList("/h", { ...io, exec: async () => { calls++; return ok(stream); } }), cachedList("/h"));
  assert.equal(calls, 2);
  assert.ok(cachedList("/h").length);
});

test("runHeadless rejects a hang in time", async () => {
  const started = Date.now();
  await assert.rejects(runHeadless(() => new Promise(() => {}), "/x", "/usage", true, { limitMs: 30 }), /took too long/);
  assert.ok(Date.now() - started < 1000);
});

// The real shell script, with a stand-in `claude` that hangs and the watchdog cut to one second.
test("the watchdog stops a claude that hangs, and leaves no process behind", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-"));
  const pidFile = join(dir, "pid");
  writeFileSync(join(dir, "claude"), `#!/bin/sh\necho $$ > "${pidFile}"\ncat > /dev/null\nexec sleep 30\n`);
  chmodSync(join(dir, "claude"), 0o755);
  assert.match(SCRIPT, new RegExp(`sleep ${HEADLESS_S};`));
  const script = SCRIPT.replace(`sleep ${HEADLESS_S};`, "sleep 1;");
  const started = Date.now();
  const code = await new Promise((resolve) => {
    execFile("zsh", ["-fc", script, "zsh", "{}", "-p"], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }, (error) => resolve(error ? error.code : 0));
  });
  assert.ok(Date.now() - started < 6000, "it gave up");
  assert.notEqual(code, 0);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("a claude that finishes quickly keeps its own exit code and output", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-"));
  writeFileSync(join(dir, "claude"), `#!/bin/sh\ncat > /dev/null\necho '{"type":"system","subtype":"init"}'\nexit 3\n`);
  chmodSync(join(dir, "claude"), 0o755);
  const started = Date.now();
  const r = await new Promise((resolve) => {
    execFile("zsh", ["-fc", SCRIPT, "zsh", "{}", "-p"], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }, (error, stdout) => resolve({ code: error ? error.code : 0, stdout }));
  });
  assert.ok(Date.now() - started < 5000, "it didn't wait for the watchdog");
  assert.equal(r.code, 3);
  assert.match(r.stdout, /"init"/);
});

test("an init message with no names counts as a failure", async () => {
  resetCache();
  assert.equal(await ensureList("/e", { exec: async () => ok('{"type":"system","subtype":"init"}\n'), trusted: () => true }), null);
});

// ---- the card's rows ----

import { completionRows, contentHeight, listHeight, ROW, rowNumber, selectedRow } from "../../mods/claude-chat/slash.js";

test("rows are a header, then its commands, for each section", () => {
  const { sections } = filterList(list, "/cl");
  const rows = completionRows(sections);
  assert.equal(rows[0].kind, "head");
  assert.equal(rows[0].first, true);
  assert.equal(rows[0].top, 0);
  assert.equal(rows.filter((r) => r.kind === "head").length, sections.length);
  assert.equal(rows.filter((r) => r.kind === "item").length, sections.reduce((a, s) => a + s.items.length, 0));
  const items = rows.filter((r) => r.kind === "item");
  assert.deepEqual(items.map((r) => r.index), items.map((_, i) => i));
});

test("each row starts where the one before it ends", () => {
  const rows = completionRows(filterList(list, "/").sections);
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].top, rows[i - 1].top + rows[i - 1].size);
  assert.equal(rows[0].size, ROW.head);
  assert.equal(rows.find((r) => r.kind === "head" && !r.first).size, ROW.head + ROW.gap);
});

test("the card is as tall as its rows and the padding, up to a most", () => {
  const few = completionRows(filterList(list, "/usa").sections);
  assert.equal(contentHeight(few), few.at(-1).top + few.at(-1).size + ROW.pad);
  assert.equal(listHeight(few), contentHeight(few));
  const all = completionRows(filterList(list, "/").sections);
  assert.equal(listHeight(all), ROW.max);
  assert.equal(listHeight(all, 200), 200);
  assert.equal(contentHeight([]), 0);
});

test("the selected command is found by its place among commands", () => {
  const rows = completionRows(filterList(list, "/").sections);
  const r = selectedRow(rows, 3);
  assert.equal(r.index, 3);
  assert.equal(rows[rowNumber(rows, 3)], r);
  assert.equal(selectedRow(rows, 9999), null);
  assert.equal(rowNumber(rows, 9999), -1);
});

// ---- trust ----

test("nothing runs in a folder that isn't trusted, and an unknown answer counts as no", async () => {
  let ran = 0;
  const exec = async () => { ran++; return ok(stream); };
  await assert.rejects(runHeadless(exec, "/x", "/usage", false));
  await assert.rejects(runHeadless(exec, "/x", "/usage"));
  await assert.rejects(runHeadless(exec, "/x", "/usage", "yes"));
  resetCache();
  assert.equal(await ensureList("/u", { exec, trusted: () => false }), null);
  assert.equal(await ensureList("/v", { exec }), null);
  assert.equal(await ensureList("/w", { exec, trusted: async () => { throw new Error("no file"); } }), null);
  assert.equal(ran, 0);
});

test("a folder is trusted only by its own accepted entry in .claude.json", () => {
  const json = JSON.stringify({ projects: { "/work/a": { hasTrustDialogAccepted: true }, "/work/b": { hasTrustDialogAccepted: false }, "/work": { hasTrustDialogAccepted: true } } });
  assert.equal(folderTrusted(json, "/work/a"), true);
  assert.equal(folderTrusted(json, "/work/b"), false);
  assert.equal(folderTrusted(json, "/work/a/sub"), false, "a parent's trust doesn't reach a child");
  assert.equal(folderTrusted(json, "/other"), false);
  assert.equal(folderTrusted("nope", "/work/a"), false);
  assert.equal(folderTrusted("{}", "/work/a"), false);
  assert.equal(folderTrusted(null, "/work/a"), false);
});

// ---- Enter on a part-typed name ----

import { pick, startRow } from "../../mods/claude-chat/slash.js";

test("Enter on part of a name runs the selected command, and on a whole name runs what was typed", () => {
  const item = { name: "/clear" };
  assert.equal(pick("/cl", item), "/clear");
  assert.equal(pick("/", item), "/clear");
  assert.equal(pick("/clear", item), "/clear");
  assert.equal(pick("/clear ", item), "/clear ");
  assert.equal(pick("/cl", undefined), "/cl");
  assert.equal(pick("hello", item), "hello");
  assert.equal(pick("/clear now", item), "/clear now");
});

test("a command typed in full runs itself, not the row the list puts first", () => {
  const list = buildList(parseStream(readFileSync(new URL("./fixtures/headless-init.jsonl", import.meta.url), "utf8")));
  for (const typed of ["/tui", "/usage", "/go", "/review", "/memory", "/plan", "/ide"]) {
    const { flat } = filterList(list, typed);
    if (!flat.some((c) => c.name === typed)) continue;
    assert.equal(pick(typed, flat[0], flat), typed, typed);
  }
});

test("a row picked with the arrows wins over the typed name", () => {
  const flat = [{ name: "/usage" }, { name: "/usage-credits" }];
  assert.equal(pick("/usage", flat[1], flat, true), "/usage-credits");
});

test("the list starts on the row that matches what's typed", () => {
  const flat = [{ name: "/figma:figma-swiftui" }, { name: "/tui" }];
  assert.equal(startRow(flat, "/tui"), 1);
  assert.equal(startRow(flat, "/tu"), 0);
});

// The Textarea's own bindings sit on `Input`, so one of ours only comes first at that depth.
test("the list's keys are bound at the input's depth, because on_key_down never hears them", () => {
  const list = keyBindings().filter((b) => b.context === `${KEY_CONTEXT.list} > Input`);
  assert.deepEqual(list.map((b) => b.keystroke).sort(), ["enter", ...LIST_KEYS].sort());
  for (const b of list) if (b.keystroke !== "enter") assert.equal(b.action, keyAction(b.keystroke));
});

test("with nothing open the arrows, Tab and Escape stay the input's", () => {
  const plain = keyBindings().filter((b) => b.context === `${KEY_CONTEXT.text} > Input`);
  assert.deepEqual(plain, [{ keystroke: "enter", action: SEND_ACTION, context: `${KEY_CONTEXT.text} > Input` }]);
});

test("a panel takes only Escape, so the arrows still move the cursor", () => {
  const panel = keyBindings().filter((b) => b.context === `${KEY_CONTEXT.panel} > Input`).map((b) => b.keystroke);
  assert.deepEqual(panel.sort(), ["enter", "escape"]);
});

test("Enter sends in every context, or a list that's open would drop it", () => {
  for (const context of Object.values(KEY_CONTEXT)) assert.ok(keyBindings().some((b) => b.keystroke === "enter" && b.action === SEND_ACTION && b.context === `${context} > Input`), context);
});

test("what wants the keys follows what's open", () => {
  const rows = { flat: [{ name: "/clear" }] }, none = { flat: [] };
  for (const [open, want] of [
    [{}, null], [{ slash: rows }, "list"], [{ slash: none }, "panel"], [{ exit: true }, "panel"], [{ usage: { closing: false } }, "panel"],
    [{ usage: { closing: true } }, null], [{ slash: rows, exit: true }, "list"],
  ]) assert.equal(keysWanted(open), want, JSON.stringify(open));
});

test("a backslash in a macOS folder name is not a Windows separator", () => {
  const json = JSON.stringify({ projects: { "/tmp/demo/child": { hasTrustDialogAccepted: true }, "C:/w/atlas": { hasTrustDialogAccepted: true } } });
  assert.equal(folderTrusted(json, "/tmp/demo\\child"), false);
  assert.equal(folderTrusted(json, "/tmp/demo/child"), true);
  assert.equal(folderTrusted(json, "C:\\w\\atlas"), true);
});
