import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// What the design pass took out and a review found the user still needs, said as a value or an action. These views load
// gpui, which node can't, so the tests read their source.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");

test("Orchi's Decisions card counts the decisions it hides from stopped sessions", () => {
  assert.match(read("mods/orchi/view.js"), /`\+\$\{hidden\} from stopped sessions`/);
});

test("Mark complete's confirm button says what it does", () => {
  assert.match(read("mods/orchi/view.js"), /`complete-yes-\$\{o\.name\}`, "Mark done and close open items"/);
});

test("a /model line the model control won't take says it wasn't sent", () => {
  assert.match(read("mods/claude-chat/commands.js"), /const PICKER_NOTE = "Not sent\. Use the model control";/);
});

test("a filter that matches nothing says so, apart from a source with no tickets", () => {
  assert.match(read("mods/tickets/main.js"), /return this\.tickets\.length \? "No matches" : "No tickets";/);
});

test("the planner skill and the docs name the buttons and labels the panels show", () => {
  const skill = read("skills/ticket-session/SKILL.md"), herd = read("docs/herd-pane.md");
  assert.doesNotMatch(skill, /Read the plan|Start orchestrators/);
  assert.match(skill, /Open plan/);
  assert.doesNotMatch(read("docs/setup.md"), /Wait for me/);
  assert.doesNotMatch(read("docs/orch-pane.md"), /\| Latest update \|/);
  assert.doesNotMatch(herd, /key sits under the map|in the key|Finished agents/);
});

test("a discuss line Orchi could only copy says it wasn't sent", () => {
  assert.match(read("mods/orchi/main.js"), /await copyText\(exec, line\);\n\s*this\.note = "Copied, not sent";/);
});

test("a project card counts its ticked tickets, so a closed card still shows them", () => {
  assert.match(read("mods/tickets/queue-view.js"), /right: ticked \? `\$\{ticked\} ticked` : null/);
});

test("a command that can't be put in its terminal shows the button off, not gone", () => {
  assert.match(read("mods/orchi/view.js"), /outline\(`paste-\$\{d\.id\}`, "Put in terminal", safe && here \?/);
});

test("Herd and orchestrator progress say they are still looking while they retry", () => {
  assert.match(read("mods/herd/main.js"), /"Session not found\. Retrying"/);
  assert.match(read("mods/orch-pane/main.js"), /"Orchestrator not found\. Retrying"/);
});

test("a card of several questions still offers the rows that need typing", () => {
  const src = read("mods/claude-chat/cards.js");
  assert.match(src, /\.child\(typingFoot\(id, t, dialog, on\)\);/);
  assert.doesNotMatch(src, /when\(!several, \(e\) => e\.child\(typingFoot/);
});

test("Put in terminal, when off, names why in its tooltip", () => {
  const src = read("mods/orchi/view.js");
  assert.match(src, /"Has a control character"/);
  assert.match(src, /"Terminal not in this app"/);
});

test("a chat still looking for its session shows a dot, not a blank pane", () => {
  assert.match(read("mods/claude-chat/main.js"), /this\.session && \(this\.loaded \|\| this\.absent\) \? v_flex\(\) : notice\(LOOKING, t\)/);
});

test("Orchi says where the switchboard is when it can't show it", () => {
  assert.match(read("mods/orchi/main.js"), /this\.note = "Switchboard is in terminal Herdr"/);
});
