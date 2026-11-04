import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RANGE, linkedIds, parseProjects, projectOf, projectFolder, filterProjects } from "../../mods/tickets/legwork.js";

const tracker = `@@projects/atlas.md
---
name: Atlas
category: work
repo: ~/dev/atlas
linear: ENG-5, ENG-83 to ENG-85
@@projects/birch.md
---
name: Birch tools
category: work
repo: none
linear: P-ENG-1027
@@projects/notes.md
---
name: Notes
category: personal
repo: ~/dev/notes
`;

test("linkedIds reads lists, ranges and project ids", () => {
  assert.deepEqual([...linkedIds("ENG-9, ENG-83 to ENG-85, P-ENG-1027")], ["ENG-9", "ENG-83", "ENG-84", "ENG-85", "P-ENG-1027"]);
  assert.deepEqual([...linkedIds("")], []);
});

test("linkedIds leaves out a range that is too long, backwards or across prefixes", () => {
  assert.deepEqual([...linkedIds("ENG-1 to ENG-99999999, ENG-7")], ["ENG-7"]);
  assert.deepEqual([...linkedIds("ENG-90 to ENG-83")], []);
  assert.deepEqual([...linkedIds("ENG-1 to OPS-3")], []);
  assert.equal(linkedIds(`ENG-1 to ENG-${MAX_RANGE}`).size, MAX_RANGE);
  assert.equal(linkedIds(`ENG-1 to ENG-${MAX_RANGE + 1}`).size, 0);
});

test("parseProjects reads each block and treats repo none as no repo", () => {
  const [atlas, intake] = parseProjects(tracker);
  assert.equal(atlas.file, "atlas");
  assert.equal(atlas.path, "projects/atlas.md");
  assert.equal(atlas.repo, "~/dev/atlas");
  assert.equal(intake.name, "Birch tools");
  assert.equal(intake.repo, null);
});

const linear = (key, extra = {}) => ({ ref: `linear:${key}`, source: "linear", id: key, ...extra });

test("a Linear ticket's project is the one whose linear: line names it, ranges included", () => {
  const projects = parseProjects(tracker);
  assert.equal(projectOf(linear("ENG-84"), projects)?.file, "atlas");
  assert.equal(projectOf(linear("ENG-5"), projects)?.file, "atlas");
});

test("a Linear project's name never picks a project", () => {
  const projects = parseProjects(tracker);
  assert.equal(projectOf(linear("ENG-1", { project: "Notes" }), projects), null);
  assert.equal(projectOf(linear("ENG-1", { project: "Birch tools" }), projects), null);
});

test("a pick beats every link, and an empty pick means no project", () => {
  const projects = parseProjects(tracker), ticket = linear("ENG-84");
  assert.equal(projectOf(ticket, projects, { picks: { "linear:ENG-84": "birch" } }).file, "birch");
  assert.equal(projectOf(ticket, projects, { picks: { "linear:ENG-84": "" } }), null);
  assert.equal(projectOf(ticket, projects, { picks: { "linear:ENG-1": "birch" } }).file, "atlas");
});

test("an id is matched whole, so ENG-8 is not ENG-83", () => {
  assert.equal(projectOf(linear("ENG-8"), parseProjects(tracker)), null);
});

test("projectFolder expands the home folder", () => {
  const [atlas, intake] = parseProjects(tracker);
  assert.equal(projectFolder(atlas, "/home/me"), "/home/me/dev/atlas");
  assert.equal(projectFolder(intake, "/home/me"), null);
});

test("filterProjects matches name or file, ignoring case and spaces", () => {
  const projects = [{ name: "Cedar", file: "cedar" }, { name: "Birch", file: "birch" }];
  assert.deepEqual(filterProjects(projects, " ced ").map((p) => p.file), ["cedar"]);
  assert.deepEqual(filterProjects(projects, "BIR").map((p) => p.file), ["birch"]);
  assert.equal(filterProjects(projects, "").length, 2);
});

test("parseProjects reads blocked_on and the next prompt, and takes nothing from the prompt as a field", () => {
  const [atlas, other] = parseProjects(`@@projects/atlas.md
name: Atlas
repo: ~/dev/atlas
blocked_on: keys
@@prompt
Human action, not a Claude session.
repo: /etc
name: Evil
linear: ENG-1
@@endprompt
@@projects/other.md
name: Other
blocked_on: none
`);
  assert.equal(atlas.blocked_on, "keys");
  assert.equal(atlas.prompt, "Human action, not a Claude session.\nrepo: /etc\nname: Evil\nlinear: ENG-1");
  assert.equal(atlas.repo, "~/dev/atlas");
  assert.equal(atlas.name, "Atlas");
  assert.equal(atlas.ids.size, 0);
  assert.equal(other.blocked_on, null);
  assert.equal(other.prompt, "");
});
