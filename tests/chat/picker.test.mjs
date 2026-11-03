import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyChoice, matches, readyState, padModels, parseApplied, parsePicker, parseStatus, parseSwitchDialog, planEffort, planModel, readModels, EFFORTS, FALLBACK_MODELS } from "../../mods/claude-chat/picker.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), "utf8");
const FAMILIES = { opus: "Opus 5.5", fable: "Fable 5.1", sonnet: "Sonnet 5.5", haiku: "Haiku 5.5" };

test("every saved picker reads with the cursor on its model and the effort line at its level", () => {
  for (const [family, name] of Object.entries(FAMILIES)) {
    for (const effort of EFFORTS) {
      const picker = parsePicker(fixture(`picker-${family}-${effort}`));
      assert.ok(picker, `${family} ${effort} parses`);
      assert.equal(picker.rows.find((r) => r.marked).name, name, `${family} ${effort} cursor`);
      assert.equal(picker.effort.level, effort, `${family} ${effort} effort`);
      assert.ok(matches(picker, { model: name, effort }));
    }
  }
});

test("a tall picker shows ten rows, the tick on the session's model and the rows past the end counted", () => {
  const p = parsePicker(fixture("picker-long-haiku-low"));
  assert.equal(p.rows.length, 10);
  assert.deepEqual(p.rows.slice(0, 2).map((r) => [r.n, r.name]), [[1, "Default (recommended)"], [2, "Opus 5.5"]]);
  assert.equal(p.marked, 5);
  assert.equal(p.current, 5);
  assert.equal(p.hiddenBelow, 3);
  assert.equal(p.total, 13);
  assert.equal(p.hiddenAbove, false);
  assert.deepEqual(p.effort, { level: "low", isDefault: false });
  assert.equal(p.rows[4].name, "Haiku 5.5");
});

test("the picker in a narrow terminal names rows by family, and the version is taken from the hint", () => {
  const p = parsePicker(fixture("picker-narrow-top"));
  assert.deepEqual(p.rows.map((r) => [r.n, r.name]), [[1, "Default (recomme…"], [2, "Opus 5.5"], [3, "Fable 5.1"]]);
  assert.equal(p.marked, 2);
  const wide = parsePicker(fixture("picker-opus-high"));
  assert.deepEqual(wide.rows.map((r) => [r.n, r.name]), [[1, "Default (recommended)"], [2, "Opus 5.5"], [3, "Fable 5.1"], [4, "Sonnet 5.5"], [5, "Haiku 5.5"]]);
  assert.equal(wide.hiddenBelow, 0);
  assert.equal(wide.current, 2, "the tick is on the session's model, which was Opus before this change");
});

test("a scrolled picker numbers its rows from where it scrolled to", () => {
  const p = parsePicker(fixture("picker-long-scrolled"));
  assert.deepEqual(p.rows.map((r) => r.n), [11, 12, 13]);
  assert.equal(p.marked, 13);
  assert.equal(p.hiddenAbove, true);
  assert.equal(p.hiddenBelow, 0);
  assert.equal(p.total, 13);
});

test("the Max effort warning does not read as a row, and the (default) mark is kept", () => {
  assert.equal(parsePicker(fixture("picker-opus-max")).effort.level, "max");
  const lines = "   Select model\n   ❯ 1.  Sonnet 5.5   Efficient\n\n   ◐ Medium effort (default) ←/→ to adjust\n   Enter to set as default · s to use this session only · Esc to cancel\n";
  assert.deepEqual(parsePicker(lines).effort, { level: "medium", isDefault: true });
});

test("a screen without the picker, or with only the prompt, is not a picker", () => {
  assert.equal(parsePicker(""), null);
  assert.equal(parsePicker("❯ /model\n  ⎿  Kept model as Opus 5.5\n"), null);
  assert.equal(parsePicker("   Select model\n   no rows here\n"), null);
});

