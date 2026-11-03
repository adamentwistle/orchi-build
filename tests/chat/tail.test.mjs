import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Windows has no python3: that name is the Microsoft Store stand-in.
const PYTHON = process.platform === "win32" ? "python" : "python3";

const TAIL = fileURLToPath(new URL("../../mods/claude-chat/tail.py", import.meta.url));
const run = (...args) => JSON.parse(execFileSync(PYTHON, ["-I", "-S", TAIL, ...args.map(String)], { maxBuffer: 1 << 24 }));
const at = "2026-10-31T12:00:00.000Z";

function file(lines, name = "t.jsonl") {
  const path = join(mkdtempSync(join(tmpdir(), "tail-")), name);
  writeFileSync(path, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return path;
}

const user = (content, extra = {}) => ({ type: "user", timestamp: at, message: { role: "user", content }, ...extra });
const assistant = (content, extra = {}) => ({ type: "assistant", timestamp: at, message: { role: "assistant", content }, ...extra });
const say = (text) => assistant([{ type: "text", text }]);
const call = (id, name, input) => assistant([{ type: "tool_use", id, name, input }]);
const result = (id, content, is_error = false) => user([{ type: "tool_result", tool_use_id: id, content, is_error }]);
const kinds = (r) => r.rows.map((x) => x.kind);

test("keeps messages and drops the bookkeeping", () => {
  const r = run(file([
    { type: "api-request-blob", message: { content: "x" } },
    { type: "attachment", attachment: {} },
    { type: "mode", mode: "auto" },
    user("hello"),
    assistant([{ type: "thinking", thinking: "secret" }]),
    say("hi there"),
    { type: "system", subtype: "stop_hook_summary" },
    { type: "system", subtype: "turn_duration", durationMs: 41000, timestamp: at },
  ]), "--last", 60);
  assert.deepEqual(kinds(r), ["user", "text", "worked"]);
  assert.equal(r.rows[0].text, "hello");
  assert.equal(r.rows[1].text, "hi there");
  assert.equal(r.rows[2].ms, 41000);
  assert.equal(r.rows[2].at, Date.parse(at));
  assert.equal(r.more, false);
});

test("drops meta lines, subagents and summaries", () => {
  const r = run(file([
    user("skill text", { isMeta: true }),
    user("from a subagent", { isSidechain: true }),
    say("nor this") && { ...say("nor this"), isSidechain: true },
    user("a summary", { isCompactSummary: true }),
    user("<local-command-caveat>x</local-command-caveat>"),
    user("kept"),
  ]), "--last", 60);
  assert.deepEqual(r.rows.map((x) => x.text), ["kept"]);
});

test("a slash command reads as typed, and /clear as a line", () => {
  const r = run(file([
    user("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
    user("<command-message>go</command-message>\n<command-name>/go</command-name>\n<command-args>lantern</command-args>"),
    user("<local-command-stdout>Done\x1b[0m</local-command-stdout>"),
    user("<local-command-stdout></local-command-stdout>"),
    { type: "system", subtype: "local_command", timestamp: at, content: "<local-command-stdout>Set model</local-command-stdout>" },
    { type: "system", subtype: "compact_boundary", timestamp: at },
    { type: "system", subtype: "away_summary", content: "a recap" },
  ]), "--last", 60);
  assert.deepEqual(r.rows.map((x) => [x.kind, x.text]), [
    ["sys", "Conversation cleared"], ["user", "/go lantern"], ["sys", "Done"], ["sys", "Set model"], ["sys", "Conversation compacted"],
  ]);
});

test("shell lines, notifications, interrupts and tags", () => {
  const r = run(file([
    user("<bash-input>ls</bash-input>"),
    user("<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>"),
    user("<task-notification>\n<summary>A review finished</summary>\n</task-notification>"),
    user([{ type: "text", text: "[Request interrupted by user]" }]),
    user('<hc from="t4">/model</hc>'),
    user('<pasted_content id="1">\nsome paste\n</pasted_content>'),
    user("before<system-reminder>hidden</system-reminder>"),
  ]), "--last", 60);
  assert.deepEqual(r.rows.map((x) => [x.kind, x.text]), [
    ["user", "!ls"], ["sys", "a"], ["sys", "A review finished"], ["sys", "Interrupted"], ["user", "/model"], ["user", "some paste"], ["user", "before"],
  ]);
});

const image = (bytes = 12) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(bytes) } });

