// A ticket's project: the legwork project it belongs to, whatever its source. Go needs one, and its category is the
// ticket's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProjects, projectOf, githubRepo, remotesToRead } from "../../mods/tickets/legwork.js";

const tracker = `@@projects/birch.md
---
name: Birch
category: work
status: queued
updated: 2026-10-31
repo: ~/dev/birch
linear: ENG-12, ENG-20 to ENG-22
@@projects/cedar.md
---
name: Cedar
category: personal
status: running
repo: /src/cedar
@@projects/_template.md
---
name: Template
`;

const projects = parseProjects(tracker);
const t = (ref, source, id) => ({ ref, source, id });
const ctx = (over = {}) => ({ picks: {}, remotes: new Map([["/h/dev/birch", "acme/app"]]), home: "/h", ...over });

test("every project is read, whatever its category, with its status and date; a file starting _ is not a project", () => {
  assert.deepEqual(projects.map((p) => [p.file, p.category, p.status, p.updated]), [["birch", "work", "queued", "2026-10-31"], ["cedar", "personal", "running", null]]);
});

test("a legwork ticket's project is itself", () => {
  assert.equal(projectOf(t("legwork:cedar", "legwork", "cedar"), projects, ctx())?.file, "cedar");
  assert.equal(projectOf(t("legwork:gone", "legwork", "gone"), projects, ctx()), null);
});

test("a Linear ticket's project is the one whose linear: line names it", () => {
  assert.equal(projectOf(t("linear:ENG-21", "linear", "ENG-21"), projects, ctx())?.file, "birch");
  assert.equal(projectOf(t("linear:ENG-99", "linear", "ENG-99"), projects, ctx()), null);
});

test("a GitHub ticket's project is the one whose repo's origin is that repo", () => {
  assert.equal(projectOf(t("gh:acme/app#7", "github", "acme/app#7"), projects, ctx())?.file, "birch");
  assert.equal(projectOf(t("gh:acme/other#7", "github", "acme/other#7"), projects, ctx()), null);
});

test("a Markdown ticket's project is the one whose repo holds the file", () => {
  assert.equal(projectOf(t("md:/src/cedar/TODO.md#ship", "markdown", "/src/cedar/TODO.md#ship"), projects, ctx())?.file, "cedar");
  assert.equal(projectOf(t("md:~/dev/birch/notes/a.md#x", "markdown", "~/dev/birch/notes/a.md#x"), projects, ctx())?.file, "birch");
  assert.equal(projectOf(t("md:/src/cedar-old/TODO.md#ship", "markdown", "/src/cedar-old/TODO.md#ship"), projects, ctx()), null);
});

test("your pick beats every link, and picking none means none", () => {
  const login = t("linear:ENG-12", "linear", "ENG-12");
  assert.equal(projectOf(login, projects, ctx({ picks: { "linear:ENG-12": "cedar" } }))?.file, "cedar");
  assert.equal(projectOf(login, projects, ctx({ picks: { "linear:ENG-12": "" } })), null);
});

test("githubRepo reads owner/repo from a GitHub remote, in lower case, and nothing else", () => {
  assert.equal(githubRepo("git@github.com:Acme/App.git\n"), "acme/app");
  assert.equal(githubRepo("https://github.com/acme/app"), "acme/app");
  assert.equal(githubRepo("https://gitlab.com/acme/app"), null);
});

test("a tracker with no projects folder, or no project files, reads as no projects, so the tickets still list", async () => {
  const { TRACKER } = await import("../../mods/tickets/legwork.js");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/tracker-`);
  const read = (folder) => execFileSync("sh", ["-c", TRACKER, "sh", folder], { encoding: "utf8" });
  assert.equal(read(`${dir}/missing`), "");
  mkdirSync(`${dir}/projects`);
  assert.equal(read(dir), "");
  writeFileSync(`${dir}/projects/birch.md`, "---\nname: Birch\ncategory: work\n---\n");
  assert.deepEqual(parseProjects(read(dir)).map((p) => [p.file, p.category]), [["birch", "work"]]);
});

test("a repo's origin is known by its folder, so a project whose repo moves is read again, and a failed read is tried again", () => {
  const remotes = new Map([["/h/dev/birch", "acme/app"]]);
  const moved = projects.map((p) => (p.file === "birch" ? { ...p, repo: "/src/birch" } : p));
  assert.equal(projectOf(t("gh:acme/app#7", "github", "acme/app#7"), moved, ctx({ remotes })), null);
  assert.deepEqual(remotesToRead(moved, remotes, "/h"), ["/src/birch", "/src/cedar"]);
  assert.deepEqual(remotesToRead(projects, remotes, "/h"), ["/src/cedar"]);
});

test("githubRepo reads a GitHub origin through an SSH host alias or with a user in the url", () => {
  assert.equal(githubRepo("git@github-personal:Acme/App.git"), "acme/app");
  assert.equal(githubRepo("ssh://git@github-work/acme/app.git"), "acme/app");
  assert.equal(githubRepo("https://me@github.com/acme/app.git"), "acme/app");
  assert.equal(githubRepo("git@gitlab.com:acme/app.git"), null);
});

test("a quoted or capitalised field reads as its plain value, as the Python reader does", () => {
  const [p] = parseProjects('@@projects/atlas.md\n---\nname: "Atlas"\ncategory: "Work"\nrepo: \'~/dev/atlas/\'\n');
  assert.deepEqual([p.name, p.category, p.repo], ["Atlas", "work", "~/dev/atlas/"]);
});

test("a repo folder written with a trailing slash is the same folder", async () => {
  const { projectFolder } = await import("../../mods/tickets/legwork.js");
  assert.equal(projectFolder({ repo: "~/dev/atlas/" }, "/h"), "/h/dev/atlas");
  assert.equal(projectFolder({ repo: "/src/atlas//" }, "/h"), "/src/atlas");
});