test("the pad's four models are the first of each family, without Default, in either picker layout", () => {
  const four = FALLBACK_MODELS.map((m) => ({ ...m }));
  assert.deepEqual(padModels(parsePicker(fixture("picker-opus-high"))), four, "five rows: Default, Opus, Fable, Sonnet, Haiku");
  assert.deepEqual(padModels(parsePicker(fixture("picker-long-haiku-low"))), four, "thirteen rows, where Haiku 4.5 repeats a family");
  assert.equal(padModels(parsePicker(fixture("picker-long-scrolled"))), null, "needs the top of the list");
  assert.equal(padModels({ rows: parsePicker(fixture("picker-long-haiku-low")).rows, hiddenAbove: false }, true).complete, true);
  assert.equal(padModels(parsePicker(fixture("picker-narrow-top")), true).complete, false, "a cut-off list has not reached the end");
});

test("model keys: from the marked row to the target by its number, up or down", () => {
  const p = parsePicker(fixture("picker-long-haiku-low"));
  assert.deepEqual(planModel(p, { name: "Sonnet 5.5" }).keys, ["up"]);
  assert.deepEqual(planModel(p, { name: "Opus 5.5" }).keys, ["up", "up", "up"]);
  assert.deepEqual(planModel(p, { name: "Haiku 5.5" }).keys, []);
  assert.deepEqual(planModel(parsePicker(fixture("picker-opus-low")), { name: "Haiku 5.5", n: 5 }).keys, ["down", "down", "down"], "a row out of sight goes by its number");
  assert.ok(planModel(p, { name: "Nothing", n: 99 }).error);
  assert.ok(planModel(null, { name: "x" }).error);
});

test("effort keys: left and right by the distance between levels", () => {
  const p = parsePicker(fixture("picker-long-haiku-low"));
  assert.deepEqual(planEffort(p, "low").keys, []);
  assert.deepEqual(planEffort(p, "xhigh").keys, ["right", "right", "right"]);
  assert.deepEqual(planEffort(parsePicker(fixture("picker-opus-max")), "low").keys, ["left", "left", "left", "left"]);
  assert.ok(planEffort(p, "ultra").error);
  assert.ok(planEffort({ effort: null }, "low").error);
});

test("the status line gives the model and effort, past the powerline glyphs and non-breaking spaces", () => {
  assert.deepEqual(parseStatus(fixture("status-haiku-max")), { model: "Haiku 5.5", effort: "max" });
  assert.deepEqual(parseStatus(fixture("status-fable-xhigh")), { model: "Fable 5.1", effort: "xhigh" });
  assert.deepEqual(parseStatus(fixture("status-opus-medium")), { model: "Opus 5.5", effort: "medium" });
  assert.deepEqual(parseStatus("   model:  Haiku 5.5  -  low  context: "), { model: "Haiku 5.5", effort: "low" });
});

test("the status line still gives the model when there is no effort, and the last line on the screen wins", () => {
  assert.deepEqual(parseStatus("model:  Claude Opus 5.5  context: 3%"), { model: "Claude Opus 5.5", effort: null });
  assert.deepEqual(parseStatus("model: Haiku 5.5 - low context: 1%\nmodel: Opus 5.5 - high context: 1%"), { model: "Opus 5.5", effort: "high" });
  assert.deepEqual(parseStatus("model: Opus 5.5 - high"), { model: "Opus 5.5", effort: "high" });
});

test("no status line, or a different one, reads as null", () => {
  assert.equal(parseStatus(""), null);
  assert.equal(parseStatus("dir: ~/Projects  gh: atlas-web"), null);
  assert.equal(parseStatus("model:"), null);
});

test("the line Claude Code prints after s, with or without the effort", () => {
  assert.deepEqual(parseApplied("  ⎿  Set model to Sonnet 5.5 for this session only with xhigh effort"), { model: "Sonnet 5.5", effort: "xhigh" });
  assert.deepEqual(parseApplied("  ⎿  Set model to Opus 5.5 for this session only"), { model: "Opus 5.5", effort: null });
  assert.equal(parseApplied("  ⎿  Kept model as Opus 5.5"), null);
});

// ---- the flow, against a fake Claude Code ----

