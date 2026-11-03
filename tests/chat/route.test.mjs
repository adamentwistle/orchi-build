import test from "node:test";
import assert from "node:assert/strict";
import { route, sends, DIALOG_COMMANDS } from "../../mods/claude-chat/route.js";

// One test per row of the spec's table, in the spec's order.
test("row 1: /model and /effort open the pad, with or without a value", () => {
  assert.deepEqual(route("/model"), { kind: "picker", which: "model", value: null });
  assert.deepEqual(route("/model sonnet"), { kind: "picker", which: "model", value: "sonnet" });
  assert.deepEqual(route("/effort"), { kind: "picker", which: "effort", value: null });
  assert.deepEqual(route("/effort xhigh"), { kind: "picker", which: "effort", value: "xhigh" });
  assert.deepEqual(route("  /effort   high  "), { kind: "picker", which: "effort", value: "high" });
});

test("row 2: /usage opens the panel", () => {
  assert.deepEqual(route("/usage"), { kind: "usage", tab: "using" });
  assert.deepEqual(route("/usage "), { kind: "usage", tab: "using" });
});

test("/stats opens the panel on its Stats tab", () => {
  assert.deepEqual(route("/stats"), { kind: "usage", tab: "stats" });
});

test("row 3: /tui and /terminal swap and send nothing", () => {
  for (const text of ["/tui", "/terminal", "/tui now"]) {
    const r = route(text);
    assert.equal(r.kind, "swap");
    assert.equal(sends(r), false);
  }
});

test("row 4: each dialog command is sent, then the terminal shows", () => {
  assert.equal(DIALOG_COMMANDS.length, 13);
  for (const head of DIALOG_COMMANDS) {
    const r = route(head);
    assert.deepEqual(r, { kind: "terminal", head });
    assert.equal(sends(r), true);
  }
  assert.deepEqual(route("/resume abc"), { kind: "terminal", head: "/resume" });
  assert.deepEqual(route("/add-dir ~/x"), { kind: "terminal", head: "/add-dir" });
});

test("row 5: /exit asks first, and so does its other name", () => {
  assert.deepEqual(route("/exit"), { kind: "exit", head: "/exit" });
  assert.deepEqual(route("/quit"), { kind: "exit", head: "/quit" });
  assert.equal(sends(route("/exit")), false);
});

test("row 6: any other command is sent and watched", () => {
  for (const head of ["/clear", "/compact", "/context", "/wrap", "/pickup", "/go", "/superpowers:brainstorming", "/anything-else"]) {
    assert.deepEqual(route(`${head} some args`), { kind: "command", head });
    assert.equal(sends(route(head)), true);
  }
});

test("row 7: anything else is a message", () => {
  for (const text of ["hello", "fix the build", "what does /model do?", "  spaced  ", "a / b", "use /usage later"]) {
    assert.deepEqual(route(text), { kind: "message" });
  }
});

test("a command name has to be the whole first word", () => {
  assert.equal(route("/modelx").kind, "command");
  assert.equal(route("/usage-report").kind, "command");
  assert.equal(route("/exits").kind, "command");
  assert.equal(route("/tuis").kind, "command");
});

test("a command is matched without regard to case, so a different case can't slip past a guard", () => {
  assert.deepEqual(route("/Exit"), { kind: "exit", head: "/exit" });
  assert.deepEqual(route("/EXIT"), { kind: "exit", head: "/exit" });
  assert.deepEqual(route("/Model sonnet"), { kind: "picker", which: "model", value: "sonnet" });
  assert.deepEqual(route("/EFFORT high"), { kind: "picker", which: "effort", value: "high" });
  assert.deepEqual(route("/Permissions"), { kind: "terminal", head: "/permissions" });
  assert.equal(route("/TUI").kind, "swap");
  assert.equal(route("/Usage").kind, "usage");
});

test("a plain command keeps the case it was typed in", () => {
  assert.deepEqual(route("/Superpowers:Brainstorming now"), { kind: "command", head: "/Superpowers:Brainstorming" });
});

test("a path is text, not a command", () => {
  assert.deepEqual(route("/Users/me/notes.md look at this"), { kind: "message" });
  assert.deepEqual(route("/tmp/x"), { kind: "message" });
});

test("nothing typed, or a lone slash, does nothing", () => {
  assert.deepEqual(route(""), { kind: "none" });
  assert.deepEqual(route("   "), { kind: "none" });
  assert.deepEqual(route("/"), { kind: "none" });
  assert.deepEqual(route(null), { kind: "none" });
  assert.deepEqual(route(undefined), { kind: "none" });
});

test("a command in the middle of a message doesn't count", () => {
  assert.equal(route("please run /clear").kind, "message");
  assert.equal(route("\n/clear").kind, "command");
});

// ---- the safety net and the swap ----

import { NET_MS, dialogNet, dialogOpen, dialogUp, waitingOnDialog } from "../../mods/claude-chat/route.js";

