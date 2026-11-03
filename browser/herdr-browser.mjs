#!/usr/bin/env node
// A browser agents drive, shown in a Herdr terminal. agent-browser owns the browser. This opens it beside the agent
// and draws it: a mod can't hold a web view, but a terminal can show images through Kitty graphics.
import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addressToUrl, createFollower, HELP, kittyFrame, locate, Page, parseArgs, parseInput, placeFrame, pngSize, sessionActive, sessionFor, statusLine, toPage, viewportFor } from "./lib.mjs";

const AGENT_BROWSER = process.env.AGENT_BROWSER_BIN || "agent-browser";
const pidFile = (session) => path.join(os.tmpdir(), `herdr-browser-${session}.pid`);

function run(bin, args, timeout = 0) {
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout }, (error, stdout, stderr) =>
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
}
const browser = (session, args, timeout) => run(AGENT_BROWSER, ["--session", session, ...args], timeout);

async function must(bin, args) {
  const r = await run(bin, args);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `${bin} failed`).trim());
  return r.stdout;
}

function viewerRunning(session) {
  try {
    const pid = Number(fs.readFileSync(pidFile(session), "utf8"));
    // A viewer that crashed leaves its file, and the number can come back as some other program.
    const owner = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout;
    return owner.includes("herdr-browser") ? pid : null;
  } catch { return null; }
}

/** `herdr-app do` reports a failed command in its output. */
async function command(name, args) {
  const out = await must("herdr-app", ["do", name, JSON.stringify(args)]);
  if (out.includes('"error"')) throw new Error(`${name}: ${JSON.parse(out).error}`);
}

const whereIs = async (terminal) => locate(JSON.parse(await must("herdr-app", ["ls"])).spaces, terminal);

