import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSettings, readSettings, settingsFile, claudeDir, orchiDir, legworkDir, switchboardDir, configDirs } from "../../mods/orchi/settings.js";

const COPIES = ["claude-chat", "herd", "orch-pane", "linear", "orchi"];

test("every mod's copy of settings.js is the same file", () => {
  const read = (m) => readFileSync(new URL(`../../mods/${m}/settings.js`, import.meta.url), "utf8");
  for (const m of COPIES) assert.equal(read(m), read("orchi"), m);
});

test("a missing, broken or non-object file reads as no settings", () => {
  for (const text of [null, "", "{", "[]", "3", "null", "\"x\""]) assert.deepEqual(parseSettings(text), {});
  assert.deepEqual(parseSettings('{"claude_dir":"~/c"}'), { claude_dir: "~/c" });
});

test("readSettings reads the file under the home, and a read error is no settings", async () => {
  const seen = [];
  const s = await readSettings(async (p) => { seen.push(p); return '{"orchi_dir":"/o"}'; }, "/h");
  assert.deepEqual(seen, ["/h/.config/orchi/settings.json"]);
  assert.equal(settingsFile("/h"), "/h/.config/orchi/settings.json");
  assert.deepEqual(s, { orchi_dir: "/o" });
  assert.deepEqual(await readSettings(async () => { throw new Error("gone"); }, "/h"), {});
});

test("folders default, expand ~ and drop a trailing slash", () => {
  assert.equal(claudeDir({}, "/h"), "/h/.claude");
  assert.equal(claudeDir(undefined, "/h"), "/h/.claude");
  assert.equal(claudeDir({ claude_dir: "~/.claude-alt/" }, "/h"), "/h/.claude-alt");
  assert.equal(claudeDir({ claude_dir: "  " }, "/h"), "/h/.claude");
  assert.equal(claudeDir({ claude_dir: 7 }, "/h"), "/h/.claude");
  assert.equal(claudeDir({ claude_dir: "~other/x" }, "/h"), "~other/x");
  assert.equal(orchiDir({}, "/h"), "/h/orchi-build");
  assert.equal(orchiDir({ orchi_dir: "/src/orchi" }, "/h"), "/src/orchi");
  assert.equal(legworkDir({}, "/h"), null);
  assert.equal(legworkDir({ legwork_dir: "~" }, "/h"), "/h");
  assert.equal(switchboardDir({ claude_dir: "/p" }, "/h"), "/p/switchboard");
});

test("configDirs lists the set profile first, then the default, once each", () => {
  assert.deepEqual(configDirs({}, "/h"), ["/h/.claude"]);
  assert.deepEqual(configDirs({ claude_dir: "/h/.claude-alt" }, "/h"), ["/h/.claude-alt", "/h/.claude"]);
  assert.deepEqual(configDirs({ claude_dir: "~/.claude" }, "/h"), ["/h/.claude"]);
});
