import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DRAW_MS, HOLD_MS, READ_MS, checkPress, follow, idle, isCard, isFinal, parseDialog, pressed, stepKeys, terminalSteps } from "../../mods/claude-chat/dialog.js";

// Every .txt under fixtures is an `hc read` of Claude Code 2.1.316, with made-up paths, and reports.json holds the
// terminal's report at that moment. See docs/chat-pane.md, step 8.
const dir = new URL("./fixtures/", import.meta.url);
const reports = JSON.parse(readFileSync(new URL("reports.json", dir), "utf8"));
const screen = (name) => readFileSync(new URL(`${name}.txt`, dir), "utf8");
const read = (name, report = reports[name]) => parseDialog(screen(name), report);
const labels = (dialog) => dialog.options.map((o) => o.label);
const keys = (dialog) => dialog.options.map((o) => o.key);

test("every fixture has a report", () => {
  for (const name of Object.keys(reports)) assert.equal(typeof screen(name), "string");
  assert.ok(Object.keys(reports).length >= 20);
});

test("a Bash prompt at 120 columns gives the tool, the command joined back up, and every option in its own words", () => {
  const d = read("permission-bash-120");
  assert.equal(d.kind, "permission");
  assert.equal(d.tool, "Bash");
  assert.equal(d.title, "Do you want to proceed?");
  assert.equal(d.why, "Create empty file b1.txt in the scratchpad folder");
  assert.equal(d.bodyKind, "command");
  assert.match(d.body, /^touch \/private\/tmp\/\S+\/scratchpad\/scratchfiles\/b1\.txt$/);
  assert.deepEqual(keys(d), ["1", "2", "3", "4"]);
  assert.equal(d.options[0].label, "Yes");
  assert.match(d.options[1].label, /^Yes, and always allow access to \/private\/\S+\/scratchfiles from this project$/);
  assert.equal(d.options[2].label, "Yes, and switch to auto mode · auto mode handles these prompts for you");
  assert.equal(d.options[3].label, "No");
});

test("the first-press case at 101 columns reads the same as 120, including a path cut mid-word", () => {
  const d = read("permission-bash-101");
  assert.equal(d.kind, "permission");
  assert.match(d.body, /^touch \/private\/tmp\/\S+\/scratchfiles\/c1\.txt$/);
  assert.match(d.options[1].label, /^Yes, and always allow access to \/private\/\S+\/scratchfiles from this project$/);
  assert.equal(d.options.length, 4);
});

test("a split as narrow as 42 columns still reads, with a tip that wraps left out", () => {
  const d = read("permission-bash-42");
  assert.equal(d.kind, "permission");
  assert.equal(d.why, "Create empty file g2.txt in scratchfiles directory");
  assert.match(d.body, /^touch \/private\/\S+\/scratchfiles\/g2\.txt$/);
  assert.equal(d.options.length, 4);
});

test("a question's last line can wrap in a narrow split", () => {
  const text = screen("question-120").replace("to navigate · Esc to cancel", "to navigate · Esc to\ncancel");
  assert.equal(parseDialog(text, reports["question-120"]).kind, "question");
});

test("the same dialog keeps its key at another width", () => {
  const wide = read("several-step1-120"), narrow = read("several-step1-101");
  assert.equal(wide.question, narrow.question);
  const a = read("permission-bash-120"), b = parseDialog(screen("permission-bash-120").replaceAll("b1.txt", "c1.txt"), { ...reports["permission-bash-120"], msg: reports["permission-bash-120"].msg.replace("b1.txt", "c1.txt") });
  assert.notEqual(a.key, b.key);
});

test("a Write prompt gives the whole path from the report, and the file's text", () => {
  const d = read("permission-write-120");
  assert.equal(d.tool, "Write");
  assert.equal(d.title, "Do you want to create w1.txt?");
  assert.match(d.target, /^\/private\/tmp\/claude-501\/.*\/w1\.txt$/);
  assert.equal(d.bodyKind, "file");
  assert.match(d.body, /1 hello/);
  assert.deepEqual(keys(d), ["1", "2", "3"]);
  assert.match(d.options[1].label, /^Yes, and switch to accept edits .* for this session \(shift\+tab\)$/);
  assert.doesNotMatch(d.options[1].label, /\/private\S*\s+\S*scratchfiles/, "a wrapped path stays whole");
});

