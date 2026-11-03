import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRUNE_DAYS, clipboardImage, droppedImage, forgetImage, forgetImages, isImagePath, previewPath, pruneImages, splitDropped } from "../../mods/claude-chat/images.js";

const HOME = "/Users/me/.config/herdr-app";

function shell(reply = {}) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args]);
    return reply[command] ?? { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

test("the clipboard's image lands in the app's folder, its path an argument and never script text", async () => {
  const { exec, calls } = shell({ osascript: { code: 0, stdout: "ok\n" } });
  assert.equal(await clipboardImage(exec, HOME, "1-a"), `${HOME}/chat-images/1-a.png`);
  assert.deepEqual(calls[0], ["mkdir", "-p", "-m", "700", `${HOME}/chat-images`]);
  const [, , , , script, path, board] = calls[1];
  assert.equal(path, `${HOME}/chat-images/1-a.png`);
  assert.equal(board, "");
  assert.ok(!script.includes(HOME));
});

test("a clipboard with no image gives null", async () => {
  assert.equal(await clipboardImage(shell({ osascript: { code: 0, stdout: "none\n" } }).exec, HOME, "1"), null);
  assert.equal(await clipboardImage(shell({ osascript: { code: 1, stdout: "" } }).exec, HOME, "1"), null);
});

test("a test can name a private pasteboard", async () => {
  const { exec, calls } = shell({ osascript: { code: 0, stdout: "ok" } });
  await clipboardImage(exec, HOME, "1", "herdr-chat-test");
  assert.equal(calls[1].at(-1), "herdr-chat-test");
});

test("only the formats Claude Code takes count as images", () => {
  for (const path of ["/a/b.png", "/a/b.JPG", "/a/b.jpeg", "/a/b.gif", "/a/b.webp"]) assert.equal(isImagePath(path), true);
  for (const path of ["/a/b.txt", "/a/png", "/a/b.tiff", "", null, "/a\nb.png"]) assert.equal(isImagePath(path), false);
});

test("dropped files split into images and paths", () => {
  assert.deepEqual(splitDropped(["/a/b.png", "/a/c.txt", "/d.jpg"]), { images: ["/a/b.png", "/d.jpg"], others: ["/a/c.txt"] });
});

test("a dropped image is copied so it can be drawn", async () => {
  const { exec, calls } = shell();
  assert.equal(await droppedImage(exec, HOME, "/a/My Shot.PNG", "1-a"), `${HOME}/chat-images/1-a.png`);
  assert.deepEqual(calls[1], ["cp", "--", "/a/My Shot.PNG", `${HOME}/chat-images/1-a.png`]);
});

test("a dropped image that can't be copied goes by its own path", async () => {
  assert.equal(await droppedImage(shell({ cp: { code: 1 } }).exec, HOME, "/a/b.png", "1"), "/a/b.png");
});

test("a preview path is relative to the app's folder, and null outside it", () => {
  assert.equal(previewPath(HOME, `${HOME}/chat-images/1-a.png`), "chat-images/1-a.png");
  assert.equal(previewPath(HOME, "/a/b.png"), null);
  assert.equal(previewPath(HOME, `${HOME}/chat-images/../secret.png`), null);
});

test("a closing pane deletes the images it was holding, and only its own", async () => {
  const { exec, calls } = shell();
  await forgetImages(exec, HOME, [`${HOME}/chat-images/1-a.png`, "/Users/me/Desktop/shot.png", `${HOME}/chat-images/2-b.jpg`]);
  assert.deepEqual(calls, [["rm", "-f", `${HOME}/chat-images/1-a.png`], ["rm", "-f", `${HOME}/chat-images/2-b.jpg`]]);
});

test("a chat starting up deletes only old files with this mod's names, one folder deep", async () => {
  const { exec, calls } = shell();
  assert.equal(await pruneImages(exec, HOME), true);
  assert.deepEqual(calls, [["find", `${HOME}/chat-images`, "-maxdepth", "1", "-type", "f", "-name", "[0-9]*-*.*", "-mmin", `+${PRUNE_DAYS * 1440}`, "-delete"]]);
  assert.equal(await pruneImages(shell().exec, ""), false);
  assert.equal(await pruneImages(shell().exec, "relative/home"), false);
  assert.equal(await pruneImages(async () => { throw new Error("no find"); }, HOME), false);
});

// The real `find`, on a folder made for this test.
test("pruning keeps new files and other names, and deletes old ones of ours", async () => {
  const home = mkdtempSync(join(tmpdir(), "chat-prune-"));
  const dir = join(home, "chat-images");
  mkdirSync(join(dir, "nested"), { recursive: true });
  const old = Date.now() / 1000 - (PRUNE_DAYS + 1) * 86400;
  const files = { oldOurs: "1700000000000-abc123.png", newOurs: "1800000000000-def456.png", oldOther: "notes.txt", oldNested: "nested/1700000000000-x.png" };
  for (const name of Object.values(files)) writeFileSync(join(dir, name), "x");
  for (const key of ["oldOurs", "oldOther", "oldNested"]) utimesSync(join(dir, files[key]), old, old);
  const run = (command, args) => new Promise((resolve) => execFile(command, args, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));
  assert.equal(await pruneImages(run, home), true);
  assert.deepEqual(Object.fromEntries(Object.entries(files).map(([key, name]) => [key, existsSync(join(dir, name))])), { oldOurs: false, newOurs: true, oldOther: true, oldNested: true });
});

test("only this pane's own files are ever deleted", async () => {
  const { exec, calls } = shell();
  await forgetImage(exec, HOME, `${HOME}/chat-images/1-a.png`);
  await forgetImage(exec, HOME, "/Users/me/Desktop/shot.png");
  await forgetImage(exec, HOME, `${HOME}/chat-images/../settings.json`);
  assert.deepEqual(calls, [["rm", "-f", `${HOME}/chat-images/1-a.png`]]);
});
