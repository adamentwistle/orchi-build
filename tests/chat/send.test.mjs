import test from "node:test";
import assert from "node:assert/strict";
import {
  applyQueueLine, arrange, cleanText, joinRows, plainQueued, promptBody, pullQueue, queueFrom, removeQueued, sendMessage, sendNow,
  serial, sessionNow, settleSent, stopTurn, trayRows, withImages, withPaths, withoutEnter,
} from "../../mods/claude-chat/send.js";

const RULE = "─".repeat(89);
const STATUS = ["   5hr:  ░░░░░░░░░░ 0%", "   model:  Haiku 5.5  -  low", "  ⏵⏵ auto mode on (shift+tab to cycle)"];
const screen = (rows, hint = "") => ["⏺ Some reply", hint, RULE, ...rows, RULE, ...STATUS].join("\n");
const EMPTY = screen(["❯ "]);
const HINTED = screen(["❯ Press up to edit queued messages"]);
const STASHED = screen(["❯ "], `${" ".repeat(78)}› stashed`);
const DIALOG = ["❯ Earlier message", `${RULE.slice(0, 40)} ☐ Drink ──`, "Tea or coffee?", "❯ 1. Tea", "  2. Coffee", RULE, "  3. Chat", "Enter to select"].join("\n");

const get = (state = "idle", name = "claude.exe", cols = 89) => JSON.stringify({ state: "live", cols, foreground: { name }, status: { state } });

// A session as `hc` sees it. `screens` are read in turn, and the last one repeats.
function session({ state = "working", name = "claude.exe", screens = [EMPTY], send = { code: 0, stdout: "{}" }, keys = {} } = {}) {
  const calls = [];
  let at = 0;
  const io = {
    calls, pause: async () => {},
    hc: async (args) => {
      calls.push(args);
      if (args[0] === "get") return { code: 0, stdout: get(state, name) };
      if (args[0] === "read") return { code: 0, stdout: screens[Math.min(at++, screens.length - 1)] };
      if (args[0] === "send") return typeof send === "function" ? send(args) : send;
      if (args[0] === "keys" && keys[args[2]]) keys[args[2]]();
      return { code: 0, stdout: "{}" };
    },
  };
  return io;
}
const pressed = (io) => io.calls.filter((c) => c[0] === "keys").map((c) => c.slice(2).join(" "));
const sends = (io) => io.calls.filter((c) => c[0] === "send").map((c) => c.at(-1));

test("the prompt is read from between the last two rules", () => {
  assert.deepEqual(promptBody(screen(["❯ first line", "  second line"])), { lines: ["first line", "second line"], text: "first line\nsecond line" });
  assert.equal(promptBody(EMPTY).text, "");
  assert.equal(promptBody(DIALOG), null);
  assert.equal(promptBody("no rules here"), null);
});

test("the prompt's own no-break space doesn't reach the text", () => {
  assert.equal(promptBody(screen(["❯\u00a0first", "\u00a0\u00a0second"])).lines.join("|"), "first|second");
});

test("control characters go and newlines stay", () => {
  assert.equal(cleanText("a\tb\r\nc\u001b[201~d\u0007  \n"), "a\tb\nc[201~d");
  assert.equal(cleanText(null), "");
});

test("a message goes with the draft set aside first", async () => {
  const io = session({ state: "idle", screens: [EMPTY, EMPTY, screen(["❯ hello there"]), EMPTY] });
  assert.deepEqual(await sendMessage(io, "t1", "hello there"), { ok: true });
  assert.deepEqual(pressed(io), ["ctrl+s"]);
  assert.deepEqual(sends(io), ["hello there"]);
});

test("a message starting with a dash isn't read as an option", async () => {
  const io = session({ state: "idle" });
  await sendMessage(io, "t1", "-v please");
  assert.deepEqual(io.calls.find((c) => c[0] === "send"), ["send", "t1", "--", "-v please"]);
});

