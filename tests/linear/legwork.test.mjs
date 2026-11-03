import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RANGE, linkedIds, parseProjects, findProject, linearProjectOf, projectFolder, filterProjects } from "../../mods/linear/legwork.js";

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
@@projects/replay.md
---
name: Replay
category: personal
repo: E:/dev/replay
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

test("findProject prefers the linear line, then the identifier map", () => {
  const projects = parseProjects(tracker);
  const file = (issue, map) => findProject(projects, issue, map)?.file ?? null;
  assert.equal(file({ identifier: "ENG-84", project: "Birch tools" }), "atlas");
  assert.equal(file({ identifier: "ENG-8", projectIdentifier: "P-ENG-1027" }), "birch");
  assert.equal(file({ identifier: "ENG-1", projectIdentifier: "P-ENG-997" }, { "P-ENG-997": "atlas" }), "atlas");
  assert.equal(file({ identifier: "ENG-1", projectIdentifier: "P-ENG-999" }, { "P-ENG-997": "atlas" }), null);
  assert.equal(file({ identifier: "ENG-1", projectIdentifier: null }, { "P-ENG-997": "atlas" }), null);
});

test("a Linear project name never picks a project", () => {
  const projects = parseProjects(tracker);
  assert.equal(findProject(projects, { identifier: "ENG-1", project: "Replay" }), null);
  assert.equal(findProject(projects, { identifier: "ENG-1", project: "Atlas app" }, { "Atlas app": "atlas" }), null);
});

test("a pick beats every link, and an empty pick means no project", () => {
  const projects = parseProjects(tracker);
  const issue = { identifier: "ENG-84", projectIdentifier: "P-ENG-1027" };
  assert.equal(findProject(projects, issue, {}, { "ENG-84": "birch" }).file, "birch");
  assert.equal(findProject(projects, issue, {}, { "ENG-84": "" }), null);
  assert.equal(findProject(projects, issue, {}, { "ENG-1": "birch" }).file, "atlas");
});

test("linearProjectOf reads the linear line, then the map", () => {
  const [atlas, intake] = parseProjects(tracker);
  assert.equal(linearProjectOf(intake), "P-ENG-1027");
  assert.equal(linearProjectOf(atlas, { "P-ENG-997": "atlas" }), "P-ENG-997");
  assert.equal(linearProjectOf(atlas), null);
});

test("an id is matched whole, so ENG-8 is not ENG-83", () => {
  assert.equal(findProject(parseProjects(tracker), { identifier: "ENG-8", project: null }), null);
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