// A fake session: the screen is the picker fixture for the cursor and effort, moved by the keys it is sent.
function fake({ status = "idle", failOn, stuck, confirm = false, askFor, silent = false, columns = 0, noEffortLine = false } = {}) {
  const models = [{ name: "Default (recommended)", n: 1 }, ...FALLBACK_MODELS];
  const st = { open: false, dialog: null, row: 5, effort: "low", model: "Haiku 5.5", sent: [], keys: [], applied: null, status };
  // A narrow terminal breaks a long line between words, and the rest carries on under it.
  const wrapped = (text) => {
    if (!columns) return text;
    const lines = [""];
    for (const word of text.split(" ")) {
      if (lines.at(-1).length + word.length + 6 > columns) lines.push("");
      lines[lines.length - 1] += `${lines.at(-1) ? " " : ""}${word}`;
    }
    return lines.join("\n     ");
  };
  const said = (model) => (model.startsWith("Default") ? "Opus 5.5 (default)" : model);
  const line = (r) => `${st.row === r.n ? "❯" : " "} ${r.n}.  ${r.name}${st.model === r.name ? " ✔" : ""}   hint`;
  const screen = () => {
    if (st.dialog) return `   Switch model?\n   Your next response will be slower and use more tokens\n\n   ❯ 1. Yes, switch to ${askFor ?? st.dialog}\n     2. No, go back`;
    if (st.open) {
      const label = { low: "Low", medium: "Medium", high: "High", xhigh: "xHigh", max: "Max" }[st.effort];
      return ["", "   Select model", ...models.map(line), "      … +8 models", "", ...(noEffortLine ? [] : [`   ◐ ${label} effort ←/→ to adjust`]), "", "   Enter to set as default · s to use this session only · Esc to cancel"].join("\n");
    }
    return `${st.old ? st.old + "\n" : ""}❯ /model\n  ⎿  ${wrapped(st.applied ?? "Kept model as " + st.model)}\n   model:  ${st.model}  -  ${st.effort}  context: 1%`;
  };
  const hc = {
    st,
    read: async () => screen(),
    status: async () => st.status,
    waitOutput: async () => {},
    send: async (t, text) => { st.sent.push(text); if (text === "/model") st.open = true; },
    keys: async (t, keys) => {
      for (const k of keys) {
        st.keys.push(k);
        if (st.dialog) {
          if (k === "1") { st.model = st.dialog; st.applied = `Set model to ${st.model} for this session only with ${st.effort} effort`; st.dialog = null; }
          if (k === "esc") st.dialog = null;
          continue;
        }
        if (!st.open) continue;
        const at = EFFORTS.indexOf(st.effort);
        if (k === "up") st.row = Math.max(1, st.row - 1);
        if (k === "down") st.row = Math.min(13, st.row + 1);
        if (k === "left") st.effort = EFFORTS[Math.max(0, at - 1)];
        if (k === "right") st.effort = EFFORTS[Math.min(4, at + 1)];
        if (k === failOn) st.row = 3; // a key that lands somewhere else
        if (k === "esc") st.open = false;
        if (k === "s") {
          st.open = false;
          const target = models.find((m) => m.n === st.row).name;
          if (confirm && target !== st.model && !stuck) st.dialog = target;
          else if (silent) { st.model = target; }
          else if (!stuck) { st.model = models.find((m) => m.n === st.row).name; st.applied = `Set model to ${said(st.model)} for this session only with ${st.effort} effort`; }
          else st.open = true;
        }
      }
    },
  };
  return hc;
}

test("the flow sets one session's model and effort with /model, arrows and s, and nothing else", async () => {
  const hc = fake();
  const result = await applyChoice(hc, "t1", { model: "Sonnet 5.5", effort: "xhigh" }, FALLBACK_MODELS[2]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.applied, { model: "Sonnet 5.5", effort: "xhigh" });
  assert.deepEqual(hc.st.sent, ["/model"]);
  assert.deepEqual(hc.st.keys, ["up", "right", "right", "right", "s"]);
  assert.equal(hc.st.keys.includes("enter"), false, "Enter would save a default");
  assert.equal(result.status, "match");
});