test("a blocked session is refused before any key is pressed", async () => {
  const io = session({ state: "blocked", screens: [DIALOG] });
  const r = await sendMessage(io, "t1", "hello");
  assert.equal(r.reason, "blocked");
  assert.deepEqual(pressed(io), []);
  assert.deepEqual(sends(io), []);
});

test("a held stash refuses the send, because ctrl+s would replace it", async () => {
  const io = session({ state: "idle", screens: [STASHED] });
  const r = await sendMessage(io, "t1", "hello");
  assert.equal(r.reason, "stashed");
  assert.deepEqual(pressed(io), []);
  assert.deepEqual(sends(io), []);
});

test("a shell left after Claude Code exits gets nothing, because the text would run", async () => {
  const io = session({ state: "idle", name: "zsh" });
  assert.equal((await sendMessage(io, "t1", "rm -rf build")).reason, "gone");
  assert.deepEqual(sends(io), []);
});

test("a dialog that opens during the send reads as blocked and the draft comes back", async () => {
  const io = session({ state: "idle", send: { code: 9, stdout: "", stderr: '{"error":{"kind":"blocked"}}' } });
  assert.equal((await sendMessage(io, "t1", "hello")).reason, "blocked");
  assert.deepEqual(pressed(io), ["ctrl+s", "ctrl+s"]);
});

test("empty text sends nothing", async () => {
  const io = session({ state: "idle" });
  assert.equal((await sendMessage(io, "t1", "  \n")).ok, false);
  assert.equal(io.calls.length, 0);
});

test("a send that sits in the prompt gets one more Enter, through hc send so a dialog refuses it", async () => {
  const sitting = screen(["❯ hello there"]);
  const io = session({ state: "idle", screens: [EMPTY, EMPTY, ...Array(18).fill(sitting), EMPTY] });
  assert.deepEqual(await sendMessage(io, "t1", "hello there"), { ok: true });
  assert.deepEqual(pressed(io), ["ctrl+s"]);
  assert.deepEqual(sends(io), ["hello there", ""]);
});

test("a command whose dialog leaves its text in the prompt is delivered, and no Enter goes into the dialog", async () => {
  const dialog = `${screen(["❯ /config"])}\n   Enter/Space to change · / to search · Esc to close`;
  const io = session({ state: "idle", screens: [EMPTY, EMPTY, ...Array(18).fill(dialog)] });
  assert.deepEqual(await sendMessage(io, "t1", "/config"), { ok: true });
  assert.deepEqual(sends(io), ["/config"]);
});

test("an address that isn't one never reaches hc", async () => {
  for (const flow of [sendMessage, sendNow, stopTurn, pullQueue]) {
    const io = session();
    assert.equal((await flow(io, "--force", "hello")).reason, "gone");
    assert.equal(io.calls.length, 0);
  }
});

test("an image path with a line break is refused, because the rest would go in as text", async () => {
  const io = session({ state: "idle" });
  assert.equal((await sendMessage(io, "t1", "hello", ["/a/b.png\nrm -rf /tmp/x"])).reason, "failed");
  assert.equal(io.calls.length, 0);
});

test("a send that never leaves the prompt says so", async () => {
  const io = session({ state: "idle", screens: [EMPTY, EMPTY, screen(["❯ hello there"])] });
  assert.equal((await sendMessage(io, "t1", "hello there")).reason, "stuck");
  assert.deepEqual(sends(io), ["hello there", ""]);
});

test("a wrapped or multi-line send is matched against the prompt without its layout", async () => {
  const io = session({ state: "idle", screens: [EMPTY, EMPTY, screen(["❯ one two", "  three"]), EMPTY] });
  assert.deepEqual(await sendMessage(io, "t1", "one\ntwo three"), { ok: true });
  assert.deepEqual(pressed(io), ["ctrl+s"]);
});

