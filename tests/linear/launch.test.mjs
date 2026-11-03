import test from "node:test";
import assert from "node:assert/strict";
import { appBin, claudeArgv, localSpace, startClaude } from "../../mods/linear/launch.js";

const standIns = (run, renames = [{ code: 0, stdout: "{}" }]) => {
  const calls = [];
  const replies = [...renames];
  return {
    calls,
    home: () => "/Users/x",
    exec: async (command, args) => { calls.push([command, ...args]); return command === "sleep" ? { code: 0 } : replies.shift() ?? { code: 0, stdout: "{}" }; },
    hc: async (args) => { calls.push(["hc", ...args]); return run; },
  };
};

const STARTED = { code: 0, stdout: '{"address":"t9","state":"live"}' };
const ask = { model: "m", effort: "low", task: "go", tab: "Update", folder: "/l", space: "sp1", labels: ["linear.runner=1"] };

test("the task is one argument, whatever it contains", () => {
  assert.deepEqual(claudeArgv("m", "low", 'a; rm "$x"'), ["claude", "--model", "m", "--effort", "low", 'a; rm "$x"']);
});

test("flags go first, so a list flag can't swallow the task", () => {
  assert.deepEqual(claudeArgv("m", "low", "go", ["--tools", "Read"]), ["claude", "--tools", "Read", "--model", "m", "--effort", "low", "go"]);
});

test("startClaude opens a labelled terminal and names its tab", async () => {
  const s = standIns(STARTED);
  assert.equal(await startClaude(s, ask), "t9");
  const run = s.calls[0];
  assert.deepEqual(run.slice(0, 3), ["hc", "run", "--json"]);
  assert.equal(run[run.indexOf("--cwd") + 1], "/l");
  const labels = run.flatMap((a, i) => (a === "--label" ? [run[i + 1]] : []));
  assert.equal(labels[0], "herdr.space=sp1");
  assert.match(labels[1], /^herdr\.tab=tb/);
  assert.equal(labels[2], "linear.runner=1");
  const [command, action, verb, json] = s.calls[1];
  assert.deepEqual([command, action, verb], ["herdr-app", "do", "tab.rename"]);
  assert.deepEqual(JSON.parse(json), { id: labels[1].split("=")[1], name: "Update" });
});

test("every label in the array reaches the terminal, each its own argument", async () => {
  const s = standIns(STARTED);
  await startClaude(s, { ...ask, labels: ["orchi.plan=s1", "orchi.session=s1", "orchi.tickets=ENG-1,ENG-2"] });
  const run = s.calls[0];
  const labels = run.flatMap((a, i) => (a === "--label" ? [run[i + 1]] : []));
  assert.deepEqual(labels.slice(2), ["orchi.plan=s1", "orchi.session=s1", "orchi.tickets=ENG-1,ENG-2"]);
});

test("no labels is fine", async () => {
  const s = standIns(STARTED);
  const { labels: _none, ...rest } = ask;
  assert.equal(await startClaude(s, rest), "t9");
  assert.equal(s.calls[0].filter((a) => a === "--label").length, 2);
});

test("a name reaches hc run, and with none there's no flag", async () => {
  const named = standIns(STARTED);
  await startClaude(named, { ...ask, name: "switchboard" });
  const run = named.calls[0];
  assert.equal(run[run.indexOf("--name") + 1], "switchboard");
  assert.ok(run.indexOf("--name") < run.indexOf("--"));
  const plain = standIns(STARTED);
  await startClaude(plain, ask);
  assert.ok(!plain.calls[0].includes("--name"));
});

test("a space this start opens gets its name, once it exists", async () => {
  const late = { code: 1, stdout: '{"error":"no space \\"sp1\\""}' };
  const s = standIns(STARTED, [{ code: 0, stdout: "{}" }, late, { code: 0, stdout: "{}" }]);
  await startClaude(s, { ...ask, spaceName: "Planning" });
  const renames = s.calls.filter((c) => c[2] === "space.rename");
  assert.equal(renames.length, 2);
  assert.deepEqual(JSON.parse(renames[1][3]), { id: "sp1", name: "Planning" });
});

test("a space that isn't opened here isn't renamed", async () => {
  const s = standIns(STARTED);
  await startClaude(s, ask);
  assert.ok(!s.calls.some((c) => c[2] === "space.rename"));
});

test("it never uses tab.new, which moves the window", async () => {
  const s = standIns(STARTED);
  await startClaude(s, ask);
  assert.ok(!s.calls.flat().includes("tab.new"));
});

test("the session gets the launcher first on PATH, with the task still one argument", async () => {
  const s = standIns(STARTED);
  await startClaude(s, { ...ask, task: 'a; rm "$x"' });
  const run = s.calls[0];
  const argv = run.slice(run.indexOf("--") + 1);
  assert.deepEqual(argv.slice(0, 2), ["/bin/zsh", "-ic"]);
  assert.match(argv[2], /^export PATH="\$1:\$PATH" HERDR_ENV=1; shift; "\$@"; exec zsh -i$/);
  assert.deepEqual(argv.slice(3), ["zsh", appBin("/Users/x"), "claude", "--model", "m", "--effort", "low", 'a; rm "$x"']);
});

test("each start gets its own tab id", async () => {
  const tabs = [];
  for (let i = 0; i < 2; i++) {
    const s = standIns(STARTED);
    await startClaude(s, ask);
    tabs.push(s.calls[0].find((a) => a.startsWith("herdr.tab=")));
  }
  assert.notEqual(tabs[0], tabs[1]);
});

test("it waits for the tab to appear", async () => {
  const late = { code: 1, stdout: '{"error":"no tab \\"x\\""}' };
  const s = standIns(STARTED, [late, late, { code: 0, stdout: "{}" }]);
  await startClaude(s, ask);
  assert.equal(s.calls.filter((c) => c[2] === "tab.rename").length, 3);
  assert.equal(s.calls.filter((c) => c[0] === "sleep").length, 2);
});

test("a tab that never takes its name still returns the running session", async () => {
  const s = standIns(STARTED, Array(50).fill({ code: 1, stdout: "no tab" }));
  assert.equal(await startClaude(s, ask), "t9");
  assert.equal(s.calls.filter((c) => c[2] === "tab.rename").length, 20);
});

test("a failed start throws and names nothing", async () => {
  for (const reply of [{ code: 1, stdout: "" }, { code: 0, stdout: "not json" }, { code: 0, stdout: "{}" }]) {
    const s = standIns(reply);
    await assert.rejects(startClaude(s, ask));
    assert.equal(s.calls.length, 1);
  }
});

test("no space on this Mac starts nothing", async () => {
  const s = standIns(STARTED);
  await assert.rejects(startClaude(s, { ...ask, space: null }));
  assert.equal(s.calls.length, 0);
});

test("the space is the folder's, else the shown one, and never another machine's", () => {
  const list = [
    { id: "win", folder: "/l", machine: "win", active: true },
    { id: "a", folder: "/a", machine: null, active: false },
    { id: "b", folder: "/l", machine: null, active: false },
    { id: "c", folder: "/c", machine: null, active: true },
  ];
  assert.equal(localSpace(list, "/l"), "b");
  assert.equal(localSpace(list, "/none"), "c");
  assert.equal(localSpace(list.map((s) => ({ ...s, active: false })), "/none"), "a");
  assert.equal(localSpace([list[0]], "/l"), null);
});
