import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repo, "scripts/install-browser.sh");
const tools = ["mkdir", "cp", "chmod", "rsync", "python3", "ln"];

const made = [];
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

const which =(name) => execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();

/** A home and a PATH of its own, so the script sees only the node and agent-browser a test wants. */
function setup({ nodeOutput, agentBrowser = true, claudeDirs = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-browser-install-"));
  made.push(root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const appHome = path.join(home, ".config/herdr-app");
  fs.mkdirSync(appHome, { recursive: true });
  fs.mkdirSync(bin);
  for (const name of tools) fs.symlinkSync(which(name), path.join(bin, name));
  if (nodeOutput !== undefined) fs.writeFileSync(path.join(bin, "node"), `#!/bin/sh\necho '${nodeOutput}'\n`, { mode: 0o755 });
  if (agentBrowser) fs.writeFileSync(path.join(bin, "agent-browser"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  for (const d of claudeDirs) fs.mkdirSync(path.join(home, d), { recursive: true });
  const run = (extra = {}) => {
    const env = { HOME: home, PATH: bin, R: repo, H: appHome, ...extra };
    const r = spawnSync("/bin/bash", [script], { env, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const programs = () => JSON.parse(fs.readFileSync(path.join(appHome, "programs.json"), "utf8")).programs;
  return { root, home, bin, appHome, run, programs, skill: (dir) => path.join(home, dir, "skills/herdr-browser/SKILL.md") };
}

test("no node on PATH warns and carries on, rather than dying half way", () => {
  const t = setup({});
  const r = t.run();
  assert.equal(r.code, 0);
  assert.match(r.err, /WARNING: skipped herdr-browser: node is not on PATH/);
  assert.ok(!fs.existsSync(path.join(t.home, ".local/bin/herdr-browser")));
  assert.match(r.err, /not in the \+ menu/);
});

test("no agent-browser warns too", () => {
  const t = setup({ nodeOutput: "22", agentBrowser: false });
  const r = t.run();
  assert.equal(r.code, 0);
  assert.match(r.err, /agent-browser is not on PATH/);
});

test("a node that is too old, or says something that isn't a number, is skipped with a reason", () => {
  for (const [output, reason] of [["20", /is version 20/], ["", /could not read the version/], ["v22.1.0 warning", /could not read the version/]]) {
    const t = setup({ nodeOutput: output });
    const r = t.run();
    assert.equal(r.code, 0, output);
    assert.match(r.err, reason);
    assert.ok(!fs.existsSync(path.join(t.home, ".local/bin/herdr-browser")), output);
  }
});

test("a good node installs the command with absolute paths, and Browser's menu entry holds the same path", () => {
  const t = setup({ nodeOutput: "22", claudeDirs: [".claude"] });
  const r = t.run();
  assert.equal(r.code, 0, r.err);
  const command = path.join(t.home, ".local/bin/herdr-browser");
  const wrapper = fs.readFileSync(command, "utf8");
  assert.ok(wrapper.includes(`exec "${path.join(t.bin, "node")}"`));
  assert.ok(wrapper.includes(`AGENT_BROWSER_BIN="${path.join(t.bin, "agent-browser")}"`));
  assert.deepEqual(t.programs()["herdr-browser"].run, [command, "pane"]);
});

/** Orchi's settings file in the test home, naming a profile folder. */
const settings = (t, claudeDir, file = path.join(t.home, ".config/orchi/settings.json")) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ claude_dir: claudeDir }));
  return file;
};

test("the skill goes to every Claude config dir that exists, and the output says where", () => {
  const t = setup({ nodeOutput: "22", claudeDirs: [".claude", ".claude-alt"] });
  settings(t, "~/.claude-alt");
  const r = t.run();
  assert.equal(r.code, 0, r.err);
  for (const d of [".claude", ".claude-alt"]) {
    assert.ok(fs.existsSync(t.skill(d)), d);
    assert.ok(r.out.includes(path.join(t.home, d, "skills/herdr-browser")), d);
  }
});

test("a profile folder is found only through the settings, which ORCHI_SETTINGS can move", () => {
  const t = setup({ nodeOutput: "22", claudeDirs: [".claude-alt"] });
  let r = t.run();
  assert.equal(r.code, 0, r.err);
  assert.ok(!fs.existsSync(t.skill(".claude-alt")));
  const file = settings(t, path.join(t.home, ".claude-alt"), path.join(t.root, "settings.json"));
  r = t.run({ ORCHI_SETTINGS: file });
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(t.skill(".claude-alt")));
});

test("a broken settings file is no settings", () => {
  const t = setup({ nodeOutput: "22", claudeDirs: [".claude"] });
  const file = path.join(t.home, ".config/orchi/settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const text of ["{", "[]", '{"claude_dir": 7}']) {
    fs.writeFileSync(file, text);
    const r = t.run();
    assert.equal(r.code, 0, r.err);
    assert.ok(fs.existsSync(t.skill(".claude")), text);
  }
});

test("CLAUDE_CONFIG_DIR is included, once, even when it is also one of the others", () => {
  const t = setup({ nodeOutput: "22", claudeDirs: [".claude-alt"] });
  settings(t, "~/.claude-alt");
  const custom = path.join(t.root, "elsewhere");
  fs.mkdirSync(custom);
  const r = t.run({ CLAUDE_CONFIG_DIR: custom });
  assert.ok(fs.existsSync(path.join(custom, "skills/herdr-browser/SKILL.md")));
  assert.ok(fs.existsSync(t.skill(".claude-alt")));
  assert.ok(!fs.existsSync(t.skill(".claude")));
  const again = t.run({ CLAUDE_CONFIG_DIR: path.join(t.home, ".claude-alt") });
  assert.equal(again.out.split("\n").filter((l) => l.includes(".claude-alt/skills")).length, 1);
  assert.equal(r.code, 0);
});

test("with no Claude config dir at all, the skill goes to ~/.claude and the output says so", () => {
  const t = setup({ nodeOutput: "22" });
  const r = t.run();
  assert.ok(fs.existsSync(t.skill(".claude")));
  assert.match(r.out, /no Claude config dir found/);
});

test("a private window gets no command or skill, and the menu entry only if the command is already there", () => {
  const t = setup({ nodeOutput: "22", claudeDirs: [".claude"] });
  let r = t.run({ HERDR_APP_HOME: t.appHome });
  assert.equal(r.code, 0);
  assert.ok(!fs.existsSync(t.skill(".claude")));
  assert.ok(!fs.existsSync(path.join(t.home, ".local/bin/herdr-browser")));
  assert.match(r.err, /not in the \+ menu/);
  fs.mkdirSync(path.join(t.home, ".local/bin"), { recursive: true });
  fs.writeFileSync(path.join(t.home, ".local/bin/herdr-browser"), "#!/bin/sh\n", { mode: 0o755 });
  r = t.run({ HERDR_APP_HOME: t.appHome });
  assert.deepEqual(t.programs()["herdr-browser"].run, [path.join(t.home, ".local/bin/herdr-browser"), "pane"]);
  assert.ok(!fs.existsSync(t.skill(".claude")));
});

test("the menu merge keeps other programs", () => {
  const t = setup({ nodeOutput: "22" });
  fs.writeFileSync(path.join(t.appHome, "programs.json"), JSON.stringify({ programs: { other: { name: "Other" } } }));
  t.run();
  assert.deepEqual(Object.keys(t.programs()).sort(), ["herdr-browser", "other"]);
});