test("a long paste is matched by its placeholder", async () => {
  const io = session({ state: "idle", screens: [EMPTY, EMPTY, ...Array(18).fill(screen(["❯ [Pasted text #1 +3 lines]"])), EMPTY] });
  assert.deepEqual(await sendMessage(io, "t1", "a\nb\nc\nd"), { ok: true });
  assert.deepEqual(sends(io), ["a\nb\nc\nd", ""]);
});

test("a draft that comes back after the send never gets an Enter", async () => {
  const io = session({ state: "idle", screens: [EMPTY, EMPTY, screen(["❯ ok"]), screen(["❯ look at this"])] });
  assert.deepEqual(await sendMessage(io, "t1", "ok"), { ok: true });
  assert.deepEqual(pressed(io), ["ctrl+s"]);
});

test("a dialog appearing after the send never gets an Enter", async () => {
  const io = session({ state: "idle", screens: [EMPTY, EMPTY, screen(["❯ hello"]), DIALOG] });
  assert.deepEqual(await sendMessage(io, "t1", "hello"), { ok: true });
  assert.deepEqual(pressed(io), ["ctrl+s"]);
});

test("an image goes as a path alone on its line after the text", async () => {
  const io = session({ state: "idle", screens: [EMPTY, EMPTY, screen(["❯ [Image #2]What is this?"]), EMPTY] });
  assert.deepEqual(await sendMessage(io, "t1", "What is this?", ["/a/one.png", "/a/two three.png"]), { ok: true });
  assert.deepEqual(sends(io), ["What is this?\n/a/one.png\n/a/two three.png"]);
});

test("images can go with no text", async () => {
  const io = session({ state: "idle" });
  assert.deepEqual(await sendMessage(io, "t1", "  ", ["/a/one.png"]), { ok: true });
  assert.deepEqual(sends(io), ["/a/one.png"]);
  assert.equal(withImages("", ["/a/one.png", "/b.png"]), "/a/one.png\n/b.png");
});

test("a message with an image in the prompt gets one more Enter if it sits there", async () => {
  const sitting = screen(["❯ [Image #2]What is this?"]);
  const io = session({ state: "idle", screens: [EMPTY, EMPTY, ...Array(18).fill(sitting), EMPTY] });
  assert.deepEqual(await sendMessage(io, "t1", "What is this?", ["/a/one.png"]), { ok: true });
  assert.equal(sends(io).at(-1), "");
});

test("images alone never count an empty prompt as sitting there", async () => {
  const io = session({ state: "idle", screens: [EMPTY] });
  assert.deepEqual(await sendMessage(io, "t1", "", ["/a/one.png"]), { ok: true });
  assert.deepEqual(pressed(io), ["ctrl+s"]);
});

test("a blocked session refuses an image too", async () => {
  const io = session({ state: "blocked", screens: [DIALOG] });
  assert.equal((await sendMessage(io, "t1", "", ["/a/one.png"])).reason, "blocked");
  assert.deepEqual(sends(io), []);
});

test("Send now presses Claude Code's own key during a turn", async () => {
  const io = session({ state: "working" });
  assert.deepEqual(await sendNow(io, "t1"), { ok: true });
  assert.deepEqual(pressed(io), ["ctrl+enter"]);
});

const HINT = screen(["❯ Press up to edit queued messages"]);

test("Send now is quiet when the queue left the prompt", async () => {
  const io = session({ state: "working", screens: [HINT, HINT, EMPTY] });
  assert.deepEqual(await sendNow(io, "t1"), { ok: true });
});

test("Send now says so when the queue didn't move, because with no tool running the key does nothing", async () => {
  const io = session({ state: "working", screens: [HINT] });
  const r = await sendNow(io, "t1");
  assert.equal(r.ok, true);
  assert.match(r.note, /no tool running/);
  assert.deepEqual(pressed(io), ["ctrl+enter"]);
});

test("Send now presses nothing on a blocked or idle session", async () => {
  for (const [state, reason] of [["blocked", "blocked"], ["idle", "idle"], ["done", "idle"]]) {
    const io = session({ state });
    assert.equal((await sendNow(io, "t1")).reason, reason);
    assert.deepEqual(pressed(io), []);
  }
});