test("every model and effort is reachable, from every starting point", async () => {
  for (const from of FALLBACK_MODELS) {
    for (const to of FALLBACK_MODELS) {
      for (const effort of EFFORTS) {
        const hc = fake();
        hc.st.row = from.n; hc.st.model = from.name; hc.st.effort = EFFORTS[(effort === "low" ? 4 : 0)];
        const result = await applyChoice(hc, "t1", { model: to.name, effort }, to);
        assert.equal(result.ok, true, `${from.name} to ${to.name} ${effort}`);
        assert.equal(hc.st.model, to.name);
        assert.equal(hc.st.effort, effort);
        assert.equal(hc.st.open, false);
      }
    }
  }
});

test("a finished turn that has not been looked at is as safe as idle", async () => {
  assert.deepEqual(["idle", "done", "working", "blocked", null, undefined, "unknown"].map(readyState), [true, true, false, false, false, false, false]);
  const hc = fake({ status: "done" });
  const result = await applyChoice(hc, "t1", { model: "Opus 5.5", effort: "high" }, FALLBACK_MODELS[0]);
  assert.equal(result.ok, true);
});

test("a session that is not idle is left alone: nothing is sent", async () => {
  for (const status of ["working", "blocked", null]) {
    const hc = fake({ status });
    const result = await applyChoice(hc, "t1", { model: "Opus 5.5", effort: "high" }, FALLBACK_MODELS[0]);
    assert.deepEqual([result.ok, result.reason], [false, "busy"]);
    assert.deepEqual(hc.st.sent, []);
    assert.deepEqual(hc.st.keys, []);
  }
});

test("a cursor that lands on the wrong row is read back, then Esc, and s is never pressed", async () => {
  const hc = fake({ failOn: "up" });
  const result = await applyChoice(hc, "t1", { model: "Sonnet 5.5", effort: "high" }, FALLBACK_MODELS[2]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "model");
  assert.equal(result.closed, true);
  assert.equal(hc.st.keys.includes("s"), false);
  assert.equal(hc.st.keys.at(-1), "esc");
  assert.equal(hc.st.model, "Haiku 5.5", "the session is unchanged");
});

test("a picker that stays open after s is an error and ends with Esc", async () => {
  const hc = fake({ stuck: true });
  const result = await applyChoice(hc, "t1", { model: "Haiku 5.5", effort: "high" }, FALLBACK_MODELS[3]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "apply");
  assert.equal(hc.st.keys.at(-1), "esc");
});

test("a /model that opens no picker is an error and sends no keys", async () => {
  const hc = fake();
  hc.send = async (t, text) => { hc.st.sent.push(text); };
  const result = await applyChoice(hc, "t1", { model: "Opus 5.5", effort: "high" }, FALLBACK_MODELS[0]);
  assert.deepEqual([result.ok, result.reason], [false, "no picker"]);
  assert.deepEqual(hc.st.keys, []);
});

test("an error while reading closes the picker with Esc", async () => {
  const hc = fake();
  let reads = 0;
  const read = hc.read;
  hc.read = async (t) => { if (++reads > 2) throw new Error("hc went away"); return read(t); };
  const result = await applyChoice(hc, "t1", { model: "Opus 5.5", effort: "high" }, FALLBACK_MODELS[0]);
  assert.equal(result.ok, false);
  assert.match(result.detail, /hc went away/);
});

test("the draft is set aside before anything is sent", async () => {
  const hc = fake();
  const order = [];
  const send = hc.send;
  hc.send = async (...a) => { order.push("send"); return send(...a); };
  await applyChoice(hc, "t1", { model: "Haiku 5.5", effort: "low" }, FALLBACK_MODELS[3], { setAside: async () => order.push("aside") });
  assert.deepEqual(order.slice(0, 2), ["aside", "send"]);
});

test("reading the pad's models walks down a short screen and closes the picker", async () => {
  const hc = fake();
  // A short screen: only three rows at a time.
  const screen = hc.read;
  hc.read = async () => {
    const all = (await screen()).split("\n");
    if (!hc.st.open) return all.join("\n");
    const rows = all.filter((l) => /^\s*[❯ ]\s*\d+\./.test(l));
    const marked = hc.st.row;
    const start = Math.max(0, Math.min(rows.length - 3, marked - 2));
    const view = rows.slice(start, start + 3).map((l, i) => (start + i > 0 && i === 0 ? l.replace(/^(\s*)[❯ ]/, "$1↑") : l));
    return ["   Select model", ...view, `      … +${rows.length - start - 3} models`, "", "   ◐ Low effort ←/→ to adjust", "   Enter to set as default · s to use this session only · Esc to cancel"].join("\n");
  };
  const result = await readModels(hc, "t1");
  assert.equal(result.ok, true);
  assert.deepEqual(result.models.map((m) => m.name), FALLBACK_MODELS.map((m) => m.name));
  assert.equal(result.closed, true);
  assert.equal(hc.st.keys.at(-1), "esc");
  assert.deepEqual(hc.st.sent, ["/model"]);
});

