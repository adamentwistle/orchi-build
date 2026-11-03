import test from "node:test";
import assert from "node:assert/strict";
import { activeSessions, addressToUrl, clean, createFollower, frontPage, Page, kittyFrame, locate, parseArgs, parseInput, placeFrame, pngSize, sessionActive, sessionFor, statusLine, toPage, viewportFor } from "../../browser/lib.mjs";

const cell = { cellWidth: 20, cellHeight: 40 };

test("each terminal gets its own session, and a name given by hand is checked", () => {
  assert.equal(sessionFor(undefined, { HC_TERMINAL_ID: "t12" }), "term-t12");
  assert.equal(sessionFor(undefined, { HC_TERMINAL_ID: "mac/t1" }), "term-mac-t1");
  assert.equal(sessionFor(undefined, {}), "herdr");
  assert.equal(sessionFor("shared", { HC_TERMINAL_ID: "t1" }), "shared");
  assert.throws(() => sessionFor("a;rm", {}));
});

test("a terminal is found by its pane, and an outsider gets the space in front", () => {
  const spaces = [
    { id: "s1", active: false, tabs: [{ terminals: [{ terminal: "t1", pane: "p1" }] }] },
    { id: "s2", active: true, tabs: [{ active: true, terminals: [{ terminal: "t2", pane: "p2" }] }, { terminals: [{ terminal: "t3", pane: "p3" }] }] },
  ];
  assert.deepEqual(locate(spaces, "t1"), { space: "s1", pane: "p1", shown: false });
  assert.deepEqual(locate(spaces, "t3"), { space: "s2", pane: "p3", shown: false });
  assert.equal(locate(spaces, "t2").shown, true);
  assert.deepEqual(locate(spaces, undefined), { space: "s2", pane: null, shown: false });
});

test("do keeps its arguments untouched, even ones that look like ours", () => {
  const a = parseArgs(["do", "--session", "s", "fill", "@e3", "--tab"]);
  assert.deepEqual([a.session, a.rest], ["s", ["fill", "@e3", "--tab"]]);
});

test("open reads where the pane goes", () => {
  assert.deepEqual(parseArgs(["open", "x.com"]).where, { kind: "split", direction: "right" });
  assert.deepEqual(parseArgs(["open", "x.com", "--split", "down"]).where, { kind: "split", direction: "down" });
  assert.deepEqual(parseArgs(["open", "--tab", "x.com"]).where, { kind: "tab" });
  assert.deepEqual(parseArgs(["open", "x.com", "--headless"]).where, { kind: "none" });
  assert.throws(() => parseArgs(["open", "--split", "up"]));
  assert.throws(() => parseArgs(["open", "--nope"]));
});

test("a running session is found by its whole name", () => {
  const list = "Active sessions:\n  term-t15\n  fl\n";
  assert.equal(sessionActive(list, "fl"), true);
  assert.equal(sessionActive(list, "term-t1"), false);
  assert.equal(sessionActive("No active sessions", "fl"), false);
});

test("the session list is read from JSON, and an unknown format is not guessed at", () => {
  const json = '{"success":true,"data":{"sessions":["term-t15","fl"]}}';
  assert.deepEqual(activeSessions(json), ["term-t15", "fl"]);
  assert.equal(sessionActive(json, "fl"), true);
  assert.equal(sessionActive(json, "term-t1"), false);
  assert.equal(sessionActive('{"success":true,"data":{"sessions":[]}}', "fl"), false);
  // Anything else must come back null, so the pane stops rather than closing a browser it didn't start.
  for (const odd of ["", "fl", "Sessions: fl", '{"data":{"sessions":"fl"}}', '{"data":{"sessions":[1]}}', "{not json", "Error: no daemon"]) {
    assert.equal(sessionActive(odd, "fl"), null, odd);
  }
});

test("the front tab is the first page that isn't devtools", () => {
  const list = [{ type: "service_worker", id: "w" }, { type: "page", id: "d", url: "devtools://x" }, { type: "page", id: "p", url: "https://a" }];
  assert.equal(frontPage(list).id, "p");
  assert.equal(frontPage([]), undefined);
  assert.equal(frontPage(null), undefined);
});

// A stand-in for WebSocket that the test drives by hand.
class FakeSocket {
  static last;
  readyState = 0;
  sent = [];
  constructor(url) { this.url = url; FakeSocket.last = this; }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen(); }
  receive(m) { this.onmessage({ data: JSON.stringify(m) }); }
}
const openPage = async (options = {}, onEvent = () => {}, onClose = () => {}) => {
  const opening = Page.open("ws://x", onEvent, onClose, { WS: FakeSocket, ...options });
  FakeSocket.last.open();
  return opening;
};

test("a call resolves with its result", async () => {
  const page = await openPage();
  const call = page.call("Page.captureScreenshot");
  assert.equal(FakeSocket.last.sent[0].method, "Page.captureScreenshot");
  FakeSocket.last.receive({ id: FakeSocket.last.sent[0].id, result: { data: "x" } });
  assert.deepEqual(await call, { data: "x" });
});

