// Checks for the Windows side of the mods: the platform check, win.py, and each place that calls it. The Mac side is
// covered by the tests beside each mod, which pass no `win` and so take the Mac path on any machine.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalPath, pythonName, samePath, winHelper } from "../../mods/claude-chat/platform.js";
import * as chat from "../../mods/claude-chat/session.js";
import * as herd from "../../mods/herd/session.js";
import * as orch from "../../mods/orch-pane/session.js";
import { clipboardImage, droppedImage, forgetImage } from "../../mods/claude-chat/images.js";
import { HEADLESS, folderTrusted, runHeadless } from "../../mods/claude-chat/slash.js";
import { longestRanges } from "../../mods/claude-chat/usage-data.js";

const PYTHON = process.platform === "win32" ? "python" : "python3";
const mod = (path) => fileURLToPath(new URL(`../../mods/${path}`, import.meta.url));
const WIN = mod("claude-chat/win.py");
const ID = "11111111-2222-4333-8444-555555555555";
const HOME = "C:/Users/me/.config/herdr-app";
const sessionText = (pid, cwd = String.raw`D:\src\x`) => JSON.stringify({ pid, sessionId: ID, cwd, updatedAt: 5 });

// An exec that records each call and answers by program and first helper argument.
function shell(answers = {}) {
  const calls = [];
  const exec = async (cmd, args = [], opts) => {
    calls.push([cmd, ...args, ...(opts ? [opts] : [])]);
    const key = args[3] ?? cmd;
    return answers[key] ?? answers[cmd] ?? { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

test("the copies of platform.js and win.py are the same file in every mod", () => {
  const platform = readFileSync(mod("claude-chat/platform.js"), "utf8");
  for (const m of ["herd", "orch-pane", "plan-view"]) assert.equal(readFileSync(mod(`${m}/platform.js`), "utf8"), platform, m);
  const win = readFileSync(WIN, "utf8");
  for (const m of ["herd", "orch-pane"]) assert.equal(readFileSync(mod(`${m}/win.py`), "utf8"), win, m);
});

test("the platform check picks python and the helper on Windows only", () => {
  assert.equal(pythonName(true), "python");
  assert.equal(pythonName(false), "python3");
  assert.equal(winHelper(HOME, "herd", true), `${HOME}/mods/herd/win.py`);
  assert.equal(winHelper(HOME, "herd", false), null);
  assert.equal(normalPath(String.raw`C:\Users\me\x.jsonl`), "c:/users/me/x.jsonl");
  assert.equal(normalPath(String.raw`\\?\C:\Users\Me\x.jsonl`), "c:/users/me/x.jsonl");
  assert.equal(samePath(String.raw`\\?\c:\H\.claude-alt\a.jsonl`, "C:/h/.claude-alt/a.jsonl"), true);
  assert.equal(normalPath("/Users/me/x.jsonl"), "/Users/me/x.jsonl");
  assert.equal(samePath(String.raw`C:\a\b`, "c:/a/b"), true);
  assert.equal(samePath("/a/b", "/a/c"), false);
});

// The profile folder comes from Orchi's settings, as on the Mac.
const SETTINGS = { claude_dir: "C:/h/.claude-alt" };

test("the chat pane finds a Windows session through win.py, from the shell's pid", async () => {
  const hc = async () => ({ code: 0, stdout: JSON.stringify({ pid: 70, foreground: { pid: 70, name: "pwsh.exe" } }) });
  const found = { dir: "C:/h/.claude-alt", text: sessionText(900) };
  const { exec, calls } = shell({ session: { code: 0, stdout: JSON.stringify(found) } });
  const s = await chat.findSession({ hc, readTextFile: async () => null, home: () => "C:/h", settings: SETTINGS, exec, win: "W/win.py", python: "python" }, "t3");
  assert.deepEqual(calls[0], ["python", "-I", "-S", "W/win.py", "session", "70", "C:/h/.claude-alt", "C:/h/.claude"]);
  assert.equal(s.pid, 900);
  assert.equal(s.transcript, `C:/h/.claude-alt/projects/D--src-x/${ID}.jsonl`);
});

test("a Windows answer from a folder that wasn't asked about, or no answer, finds nothing", async () => {
  const hc = async () => ({ code: 0, stdout: JSON.stringify({ foreground: { pid: 70 } }) });
  const deps = (stdout, code = 0) => ({ hc, readTextFile: async () => null, home: () => "C:/h", exec: shell({ session: { code, stdout } }).exec, win: "w" });
  assert.equal(await chat.findSession(deps(JSON.stringify({ dir: "C:/elsewhere", text: sessionText(9) })), "t"), null);
  assert.equal(await chat.findSession(deps("null"), "t"), null);
  assert.equal(await chat.findSession(deps("", 1), "t"), null);
  assert.equal(await chat.findSession(deps("not json"), "t"), null);
});

test("herd and the progress pane find a Windows session the same way", async () => {
  const found = { dir: "C:/h/.claude-alt", text: sessionText(900) };
  for (const m of [herd, orch]) {
    const { exec, calls } = shell({ session: { code: 0, stdout: JSON.stringify(found) } });
    const s = await m.findSession({ readTextFile: async () => null, home: () => "C:/h", orchi: SETTINGS, exec, win: "w.py", python: "python" }, { foreground: { pid: 70 } });
    assert.deepEqual(calls[0].slice(4), ["session", "70", "C:/h/.claude-alt", "C:/h/.claude"]);
    assert.equal(s.sessionId, ID);
    assert.equal(s.dir, "C:/h/.claude-alt");
  }
});

test("on Windows a transcript is looked for by id through win.py, and a changed path matches with backslashes", async () => {
  const { exec, calls } = shell({ locate: { code: 0, stdout: `C:/h/.claude-alt/projects/x/${ID}.jsonl\r\n` } });
  assert.equal(await chat.locateTranscript({ exec, win: "w.py" }, { dir: "C:/h/.claude-alt", sessionId: ID }), `C:/h/.claude-alt/projects/x/${ID}.jsonl`);
  assert.deepEqual(calls[0], ["python", "-I", "-S", "w.py", "locate", "C:/h/.claude-alt", ID]);
  const transcript = `C:/h/.claude-alt/projects/x/${ID}.jsonl`;
  assert.equal(chat.wakesTranscript([String.raw`c:\h\.claude-alt\projects\x\ `.trim() + `${ID}.jsonl`], transcript), true);
  assert.equal(chat.wakesSession([String.raw`C:\h\.claude-alt\sessions\900.json`], { dir: "C:/h/.claude-alt", pid: 900 }), true);
});

test("the readers run python on Windows and python3 on the Mac", async () => {
  const { exec, calls } = shell({ python: { code: 0, stdout: "{}" } });
  await chat.tail({ exec, python: "python" }, "t.py", "p.jsonl", "--last", 5);
  await chat.tail({ exec }, "t.py", "p.jsonl");
  await longestRanges({ exec, python: "python" }, "l.py", "p", "2026-11-01");
  assert.deepEqual(calls.map((c) => c[0]), ["python", "python3", "python"]);
});

test("Windows images go through win.py: a folder, the clipboard, a copy and a delete", async () => {
  const { exec, calls } = shell({ clipboard: { code: 0, stdout: "ok\r\n" } });
  assert.equal(await clipboardImage(exec, HOME, "1-a", "", "w.py"), `${HOME}/chat-images/1-a.png`);
  assert.deepEqual(calls, [
    ["python", "-I", "-S", "w.py", "mkdir", `${HOME}/chat-images`],
    ["python", "-I", "-S", "w.py", "clipboard", `${HOME}/chat-images/1-a.png`],
  ]);
  assert.equal(await clipboardImage(shell({ clipboard: { code: 0, stdout: "none" } }).exec, HOME, "1", "", "w.py"), null);

  const dropped = shell();
  assert.equal(await droppedImage(dropped.exec, HOME, String.raw`C:\Shots\My Shot.PNG`, "2", "w.py"), `${HOME}/chat-images/2.png`);
  assert.deepEqual(dropped.calls[1].slice(4), ["copy", String.raw`C:\Shots\My Shot.PNG`, `${HOME}/chat-images/2.png`]);
  assert.equal(await droppedImage(shell({ copy: { code: 1 } }).exec, HOME, "C:/a/b.png", "3", "w.py"), "C:/a/b.png");

  const gone = shell();
  await forgetImage(gone.exec, HOME, `${HOME}/chat-images/2.png`, "w.py");
  await forgetImage(gone.exec, HOME, "C:/Users/me/Desktop/shot.png", "w.py");
  assert.deepEqual(gone.calls, [["python", "-I", "-S", "w.py", "remove", `${HOME}/chat-images/2.png`]]);
});

test("the headless start goes through win.py on Windows, with the message as one argument", async () => {
  let call;
  await runHeadless(async (cmd, args, opts) => { call = { cmd, args, opts }; return { code: 0, stdout: "" }; }, "D:/x", `/usage "$(no)"`, true, { win: "w.py" });
  assert.equal(call.cmd, "python");
  assert.deepEqual(call.args.slice(0, 4), ["-I", "-S", "w.py", "headless"]);
  assert.equal(JSON.parse(call.args[4]).message.content, `/usage "$(no)"`);
  assert.deepEqual(call.args.slice(5), HEADLESS);
  assert.deepEqual(call.opts, { cwd: "D:/x" });
});

test("trust is found for a Windows folder, which .claude.json keys with forward slashes", () => {
  const json = JSON.stringify({ projects: { "D:/src/x": { hasTrustDialogAccepted: true } } });
  assert.equal(folderTrusted(json, String.raw`D:\src\x`), true);
  assert.equal(folderTrusted(json, String.raw`D:\src\y`), false);
  assert.equal(folderTrusted(JSON.stringify({ projects: { "/w/x": { hasTrustDialogAccepted: true } } }), "/w/x"), true);
});

// win.py itself. Its file commands use only the standard library, so they run anywhere; `session` needs Windows.
const win = (...args) => execFileSync(PYTHON, ["-I", "-S", WIN, ...args.map(String)], { encoding: "utf8" });

test("win.py makes a folder, copies into it, deletes, and finds a transcript by id", () => {
  const root = mkdtempSync(join(tmpdir(), "win-py-"));
  win("mkdir", join(root, "a", "b"));
  writeFileSync(join(root, "src.png"), "x");
  win("copy", join(root, "src.png"), join(root, "a", "b", "c.png"));
  assert.equal(readFileSync(join(root, "a", "b", "c.png"), "utf8"), "x");
  win("remove", join(root, "a", "b", "c.png"));
  win("remove", join(root, "a", "b", "c.png"));
  assert.equal(existsSync(join(root, "a", "b", "c.png")), false);
  mkdirSync(join(root, "projects", "D--x"), { recursive: true });
  writeFileSync(join(root, "projects", "D--x", `${ID}.jsonl`), "");
  assert.equal(win("locate", root, ID).trim(), join(root, "projects", "D--x", `${ID}.jsonl`).replace(/\\/g, "/"));
  assert.equal(win("locate", root, "nope").trim(), "");
});

test("win.py finds the session of a process under the given one, and the newest of two", { skip: process.platform !== "win32" }, () => {
  const a = mkdtempSync(join(tmpdir(), "win-a-")), b = mkdtempSync(join(tmpdir(), "win-b-"));
  for (const d of [a, b]) mkdirSync(join(d, "sessions"));
  // This node is a child of the process that started it, so asking from the parent has to look one level down.
  writeFileSync(join(a, "sessions", `${process.pid}.json`), JSON.stringify({ sessionId: ID, updatedAt: 1 }));
  writeFileSync(join(b, "sessions", `${process.pid}.json`), JSON.stringify({ sessionId: ID, updatedAt: 2 }));
  const found = JSON.parse(win("session", process.ppid, a, b));
  assert.equal(found.dir, b);
  assert.equal(JSON.parse(found.text).updatedAt, 2);
  assert.equal(win("session", process.ppid, join(a, "none")).trim(), "null");
});

test("on Windows a terminal counts as Claude Code by its reported status, since its foreground process is the shell", async () => {
  const { runsClaude } = await import("../../mods/claude-chat/draft.js");
  const { sessionNow } = await import("../../mods/claude-chat/send.js");
  const shellUnder = { state: "live", cols: 120, foreground: { name: "pwsh.exe" }, status: { app: "claude-code", state: "idle" } };
  assert.equal(runsClaude(shellUnder, true), true);
  assert.equal(runsClaude(shellUnder, false), false);
  assert.equal(runsClaude({ foreground: { name: "pwsh.exe" } }, true), false);
  assert.equal(runsClaude({ foreground: { name: "claude" } }), true);
  const io = (windows) => ({ windows, hc: async () => ({ code: 0, stdout: JSON.stringify(shellUnder) }) });
  assert.deepEqual(await sessionNow(io(true), "t3"), { live: true, state: "idle", cols: 120 });
  assert.deepEqual(await sessionNow(io(false), "t3"), { live: false });
});

test("a changed transcript is known by its name when its full path comes back in another form", () => {
  const transcript = `C:/h/.claude-alt/projects/x/${ID}.jsonl`;
  assert.equal(chat.wakesTranscript([`D:/elsewhere/${ID}.jsonl`], transcript), true);
  assert.equal(chat.wakesTranscript(["C:/h/.claude-alt/projects/x/other.jsonl"], transcript), false);
  assert.equal(chat.wakesTranscript([`C:/x/${ID}.jsonl`], null), false);
});