test("the screens of the switch question read, and name the model it would switch to", () => {
  const text = readFileSync(new URL("./fixtures/switch-dialog.txt", import.meta.url), "utf8");
  assert.deepEqual(parseSwitchDialog(text), { model: "Sonnet 5.5" });
  assert.equal(parseSwitchDialog(fixture("picker-opus-high")), null);
  assert.equal(parseSwitchDialog("❯ /model\n  ⎿  Set model to Opus 5.5 for this session only"), null);
});

test("only the output of the latest /model counts as the result", () => {
  const old = "❯ /model\n  ⎿  Set model to Haiku 5.5 for this session only with low effort\n❯ hello\n";
  assert.equal(parseApplied(old).model, "Haiku 5.5");
  assert.equal(parseApplied(old + "❯ /model\n"), null, "a new /model with no result yet is not the old one");
  assert.equal(parseApplied(old + "❯ /model\n  ⎿  Kept model as Haiku 5.5"), null);
  assert.deepEqual(parseApplied(old + "❯ /model\n  ⎿  Set model to Opus 5.5 for this session only with max effort"), { model: "Opus 5.5", effort: "max" });
});

test("the switch question is answered with its own 1, when it names the chosen model", async () => {
  const hc = fake({ confirm: true });
  const result = await applyChoice(hc, "t1", { model: "Sonnet 5.5", effort: "high" }, FALLBACK_MODELS[2]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.applied, { model: "Sonnet 5.5", effort: "high" });
  assert.deepEqual(hc.st.keys.slice(-2), ["s", "1"]);
  assert.equal(hc.st.keys.includes("enter"), false);
  assert.equal(hc.st.model, "Sonnet 5.5");
});

test("a switch question that names another model is not answered: Esc, and the session is unchanged", async () => {
  const hc = fake({ confirm: true, askFor: "Opus 5" });
  const result = await applyChoice(hc, "t1", { model: "Sonnet 5.5", effort: "high" }, FALLBACK_MODELS[2]);
  assert.deepEqual([result.ok, result.reason, result.closed], [false, "dialog", true]);
  assert.equal(hc.st.keys.includes("1"), false);
  assert.equal(hc.st.model, "Haiku 5.5");
});

test("a result left over from an earlier change is not taken for this one", async () => {
  const hc = fake({ silent: true });
  hc.st.old = "❯ /model\n  ⎿  Set model to Haiku 5.5 for this session only with high effort";
  const result = await applyChoice(hc, "t1", { model: "Haiku 5.5", effort: "high" }, FALLBACK_MODELS[3]);
  assert.deepEqual([result.ok, result.reason], [false, "unconfirmed"], "the old line has the same model and effort, and still does not count");
});

test("the context percent comes from the status line, and is null without one", async () => {
  const { parseContext } = await import("../../mods/claude-chat/picker.js");
  assert.equal(parseContext(fixture("status-fable-xhigh")), 0);
  assert.equal(parseContext("context:  ▓▓░░░░░░░░ 15.1%   0"), 15.1);
  assert.equal(parseContext("no status line"), null);
});

test("a narrow terminal draws the picker another way, and what is read from it is not trusted", async () => {
  const { modelsLookRight } = await import("../../mods/claude-chat/picker.js");
  const narrow = parsePicker(fixture("picker-narrow-top"));
  assert.ok(narrow, "the narrow screen still reads as a picker");
  assert.equal(narrow.effort, null, "the effort line is cut off, so the flow has nothing to set");
  assert.ok(planEffort(narrow, "high").error);
  assert.equal(modelsLookRight(padModels({ rows: narrow.rows, hiddenAbove: false })), false);
  assert.equal(modelsLookRight(FALLBACK_MODELS), true);
  assert.equal(modelsLookRight(padModels(parsePicker(fixture("picker-long-haiku-low")))), true);
  for (const bad of [null, [], [{ name: "Opus", family: "Opus", n: 2 }], "x"]) assert.equal(modelsLookRight(bad), false);
});