test("stop interrupts a running turn, and still_working isn't a failure", async () => {
  const io = session({ state: "working" });
  const hc = io.hc;
  let pressedStop = null;
  io.hc = async (args) => {
    if (args[0] !== "interrupt") return hc(args);
    pressedStop = args;
    return { code: 0, stdout: '{"key":"esc","outcome":"still_working"}' };
  };
  assert.deepEqual(await stopTurn(io, "t1"), { ok: true });
  assert.deepEqual(pressedStop, ["interrupt", "--json", "--timeout", "2", "t1"]);
});

test("stop never presses Esc into a dialog", async () => {
  const io = session({ state: "blocked" });
  assert.equal((await stopTurn(io, "t1")).reason, "blocked");
  assert.equal(io.calls.length, 1);
});

test("a queue is built from the transcript's lines", () => {
  assert.deepEqual(queueFrom([
    { operation: "enqueue", content: "one" }, { operation: "enqueue", content: "two" }, { operation: "enqueue", content: "three" },
    { operation: "dequeue" }, { operation: "remove", content: "three", reason: "absorbed_mid_turn" },
  ]), [{ text: "two" }]);
});

test("popAll empties the queue whatever comes after", () => {
  assert.deepEqual(queueFrom([
    { operation: "enqueue", content: "one" }, { operation: "enqueue" }, { operation: "popAll", content: "one" }, { operation: "popAll", content: "two" },
  ]), []);
});

test("an enqueue with no content takes a place, and a dequeue or remove can clear it", () => {
  assert.deepEqual(queueFrom([{ operation: "enqueue" }]), [{ text: null }]);
  assert.deepEqual(queueFrom([{ operation: "enqueue" }, { operation: "dequeue" }]), []);
  assert.deepEqual(queueFrom([{ operation: "enqueue" }, { operation: "remove", content: "hi" }]), []);
});

test("a line the queue doesn't know leaves it alone", () => {
  const q = [{ text: "one" }];
  assert.equal(applyQueueLine(q, { operation: "something" }), q);
  assert.equal(applyQueueLine(q, { operation: "remove", content: "other" }), q);
  assert.deepEqual(queueFrom([{ operation: "dequeue" }]), []);
});

test("subagent results hold a place in the queue but never show", () => {
  const q = queueFrom([{ operation: "enqueue", content: "<task-notification>\n<task-id>x" }, { operation: "enqueue", content: "<agent-message from=\"a\">" }, { operation: "enqueue", content: "mine" }]);
  assert.deepEqual(trayRows(q, "working"), [{ text: "mine" }]);
  assert.deepEqual(trayRows(queueFrom([{ operation: "dequeue" }], q), "working"), [{ text: "mine" }]);
});

test("the tray is empty unless a turn is running", () => {
  const q = [{ text: "left over" }];
  for (const state of ["idle", "done", null]) assert.deepEqual(trayRows(q, state), []);
  assert.deepEqual(trayRows(q, "blocked"), q);
});

test("a long paste shows its own text", () => {
  const raw = '<pasted_content id="8add">\nLong line 1\nLong line 2\n</pasted_content id="8add">';
  assert.equal(plainQueued(raw), "Long line 1\nLong line 2");
  assert.deepEqual(trayRows([{ text: raw }], "working"), [{ text: "Long line 1\nLong line 2" }]);
});

test("text sent but not in the transcript shows at once and gives way to its row", () => {
  assert.deepEqual(trayRows([], "working", ["hello"]), [{ text: "hello" }]);
  assert.deepEqual(trayRows([{ text: "hello" }], "working", ["hello", "next"]), [{ text: "hello" }, { text: "next" }]);
});

test("a row with no content borrows the text sent", () => {
  assert.deepEqual(trayRows([{ text: null }], "working", ["hello"]), [{ text: "hello" }]);
  assert.deepEqual(trayRows([{ text: null }], "working"), [{ text: null }]);
});

