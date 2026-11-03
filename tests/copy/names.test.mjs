import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Orchi ships to anyone, so the skills, commands and mods read as written for whoever installs it. The user is "you"
// where a text speaks to them and "the user" where it speaks about them, and a path, owner or team comes from Orchi's
// settings by its name, such as `<legwork_dir>`. This list holds only generic patterns.
export const DENY = [
  ["the author's first name", /\bAdam\b/],
  ["a named Claude profile folder in a home", /~\/\.claude-[a-z]/],
  ["a projects folder in someone's home", /~\/Projects\//],
  ["someone's home folder", /\/Users\/(?!me\b)[A-Za-z]/],
  ["a team key written as a constant", /\b(?:[A-Z_]*TEAM[A-Z_]*|team(?:Key|_key|s)?)["']?\s*[:=]\s*\[?\s*["'`][A-Z][A-Z0-9]{1,9}["'`]/],
  ["an owner list for a review bot", /bugbot[\s._-]*owners/i],
];

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TEXT = /\.(md|js|mjs|json|py|sh|css|html|svg|txt|ya?ml|ts)$|\/[^./]+$/;
// Bundled separately, and made generic in its own pass. It comes off this list once it is clean.
const NOT_YET = ["skills/pr-drafter"];

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : files(path);
    return TEXT.test(path) ? [path] : [];
  });
}

export function hits(text) {
  return text.split("\n").flatMap((line, i) => DENY.filter(([, re]) => re.test(line)).map(([what]) => `${i + 1}: ${what}: ${line.trim()}`));
}

const scanned = ["skills", "commands", "mods"].flatMap((d) => files(join(ROOT, d)))
  .map((p) => relative(ROOT, p))
  .filter((p) => !NOT_YET.some((n) => p.startsWith(`${n}/`)));

test("the skills, commands and mods are all scanned", () => {
  for (const p of ["skills/switchboard/SKILL.md", "skills/herdr/SKILL.md", "commands/ship.md", "mods/orchi/main.js", "mods/space-agents/context.py"]) {
    assert.ok(scanned.includes(p), p);
  }
});

for (const p of scanned) {
  test(`${p} names no person, work team or work path`, () => {
    assert.deepEqual(hits(readFileSync(join(ROOT, p), "utf8")), []);
  });
}

test("each pattern catches a planted example", () => {
  const planted = [
    "Tell Adam in one line.",
    "CLAUDE_CONFIG_DIR=~/.claude-office claude",
    "the tracker in ~/Projects/legwork",
    "cd /Users/someone/orchi",
    'const TEAM = "ENG";',
    "github.bugbot_owners lists them",
  ];
  planted.forEach((line, i) => assert.equal(hits(line).length, 1, `${DENY[i][0]}: ${line}`));
});

test("a team key in JSON is caught too", () => {
  for (const line of ['"teams": ["ENG"]', '"teamKey": "ENG"']) assert.equal(hits(line).length, 1, line);
});

test("placeholders and the words around them pass", () => {
  for (const line of ["Tell the user in one line.", "with your home in place of `/Users/me`", "`<legwork_dir>/projects/<project>.md`",
    "the teams in `linear.teams`", "`Adamant` is not a name", "`ENG-12` is a ticket reference"]) {
    assert.deepEqual(hits(line), [], line);
  }
});

for (const n of NOT_YET) {
  test(`${n} is still on the not-yet list for a reason`, () => {
    const found = files(join(ROOT, n)).some((p) => hits(readFileSync(p, "utf8")).length);
    assert.ok(found, `${n} is clean now: take it off NOT_YET in tests/copy/names.test.mjs`);
  });
}
