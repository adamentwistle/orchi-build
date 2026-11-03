// The parts of the browser pane that need no terminal or browser, so tests can reach them.

export const HELP = `herdr-browser: a browser agents drive, shown in a Herdr pane or tab.

  herdr-browser open <url> [--split right|down | --tab | --headless] [--session name]
  herdr-browser show [--split right|down | --tab] [--session name]
  herdr-browser do <agent-browser command...>      snapshot -i, click @e2, fill @e3 "x"
  herdr-browser close [--session name]
  herdr-browser ls

The session defaults to one per terminal. In the pane, Ctrl+L types an address and Ctrl+Q closes the pane.`;

export function sessionFor(given, env = {}) {
  const raw = given || env.HERDR_BROWSER_SESSION || (env.HC_TERMINAL_ID ? `term-${env.HC_TERMINAL_ID}` : "herdr");
  const name = String(raw).replace(/[^A-Za-z0-9_-]/g, "-");
  if (given && name !== given) throw new Error(`session names use letters, digits, - and _: ${given}`);
  if (name.length > 64) throw new Error("session name over 64 characters");
  return name;
}

/**
 * The active session names in the output of `agent-browser session list`, or null when it isn't a format we know.
 * It takes `--json`, which is what to ask for. The plain text, a heading and a name to a line, is read too.
 */
export function activeSessions(output) {
  const text = String(output ?? "").trim();
  if (text.startsWith("{")) {
    try {
      const sessions = JSON.parse(text)?.data?.sessions;
      if (Array.isArray(sessions) && sessions.every((s) => typeof s === "string")) return sessions;
    } catch { /* not JSON after all */ }
    return null;
  }
  if (/^No active sessions/i.test(text)) return [];
  const lines = text.split("\n").map((l) => l.trim());
  if (!/^Active sessions:?$/i.test(lines[0])) return null;
  return lines.slice(1).filter(Boolean);
}

/** Whether a session is in that list. Null, not false, when the output wasn't understood: a guess would be wrong. */
export function sessionActive(output, session) {
  const sessions = activeSessions(output);
  return sessions === null ? null : sessions.includes(session);
}

/** The tab in front of a DevTools `/json/list`: the first real page. */
export function frontPage(list) {
  return Array.isArray(list) ? list.find((t) => t?.type === "page" && !String(t.url).startsWith("devtools://")) : undefined;
}

/**
 * Follows the front tab. One check runs at a time, so a DevTools endpoint that hangs can't stack requests. A check
 * that fails or times out is a miss, and enough misses in a row mean the browser has gone.
 */
export function createFollower({ list, attach, current, onGone, maxMisses = 3 }) {
  let running = null;
  let misses = 0;
  const check = async () => {
    try {
      const front = frontPage(await list());
      if (front && front.id !== current()) await attach(front);
      misses = 0;
    } catch {
      if (++misses >= maxMisses) onGone();
    }
  };
  return () => (running ??= check().finally(() => { running = null; }));
}

/** A connection to one page over the DevTools Protocol. Calls fail rather than wait for ever. */
export class Page {
  #id = 0;
  #ws;
  #timeout;
  #waiting = new Map();
  constructor(ws, timeout = 5000) { this.#ws = ws; this.#timeout = timeout; }
  static open(url, onEvent, onClose, { WS = globalThis.WebSocket, timeout = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WS(url);
      let page;
      const timer = setTimeout(() => { reject(new Error("the page did not answer")); try { ws.close(); } catch { /* already gone */ } }, timeout);
      ws.onerror = () => { clearTimeout(timer); reject(new Error("could not reach the page")); };
      ws.onclose = () => { clearTimeout(timer); page?.#failAll("the page closed"); onClose?.(); };
      ws.onopen = () => { clearTimeout(timer); page = new Page(ws, timeout); resolve(page); };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.method) onEvent(m.method, m.params, page);
        else page?.settle(m);
      };
    });
  }
  settle(m) {
    const call = this.#waiting.get(m.id);
    if (!call) return;
    this.#waiting.delete(m.id);
    clearTimeout(call.timer);
    call.resolve(m.result);
  }
  #failAll(reason) {
    for (const [id, call] of this.#waiting) { clearTimeout(call.timer); call.reject(new Error(reason)); this.#waiting.delete(id); }
  }
  /** Resolves with the result. Rejects if the socket isn't open, closes first, or says nothing in time. */
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (this.#ws.readyState !== 1) return reject(new Error("the page is not connected"));
      const id = this.send(method, params);
      const timer = setTimeout(() => { this.#waiting.delete(id); reject(new Error(`${method} timed out`)); }, this.#timeout);
      this.#waiting.set(id, { resolve, reject, timer });
    });
  }
  /** Returns the message id, or null when the socket wasn't open and nothing was sent. */
  send(method, params = {}) {
    if (this.#ws.readyState !== 1) return null;
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return id;
  }
  close() { this.#ws.onclose = null; this.#failAll("the page closed"); this.#ws.close(); }
}

/** Finds a terminal's pane and space in `herdr-app ls`. With no such terminal, the space in front and no pane. */
export function locate(spaces, terminal) {
  for (const space of spaces) {
    for (const tab of space.tabs ?? []) {
      const found = (tab.terminals ?? []).find((t) => t.terminal === terminal);
      if (found) return { space: space.id, pane: found.pane, shown: Boolean(space.active && tab.active) };
    }
  }
  return { space: spaces.find((s) => s.active)?.id ?? null, pane: null, shown: false };
}

/** Splits our own flags from the rest. `do` keeps everything after it, untouched. */
export function parseArgs(argv) {
  const out = { command: argv[0], rest: [], where: { kind: "split", direction: "right" }, session: undefined };
  if (out.command === "do") {
    let i = 1;
    if (argv[1] === "--session") { out.session = argv[2]; i = 3; }
    out.rest = argv.slice(i);
    return out;
  }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--split") {
      const direction = argv[++i];
      if (direction !== "right" && direction !== "down") throw new Error("--split takes right or down");
      out.where = { kind: "split", direction };
    } else if (a === "--tab") out.where = { kind: "tab" };
    else if (a === "--headless") out.where = { kind: "none" };
    else if (a === "--session") out.session = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else out.rest.push(a);
  }
  return out;
}

