// scripts/install.sh against a throwaway HOME, with a stand-in herdr-app on PATH, so no real window or home is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repo, "scripts", "install.sh");

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "sa-install-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "herdr-app"), '#!/bin/sh\n[ "$1" = status ] && echo \'"errors": []\'\nexit 0\n');
  chmodSync(join(bin, "herdr-app"), 0o755);
  return { home, bin };
}

function install({ home, bin }, appHome, args = [], env = {}) {
  const r = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`, HOME: home, ...(appHome ? { HERDR_APP_HOME: appHome } : {}), ...env },
  });
  return r;
}

const json = (p) => JSON.parse(readFileSync(p, "utf8"));

test("a fresh private home with no keys.json or settings.json installs, and the real launcher is left alone", () => {
  const box = sandbox();
  const app = join(box.home, "hd", "x");
  const r = install(box, app);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(join(app, "settings.json")).sounds.enabled, true);
  assert.equal(json(join(app, "keys.json")).global["cmd-shift-u"], "space-agents.oldest-blocked");
  assert.equal(existsSync(join(box.home, ".local", "libexec", "orchi-app", "herdr")), false);
});

test("the default home gets the launcher", () => {
  const box = sandbox();
  const r = install(box, null);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(box.home, ".local", "libexec", "orchi-app", "herdr")));
});

test("settings only gain missing keys, at any depth: a mute and a picked sound stay", () => {
  const box = sandbox();
  const app = join(box.home, "app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "settings.json"), JSON.stringify({ font: "Mine", sounds: { enabled: false, done: "mine.mp3" }, zoom: 1.2 }));
  const r = install(box, app);
  assert.equal(r.status, 0, r.stderr);
  const s = json(join(app, "settings.json"));
  assert.equal(s.font, "Mine");
  assert.equal(s.zoom, 1.2);
  assert.deepEqual(s.sounds, { enabled: false, done: "mine.mp3", blocked: "sounds/needs-you.mp3" });
  assert.equal(s.ui_font, "Geist");
});

test("an installed mod file the repo lacks stops the install and is named, and --force goes on", () => {
  const box = sandbox();
  const app = join(box.home, "app");
  assert.equal(install(box, app).status, 0);
  writeFileSync(join(app, "mods", "panel-buttons", "stray.svg"), "<svg/>");
  writeFileSync(join(app, "mods", "panel-buttons", "main.js.error"), "kept by the app");
  const r = install(box, app);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /mods\/panel-buttons\/stray\.svg/);
  assert.doesNotMatch(r.stderr, /main\.js\.error/);
  assert.ok(existsSync(join(app, "mods", "panel-buttons", "stray.svg")), "nothing copied before stopping");
  const forced = install(box, app, ["--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(existsSync(join(app, "mods", "panel-buttons", "stray.svg")), false);
});

test("an installed layout that holds a mod the repo's lacks stops the install", () => {
  const box = sandbox();
  const app = join(box.home, "app");
  assert.equal(install(box, app).status, 0);
  const layout = json(join(repo, "layouts", "main-linear.json"));
  layout.children.push({ id: "browser", type: "block", content: { mod: "browser-pane" } });
  writeFileSync(join(app, "layouts", "main-linear.json"), JSON.stringify(layout));
  const r = install(box, app);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /drop the mod browser-pane/);
  assert.equal(install(box, app, [], { HERDR_INSTALL_FORCE: "1" }).status, 0);
});

test("a re-install from the same tree changes nothing it would lose", () => {
  const box = sandbox();
  const app = join(box.home, "app");
  assert.equal(install(box, app).status, 0);
  cpSync(join(app, "settings.json"), join(box.home, "before.json"));
  const r = install(box, app);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(json(join(app, "settings.json")), json(join(box.home, "before.json")));
});