test("a pasted image reads as [image] where it was pasted, and is counted", () => {
  const r = run(file([user([image(), { type: "text", text: "[Image #1] does this help?" }])]), "--last", 60);
  assert.equal(r.rows[0].kind, "user");
  assert.equal(r.rows[0].text, "[image] does this help?");
  assert.equal(r.rows[0].images, 1);
});

test("a message of only images still makes a row", () => {
  const r = run(file([user([image(), image()])]), "--last", 60);
  assert.equal(r.rows[0].text, "[image] [image]");
  assert.equal(r.rows[0].images, 2);
});

test("an image with no mark in the text goes on the end", () => {
  const r = run(file([user([{ type: "text", text: "Look" }, image(), image()])]), "--last", 60);
  assert.equal(r.rows[0].text, "Look [image] [image]");
});

test("a typed [Image #1] with no image stays as typed, and a row with none has no count", () => {
  const r = run(file([user("I said [Image #1] earlier")]), "--last", 60);
  assert.equal(r.rows[0].text, "I said [Image #1] earlier");
  assert.equal("images" in r.rows[0], false);
});

test("image data never reaches a reply, and big images keep it under 1 MiB in both directions", () => {
  const path = file(Array.from({ length: 40 }, () => user([image(1 << 20), { type: "text", text: "[Image #1] x" }])));
  for (const r of [run(path, "--last", 60), run(path, "--from", 0)]) {
    const text = JSON.stringify(r);
    assert.ok(text.length < 1 << 20);
    assert.equal(text.includes("AAAA"), false);
  }
  assert.equal(run(path, "--last", 60).rows.length, 40);
});

test("an image in a tool result stays out of its text too", () => {
  const path = file([result("t1", [{ type: "text", text: "shot" }, image(1 << 20)])]);
  const { rows } = run(path, "--last", 60);
  assert.equal(rows[0].size, 12);
  assert.equal(run(path, "--result", rows[0].line, "--tool", "t1").text, "shot\n[image]");
});

test("a tool call and its result are rows, and the result's text stays behind", () => {
  const path = file([call("t1", "Bash", { command: "ls -la\nsecond line", description: "List" }), result("t1", "a\nb\nc")]);
  const r = run(path, "--last", 60);
  assert.deepEqual(kinds(r), ["tool", "result"]);
  assert.equal(r.rows[0].tool, "t1");
  assert.equal(r.rows[0].name, "Bash");
  assert.equal(r.rows[0].target, "ls -la");
  assert.equal(r.rows[1].tool, "t1");
  assert.equal(r.rows[1].ok, true);
  assert.equal(r.rows[1].size, 5);
  assert.equal(JSON.stringify(r).includes("a\\nb"), false);
});

test("a tool's target comes from its most telling field", () => {
  const r = run(file([
    call("1", "Read", { file_path: "/a/b.js", limit: 3 }),
    call("2", "Grep", { pattern: "foo", path: "src" }),
    call("3", "WebFetch", { url: "https://x.dev" }),
    call("4", "Odd", { nested: { a: 1 }, name: "plain" }),
    call("5", "None", {}),
  ]), "--last", 60);
  assert.deepEqual(r.rows.map((x) => x.target), ["/a/b.js", "foo", "https://x.dev", "plain", ""]);
});

test("--result fetches one result with ANSI stripped, and marks an error", () => {
  const path = file([call("t1", "Bash", {}), result("t1", [{ type: "text", text: "\x1b[31mred\x1b[0m" }], true)]);
  const { rows } = run(path, "--last", 60);
  const r = run(path, "--result", rows[1].line, "--tool", "t1");
  assert.deepEqual(r, { tool: "t1", text: "red", ok: false, clipped: false });
});

test("--result clips a huge result and misses cleanly", () => {
  const path = file([result("t1", "x".repeat(200000))]);
  const { rows } = run(path, "--last", 60);
  const r = run(path, "--result", rows[0].line, "--tool", "t1");
  assert.equal(r.clipped, true);
  assert.equal(r.text.length, 24000);
  assert.equal(run(path, "--result", rows[0].line, "--tool", "nope").missing, true);
  assert.equal(run(path, "--result", 3, "--tool", "t1").missing, true);
});