/** A page controls its own URL, so nothing from it reaches the terminal as a control character. */
export function clean(text) {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

export function statusLine(url, columns, typing) {
  const entering = typing !== null && typing !== undefined;
  const text = entering ? ` Go to: ${clean(typing)}` : ` ${clean(url)}`;
  const hint = entering ? " Esc cancel " : columns >= 60 ? " ^L address  ^Q close " : " ^L ^Q ";
  const right = hint.length < columns ? hint : "";
  const room = columns - right.length;
  const left = text.length > room ? text.slice(0, Math.max(0, room - 1)) + "…" : text.padEnd(room);
  return left + right;
}

export function addressToUrl(typed) {
  const t = typed.trim();
  if (!t) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^/]+:\d+(\/|$)/.test(t)) return t;
  return (/^(localhost|127\.|\[::1\])/.test(t) ? "http://" : "https://") + t;
}

/** Retina cells are about twice the height, and the page should stay the size it would be in a browser. */
export function scaleFor(cellHeight) {
  return cellHeight >= 28 ? 2 : 1;
}

// Chrome won't draw a page narrower than this, and leaves the rest of the frame empty if asked.
export const MIN_WIDTH = 500;

/** The page size for a pane, and the most pixels worth sending. A narrow pane gets a smaller view of a wider page. */
export function viewportFor({ columns, rows, cellWidth, cellHeight }) {
  const scale = scaleFor(cellHeight);
  const usable = Math.max(1, rows - 1);
  const pxWidth = columns * cellWidth;
  const pxHeight = usable * cellHeight;
  const width = Math.max(MIN_WIDTH, Math.floor(pxWidth / scale));
  return { width, height: Math.max(1, Math.round((width * pxHeight) / pxWidth)), scale, pxWidth, pxHeight };
}

/** Fits a frame into the rows above the status line, keeping its shape. Cells are whole, so it rounds down. */
export function placeFrame(frame, { columns, rows, cellWidth, cellHeight }) {
  const usable = Math.max(1, rows - 1);
  const fit = Math.min((columns * cellWidth) / frame.width, (usable * cellHeight) / frame.height);
  const pxWidth = frame.width * fit;
  const pxHeight = frame.height * fit;
  const cols = Math.max(1, Math.round(pxWidth / cellWidth));
  const rowsUsed = Math.max(1, Math.round(pxHeight / cellHeight));
  return {
    cols,
    rows: rowsUsed,
    left: Math.floor((columns - cols) / 2),
    top: Math.floor((usable - rowsUsed) / 2),
  };
}

/** Maps a point in the terminal, in pixels, to the page. Null when it's outside the frame. */
export function toPage(x, y, place, { cellWidth, cellHeight }, viewport) {
  const px = x - place.left * cellWidth;
  const py = y - place.top * cellHeight;
  const w = place.cols * cellWidth;
  const h = place.rows * cellHeight;
  if (px < 0 || py < 0 || px >= w || py >= h) return null;
  return { x: (px / w) * viewport.width, y: (py / h) * viewport.height };
}