test("items are matched to the prompt in its order, even if the lines came out of order", () => {
  const known = [{ text: "Remember CHARLIE" }, { text: "Remember BRAVO one\nand BRAVO two" }];
  assert.deepEqual(arrange(known, ["Remember BRAVO one", "and BRAVO two", "Remember CHARLIE"]), [known[1], known[0]]);
});

test("rewrapped text still matches", () => {
  const known = [{ text: "a long message that wraps" }];
  assert.deepEqual(arrange(known, ["a long message", "that wraps"]), known);
});

test("a paste placeholder matches the message with that many lines", () => {
  const known = [{ text: "short" }, { text: "a\nb\nc" }];
  assert.deepEqual(arrange(known, ["[Pasted text #1 +2 lines]", "short"]), [known[1], known[0]]);
  assert.equal(arrange([{ text: "short" }], ["[Pasted text #1 +2 lines]"]), null);
});

test("a prompt holding anything else doesn't match", () => {
  assert.equal(arrange([{ text: "one" }], ["one", "typed in the terminal"]), null);
  assert.equal(arrange([], ["one"]), null);
});

test("wrapped rows join, and real line breaks stay", () => {
  const rows = ["Noted item THREE, which is long enough on purpose to wrap past the width of this", "terminal so we can see", "a new line"];
  assert.equal(joinRows(rows, 89), "Noted item THREE, which is long enough on purpose to wrap past the width of this terminal so we can see\na new line");
  assert.equal(joinRows(["x".repeat(87), "yyy"], 89), `${"x".repeat(87)}yyy`);
  assert.equal(joinRows(["one", "two"], 89), "one\ntwo");
});

const PULLED = screen(["❯ first", "  second line", "  third"]);
const known = [{ text: "first" }, { text: "second line" }, { text: "third" }];

test("Edit takes the whole queue, in the prompt's order, and clears the prompt", async () => {
  const io = session({ screens: [HINTED, PULLED, PULLED, EMPTY] });
  const r = await pullQueue(io, "t1", [known[2], known[0], known[1]]);
  assert.equal(r.text, "first\nsecond line\nthird");
  assert.deepEqual(r.items, known);
  assert.equal(r.cleared, true);
  assert.deepEqual(pressed(io), ["up", Array(8).fill("ctrl+u").join(" ")]);
});

test("a half-drawn prompt isn't read as the queue", async () => {
  const io = session({ screens: [HINTED, screen(["❯ third"]), PULLED, PULLED, EMPTY] });
  assert.equal((await pullQueue(io, "t1", known)).text, "first\nsecond line\nthird");
});

test("Edit reads the screen when the queue can't be matched", async () => {
  const io = session({ screens: [HINTED, PULLED, PULLED, EMPTY] });
  const r = await pullQueue(io, "t1", []);
  assert.equal(r.text, "first\nsecond line\nthird");
  assert.equal(r.items, null);
});

test("Edit presses again until the prompt is clear", async () => {
  const io = session({ screens: [HINTED, PULLED, PULLED, screen(["❯ first"]), EMPTY] });
  assert.equal((await pullQueue(io, "t1", known)).cleared, true);
  assert.equal(pressed(io).length, 3);
});

test("Edit says so when the prompt won't clear, and keeps the text", async () => {
  const io = session({ screens: [HINTED, PULLED] });
  const r = await pullQueue(io, "t1", known);
  assert.equal(r.cleared, false);
  assert.equal(r.text, "first\nsecond line\nthird");
});

test("a suggestion left in an emptied prompt doesn't count as text", async () => {
  const io = session({ screens: [HINTED, PULLED, PULLED, screen(["❯ run it again"])] });
  assert.equal((await pullQueue(io, "t1", known)).cleared, true);
});