test("--code fetches the whole of a clipped code row, for Copy", () => {
  const big = "y".repeat(40000);
  const path = file([say("intro\n```js\n" + big + "\n```\nafter"), assistant([{ type: "text", text: "a" }, { type: "text", text: "```py\n" + big + "\n```" }])]);
  const { rows } = run(path, "--last", 60);
  const codes = rows.filter((x) => x.kind === "code");
  assert.deepEqual(codes.map((x) => [x.code.length, x.clipped]), [[16000, true], [16000, true]]);
  for (const row of codes) {
    const r = run(path, "--code", row.id.split(".")[0], "--id", row.id);
    assert.deepEqual(r, { id: row.id, code: big, clipped: false });
  }
  assert.equal(run(path, "--code", codes[0].id.split(".")[0], "--id", "nope").missing, true);
  assert.equal(run(path, "--code", 3, "--id", codes[0].id).missing, true);
});

test("code fences become code rows between prose rows", () => {
  const r = run(file([say("Before\n\n```bash\ngit status\n\n  two\n```\nAfter\n\n~~~\nplain\n~~~\n\n```js\nunclosed")]), "--last", 60);
  assert.deepEqual(r.rows.map((x) => [x.kind, x.lang ?? null, x.code ?? x.text]), [
    ["text", null, "Before"], ["code", "bash", "git status\n\n  two"], ["text", null, "After"], ["code", "", "plain"], ["code", "js", "unclosed"],
  ]);
  assert.equal(new Set(r.rows.map((x) => x.id)).size, 5);
});

test("a block's text splits into paragraphs, headings and list items, sharing a block", () => {
  const r = run(file([say("Intro line\nstill intro\n\n## Title\nAfter it\n\n1. one\n2. two\n- three\n\n| a |\n|---|\n| 1 |")]), "--last", 60);
  assert.deepEqual(r.rows.map((x) => x.text), ["Intro line\nstill intro", "## Title", "After it", "1. one", "2. two", "- three", "| a |\n|---|\n| 1 |"]);
  assert.equal(new Set(r.rows.map((x) => x.block)).size, 1);
  assert.equal(new Set(r.rows.map((x) => x.id)).size, 7);
});

test("a code row shares its block with the text around it", () => {
  const r = run(file([say("Before\n\n```js\nx\n```\n\nAfter"), say("Next")]), "--last", 60);
  assert.equal(new Set(r.rows.slice(0, 3).map((x) => x.block)).size, 1);
  assert.notEqual(r.rows[3].block, r.rows[0].block);
});

test("a block counts as one message, however many chunks it has", () => {
  const r = run(file(Array.from({ length: 5 }, (_, i) => say(`a${i}\n\nb${i}\n\nc${i}`))), "--last", 2);
  assert.equal(r.rows.length, 6);
  assert.equal(r.rows[0].text, "a3");
});

test("a shorter fence inside a longer one stays code", () => {
  const r = run(file([say("````md\n```js\nx\n```\n````")]), "--last", 60);
  assert.deepEqual(r.rows.map((x) => x.code), ["```js\nx\n```"]);
});

test("a Markdown image keeps its words and loses its address", () => {
  const r = run(file([say("See ![a chart](https://evil.example/pixel.png) here")]), "--last", 60);
  assert.equal(r.rows[0].text, "See a chart here");
});

test("--last stops at N messages and reports where it stopped", () => {
  const lines = Array.from({ length: 200 }, (_, i) => say(`m${i}`));
  const path = file(lines);
  const r = run(path, "--last", 60);
  assert.equal(r.rows.length, 60);
  assert.equal(r.rows[0].text, "m140");
  assert.equal(r.rows[59].text, "m199");
  assert.equal(r.more, true);
  assert.equal(r.end, statSync(path).size);
  const line = readFileSync(path).subarray(r.start).toString().split("\n")[0];
  assert.equal(JSON.parse(line).message.content[0].text, "m140");
});