test("a call on a socket that isn't open rejects at once, and send does nothing", async () => {
  const page = await openPage();
  FakeSocket.last.readyState = 3;
  await assert.rejects(page.call("Page.enable"), /not connected/);
  assert.equal(page.send("Page.enable"), null);
  assert.equal(FakeSocket.last.sent.length, 0);
});

test("a call nobody answers times out, and leaves nothing waiting", async () => {
  const page = await openPage({ timeout: 20 });
  await assert.rejects(page.call("Page.captureScreenshot"), /timed out/);
  page.settle({ id: 1, result: {} }); // The late answer finds nobody and does nothing.
});

test("calls still waiting when the socket closes are rejected", async () => {
  let closed = 0;
  const page = await openPage({ timeout: 5000 }, () => {}, () => closed++);
  const call = page.call("Page.captureScreenshot");
  FakeSocket.last.close();
  await assert.rejects(call, /closed/);
  assert.equal(closed, 1);
});

test("closing a page rejects what it was waiting for, without telling onClose", async () => {
  let closed = 0;
  const page = await openPage({}, () => {}, () => closed++);
  const call = page.call("Page.enable");
  page.close();
  await assert.rejects(call, /closed/);
  assert.equal(closed, 0);
});

test("a socket that never opens fails the open", async () => {
  await assert.rejects(Page.open("ws://x", () => {}, () => {}, { WS: FakeSocket, timeout: 20 }), /did not answer/);
});

test("events say which page sent them, so a stale one can be told apart", async () => {
  const seen = [];
  const page = await openPage({}, (method, params, from) => seen.push([method, params.n, from]));
  FakeSocket.last.receive({ method: "Page.screencastFrame", params: { n: 1 } });
  assert.deepEqual(seen, [["Page.screencastFrame", 1, page]]);
});

const tabs = [{ type: "page", id: "a", url: "https://a" }];
const follower = (overrides = {}) => {
  const log = { lists: 0, attached: [], gone: 0 };
  let current = null;
  const tick = createFollower({
    list: () => { log.lists++; return Promise.resolve(tabs); },
    attach: async (t) => { log.attached.push(t.id); current = t.id; },
    current: () => current,
    onGone: () => log.gone++,
    ...overrides,
  });
  return { tick, log };
};

test("the follower attaches a new front tab once", async () => {
  const { tick, log } = follower();
  await tick();
  await tick();
  assert.deepEqual(log.attached, ["a"]);
});

test("a check still running is not started again", async () => {
  let release;
  let lists = 0;
  const { tick } = follower({ list: () => { lists++; return new Promise((r) => { release = () => r(tabs); }); } });
  const first = tick();
  assert.equal(tick(), first);
  assert.equal(tick(), first);
  assert.equal(lists, 1);
  release();
  await first;
  const next = tick(); // Free again once it finished.
  assert.notEqual(next, first);
  release();
  await next;
  assert.equal(lists, 2);
});

test("failed checks, a timeout among them, add up to the browser having gone", async () => {
  const failures = [new Error("refused"), new DOMException("timed out", "TimeoutError"), new Error("refused")];
  let n = 0;
  const { tick, log } = follower({ list: () => Promise.reject(failures[n++]) });
  await tick();
  await tick();
  assert.equal(log.gone, 0);
  await tick();
  assert.equal(log.gone, 1);
});

test("an answer in between resets the count", async () => {
  const results = [false, false, true, false, false];
  let n = 0;
  const { tick, log } = follower({ list: () => (results[n++] ? Promise.resolve(tabs) : Promise.reject(new Error("x"))) });
  for (let i = 0; i < results.length; i++) await tick();
  assert.equal(log.gone, 0);
});

test("a tab that fails to attach is a miss, and is tried again", async () => {
  let fail = true;
  const attached = [];
  const { tick, log } = follower({ attach: async (t) => { attached.push(t.id); if (fail) throw new Error("no socket"); } });
  await tick();
  fail = false;
  await tick();
  assert.deepEqual(attached, ["a", "a"]);
  assert.equal(log.gone, 0);
});

test("a page can't put control characters into the status line", () => {
  assert.equal(clean("a\x1b]0;evil\x07b\u009bc"), "a]0;evilbc");
  assert.ok(!statusLine("http://x/\x1b[2J", 60).includes("\x1b"));
});

test("the status line always fills exactly the row", () => {
  for (const columns of [5, 10, 30, 61, 200]) {
    assert.equal(statusLine("https://example.com/" + "a".repeat(300), columns).length, columns);
    assert.equal(statusLine("x", columns, "typed").length, columns);
  }
});

test("a typed address gets a scheme only when it has none", () => {
  assert.equal(addressToUrl("example.com"), "https://example.com");
  assert.equal(addressToUrl("localhost:3000/a"), "http://localhost:3000/a");
  assert.equal(addressToUrl("http://x.dev"), "http://x.dev");
  assert.equal(addressToUrl("file:///tmp/a.html"), "file:///tmp/a.html");
  assert.equal(addressToUrl("   "), null);
});