// ---- what a terminal narrower than the result line does, and what a typed command doesn't name ----

test("a result line wrapped by a narrow terminal still reads, from a real 42 column screen", () => {
  const screen = readFileSync(new URL("./fixtures/result-wrapped-42.txt", import.meta.url), "utf8");
  assert.deepEqual(parseApplied(screen), { model: "Haiku 5.5", effort: "high" });
});

test("a wrapped result line counts only after the latest /model", () => {
  const screen = "  ⎿  Set model to Sonnet 5.5 for this\n     session only\n\n❯ /model\n  ⎿  Kept model as Haiku 5.5\n";
  assert.equal(parseApplied(screen), null);
});

test("the default row's name in the result line loses its mark", () => {
  assert.deepEqual(parseApplied("❯ /model\n  ⎿  Set model to Opus 5.5 (default) for this session only"), { model: "Opus 5.5", effort: null });
});

test("a change on a 42 column terminal is confirmed, not reported as a failure", async () => {
  const hc = fake({ columns: 42 });
  const result = await applyChoice(hc, "t1", { model: "Sonnet 5.5", effort: "low" }, FALLBACK_MODELS[2]);
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(result.set, { model: "Sonnet 5.5", effort: "low" });
});

test("the question before a switch reads when its model wraps", () => {
  const screen = "   Switch model?\n\n   ❯ 1. Yes, switch to Sonnet\n        5.5\n     2. No, go back";
  assert.deepEqual(parseSwitchDialog(screen), { model: "Sonnet 5.5" });
});

test("an effort alone stays on the session's model, whatever the pane last thought", async () => {
  const hc = fake();
  hc.st.row = 4; hc.st.model = "Sonnet 5.5";
  const result = await applyChoice(hc, "t1", { model: null, effort: "high" }, null);
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(result.set, { model: "Sonnet 5.5", effort: "high" });
  assert.equal(hc.st.model, "Sonnet 5.5");
  assert.deepEqual(hc.st.keys, ["right", "right", "s"]);
});

test("an effort alone on the default row stays on the default row", async () => {
  const hc = fake();
  hc.st.row = 1; hc.st.model = "Default (recommended)";
  const result = await applyChoice(hc, "t1", { model: null, effort: "medium" }, null);
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(result.set, { model: "Opus 5.5", effort: "medium" });
  assert.deepEqual(hc.st.keys, ["right", "s"]);
});

test("an effort alone refuses a question that would change the model", async () => {
  const hc = fake({ confirm: true, askFor: "Haiku 5.5" });
  hc.st.row = 4; hc.st.model = "Sonnet 5.5"; hc.st.dialog = null;
  const keys = hc.keys;
  hc.keys = async (t, list) => { await keys(t, list); if (list.includes("s")) hc.st.dialog = "Haiku 5.5"; };
  const result = await applyChoice(hc, "t1", { model: null, effort: "high" }, null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "dialog");
  assert.ok(!hc.st.keys.includes("1"));
});

test("a model alone keeps the effort the session runs, read from the picker", async () => {
  const hc = fake();
  hc.st.effort = "xhigh";
  const result = await applyChoice(hc, "t1", { model: "Sonnet 5.5", effort: null }, FALLBACK_MODELS[2]);
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(result.set, { model: "Sonnet 5.5", effort: "xhigh" });
});

test("/model then an effort, at either order, leaves both on the session", async () => {
  for (const columns of [0, 42]) {
    const hc = fake({ columns });
    await applyChoice(hc, "t1", { model: "Sonnet 5.5", effort: null }, FALLBACK_MODELS[2]);
    await applyChoice(hc, "t1", { model: null, effort: "high" }, null);
    assert.deepEqual([hc.st.model, hc.st.effort], ["Sonnet 5.5", "high"], `model first at ${columns}`);
    await applyChoice(hc, "t1", { model: null, effort: "medium" }, null);
    await applyChoice(hc, "t1", { model: "Fable 5.1", effort: null }, FALLBACK_MODELS[1]);
    assert.deepEqual([hc.st.model, hc.st.effort], ["Fable 5.1", "medium"], `effort first at ${columns}`);
  }
});