test("--before reads the page above, and pages meet with no gap and no repeat", () => {
  const path = file(Array.from({ length: 150 }, (_, i) => say(`m${i}`)));
  const seen = [];
  let r = run(path, "--last", 60);
  seen.unshift(...r.rows.map((x) => x.text));
  while (r.more) {
    r = run(path, "--last", 60, "--before", r.start);
    seen.unshift(...r.rows.map((x) => x.text));
  }
  assert.deepEqual(seen, Array.from({ length: 150 }, (_, i) => `m${i}`));
});

test("row ids don't change with the page that read them", () => {
  const path = file(Array.from({ length: 100 }, (_, i) => say(`m${i}`)));
  const a = run(path, "--last", 60), b = run(path, "--last", 100);
  assert.deepEqual(b.rows.slice(-60).map((x) => x.id), a.rows.map((x) => x.id));
});

test("--from picks up what was added, and leaves a half-written line", () => {
  const path = file([say("one")]);
  const first = run(path, "--last", 60);
  appendFileSync(path, `${JSON.stringify(say("two"))}\n{"type":"assistant","mess`);
  const r = run(path, "--from", first.end);
  assert.deepEqual(r.rows.map((x) => x.text), ["two"]);
  appendFileSync(path, `age":{"content":[{"type":"text","text":"three"}]}}\n`);
  const next = run(path, "--from", r.end);
  assert.deepEqual(next.rows.map((x) => x.text), ["three"]);
  assert.equal(next.end, statSync(path).size);
});

test("a first read ignores a half-written last line, and the next read gets it", () => {
  const path = file([say("one")]);
  appendFileSync(path, '{"type":"assistant","mess');
  const r = run(path, "--last", 60);
  assert.deepEqual(r.rows.map((x) => x.text), ["one"]);
  appendFileSync(path, `age":{"content":[{"type":"text","text":"two"}]}}\n`);
  assert.deepEqual(run(path, "--from", r.end).rows.map((x) => x.text), ["two"]);
});

test("an unreadable line is skipped, and a shrunk file asks for a reset", () => {
  const path = file([say("one"), "{not json", say("two")]);
  assert.deepEqual(run(path, "--last", 60).rows.map((x) => x.text), ["one", "two"]);
  assert.equal(run(path, "--from", 1e9).reset, true);
});

test("a missing file and a wrong path are plain answers", () => {
  const dir = mkdtempSync(join(tmpdir(), "tail-"));
  assert.equal(run(join(dir, "gone.jsonl"), "--last", 60).missing, true);
  assert.equal(run(join(dir, "gone.txt"), "--last", 60).error, "not a transcript");
});

test("an empty file reads as no rows", () => {
  const path = join(mkdtempSync(join(tmpdir(), "tail-")), "e.jsonl");
  writeFileSync(path, "");
  const r = run(path, "--last", 60);
  assert.deepEqual([r.rows, r.start, r.end, r.more], [[], 0, 0, false]);
});

test("lines longer than the read chunk are handled", () => {
  const big = "y".repeat(3 << 20);
  const path = file([say("first"), result("t", big), say("last")]);
  const r = run(path, "--last", 60);
  assert.deepEqual(kinds(r), ["text", "result", "text"]);
  assert.equal(r.rows[1].size, big.length);
  assert.equal(r.start, 0);
});

test("a reply stays under 1 MiB, in both directions, with long text clipped", () => {
  const long = "z".repeat(50000);
  const path = file(Array.from({ length: 300 }, () => say(long)));
  const back = run(path, "--last", 300);
  assert.ok(JSON.stringify(back).length < 1 << 20);
  assert.ok(back.rows.length < 300);
  assert.equal(back.more, true);
  assert.equal(back.rows.at(-1).clipped, true);
  const forward = run(path, "--from", 0);
  assert.ok(JSON.stringify(forward).length < 1 << 20);
  assert.equal(forward.partial, true);
  assert.ok(forward.end < statSync(path).size);
  const next = run(path, "--from", forward.end);
  assert.equal(next.start, forward.end);
});