test("the viewport leaves the status row, and retina cells keep page size", () => {
  assert.deepEqual(viewportFor({ columns: 60, rows: 31, ...cell }), { width: 600, height: 600, scale: 2, pxWidth: 1200, pxHeight: 1200 });
  assert.deepEqual(viewportFor({ columns: 60, rows: 31, cellWidth: 10, cellHeight: 20 }), { width: 600, height: 600, scale: 1, pxWidth: 600, pxHeight: 600 });
});

test("a pane narrower than Chrome allows keeps its shape on a wider page", () => {
  const v = viewportFor({ columns: 28, rows: 28, cellWidth: 20, cellHeight: 51 });
  assert.equal(v.width, 500);
  assert.equal(v.height, Math.round((500 * 1377) / 560));
});

test("a frame the pane's shape fills it, and another keeps its shape", () => {
  const size = { columns: 60, rows: 31, ...cell };
  assert.deepEqual(placeFrame({ width: 1200, height: 1200 }, size), { cols: 60, rows: 30, left: 0, top: 0 });
  assert.deepEqual(placeFrame({ width: 1200, height: 600 }, size), { cols: 60, rows: 15, left: 0, top: 7 });
});

test("a pointer maps to the page, and misses outside the frame", () => {
  const place = { cols: 60, rows: 15, left: 0, top: 7 };
  const vp = { width: 600, height: 300 };
  assert.deepEqual(toPage(600, 280 + 300, place, cell, vp), { x: 300, y: 150 });
  assert.equal(toPage(600, 10, place, cell, vp), null);
});

test("an image's size comes from its header", () => {
  const png = Buffer.alloc(32);
  png.writeUInt32BE(1220, 16);
  png.writeUInt32BE(1376, 20);
  assert.deepEqual(pngSize(png.toString("base64")), { width: 1220, height: 1376 });
});

test("a large image splits into chunks and only the first carries the header", () => {
  const parts = kittyFrame("A".repeat(5000), 2, 1, 10, 5).split("\x1b\\").filter(Boolean);
  assert.match(parts[0], /^\x1b_Ga=t,f=100,i=2,q=2,m=1;/);
  assert.match(parts[1], /^\x1b_Gm=0;A+$/);
});

test("a new picture is on screen before the last one goes", () => {
  const parts = kittyFrame("AAAA", 2, 1, 10, 5).split("\x1b\\").filter(Boolean);
  assert.deepEqual(parts.slice(1), ["\x1b_Ga=p,i=2,p=1,q=2,C=1,c=10,r=5", "\x1b_Ga=d,d=I,i=1,q=2"]);
});

test("the first picture has nothing to remove, and one chunk says there's no more", () => {
  const out = kittyFrame("A".repeat(4096), 1, 0, 1, 1);
  assert.match(out, /m=0;/);
  assert.ok(!out.includes("a=d"));
});

test("mouse, wheel and drag", () => {
  const { events } = parseInput("\x1b[<0;10;20M\x1b[<32;11;20M\x1b[<0;11;20m\x1b[<65;1;2M\x1b[<64;1;2M\x1b[<2;5;5M");
  assert.deepEqual(events.map((e) => e.type), ["press", "move", "release", "wheel", "wheel", "press"]);
  assert.deepEqual([events[3].deltaY, events[4].deltaY, events[5].button], [60, -60, "right"]);
});

test("keys, including our two, and control letters", () => {
  const { events } = parseInput("a\r\x7f\x1b[A\x1b[3~\x0c\x11\x01é");
  assert.deepEqual(events.map((e) => e.key ?? e.type), ["a", "Enter", "Backspace", "ArrowUp", "Delete", "address", "quit", "a", "é"]);
  assert.equal(events[7].modifiers, 2);
});

test("a modified arrow carries its modifier", () => {
  assert.equal(parseInput("\x1b[1;2A").events[0].modifiers, 8);
});

test("a paste stays whole, and one still arriving waits", () => {
  assert.deepEqual(parseInput("\x1b[200~line\nmore\x1b[201~").events, [{ type: "paste", text: "line\nmore" }]);
  const part = parseInput("\x1b[200~line");
  assert.deepEqual([part.events, part.leftover], [[], "\x1b[200~line"]);
});

test("replies from the terminal are read, not typed into the page", () => {
  const { events } = parseInput("\x1b[4;800;1200t\x1b[6;40;20t\x1b[?1016;1$y\x1b_Gi=1;OK\x1b\\");
  assert.deepEqual(events.map((e) => e.type), ["pixels", "cell", "pixelMouse"]);
});

test("half a mouse report waits for the rest", () => {
  const { events, leftover } = parseInput("\x1b[<0;10");
  assert.deepEqual([events, leftover], [[], "\x1b[<0;10"]);
});

test("an Escape alone is the key", () => {
  assert.equal(parseInput("\x1b").events[0].key, "Escape");
});