/** Width and height from a PNG's header, as base64. */
export function pngSize(base64) {
  const head = Buffer.from(base64.slice(0, 44), "base64");
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

const CHUNK = 4096;

/**
 * The Kitty graphics escapes for one PNG, as base64. It's sent to a second image id and only then shown over the last
 * one, which goes after. Sending to the id on screen removes that picture first, so the pane shows blank until the new
 * one has decoded, and that was most of the time on a busy page. q=2 keeps the terminal from answering.
 */
export function kittyFrame(base64, id, previous, cols, rows) {
  let out = "";
  for (let i = 0; i < base64.length; i += CHUNK) {
    const more = i + CHUNK < base64.length ? 1 : 0;
    const head = i === 0 ? `a=t,f=100,i=${id},q=2,m=${more}` : `m=${more}`;
    out += `\x1b_G${head};${base64.slice(i, i + CHUNK)}\x1b\\`;
  }
  out += `\x1b_Ga=p,i=${id},p=1,q=2,C=1,c=${cols},r=${rows}\x1b\\`;
  if (previous) out += `\x1b_Ga=d,d=I,i=${previous},q=2\x1b\\`;
  return out;
}

const NAMED = {
  A: ["ArrowUp", 38], B: ["ArrowDown", 40], C: ["ArrowRight", 39], D: ["ArrowLeft", 37],
  H: ["Home", 36], F: ["End", 35],
};
const TILDE = { 3: ["Delete", 46], 5: ["PageUp", 33], 6: ["PageDown", 34] };

/** Reads what the terminal sent. Returns events and any bytes that may be the start of something longer. */
export function parseInput(text) {
  const events = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith("\x1b[200~")) {
      const end = rest.indexOf("\x1b[201~");
      if (end < 0) break;
      events.push({ type: "paste", text: rest.slice(6, end) });
      i += end + 6;
      continue;
    }
    let m;
    if ((m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest))) {
      events.push(mouse(+m[1], +m[2], +m[3], m[4] === "M"));
    } else if ((m = /^\x1b\[4;(\d+);(\d+)t/.exec(rest))) {
      events.push({ type: "pixels", height: +m[1], width: +m[2] });
    } else if ((m = /^\x1b\[6;(\d+);(\d+)t/.exec(rest))) {
      events.push({ type: "cell", height: +m[1], width: +m[2] });
    } else if ((m = /^\x1b\[\?1016;(\d)\$y/.exec(rest))) {
      events.push({ type: "pixelMouse", on: m[1] === "1" || m[1] === "2" });
    } else if ((m = /^\x1b\[(?:1;(\d))?([ABCDHF])/.exec(rest))) {
      const [key, code] = NAMED[m[2]];
      events.push({ type: "key", key, code, modifiers: m[1] ? modifiers(+m[1]) : 0 });
    } else if ((m = /^\x1b\[(\d+)~/.exec(rest))) {
      if (TILDE[m[1]]) events.push({ type: "key", key: TILDE[m[1]][0], code: TILDE[m[1]][1], modifiers: 0 });
    } else if (rest.startsWith("\x1b[") || rest.startsWith("\x1b_")) {
      // A reply or sequence still arriving, or one we don't use.
      const done = /^\x1b(?:\[[0-9;:<=>?$]*[ -/]*[@-~]|_[^\x1b]*\x1b\\)/.exec(rest);
      if (!done) break;
      m = done;
    } else if (rest[0] === "\x1b") {
      if (rest.length === 1) { events.push({ type: "key", key: "Escape", code: 27, modifiers: 0 }); i += 1; continue; }
      i += 1; // Alt+key, which a page rarely wants. The key itself still arrives.
      continue;
    } else {
      const char = String.fromCodePoint(rest.codePointAt(0));
      events.push(key(char));
      i += char.length;
      continue;
    }
    i += m[0].length;
  }
  return { events, leftover: text.slice(i) };
}

function modifiers(n) {
  const m = n - 1; // terminal: shift 1, alt 2, ctrl 4. CDP: alt 1, ctrl 2, meta 4, shift 8.
  return (m & 2 ? 1 : 0) | (m & 4 ? 2 : 0) | (m & 1 ? 8 : 0);
}

function mouse(b, x, y, down) {
  const base = { x, y };
  if (b & 64) return { type: "wheel", ...base, deltaY: b & 1 ? 60 : -60 };
  const button = ["left", "middle", "right", "none"][b & 3];
  if (b & 32) return { type: "move", ...base, button };
  return { type: down ? "press" : "release", ...base, button };
}

function key(char) {
  const c = char.charCodeAt(0);
  if (char === "\r" || char === "\n") return { type: "key", key: "Enter", code: 13, text: "\r", modifiers: 0 };
  if (char === "\t") return { type: "key", key: "Tab", code: 9, modifiers: 0 };
  if (c === 0x7f || c === 8) return { type: "key", key: "Backspace", code: 8, modifiers: 0 };
  if (c === 0x0c) return { type: "address" };
  if (c === 0x11) return { type: "quit" };
  if (c < 0x20) {
    const letter = String.fromCharCode(c + 96);
    return { type: "key", key: letter, code: letter.toUpperCase().charCodeAt(0), modifiers: 2 };
  }
  return { type: "key", key: char, text: char, code: char.toUpperCase().charCodeAt(0), modifiers: 0 };
}