test("a page ends where the reply limit stopped it, so the next page has no gap", () => {
  const path = file(Array.from({ length: 200 }, (_, i) => say(`${i} ${"z".repeat(20000)}`)));
  const seen = [];
  let r = run(path, "--last", 500);
  seen.unshift(...r.rows.map((x) => parseInt(x.text, 10)));
  while (r.more) {
    r = run(path, "--last", 500, "--before", r.start);
    seen.unshift(...r.rows.map((x) => parseInt(x.text, 10)));
  }
  assert.deepEqual(seen, Array.from({ length: 200 }, (_, i) => i));
});

test("text in a transcript that looks like an order stays text", () => {
  const r = run(file([say("$(rm -rf ~) `hc send t1 x`")]), "--last", 60);
  assert.equal(r.rows[0].text, "$(rm -rf ~) `hc send t1 x`");
});

test("it opens the transcript for reading only", () => {
  const source = readFileSync(TAIL, "utf8");
  assert.deepEqual([...source.matchAll(/\bopen\(([^)]*)\)/g)].map((m) => m[1]), ["args.path, \"rb\""]);
});

test("queue lines come through for the tray and count as no message", () => {
  const r = run(file([
    user("hello"),
    { type: "queue-operation", operation: "enqueue", timestamp: at, content: "later \u001b[31mplease" },
    { type: "queue-operation", operation: "dequeue", timestamp: at },
  ]), "--last", 1);
  assert.deepEqual(r.rows.filter((x) => x.kind === "queue").map((x) => [x.op, x.text]), [["enqueue", "later please"], ["dequeue", null]]);
  assert.equal(r.rows.filter((x) => x.kind === "user").length, 1);
});

test("a long queue line is clipped and says so", () => {
  const r = run(file([{ type: "queue-operation", operation: "enqueue", timestamp: at, content: "x".repeat(20_000) }]), "--last", 5);
  assert.equal(r.rows[0].clipped, true);
});

test("a queued message that reached the model mid-turn is a message of yours", () => {
  const r = run(file([
    { type: "attachment", timestamp: at, attachment: { type: "queued_command", prompt: "keep going", humanTurn: true } },
    { type: "attachment", timestamp: at, attachment: { type: "queued_command", prompt: "<task-notification>x", humanTurn: false } },
    { type: "attachment", timestamp: at, attachment: { type: "queued_command", humanTurn: true, prompt: [{ type: "text", text: "[Image #7]What is this?" }, { type: "image", source: { data: "AAAA" } }] } },
  ]), "--last", 5);
  assert.deepEqual(r.rows.map((x) => [x.kind, x.text]), [["user", "keep going"], ["user", "[image]What is this?"]]);
  assert.equal(r.rows[1].images, 1);
  assert.ok(!JSON.stringify(r).includes("AAAA"));
});

// ---- what Markdown could do with a row, and lines that can't be read ----

const textOf = (text) => run(file([say(text)]), "--last", 10).rows.map((r) => r.text ?? r.code).join("\n");

test("an image with brackets in its words or brackets in its address loses its address", () => {
  assert.equal(textOf("![[x]](http://e/p.png) end"), "\\[x\\] end");
  assert.equal(textOf("![a](http://e/a(1).png) end"), "a end");
  assert.equal(textOf('![a](http://e/a.png "title") end'), "a end");
});

test("a link that isn't http or https keeps only its words", () => {
  assert.equal(textOf("[docs](file:///etc/hosts) [web](https://e.com/a_(b)) [mail](mailto:a@b.c) [up](HTTP://E.COM) [here](notes.md)"), "docs [web](https://e.com/a_(b)) mail [up](HTTP://E.COM) here");
});

test("an autolink and a reference that aren't http or https stop being links", () => {
  assert.equal(textOf("see <file:///etc/hosts> and <https://e.com>"), "see file:///etc/hosts and <https://e.com>");
  assert.equal(textOf("[a][r] then\n\n[r]: file:///etc/hosts"), "\\[a\\]\\[r\\] then");
  assert.equal(textOf("[a][r] then\n\n[r]: https://e.com"), "\\[a\\]\\[r\\] then\n\\[r\\]: https://e.com");
});

