import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Every word on a panel is a name, a value or an action. These are the taglines, hints and explanations the design pass
// took out, so none of them comes back. A screen that seems to need one gets a better layout instead.
export const GONE = [
  // Herd
  "Nothing else running yet", "Open a Claude Code session to see", "Reading this session", "Finished agents",
  "more, older", "of ${model.total} done", "\"Thinking\"], [\"read\"",
  // Orchi
  "These win over what the plan says", "How should ${title} run?", "How should this run handle PRs",
  "Anything this run should know", "Nothing is waiting for you", "No plans are ready",
  "There are no orchestrators running currently", "Nothing reported yet", "Orchestrator on ",
  "Mark complete writes the run's DONE", "Worktrees and branches stay", "so it can only be copied",
  "That terminal isn't in the app", "from stopped sessions not shown", "Usage holds last until the limit resets",
  "Queued in legwork", "Running in terminal Herdr", "Or type a reply", "Details, a response or feedback",
  "Choose a project", "Create a new plan", "Planning terminal ›", "Paste it once the switchboard is up",
  "so it can't be shown from here", "so nothing was pasted",
  // Orchestrator progress and the plan
  "No workers yet", "A time left shows once", "Times left are estimates", "Waiting for this orchestrator's session",
  "Left, estimate", "Close it and open it again", "This project has no plan to show",
  // Tickets
  "Press to open it", "How should this session handle PRs", "No tickets match", "No open tickets",
  // Spaces
  "New space there",
  // Chat
  "Reply to Claude, or type / for commands", "The terminal has everything", "The terminal has all of it",
  "This exits Claude Code in its terminal", "Anything typed opens the terminal", "These open the terminal",
  "Send these answers?", "Press a number, or", "Where you'll land at this rate", "longer than listening to",
  "hasn't written stats-cache.json yet", "Refresh to try again", "What's contributing comes from starting",
  "Nothing was sent, because", "With no tool running, it goes in", "Couldn't tell the queued messages apart",
  "Swap to it and back", "Pick one here", "\"Fill in\"",
];

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return files(path);
    return /\.(js|py)$/.test(path) ? [path] : [];
  });
}

const scanned = files(join(ROOT, "mods")).map((p) => [relative(ROOT, p), readFileSync(p, "utf8")]);

test("the mods are scanned", () => {
  assert.ok(scanned.length > 50);
});

test("no panel carries a tagline, hint or explanation", () => {
  const found = scanned.flatMap(([path, text]) => GONE.filter((g) => text.includes(g)).map((g) => `${path}: ${g}`));
  assert.deepEqual(found, []);
});