test("an Edit prompt gives the diff", () => {
  const d = read("permission-edit-120");
  assert.equal(d.tool, "Edit");
  assert.equal(d.title, "Do you want to make this edit to w1.txt?");
  assert.match(d.body, /1 -hello\n\s*1 \+goodbye/);
  assert.equal(labels(d)[2], "No");
});

test("dialog-shaped lines inside a command stay in the command, and the real options are the ones read", () => {
  const d = read("permission-fake-lines-120");
  assert.equal(d.kind, "permission");
  assert.match(d.body, /# Do you want to proceed\?\n# ❯ 1\. Yes\n#   2\. No\n#\n# Esc to cancel\ntouch /);
  assert.deepEqual(labels(d), ["Yes", "Yes, and don’t ask again for: touch *", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"]);
});

// A command of one line, 80 columns or less, has no box mark. See "Cards after the demos" in docs/chat-pane.md.
const SHORT = ["89", "101", "207"];

test("a one-line Bash prompt has no box mark and reads at every width", () => {
  for (const width of SHORT) {
    const d = read(`permission-short-${width}`);
    assert.equal(d.kind, "permission", width);
    assert.equal(d.tool, "Bash");
    assert.equal(d.body, "touch ~/.config/hd/c2/x/n2.txt");
    assert.equal(d.why, "Create empty file n2.txt at the given path");
    assert.equal(d.reason, null);
    assert.deepEqual(keys(d), ["1", "2", "3", "4"]);
    assert.equal(labels(d)[1], "Yes, and always allow access to /Users/me/.config/hd/c2/x from this project");
  }
  assert.equal(read("permission-short-89").key, read("permission-short-207").key);
});

test("the line This command requires approval is read, and kept for the card", () => {
  for (const width of SHORT) {
    const d = read(`permission-approval-${width}`);
    assert.equal(d.kind, "permission", width);
    assert.equal(d.body, 'python3 -c "print(6*7)"');
    assert.equal(d.reason, "This command requires approval");
    assert.equal(d.title, "Do you want to proceed?");
    assert.equal(labels(d)[1], "Yes, and don’t ask again for: python3 *");
  }
});

test("a reason in a box is read too, and belongs to the dialog's key", () => {
  const d = read("permission-glob-89");
  assert.equal(d.body, "touch /private/tmp/claude-501/*cards2/75c*/scratchpad/n3.txt");
  assert.equal(d.reason, "Glob patterns are not allowed in write operations. Please specify an exact file path.");
  assert.equal(read("permission-glob-42").reason, d.reason);
  const other = parseDialog(screen("permission-glob-89").replace("Glob patterns", "Something else"), reports["permission-glob-89"]);
  assert.notEqual(other.key, d.key);
});

test("a short command in a narrow split wraps with no mark, and joins back up", () => {
  assert.equal(read("permission-glob-42").body, "touch /private/tmp/claude-501/*cards2/75c*/scratchpad/n3.txt");
  assert.equal(read("permission-compound-89").body, 'python3 -c "print(1)" && python3 -c "print(2)"; python3 -c "print(3)"');
  assert.equal(read("permission-compound-42").body, read("permission-compound-89").body);
});

test("the one-line prompts seen live in a 42 column split read too", () => {
  const d = read("permission-approval-42");
  assert.equal(d.body, 'python3 -c "print(6*8)"');
  assert.equal(d.why, "Print 6 times 8 with python3");
  assert.equal(d.reason, "This command requires approval");
});

test("a command's printed output above a later prompt changes nothing", () => {
  assert.match(screen("permission-after-hostile-42"), /❯ 1\. Yes/);
  const d = read("permission-after-hostile-42");
  assert.equal(d.body, 'python3 -c "print(7*7)"');
  assert.equal(labels(d)[0], "Yes");
  assert.equal(labels(d)[3], "No");
});

test("a one-line command that imitates an option stays in the command, at every width", () => {
  for (const width of SHORT) {
    const d = read(`permission-hostile-${width}`);
    assert.equal(d.kind, "permission", width);
    assert.equal(d.body, `python3 -c "print('❯ 1. Yes')"`);
    assert.deepEqual(labels(d), ["Yes", "Yes, and don’t ask again for: python3 *", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"]);
  }
});

test("a command of several lines that imitates the whole dialog stays in the command, at every width", () => {
  for (const name of ["permission-hostile-lines-101", "permission-hostile-lines-207"]) {
    const d = read(name);
    assert.equal(d.kind, "permission", name);
    assert.match(d.body, /^python3 -c "print\('''\n─+\n Bash command\n Harmless\n╌+\n true\n╌+\n Do you want to proceed\?\n ❯ 1\. Yes\n   2\. No\n\n Esc to cancel · Tab to amend\n'''\)"$/);
    assert.equal(d.why, "Print the pasted dialog text with python3");
    assert.equal(d.reason, "This command requires approval");
    assert.deepEqual(keys(d), ["1", "2", "3", "4"]);
  }
});

test("the dialog's own question as a one-line command changes nothing", () => {
  const line = " Do you want to proceed?";
  const text = screen("permission-short-89").replace(" touch ~/.config/hd/c2/x/n2.txt\n╌", `${line}\n╌`);
  const d = parseDialog(text, { ...reports["permission-short-89"], msg: `approve Bash:${line}` });
  assert.equal(d.body, line.trim());
  assert.equal(labels(d)[3], "No");
});

test("a command with no mark has to match the report", () => {
  const report = reports["permission-short-89"], text = screen("permission-short-89");
  assert.deepEqual(parseDialog(text, { ...report, msg: "approve Bash: rm -rf /tmp/other" }), { kind: "terminal", reason: "unreadable" });
  assert.deepEqual(parseDialog(text, { ...report, msg: "permission prompt" }), { kind: "terminal", reason: "unreadable" });
});

test("a box with a line missing its mark isn't read", () => {
  const text = screen("permission-hostile-lines-101").replace(" │ '''", " '''");
  assert.deepEqual(parseDialog(text, reports["permission-hostile-lines-101"]), { kind: "terminal", reason: "unreadable" });
});

test("a reason has to be set off from the question by a blank line", () => {
  const text = screen("permission-approval-89").replace(" This command requires approval\n\n", " This command requires approval\n");
  assert.deepEqual(parseDialog(text, reports["permission-approval-89"]), { kind: "terminal", reason: "unreadable" });
});

test("a Write or Edit prompt with text under its box goes to the terminal, because none has been seen", () => {
  const text = screen("permission-write-120").replace(" Do you want to create", " A line nobody has seen\n\n Do you want to create");
  assert.deepEqual(parseDialog(text, reports["permission-write-120"]), { kind: "terminal", reason: "unreadable" });
});

test("a question with no rule above it isn't read", () => {
  const text = screen("permission-short-89").replace(/^╌+\n/gm, "");
  assert.deepEqual(parseDialog(text, reports["permission-short-89"]), { kind: "terminal", reason: "unreadable" });
});

test("a tall prompt with its top off the screen goes to the terminal, and reads whole with history", () => {
  const cut = read("permission-tall-screen-only-120x24");
  assert.deepEqual(cut, { kind: "terminal", reason: "cut off" });
  assert.equal(isFinal(cut), false);
  const whole = read("permission-tall-with-history-89");
  assert.equal(whole.kind, "permission");
  assert.match(whole.body, /^touch \S+e1\.txt\n# note line 1\n/);
  assert.match(whole.body, /# note line 45\ntouch \S+e2\.txt$/);
});

test("the line hc adds when its history runs out isn't part of the dialog", () => {
  assert.match(screen("permission-history-cut-89"), /\[hc\] incomplete: /);
  assert.equal(read("permission-history-cut-89").kind, "permission");
});

test("a question gives its text and options, with the two that need typing kept apart", () => {
  const d = read("question-120");
  assert.equal(d.kind, "question");
  assert.equal(d.tab, "Drink");
  assert.equal(d.question, "Tea or coffee?");
  assert.equal(d.tabs, null);
  assert.deepEqual(d.options.map((o) => [o.key, o.label, o.note]), [["1", "Tea", "Hot leaves"], ["2", "Coffee", "Roasted beans"], ["3", "Water", "Plain"]]);
  assert.deepEqual(d.typing, [{ key: "4", label: "Type something" }, { key: "5", label: "Chat about this" }]);
});

test("a long question at 101 columns joins back up, and the report says where a label ends", () => {
  const d = read("question-wrapped-101");
  assert.equal(d.kind, "question");
  assert.match(d.question, /^When the chat pane opens .* wrap on screen\?$/);
  assert.equal(d.options[0].label, "Keep the wrapped text and join it back together when reading the screen so nothing is lost");
  assert.equal(d.options[0].note, "This keeps the words exactly as Claude Code printed them, including anything that runs over the end of a line in a narrow terminal");
  assert.equal(d.options[1].note, "Short");
});

test("labels and a question with brackets in them still match the report", () => {
  const d = read("question-parens-89");
  assert.equal(d.question, "Soup or salad?");
  assert.deepEqual(d.options.map((o) => [o.label, o.note]), [["Soup (Hot)", "Hot soup"], ["Salad (Cold)", "Cold salad"]]);
  const text = screen("question-parens-89").replace(/^Soup or salad\?$/m, "Soup (or salad)?");
  const asked = parseDialog(text, { ...reports["question-parens-89"], msg: "answer: Soup (or salad)? (Soup (Hot) · Salad (Cold))" });
  assert.equal(asked.question, "Soup (or salad)?");
  assert.equal(asked.options[1].label, "Salad (Cold)");
});

test("a question that disagrees with the report goes to the terminal", () => {
  const report = { ...reports["question-120"], msg: "answer: Tea or coffee? (Tea · Coffee)" };
  assert.deepEqual(read("question-120", report), { kind: "terminal", reason: "unreadable" });
  const other = { ...reports["question-120"], msg: "answer: Something else? (Tea · Coffee · Water)" };
  assert.deepEqual(read("question-120", other), { kind: "terminal", reason: "unreadable" });
});

test("a Bash prompt that disagrees with the report goes to the terminal", () => {
  const report = { ...reports["permission-bash-120"], msg: "approve Bash: rm -rf /tmp/other" };
  assert.deepEqual(read("permission-bash-120", report), { kind: "terminal", reason: "unreadable" });
  assert.deepEqual(read("permission-bash-120", { kind: "permission", msg: "approve Write: /tmp/x" }), { kind: "terminal", reason: "unreadable" });
});

test("several questions read step by step, with a tab for each and the answered ones marked", () => {
  const one = read("several-step1-120");
  assert.equal(one.kind, "question");
  assert.deepEqual(one.tabs, [{ label: "Drink", answered: false }, { label: "Snack", answered: false }, { label: "Seat", answered: false }]);
  assert.equal(one.step, 0);
  assert.equal(one.question, "Which drink?");
  assert.deepEqual(labels(one), ["Tea", "Coffee"]);
  assert.deepEqual(one.typing.map((t) => t.key), ["3", "4"]);

  const two = read("several-step2-120");
  assert.equal(two.step, 1);
  assert.equal(two.question, "Which snack?");
  assert.deepEqual(labels(two), ["Toast", "Fruit", "Nuts"]);
  assert.deepEqual(two.options.map((o) => o.note), ["Warm bread", "Fresh", "Salty"]);
  assert.equal(two.tabs[0].answered, true);

  const three = read("several-step3-120");
  assert.equal(three.step, 2);
  assert.equal(three.question, "Where to sit?");
  for (const d of [one, two, three]) assert.notEqual(d.key, undefined);
  assert.notEqual(one.key, two.key);
});

test("several questions read at 101 columns too", () => {
  const d = read("several-step1-101");
  assert.equal(d.question, "Which drink?");
  assert.equal(d.tabs.length, 2);
});

test("going back to an answered step marks the answer given", () => {
  const d = read("several-answered-step-120");
  assert.equal(d.question, "Where to sit?");
  assert.deepEqual(d.options.map((o) => [o.label, o.chosen]), [["Window", true], ["Aisle", false]]);
  assert.equal(d.step, -1);
});

test("the Submit step gives the answers and its two options", () => {
  const d = read("several-review-120");
  assert.equal(d.kind, "review");
  assert.deepEqual(d.answers, [
    { tab: "Drink", question: "Which drink?", answer: "Coffee" },
    { tab: "Snack", question: "Which snack?", answer: "Nuts" },
    { tab: "Seat", question: "Where to sit?", answer: "Window" },
  ]);
  assert.deepEqual(d.options, [{ key: "1", label: "Submit answers" }, { key: "2", label: "Cancel" }]);
});

test("the Submit step with questions unanswered goes to the terminal", () => {
  assert.deepEqual(read("several-review-unanswered-120"), { kind: "terminal", reason: "unreadable" });
});

test("multi-select, a plan approval and a question with previews go to the terminal straight away", () => {
  for (const [name, reason] of [["multi-select-120", "multi-select"], ["plan-approval-120", "plan"], ["question-preview-120", "preview"]]) {
    const d = read(name);
    assert.deepEqual(d, { kind: "terminal", reason }, name);
    assert.equal(isFinal(d), true, name);
  }
});

test("status can turn blocked before the dialog is drawn, and that may clear on the next read", () => {
  const d = read("status-before-screen-120");
  assert.deepEqual(d, { kind: "terminal", reason: "not drawn" });
  assert.equal(isFinal(d), false);
});

test("nothing that isn't a dialog reads as one", () => {
  const report = { kind: "permission", msg: "approve Bash: touch x" };
  for (const text of ["", "\n\n", "plain text", "❯ 1. Yes\n  2. No\n\nEsc to cancel", " Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel"]) {
    assert.equal(isCard(parseDialog(text, report)), false, text);
    assert.equal(isCard(parseDialog(text, { kind: "question", msg: "answer: x (a · b)" })), false, text);
  }
  assert.equal(isCard(parseDialog(screen("permission-bash-120"), null)), false);
  assert.equal(isCard(parseDialog(screen("question-120"), { kind: "permission", msg: "" })), false);
  assert.equal(isCard(parseDialog(screen("permission-bash-120"), { kind: "question", msg: "" })), false);
});

test("a prompt from a tool with no saved screen goes to the terminal", () => {
  const text = screen("permission-bash-120").replace(" Bash command\n", " Fetch\n");
  assert.deepEqual(parseDialog(text, { kind: "permission", msg: "permission prompt" }), { kind: "terminal", reason: "unreadable" });
});

test("a list with a gap, or no cursor, isn't read", () => {
  const report = reports["permission-bash-120"];
  assert.equal(isCard(parseDialog(screen("permission-bash-120").replace("   4. No", "   5. No"), report)), false);
  assert.equal(isCard(parseDialog(screen("permission-bash-120").replace("❯ 1. Yes", "  1. Yes"), report)), false);
  assert.equal(isCard(parseDialog(screen("permission-bash-120").replace("   4. No\n", "   4. No\n   3. Extra\n"), report)), false);
});

test("a question's own text can't pose as the tab row", () => {
  const text = screen("question-120").replace(/^Tea or coffee\?$/m, "☐ Fake\n\nTea or coffee?");
  const d = parseDialog(text, { kind: "question", msg: "permission prompt" });
  assert.equal(d.tab, "Drink");
  assert.match(d.question, /☐ Fake/);
});

test("a press goes through on the same dialog, for a key it offers", () => {
  const d = read("permission-bash-120");
  assert.deepEqual(checkPress(d, read("permission-bash-120"), "blocked", "1"), { send: "1" });
  assert.deepEqual(checkPress(d, read("permission-bash-120"), "blocked", "esc"), { send: "esc" });
});

test("a press does nothing when the dialog has moved on", () => {
  const d = read("permission-bash-120");
  assert.deepEqual(checkPress(d, read("permission-bash-101"), "blocked", "1"), { send: null });
  assert.deepEqual(checkPress(d, read("question-120"), "blocked", "1"), { send: null });
  assert.deepEqual(checkPress(d, read("plan-approval-120"), "blocked", "1"), { send: null });
  assert.deepEqual(checkPress(d, read("status-before-screen-120"), "blocked", "1"), { send: null });
});

test("a press does nothing when the read failed", () => {
  const d = read("permission-bash-120");
  assert.deepEqual(checkPress(d, null, "blocked", "1"), { send: null });
});

test("a press does nothing once the session isn't blocked", () => {
  const d = read("permission-bash-120");
  for (const status of ["working", "idle", "done", null]) assert.deepEqual(checkPress(d, d, status, "1"), { send: null });
});

test("a key the dialog doesn't offer does nothing", () => {
  const d = read("question-120");
  assert.deepEqual(checkPress(d, d, "blocked", "9"), { send: null });
  assert.deepEqual(checkPress(d, d, "blocked", "4"), { send: null }, "Type something needs the terminal");
});

test("the Submit step has no Esc", () => {
  const d = read("several-review-120");
  assert.deepEqual(checkPress(d, d, "blocked", "esc"), { send: null });
  assert.deepEqual(checkPress(d, d, "blocked", "1"), { send: "1" });
});

test("moving between steps only works on a dialog with steps", () => {
  const several = read("several-step2-120"), one = read("question-120");
  assert.deepEqual(checkPress(several, several, "blocked", "left"), { send: "left" });
  assert.deepEqual(checkPress(one, one, "blocked", "left"), { send: null });
  assert.deepEqual(stepKeys(2, 0), ["left", "left"]);
  assert.deepEqual(stepKeys(1, 3), ["right", "right"]);
  assert.deepEqual(stepKeys(1, 1), []);
});

const blocked = (name) => ({ status: "blocked", read: read(name) });
const notDrawn = blocked("status-before-screen-120");

test("a dialog on the screen becomes a card", () => {
  const { state, swap } = follow(idle, blocked("permission-bash-120"), 0);
  assert.equal(state.phase, "card");
  assert.equal(state.card.kind, "permission");
  assert.equal(swap, undefined);
});

test("the session moving on clears everything", () => {
  const { state } = follow(idle, blocked("permission-bash-120"), 0);
  assert.deepEqual(follow(state, { status: "working", read: null }, 1).state, idle);
  assert.deepEqual(follow({ phase: "terminal", card: null }, { status: "idle", read: null }, 1).state, idle);
});

test("no read yet changes nothing", () => {
  const { state } = follow(idle, blocked("permission-bash-120"), 0);
  assert.equal(follow(state, { status: "blocked", read: null }, 1).state, state);
});

test("a blocked status with no dialog drawn waits, then swaps to the terminal once", () => {
  const first = follow(idle, notDrawn, 1000);
  assert.equal(first.state.phase, "waiting");
  assert.equal(first.swap, undefined);
  const still = follow(first.state, notDrawn, 1000 + DRAW_MS - 1);
  assert.equal(still.swap, undefined);
  const late = follow(still.state, notDrawn, 1000 + DRAW_MS);
  assert.equal(late.swap, true);
  assert.equal(late.state.phase, "terminal");
  assert.equal(follow(late.state, notDrawn, 1000 + DRAW_MS * 3).swap, undefined);
});

test("a dialog that's there but can't be read gets a moment, then swaps", () => {
  const look = blocked("several-review-unanswered-120");
  const first = follow(idle, look, 0);
  assert.equal(first.swap, undefined);
  assert.equal(follow(first.state, look, READ_MS).swap, true);
});

test("the dialog drawing inside the wait becomes a card", () => {
  const { state } = follow(idle, notDrawn, 0);
  assert.equal(follow(state, blocked("question-120"), 5800).state.phase, "card");
});

test("multi-select, a plan approval and previews swap at once", () => {
  for (const name of ["multi-select-120", "plan-approval-120", "question-preview-120"]) {
    const { state, swap } = follow(idle, blocked(name), 0);
    assert.equal(swap, true, name);
    assert.equal(state.phase, "terminal", name);
  }
});

test("a card can follow a dialog that swapped to the terminal", () => {
  const { state } = follow(idle, blocked("plan-approval-120"), 0);
  assert.equal(follow(state, blocked("question-120"), 1).state.phase, "card");
});

test("after a press the same dialog stays hidden, so it can't take a second press", () => {
  const d = read("permission-bash-120"), state = pressed(d, 1000);
  assert.equal(state.card, null);
  const same = follow(state, blocked("permission-bash-120"), 1000 + HOLD_MS - 1);
  assert.equal(same.state, state);
  assert.equal(same.swap, undefined);
  const gone = follow(state, notDrawn, 1000 + HOLD_MS - 1);
  assert.equal(gone.state.phase, "pressed");
  assert.equal(gone.state.card, null);
  assert.equal(gone.swap, undefined);
});

test("the same dialog asked again after it went shows as a new card", () => {
  const d = read("permission-bash-120"), state = pressed(d, 1000);
  const gone = follow(state, notDrawn, 1500).state;
  assert.equal(gone.gone, true);
  // Reading the empty screen again changes nothing, so the pane doesn't redraw on every poll.
  assert.equal(follow(gone, notDrawn, 2000).state, gone);
  const again = follow(gone, blocked("permission-bash-120"), 2500).state;
  assert.equal(again.phase, "card");
  assert.equal(again.card.key, d.key);
});

test("a screen that can't be read after a press doesn't count as the dialog going", () => {
  const state = pressed(read("permission-bash-120"), 0);
  for (const reason of ["unreadable", "cut off"]) {
    assert.equal(follow(state, { status: "blocked", read: { kind: "terminal", reason } }, 1).state, state);
  }
});

test("a card with steps that went and came back is a new card", () => {
  const one = read("several-step1-120"), state = pressed(one, 0);
  const gone = follow(state, notDrawn, 1).state;
  assert.equal(gone.card, one);
  const again = follow(gone, blocked("several-step1-120"), 2).state;
  assert.equal(again.phase, "card");
  assert.notEqual(again.card, one);
  assert.equal(again.card.key, one.key);
});

test("a press that didn't land brings the card back", () => {
  const state = pressed(read("permission-bash-120"), 0);
  assert.equal(follow(state, blocked("permission-bash-120"), HOLD_MS).state.phase, "card");
});

test("the next dialog after a press shows at once", () => {
  const state = pressed(read("permission-bash-120"), 0);
  const next = follow(state, blocked("question-120"), 1);
  assert.equal(next.state.phase, "card");
  assert.equal(next.state.card.question, "Tea or coffee?");
});

test("a press followed by a dialog the card can't draw swaps at once", () => {
  const next = follow(pressed(read("several-step1-120"), 0), blocked("multi-select-120"), 1);
  assert.equal(next.swap, true);
});

test("a card with steps stays up between steps, and the next step replaces it", () => {
  const one = read("several-step1-120"), state = pressed(one, 0);
  assert.equal(state.card, one);
  assert.equal(follow(state, blocked("several-step1-120"), 1).state, state);
  assert.equal(follow(state, blocked("several-step2-120"), 2).state.card.question, "Which snack?");
});

const term = { pane: "p1", terminal: "t1", tab: "a", focused: false, zoomed: false };
const chat = { pane: "p2", terminal: null, mod: "claude-chat", tab: "a", focused: true, zoomed: true };

test("swapping to the terminal zooms it and focuses it", () => {
  assert.deepEqual(terminalSteps([term, chat], { p2: "t1" }, "t1"), [["pane.zoom", { pane: "p1" }], ["pane.focus", { pane: "p1" }]]);
});

test("a chat side by side only moves focus, because a second zoom would undo a zoom", () => {
  assert.deepEqual(terminalSteps([term, { ...chat, zoomed: false }], { p2: "t1" }, "t1"), [["pane.focus", { pane: "p1" }]]);
});

test("a chat that isn't focused doesn't move the window", () => {
  assert.equal(terminalSteps([term, { ...chat, focused: false }], { p2: "t1" }, "t1"), null);
  assert.equal(terminalSteps([{ ...chat }], { p2: "t1" }, "t1"), null);
});

test("in a tab with two sessions each chat keeps to its own terminal", () => {
  const other = { ...term, pane: "p3", terminal: "t2" }, second = { ...chat, pane: "p4", focused: false };
  assert.equal(terminalSteps([term, other, chat, second], { p2: "t1", p4: "t2" }, "t2"), null);
  assert.deepEqual(terminalSteps([term, other, chat, second], { p2: "t1", p4: "t2" }, "t1")[1], ["pane.focus", { pane: "p1" }]);
});

test("a read that changes nothing leaves the same state, so a card up doesn't redraw the pane on every poll", () => {
  const shown = follow(idle, blocked("permission-bash-120"), 1000).state;
  assert.equal(shown.phase, "card");
  assert.equal(follow(shown, blocked("permission-bash-120"), 1500).state, shown);
  const waiting = follow(idle, notDrawn, 1000).state;
  assert.equal(waiting.phase, "waiting");
  assert.equal(follow(waiting, notDrawn, 1500).state, waiting);
});