test("Edit won't press up into a draft, and says why", async () => {
  const io = session({ screens: [screen(["❯ half typed"])] });
  assert.equal((await pullQueue(io, "t1", known)).reason, "draft");
  assert.deepEqual(pressed(io), []);
});

test("Edit presses nothing with no queue, an idle session or a dialog", async () => {
  for (const [state, screens, reason] of [["working", [EMPTY], "nothing"], ["idle", [HINTED], "idle"], ["blocked", [DIALOG], "blocked"], ["working", [DIALOG], "unreadable"]]) {
    const io = session({ state, screens });
    assert.equal((await pullQueue(io, "t1", known)).reason, reason);
    assert.deepEqual(pressed(io), []);
  }
});

test("Edit gives up if up pulls nothing", async () => {
  const io = session({ screens: [HINTED, EMPTY] });
  assert.equal((await pullQueue(io, "t1", known)).reason, "nothing");
  assert.deepEqual(pressed(io), ["up"]);
});

test("a long paste nobody can read stays in the terminal", async () => {
  const io = session({ screens: [HINTED, screen(["❯ [Pasted text #1 +39 lines]"]), screen(["❯ [Pasted text #1 +39 lines]"])] });
  assert.equal((await pullQueue(io, "t1", [])).reason, "terminal");
  assert.deepEqual(pressed(io), ["up"]);
});

test("a queued image stops Edit before up is pressed, because its text alone would lose it", async () => {
  const io = session({ screens: [HINTED] });
  const r = await pullQueue(io, "t1", [{ text: "[Image #7]What is this?" }, { text: "first" }]);
  assert.equal(r.reason, "image");
  assert.deepEqual(pressed(io), []);
});

test("an image nobody knew about stays in the terminal after up", async () => {
  const pulled = screen(["❯ [Image #7]What is this?"]);
  const io = session({ screens: [HINTED, pulled, pulled] });
  assert.equal((await pullQueue(io, "t1", [])).reason, "terminal");
  assert.deepEqual(pressed(io), ["up"]);
});

test("Remove pulls the queue and sends the others in order", async () => {
  const io = session({ screens: [HINTED, PULLED, PULLED, EMPTY, screen(["❯ first"]), EMPTY, screen(["❯ third"]), EMPTY] });
  assert.deepEqual(await removeQueued(io, "t1", known, known[1]), { ok: true, again: ["first", "third"] });
  assert.deepEqual(sends(io), ["first", "third"]);
});

test("Remove leaves nothing when it was the only message", async () => {
  const io = session({ screens: [HINTED, screen(["❯ first"]), screen(["❯ first"]), EMPTY] });
  assert.deepEqual(await removeQueued(io, "t1", [known[0]], known[0]), { ok: true, again: [] });
  assert.deepEqual(sends(io), []);
});

test("Remove gives everything back when it can't tell the messages apart", async () => {
  const io = session({ screens: [HINTED, PULLED, PULLED, EMPTY] });
  const r = await removeQueued(io, "t1", [], known[1]);
  assert.equal(r.reason, "split");
  assert.equal(r.text, "first\nsecond line\nthird");
  assert.deepEqual(sends(io), []);
});

test("Remove gives back what's left if a send is refused", async () => {
  const io = session({ screens: [HINTED, PULLED, PULLED, EMPTY], send: { code: 9, stderr: '{"error":{"kind":"blocked"}}' } });
  const r = await removeQueued(io, "t1", known, known[1]);
  assert.equal(r.reason, "blocked");
  assert.equal(r.text, "first\nthird");
});

test("Remove passes a refusal straight through", async () => {
  const io = session({ state: "idle", screens: [HINTED] });
  assert.equal((await removeQueued(io, "t1", known, known[0])).reason, "idle");
});

test("a session that has gone reads as not live", async () => {
  assert.deepEqual(await sessionNow(session({ name: "zsh" }), "t1"), { live: false });
  const io = { hc: async () => ({ code: 1, stdout: "" }) };
  assert.deepEqual(await sessionNow(io, "t1"), { live: false });
  assert.deepEqual(await sessionNow(session({ state: "working" }), "t1"), { live: true, state: "working", cols: 89 });
});