// ---- a dialog that's already open, a stash, and screen text that only looks like the picker ----

test("the flow presses nothing into a dialog that reads idle", async () => {
  const hc = fake();
  hc.dialog = async () => true;
  const result = await applyChoice(hc, "t1", { model: "Sonnet 5.5", effort: "low" }, FALLBACK_MODELS[2]);
  assert.equal(result.reason, "dialog");
  assert.deepEqual(hc.st.sent, []);
  assert.deepEqual(hc.st.keys, []);
});

test("the flow won't send /model into an open picker, whose Enter would save a default", async () => {
  const hc = fake();
  hc.st.open = true;
  const result = await applyChoice(hc, "t1", { model: "Sonnet 5.5", effort: "low" }, FALLBACK_MODELS[2]);
  assert.equal(result.reason, "dialog");
  assert.deepEqual(hc.st.sent, []);
});

test("reading the models presses nothing into an open dialog", async () => {
  const hc = fake();
  hc.dialog = async () => true;
  assert.equal((await readModels(hc, "t1")).reason, "dialog");
  assert.deepEqual(hc.st.sent, []);
});

test("the flow leaves a held stash alone", async () => {
  const hc = fake();
  const read = hc.read;
  hc.read = async () => `${await read()}\n                                                  › stashed`;
  const result = await applyChoice(hc, "t1", { model: "Sonnet 5.5", effort: "low" }, FALLBACK_MODELS[2]);
  assert.equal(result.reason, "stashed");
  assert.deepEqual(hc.st.sent, []);
  assert.equal((await readModels(hc, "t1")).reason, "stashed");
});

test("conversation text quoting the switch question isn't the question", () => {
  const rule = "─".repeat(40);
  const quoted = `⏺ It asks Switch model?\n\n   Switch model?\n   ❯ 1. Yes, switch to Sonnet 5.5\n     2. No, go back\n\n${rule}\n❯ \n${rule}\n   model:  Haiku 5.5  -  low`;
  assert.equal(parseSwitchDialog(quoted), null);
});

test("the real switch question still reads", () => {
  assert.deepEqual(parseSwitchDialog(readFileSync(new URL("./fixtures/switch-dialog.txt", import.meta.url), "utf8")), { model: "Sonnet 5.5" });
});

test("a question with no first option doesn't count", () => {
  assert.equal(parseSwitchDialog("   Switch model?\n\n     2. No, go back"), null);
});

test("conversation text quoting the picker isn't the picker", () => {
  const rule = "─".repeat(40);
  const quoted = `   Select model\n   ❯ 5.  Haiku 5.5 ✔   Fast\n\n${rule}\n❯ \n${rule}\n   model:  Haiku 5.5  -  low`;
  assert.equal(parsePicker(quoted), null);
});

// ---- a terminal too small for the picker's effort line ----

test("a model alone goes through when the effort line is off the screen, and the effort is left alone", async () => {
  const hc = fake({ noEffortLine: true });
  const result = await applyChoice(hc, "t1", { model: "Sonnet 5.5", effort: null }, FALLBACK_MODELS[2]);
  assert.equal(result.ok, true, result.detail);
  assert.equal(hc.st.model, "Sonnet 5.5");
  assert.equal(hc.st.effort, "low");
  assert.deepEqual(hc.st.keys, ["up", "s"]);
});

test("an effort can't be set with its line off the screen, and that's what the flow says", async () => {
  for (const wanted of [{ model: null, effort: "high" }, { model: "Sonnet 5.5", effort: "high" }]) {
    const hc = fake({ noEffortLine: true });
    const result = await applyChoice(hc, "t1", wanted, wanted.model ? FALLBACK_MODELS[2] : null);
    assert.equal(result.reason, "no effort line");
    assert.equal(hc.st.keys.includes("s"), false);
    assert.equal(hc.st.keys.at(-1), "esc");
  }
});