/** Opens the viewer without taking focus or moving the window, so an agent can call it while someone is working. */
async function show(session, where) {
  if (where.kind === "none" || viewerRunning(session)) return;
  const terminal = process.env.HC_TERMINAL_ID;
  const argv = ["/usr/bin/env", `AGENT_BROWSER_BIN=${AGENT_BROWSER}`, process.execPath, fileURLToPath(import.meta.url), "view", "--session", session];
  const { space, pane, shown } = await whereIs(terminal);
  if (where.kind === "split") {
    if (!pane) throw new Error("--split needs a Herdr terminal. Use --tab, or run this inside one");
    await command("pane.split", { direction: where.direction, pane, argv });
    if (shown) await command("pane.focus", { pane }); // A split takes focus, and whoever's typing to the agent keeps it.
    return;
  }
  if (!space) throw new Error("there's no Herdr space to open a tab in");
  const tab = `tb${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  await must("hc", ["run", "--bg", "--no-parent", "--no-notify", "--outlive-parent", "--rm", "--label", `herdr.space=${space}`, "--label", `herdr.tab=${tab}`, "--", ...argv]);
  for (let i = 0; i < 20; i++) {
    try { await command("tab.rename", { id: tab, name: "Browser" }); break; } catch { /* the tab appears a moment later */ }
    await new Promise((done) => setTimeout(done, 100));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const session = sessionFor(args.session, process.env);
  switch (args.command) {
    case "open": {
      if (args.rest.length !== 1) throw new Error("open takes one address");
      console.log((await must(AGENT_BROWSER, ["--session", session, "open", args.rest[0]])).trim());
      await show(session, args.where);
      console.log(`session ${session}`);
      break;
    }
    case "show": await show(session, args.where); break;
    case "do": {
      const r = spawnSync(AGENT_BROWSER, ["--session", session, ...args.rest], { stdio: "inherit" });
      process.exitCode = r.status ?? 1;
      break;
    }
    case "close": {
      const pid = viewerRunning(session);
      if (pid) process.kill(pid, "SIGTERM");
      await must(AGENT_BROWSER, ["--session", session, "close"]);
      break;
    }
    case "ls": console.log((await must(AGENT_BROWSER, ["session", "list"])).trim()); break;
    case "view": await view(session); break;
    case "pane": { // From the + menu: this terminal is the pane. A browser it starts goes when the pane goes.
      const list = await run(AGENT_BROWSER, ["session", "list", "--json"], 15000);
      if (list.code !== 0) throw new Error("could not list browser sessions");
      const active = sessionActive(list.stdout, session);
      if (active === null) throw new Error(`could not read the browser session list: ${list.stdout.trim().slice(0, 200)}`);
      const owned = !active;
      if (owned) await must(AGENT_BROWSER, ["--session", session, "open", "about:blank"]);
      await view(session, owned);
      break;
    }
    default: console.log(HELP); process.exitCode = args.command ? 2 : 0;
  }
}

async function view(session, owned = false) {
  const out = process.stdout;
  const size = { columns: out.columns || 80, rows: out.rows || 24, cellWidth: 0, cellHeight: 0 };
  const state = { url: "", typing: null, page: null, pageId: null, viewport: null, place: null, frame: null, busy: false, pixelMouse: false, sized: null, clicks: 0, lastPress: 0, imageId: 0 };
  let leftover = "";
  let first = true;

  fs.writeFileSync(pidFile(session), String(process.pid));
  const write = (text) => new Promise((done) => out.write(text, done));
  const metrics = () => (size.cellHeight ? size : { ...size, cellWidth: 9, cellHeight: 18 });

  const drawStatus = () => out.write(`\x1b[${size.rows};1H\x1b[7m${statusLine(state.url, size.columns, state.typing)}\x1b[0m`);

  async function pump() {
    if (state.busy) return;
    state.busy = true;
    while (state.frame) {
      const { data, width, height } = state.frame;
      state.frame = null;
      const place = placeFrame({ width, height }, metrics());
      if (state.place && (state.place.cols !== place.cols || state.place.rows !== place.rows || state.place.left !== place.left || state.place.top !== place.top)) {
        out.write("\x1b_Ga=d,d=A,q=2\x1b\\\x1b[2J");
        drawStatus();
      }
      state.place = place;
      const id = state.imageId === 1 ? 2 : 1;
      await write(`\x1b[${place.top + 1};${place.left + 1}H${kittyFrame(data, id, state.imageId, place.cols, place.rows)}`);
      state.imageId = id;
    }
    state.busy = false;
  }

  // The screencast sends page pixels unless told it may send more, which would blur on a Retina display.
  function startScreencast() {
    const v = viewportFor(metrics());
    const page = state.page;
    state.viewport = { width: v.width, height: v.height };
    page?.send("Page.stopScreencast");
    page?.send("Page.startScreencast", { format: "png", everyNthFrame: 2, maxWidth: v.pxWidth, maxHeight: v.pxHeight });
    // A page that isn't moving sends nothing, so it needs one picture to begin with.
    page?.call("Page.captureScreenshot", { format: "png" }).then((shot) => {
      if (!shot?.data || page !== state.page) return;
      state.frame = { data: shot.data, ...pngSize(shot.data) };
      pump();
    }, () => { /* the page went, or never answered; the next tab brings its own picture */ });
  }

  async function fit() {
    if (!size.cellHeight) return;
    const v = viewportFor(size);
    const key = `${v.width}x${v.height}@${v.scale}`;
    if (key === state.sized) return;
    state.sized = key;
    await browser(session, ["set", "viewport", String(v.width), String(v.height), String(v.scale)], 15000);
    startScreencast();
  }

  function onEvent(method, params, from) {
    if (from !== state.page) return; // A frame from a socket that has since been replaced, or one still attaching.
    if (method === "Page.screencastFrame") {
      state.page.send("Page.screencastFrameAck", { sessionId: params.sessionId });
      state.viewport = { width: params.metadata.deviceWidth, height: params.metadata.deviceHeight };
      state.frame = { data: params.data, ...pngSize(params.data) };
      pump();
    } else if (method === "Page.frameNavigated" && !params.frame.parentId) {
      state.url = params.frame.url;
      drawStatus();
    }
  }

  async function attach(target) {
    state.page?.close();
    state.page = null;
    state.pageId = null; // Set once the page is open, so a failed attach is tried again.
    state.url = target.url;
    if (first && target.url === "about:blank") state.typing = ""; // Opened from the menu, so there's nowhere to look yet.
    first = false;
    state.page = await Page.open(target.webSocketDebuggerUrl, onEvent, () => { state.pageId = null; });
    state.pageId = target.id;
    state.page.send("Page.enable");
    state.page.send("Page.bringToFront"); // A tab behind the others sends no frames.
    state.sized = null; // Each tab has its own size.
    if (size.cellHeight) await fit();
    else startScreencast();
    drawStatus();
  }

  // Follows the tab in front. An agent can open or switch tabs at any time.
  function followFrom(port) {
    return createFollower({
      list: async () => {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) throw new Error(`DevTools answered ${res.status}`);
        return res.json();
      },
      attach,
      current: () => state.pageId,
      onGone: () => quit("The browser has closed"),
    });
  }

  function quit(note) {
    if (quit.done) return;
    quit.done = true;
    out.write("\x1b_Ga=d,d=A,q=2\x1b\\\x1b[?1016l\x1b[?1002l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l");
    try { fs.unlinkSync(pidFile(session)); } catch { /* already gone */ }
    if (owned) spawn(AGENT_BROWSER, ["--session", session, "close"], { detached: true, stdio: "ignore" }).unref();
    if (note) console.log(note);
    process.exit(0);
  }

  function key(event, up = true) {
    const base = { key: event.key, code: event.key, windowsVirtualKeyCode: event.code, modifiers: event.modifiers };
    state.page?.send("Input.dispatchKeyEvent", { type: event.text ? "keyDown" : "rawKeyDown", ...base, ...(event.text ? { text: event.text } : {}) });
    if (up) state.page?.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  function typeAddress(event) {
    if (event.type !== "key" && event.type !== "paste") return;
    if (event.type === "paste") state.typing += event.text.replace(/\s+/g, " ");
    else if (event.key === "Escape") state.typing = null;
    else if (event.key === "Backspace") state.typing = state.typing.slice(0, -1);
    else if (event.key === "Enter") {
      const url = addressToUrl(state.typing);
      state.typing = null;
      if (url) state.page?.send("Page.navigate", { url });
    } else if (event.text) state.typing += event.text;
    drawStatus();
  }

  function pointer(event) {
    if (!state.place || !state.viewport) return;
    const m = metrics();
    const x = state.pixelMouse ? event.x : (event.x - 0.5) * m.cellWidth;
    const y = state.pixelMouse ? event.y : (event.y - 0.5) * m.cellHeight;
    const at = toPage(x, y, state.place, m, state.viewport);
    if (!at) return;
    if (event.type === "wheel") {
      state.page?.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...at, deltaX: 0, deltaY: event.deltaY });
    } else if (event.type === "move") {
      state.page?.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at, button: event.button === "none" ? "none" : event.button, buttons: event.button === "none" ? 0 : 1 });
    } else {
      const now = Date.now();
      if (event.type === "press") { state.clicks = now - state.lastPress < 400 ? state.clicks + 1 : 1; state.lastPress = now; }
      state.page?.send("Input.dispatchMouseEvent", { type: event.type === "press" ? "mousePressed" : "mouseReleased", ...at, button: event.button, clickCount: state.clicks });
    }
  }

  function input(event) {
    switch (event.type) {
      case "cell": size.cellHeight = event.height; size.cellWidth = event.width; fit(); return;
      case "pixelMouse": state.pixelMouse = event.on; return;
      case "pixels": return;
      case "quit": quit(); return;
      case "address": state.typing = ""; drawStatus(); return;
      case "press": case "release": case "move": case "wheel": pointer(event); return;
    }
    if (state.typing !== null) return typeAddress(event);
    if (event.type === "paste") state.page?.send("Input.insertText", { text: event.text });
    else if (event.type === "key") key(event);
  }

  process.stdin.setRawMode?.(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    const { events, leftover: more } = parseInput(leftover + chunk);
    leftover = more;
    events.forEach(input);
  });
  process.on("SIGTERM", () => quit());
  process.on("SIGHUP", () => quit());
  process.on("SIGWINCH", () => {
    size.columns = out.columns;
    size.rows = out.rows;
    write("\x1b[16t\x1b[2J");
    state.sized = null;
    drawStatus();
  });

  out.write("\x1b]2;herdr-browser\x07\x1b[?1049h\x1b[?25l\x1b[2J\x1b[?1002h\x1b[?1006h\x1b[?1016h\x1b[?2004h\x1b[?1016$p\x1b[16t");
  drawStatus();

  const cdp = (await browser(session, ["get", "cdp-url"])).stdout.trim().split("\n").pop();
  const port = /:(\d+)\//.exec(cdp)?.[1];
  if (!port) quit(`No browser for session ${session}`);
  const follow = followFrom(port);
  await follow();
  setInterval(follow, 1000);
}

main().catch((error) => { console.error(`herdr-browser: ${error.message}`); process.exitCode = 1; });