const sent = (over = {}) => ({ id: "sent:1", text: "hello there", images: 0, queued: false, at: 1000, ...over });

test("a sent message settles when its own row arrives", () => {
  const row = { kind: "user", text: "hello  there" };
  assert.deepEqual(settleSent([sent()], [{ kind: "text", text: "hello there" }, row], [], 2000), { left: [], settled: [[sent(), row]] });
  assert.deepEqual(settleSent([sent()], [], [], 2000), { left: [sent()], settled: [] });
});

test("two messages with the same text settle one row at a time", () => {
  const row = { kind: "user", text: "hello there" };
  const { left, settled } = settleSent([sent(), sent({ id: "sent:2" })], [row], [], 2000);
  assert.equal(settled.length, 1);
  assert.deepEqual(left.map((x) => x.id), ["sent:2"]);
});

test("a message with an image settles on the row that says [image]", () => {
  const row = { kind: "user", text: "[image]What is this?", images: 1 };
  assert.equal(settleSent([sent({ text: "What is this?", images: 1 })], [row], [], 2000).settled.length, 1);
  assert.equal(settleSent([sent({ text: "", images: 1 })], [{ kind: "user", text: "[image]", images: 1 }], [], 2000).settled.length, 1);
});

test("a clipped row settles on its start", () => {
  const long = "word ".repeat(200);
  assert.equal(settleSent([sent({ text: long })], [{ kind: "user", text: long.slice(0, 300), clipped: true }], [], 2000).settled.length, 1);
});

test("a queued message gives way to its queue row", () => {
  assert.deepEqual(settleSent([sent({ queued: true })], [], [{ text: "hello there" }], 2000).left, []);
  assert.equal(settleSent([sent({ queued: false })], [], [{ text: "hello there" }], 2000).left.length, 1);
  assert.deepEqual(settleSent([sent({ queued: true, text: "What is this?" })], [], [{ text: "[Image #7]What is this?" }], 2000).left, []);
});

test("a message nothing ever confirmed goes after two minutes", () => {
  assert.equal(settleSent([sent()], [], [], 120_999).left.length, 1);
  assert.deepEqual(settleSent([sent()], [], [], 121_000).left, []);
});

test("dropped paths are escaped and spaced", () => {
  assert.equal(withPaths("", ["/a/b.txt"]), "/a/b.txt ");
  assert.equal(withPaths("see", ["/a/my file.txt", "/c"]), "see /a/my\\ file.txt /c ");
  assert.equal(withPaths("see ", ["/c"]), "see /c ");
  assert.equal(withPaths("see", []), "see");
});

test("the newline Enter added comes back out, wherever the cursor was", () => {
  assert.equal(withoutEnter("hello", "hello\n"), "hello");
  assert.equal(withoutEnter("hello", "he\nllo"), "hello");
  assert.equal(withoutEnter("hello", "hello"), "hello");
  assert.equal(withoutEnter("hello", "hello!"), "hello!");
  assert.equal(withoutEnter("a\nb", "a\nb\n"), "a\nb");
});

test("flows run one at a time, and a failed one doesn't stop the next", async () => {
  const run = serial(), order = [];
  let release;
  const first = run(() => new Promise((resolve) => { release = () => { order.push("first"); resolve("one"); }; }));
  const second = run(async () => { order.push("second"); throw new Error("no"); });
  const third = run(async () => { order.push("third"); return "three"; });
  await Promise.resolve();
  release();
  assert.equal(await first, "one");
  await assert.rejects(second);
  assert.equal(await third, "three");
  assert.deepEqual(order, ["first", "second", "third"]);
});

// ---- a dialog of Claude Code's own, which doesn't read blocked ----

const PICKER = ["   Select model", "   ❯ 5.  Haiku 5.5 ✔   Fast", "", "   ◐ Low effort ←/→ to adjust", "", "   Enter to set as default · s to use this session only · Esc to cancel"].join("\n");

