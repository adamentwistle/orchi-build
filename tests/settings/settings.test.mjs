import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import {
  resolveSettings, readSettings, settingsFile, oldFile, claudeDir, profileDir, orchiDir, legworkDir, switchboardDir, configDirs,
} from "../../mods/orchi/settings.js";

const COPIES = ["claude-chat", "herd", "orch-pane", "linear", "orchi"];
const root = new URL("../../", import.meta.url);
const { home: HOME, defaults, cases } = JSON.parse(readFileSync(new URL("tests/settings/fixtures.json", root), "utf8"));
const text = (v) => (v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v));
const texts = (files) => ({ settings: text(files.settings), orchi: text(files.orchi), linear: text(files.linear) });

test("every mod's copy of settings.js is the same file", () => {
  const read = (m) => readFileSync(new URL(`mods/${m}/settings.js`, root), "utf8");
  for (const m of COPIES) assert.equal(read(m), read("orchi"), m);
});

for (const c of cases) {
  test(`fixture: ${c.name}`, () => {
    const got = resolveSettings(texts(c.files), c.home ?? HOME);
    assert.deepStrictEqual(got, { ...defaults, ...c.expected });
    assert.ok(!JSON.stringify(got).includes("fixture-key"), "the API key came through");
  });
}

test("readSettings reads settings.json under the home and the old files under the app home", async () => {
  const seen = [];
  const files = {
    "/h/.config/orchi/settings.json": '{"orchi_dir":"/o"}',
    "/app/orchi.json": '{"workerLimit":9}',
    "/app/linear.json": '{"apiKey":"fixture-key-0000","teams":["eng"]}',
  };
  const s = await readSettings(async (p) => { seen.push(p); if (p in files) return files[p]; throw new Error("gone"); }, "/h", "/app");
  assert.deepEqual(seen.sort(), Object.keys(files).sort());
  assert.equal(s.orchi_dir, "/o");
  assert.equal(s.worker_limit, 9);
  assert.deepEqual(s.linear.teams, ["ENG"]);
  assert.ok(!JSON.stringify(s).includes("fixture-key"));
  assert.equal(settingsFile("/h"), "/h/.config/orchi/settings.json");
  assert.equal(oldFile("/app", "orchi"), "/app/orchi.json");
  assert.equal(oldFile("/app", "linear"), "/app/linear.json");
});

test("with no app home the old files are Herdr's own, under the home", async () => {
  const seen = [];
  await readSettings(async (p) => { seen.push(p); throw new Error("gone"); }, "/h");
  assert.deepEqual(seen.sort(), ["/h/.config/herdr-app/linear.json", "/h/.config/herdr-app/orchi.json", "/h/.config/orchi/settings.json"]);
});

test("a read that fails or gives nothing is no file", async () => {
  assert.deepStrictEqual(await readSettings(async () => { throw new Error("gone"); }, HOME, "/app"), defaults);
  assert.deepStrictEqual(await readSettings(async () => null, HOME, "/app"), defaults);
  assert.deepStrictEqual(await readSettings(async () => undefined, HOME, "/app"), defaults);
});

test("the folder helpers default, expand ~ and drop a trailing slash, on read settings or a raw object", () => {
  const read = resolveSettings({}, "/h");
  assert.equal(claudeDir(read, "/h"), "/h/.claude");
  assert.equal(claudeDir(undefined, "/h"), "/h/.claude");
  assert.equal(claudeDir({ claude_dir: "~/.claude-alt/" }, "/h"), "/h/.claude-alt");
  assert.equal(claudeDir({ claude_dir: "  " }, "/h"), "/h/.claude");
  assert.equal(orchiDir(read, "/h"), "/h/orchi-build");
  assert.equal(orchiDir({ orchi_dir: "/src/orchi" }, "/h"), "/src/orchi");
  assert.equal(legworkDir(read, "/h"), null);
  assert.equal(legworkDir({ legwork_dir: "~" }, "/h"), "/h");
  assert.equal(switchboardDir({ claude_dir: "/p" }, "/h"), "/p/switchboard");
  assert.equal(switchboardDir(read, "/h"), "/h/.claude/switchboard");
});

test("profileDir is the profile only when the settings set one, for sessions the panels start", () => {
  assert.equal(profileDir(resolveSettings({}, "/h"), "/h"), null);
  assert.equal(profileDir(undefined, "/h"), null);
  assert.equal(profileDir(resolveSettings({ settings: '{"claude_dir":"~/.claude-alt"}' }, "/h"), "/h"), "/h/.claude-alt");
});

test("configDirs lists the set profile first, then the default, once each", () => {
  assert.deepEqual(configDirs({}, "/h"), ["/h/.claude"]);
  assert.deepEqual(configDirs({ claude_dir: "/h/.claude-alt" }, "/h"), ["/h/.claude-alt", "/h/.claude"]);
  assert.deepEqual(configDirs({ claude_dir: "~/.claude" }, "/h"), ["/h/.claude"]);
});

// The old Herdr-side files are read only by the readers until setup moves them. The Linear panel still reads the API
// key out of linear.json itself, in mods/linear/linear.js, because the key never passes through settings.
const READERS = new Set(["bin/orchi_settings.py", "src/orchi/settings.py", "mods/linear/linear.js", ...COPIES.map((m) => `mods/${m}/settings.js`)]);
const OLD = /(?<![\w./-])(orchi|linear)\.json|herdr-app\/(orchi|linear)\.json|appHome\(\)\}\/(orchi|linear)\.json/;

function* files(dir) {
  for (const name of readdirSync(new URL(dir, root))) {
    const path = `${dir}/${name}`;
    if (name === "tests" || name === "node_modules" || name.startsWith(".")) continue;
    if (statSync(new URL(path, root)).isDirectory()) yield* files(path);
    else if (/\.(m?js|py|sh)$/.test(name) || !name.includes(".")) yield path;
  }
}

test("no mod or script reads orchi.json or linear.json except through the reader", () => {
  const found = [];
  for (const dir of ["mods", "bin", "scripts", "browser", "src"]) {
    for (const path of files(dir)) {
      if (READERS.has(path)) continue;
      readFileSync(new URL(path, root), "utf8").split("\n").forEach((line, i) => { if (OLD.test(line)) found.push(`${path}:${i + 1}: ${line.trim()}`); });
    }
  }
  assert.deepEqual(found, []);
});