// Every bracket and `<` left in prose is escaped, so these draw as the text they are. Only the safe shapes stay links.
test("shapes the link patterns miss can't become links or HTML", () => {
  assert.equal(textOf("[a[b[c]]](file:///etc/hosts)"), "\\[a\\[b\\[c\\]\\]\\](file:///etc/hosts)");
  assert.equal(textOf("[x](file:///tmp/a((b)))"), "\\[x\\](file:///tmp/a((b)))");
  assert.equal(textOf("[r]:\n  file:///etc/hosts\n\nsee [r]"), "see \\[r\\]");
  assert.equal(textOf('<a href="file:///etc/hosts">x</a> and <img src="file:///y">'), '\\<a href="file:///etc/hosts">x\\</a> and \\<img src="file:///y">');
  assert.equal(textOf("[w <b>](https://e.com) <https://e.com/x>"), "[w \\<b>](https://e.com) <https://e.com/x>");
});

// Shapes where a regex and a Markdown parser can disagree on where code or a link starts. Code is found as CommonMark finds
// it, so text Markdown would draw as a link is never mistaken for code and left alone.
test("an escaped backtick or a backtick run that doesn't match isn't code, so a link after it is made safe", () => {
  assert.equal(textOf("\\`[x](file:///etc/hosts)`"), "\\`x`");
  assert.equal(textOf("`[x](file:///etc/hosts)``"), "`x``");
  assert.equal(textOf("``[x](file:///a)`` and \\\\`[y](file:///b)`"), "``[x](file:///a)`` and \\\\`[y](file:///b)`");
  assert.equal(textOf("`a` [b](file:///c) `d`"), "`a` b `d`");
});

test("a safe-looking link whose closing bracket is escaped isn't kept as a link", () => {
  assert.equal(textOf("[a\\](https://e.com) z"), "\\[a\\](https://e.com) z");
  assert.equal(textOf("[a\\\\](https://e.com) z"), "[a\\\\](https://e.com) z");
});

test("odd addresses, schemes and line breaks never keep a link that isn't http or https", () => {
  for (const shape of ["[x](<file:///a b>)", "[x](file&#58;///etc)", "[x](FiLe:///etc)", "[x]( file:///etc)", "[x](\x01file:///etc)", "[x](\nfile:///etc)", "[x](javascript:alert(1))"]) {
    assert.equal(textOf(shape), "x", JSON.stringify(shape));
  }
  assert.equal(textOf("[x\ny](file:///etc)"), "x\ny");
  assert.equal(textOf("[x]\n(file:///etc)"), "\\[x\\]\n(file:///etc)");
  assert.equal(textOf("<file:///x> <FILE:x> <https://e.com>"), "file:///x FILE:x <https://e.com>");
  assert.equal(textOf("[x]( https://e.com)"), "x");
});

test("each chunk is made safe as its own document, so a code span can't reach across a paragraph", () => {
  assert.equal(textOf("one `start\n\n[x](file:///etc/hosts) end`"), "one `start\nx end`");
});

test("escaping leaves task boxes, text already escaped and inline code as written", () => {
  assert.equal(textOf("- [ ] todo"), "- [ ] todo");
  assert.equal(textOf("- [x] done"), "- [x] done");
  assert.equal(textOf("a \\[b] 1 < 2 `[c](file:///x) <b>`"), "a \\[b\\] 1 \\< 2 `[c](file:///x) <b>`");
  assert.equal(textOf("a \\\\[b](file:///x)"), "a \\\\b");
});

test("code keeps what looks like an image or a link", () => {
  const code = "![a](http://e/a.png) [x](file:///y)";
  assert.equal(textOf("```md\n" + code + "\n```"), code);
});

test("one line that can't be mapped loses only itself", () => {
  const path = file([say("before"), { type: "assistant", timestamp: at, message: "not an object" }, say("after")]);
  assert.deepEqual(run(path, "--last", 10).rows.map((r) => r.text), ["before", "after"]);
  assert.deepEqual(run(path, "--from", 0).rows.map((r) => r.text), ["before", "after"]);
});

test("half a surrogate pair in a line can't stop the reply", () => {
  const path = file([say("before"), '{"type":"assistant","timestamp":"' + at + '","message":{"role":"assistant","content":[{"type":"text","text":"a\\ud83db"}]}}', say("after")]);
  const rows = run(path, "--last", 10).rows.map((r) => r.text);
  assert.equal(rows.length, 3);
  assert.equal(rows[2], "after");
});