test("a send presses nothing into a dialog that reads idle, from the screen", async () => {
  const io = session({ state: "done", screens: [PICKER] });
  assert.equal((await sendMessage(io, "t1", "hello")).reason, "blocked");
  assert.deepEqual(pressed(io), []);
  assert.deepEqual(sends(io), []);
});

test("a send presses nothing into a dialog whose footer has scrolled off, from the session file", async () => {
  const io = { ...session({ state: "done", screens: [EMPTY] }), dialog: async () => true };
  assert.equal((await sendMessage(io, "t1", "hello")).reason, "blocked");
  assert.deepEqual(pressed(io), []);
  assert.deepEqual(sends(io), []);
});

test("a conversation quoting a dialog's footer doesn't stop a send", async () => {
  const quoted = screen(["❯ "], "   Enter to set as default · s to use this session only · Esc to cancel");
  const io = session({ state: "done", screens: [quoted] });
  assert.equal((await sendMessage(io, "t1", "hello")).ok, true);
});

test("a / command stuck in the prompt never gets the rescue Enter, which would land in a dialog it opened", async () => {
  const stuck = screen(["❯ /mcp"]);
  const io = session({ state: "done", screens: [EMPTY, EMPTY, stuck] });
  assert.equal((await sendMessage(io, "t1", "/mcp")).reason, "stuck");
  assert.equal(sends(io).filter((text) => text === "").length, 0);
});

test("a command that opened a dialog under the session file counts as delivered", async () => {
  const stuck = screen(["❯ /mcp"]);
  let asked = 0;
  const io = { ...session({ state: "done", screens: [EMPTY, EMPTY, stuck] }), dialog: async () => ++asked > 1 };
  assert.equal((await sendMessage(io, "t1", "/mcp")).ok, true);
});

test("a message stuck in the prompt still gets the rescue Enter", async () => {
  const stuck = screen(["❯ hello there"]);
  const io = session({ state: "done", screens: [EMPTY, EMPTY, stuck, stuck, stuck, stuck, stuck, stuck, stuck, stuck, stuck, stuck, stuck, stuck, stuck, stuck, stuck, stuck, EMPTY] });
  await sendMessage(io, "t1", "hello there");
  assert.equal(sends(io).filter((text) => text === "").length, 1);
});

// ---- the queue, when the prompt wouldn't clear ----

test("Remove sends nothing while the pulled text is still in the prompt, or the removed message would go too", async () => {
  const known = [{ text: "one" }, { text: "two" }];
  const pulled = screen(["❯ one", "  two"]);
  const io = session({ screens: [HINTED, pulled, pulled, pulled, pulled, pulled, pulled, pulled, pulled, pulled, pulled, pulled] });
  const r = await removeQueued(io, "t1", known, known[1]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "terminal");
  assert.equal(r.text, undefined, "the text is in the terminal, so a copy here would send it twice");
  assert.deepEqual(sends(io), []);
});

// ---- Send now, with something typed in the terminal ----

test("Send now won't press Ctrl+Enter over text typed in the terminal", async () => {
  const io = session({ screens: [screen(["❯ half a thought"])] });
  assert.equal((await sendNow(io, "t1")).reason, "draft");
  assert.deepEqual(pressed(io), []);
});

test("Send now presses Ctrl+Enter on an empty prompt and on the queue's hint", async () => {
  for (const shown of [EMPTY, HINTED]) {
    const io = session({ screens: [shown] });
    assert.equal((await sendNow(io, "t1")).ok, true);
    assert.deepEqual(pressed(io), ["ctrl+enter"]);
  }
});

test("Send now presses nothing when the prompt can't be read", async () => {
  const io = session({ screens: [DIALOG] });
  assert.equal((await sendNow(io, "t1")).reason, "unreadable");
  assert.deepEqual(pressed(io), []);
});