test("a dialog is one that shows Esc to cancel", () => {
  assert.equal(dialogOpen("  Select model\n  Enter to confirm · Esc to cancel"), true);
  assert.equal(dialogOpen("   Enter/Space to change · / to search · Esc to close"), true);
  assert.equal(dialogOpen("› \n  ? for shortcuts"), false);
  assert.equal(dialogOpen("✻ Working… (12s · esc to interrupt)"), false);
  assert.equal(dialogOpen("Press Esc again to clear"), false);
  assert.equal(dialogOpen(""), false);
  assert.equal(dialogOpen(null), false);
});

test("the net looks at 2 seconds and once more later", () => {
  assert.equal(NET_MS[0], 2000);
  assert.ok(NET_MS.length === 2 && NET_MS[1] > NET_MS[0]);
});

test("the session file says a dialog is open, whatever the screen shows", () => {
  assert.equal(waitingOnDialog({ status: "waiting", waitingFor: "dialog open" }), true);
  assert.equal(waitingOnDialog({ status: "waiting", waitingFor: "Dialog Open" }), true);
  assert.equal(waitingOnDialog({ status: "waiting", waitingFor: "input" }), false);
  assert.equal(waitingOnDialog({ status: "idle", waitingFor: "dialog open" }), false);
  assert.equal(waitingOnDialog({ status: "waiting" }), false);
  assert.equal(waitingOnDialog(null), false);
});

test("only the foot of the screen counts as a dialog's footer", () => {
  const quoted = ["Enter to confirm · Esc to cancel", "─".repeat(40), "❯ ", "─".repeat(40), "   model:  Haiku 5.5  -  low", "   dir:  ~/x", "  auto mode on"].join("\n");
  assert.equal(dialogOpen(quoted), false);
});

test("the /config dialog's filter footer counts", () => {
  assert.equal(dialogOpen("   Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear\n"), true);
});

test("a dialog is up when the screen's foot or the session file says so, and a failed read counts as no", async () => {
  assert.equal(await dialogUp({}, "   Enter to confirm · Esc to cancel"), true);
  assert.equal(await dialogUp({ dialog: async () => true }, "❯ "), true);
  assert.equal(await dialogUp({ dialog: async () => false }, "❯ "), false);
  assert.equal(await dialogUp({ dialog: async () => { throw new Error("gone"); } }, "❯ "), false);
  assert.equal(await dialogUp({}, "❯ "), false);
});

// A fake session for the safety net: `looks` runs what `after` was given, in order.
function net({ session = null, screen = "", own = () => false, end = () => 100 } = {}) {
  const looks = [], swaps = [];
  dialogNet({ threadEnd: end, session: () => session, screen: async () => screen, own, swap: (cx) => swaps.push(cx) }, (ms, look) => looks.push(look));
  return { looks, swaps };
}
const OPEN = { status: "waiting", waitingFor: "dialog open" };

test("the net swaps when a command opens a dialog, by the session file or by the screen", async () => {
  const byFile = net({ session: OPEN });
  await byFile.looks[0]("cx");
  assert.deepEqual(byFile.swaps, ["cx"]);
  const byScreen = net({ screen: "a dialog\n\n Esc to cancel" });
  await byScreen.looks[0]("cx");
  await byScreen.looks[1]("cx");
  assert.equal(byScreen.swaps.length, 1);
});

test("the net stays out of it when the command reached the transcript", async () => {
  let at = 100;
  const n = net({ session: OPEN, end: () => at });
  at = 200;
  await n.looks[0]("cx");
  await n.looks[1]("cx");
  assert.deepEqual(n.swaps, []);
});

test("the pane's own model picker isn't a dialog for the net", async () => {
  for (const seen of [{ session: OPEN }, { screen: "Select model\n\n Esc to cancel" }]) {
    const n = net({ ...seen, own: () => true });
    await n.looks[0]("cx");
    await n.looks[1]("cx");
    assert.deepEqual(n.swaps, [], JSON.stringify(seen));
  }
});

test("a picker that opens during a look doesn't count either", async () => {
  let own = false;
  const looks = [], swaps = [];
  dialogNet({ threadEnd: () => 100, session: () => null, own: () => own, screen: async () => { own = true; return " Esc to cancel"; }, swap: () => swaps.push(1) }, (ms, look) => looks.push(look));
  await looks[0]("cx");
  assert.deepEqual(swaps, []);
});

test("a real dialog still swaps on the later look once the pane's picker has gone", async () => {
  let own = true;
  const looks = [], swaps = [];
  dialogNet({ threadEnd: () => 100, session: () => OPEN, screen: async () => "", own: () => own, swap: () => swaps.push(1) }, (ms, look) => looks.push(look));
  await looks[0]("cx");
  own = false;
  await looks[1]("cx");
  assert.deepEqual(swaps, [1]);
});
