import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildStats, albumRatio, compact, dayLabel, duration, heatGrid, landing, landingBar, limitMeters, loadDetail, modelName, parseStatsCache, parseUsageText, statsFigures, statsView, streaks, tokenTotals, topOf, usageText, WEEKS } from "../../mods/claude-chat/usage-data.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
// Made up, in the shapes Claude Code 2.1.316 and ccstatusline write: the headless /usage text, ccstatusline's usage.json
// and the profile folder's stats-cache.json.
const text = fixture("usage-headless.txt");
const usageJson = fixture("ccstatusline-usage.json");
const cache = parseStatsCache(fixture("stats-cache.json"));

// A mod can't import outside its own folder (herdr-app check: "resolves outside the application directory", and a symlink is
// resolved first), so mods/claude-chat/orchi-usage.js is Orchi's file, byte for byte. This is what keeps it from drifting.
test("orchi-usage.js is Orchi's usage.js unchanged", () => {
  const here = readFileSync(new URL("../../mods/claude-chat/orchi-usage.js", import.meta.url), "utf8");
  const orchi = readFileSync(new URL("../../mods/orchi/usage.js", import.meta.url), "utf8");
  assert.equal(here, orchi, "run: cp mods/orchi/usage.js mods/claude-chat/orchi-usage.js");
});

// ---- the headless text ----

test("the limits and both ranges come out of the saved /usage text", () => {
  const p = parseUsageText(text);
  assert.deepEqual(p.limits, [
    { label: "Current week (all models)", used: 44, resets: "Sep 21 at 9am (Europe/Paris)" },
    { label: "Current week (Fable)", used: 6, resets: "Sep 21 at 9am (Europe/Paris)" },
  ]);
  assert.deepEqual(p.ranges.map((r) => [r.label, r.requests, r.sessions]), [["Last 24h", 3812, 141], ["Last 7d", 15206, 598]]);
});

test("each range keeps its advice lines in order, with the note after the dot", () => {
  const [day, week] = parseUsageText(text).ranges;
  assert.equal(day.advice.length, 5);
  assert.deepEqual(day.advice[0], { pct: 68, text: 'Give "general-purpose" subagents a cheaper model', note: "" });
  assert.deepEqual(day.advice[1], { pct: 66, text: "Start fresh when you switch tasks", note: "run /clear" });
  assert.deepEqual(day.advice[3], { pct: 24, text: "Turn off skills you don't use", note: "15k tokens per request" });
  assert.deepEqual(week.advice.map((a) => a.pct), [71, 70, 58, 21]);
});

test("tops give names with percents, and the count that was cut off", () => {
  const [day, week] = parseUsageText(text).ranges;
  const skills = topOf(day, "Top skills");
  assert.equal(skills.items.length, 8);
  assert.deepEqual(skills.items[0], { name: "/go", pct: 4 });
  assert.deepEqual(skills.items[2], { name: "/benchmark-suite", pct: 2 });
  assert.equal(skills.more, 5);
  assert.deepEqual(topOf(day, "Top subagents").items.map((i) => i.name), ["general-purpose", "Explore", "long-runner", "fanout", "code-reviewer"]);
  assert.equal(topOf(day, "Top subagents").more, 0);
  assert.deepEqual(topOf(week, "Top skills").items[0], { name: "/pr-drafter", pct: 6 });
  assert.equal(topOf(week, "Top MCP servers").items[0].name, "plugin:playwright:playwright");
  assert.deepEqual(topOf(week, "Top nothing"), { title: "Top nothing", items: [], more: 0 });
});

test("text that isn't the screen gives nothing, and unknown lines are skipped", () => {
  assert.deepEqual(parseUsageText(""), { limits: [], ranges: [] });
  assert.deepEqual(parseUsageText(null), { limits: [], ranges: [] });
  assert.deepEqual(parseUsageText("not the usage screen\nat all"), { limits: [], ranges: [] });
  const odd = parseUsageText("Last 30d\n  50%  A thing\n  something odd here\n  Top skills: nothing useful\n");
  assert.equal(odd.ranges[0].requests, 0);
  assert.equal(odd.ranges[0].advice.length, 1);
  assert.deepEqual(odd.ranges[0].tops[0].items, []);
});

test("a number with a comma reads as a number", () => {
  assert.equal(parseUsageText("Last 24h · 1,234 requests · 2,001 sessions").ranges[0].requests, 1234);
});

test("the text comes out of a stream by its result line, else the local command output", () => {
  const result = JSON.stringify({ type: "result", result: text });
  assert.equal(usageText(`banner\n{"type":"system"}\n${result}\n`), text);
  const local = JSON.stringify({ type: "assistant", local_command_source: `<local-command-stdout>${text.trim()}</local-command-stdout>` });
  assert.equal(usageText(local), text.trim());
  assert.equal(usageText("nothing"), null);
  assert.equal(usageText(null), null);
});

test("loadDetail runs claude -p /usage and parses what came back", async () => {
  let seen;
  const exec = async (cmd, args, opts) => { seen = { cmd, args, opts }; return { code: 0, stdout: JSON.stringify({ type: "result", result: text }) + "\n", stderr: "" }; };
  const detail = await loadDetail(exec, "/work/x", true);
  assert.equal(detail.ranges.length, 2);
  assert.equal(JSON.parse(seen.args[3]).message.content, "/usage");
  assert.equal(seen.opts.cwd, "/work/x");
  await assert.rejects(loadDetail(async () => ({ code: 0, stdout: JSON.stringify({ type: "result", result: "no screen here" }), stderr: "" }), "/x", true));
  await assert.rejects(loadDetail(async () => { throw new Error("timed out"); }, "/x", true));
  await assert.rejects(loadDetail(exec, "/work/x", false), /not trusted/);
});

// ---- limits ----

test("limits come from the status line cache through Orchi's projection", () => {
  const now = Date.parse("2026-09-19T20:00:00Z");
  const meters = limitMeters(usageJson, now);
  assert.deepEqual(meters.map((m) => m.label), ["Current week", "Week, Fable"]);
  const [week, fable] = meters;
  assert.equal(week.used, 46);
  // 36 hours are left of 168, so 79 percent of the week has gone and 46 used lands at 59.
  assert.equal(landing(week), 59);
  assert.equal(week.tone, "done");
  assert.equal(fable.used, 5);
  assert.equal(week.resetIn, "1d 12h");
});

test("a session limit shows when the cache has its reset time", () => {
  const now = Date.parse("2026-10-30T12:20:00Z");
  const text = JSON.stringify({ sessionUsage: 5, sessionResetAt: "2026-10-30T15:40:00Z", weeklyUsage: 40, weeklyResetAt: "2026-11-02T04:00:00Z" });
  const [session, week] = limitMeters(text, now);
  assert.equal(session.label, "Current session");
  assert.equal(Math.round(session.projected), 15);
  assert.equal(session.tone, "done");
  assert.equal(week.label, "Current week");
});

// ccstatusline-usage.json is the file an Ultra plan gets, which has no 5-hour limit: sessionUsage 0 and no reset time.
// ccstatusline-usage-5h.json is the same shape, for a plan that still has one.
test("an Ultra plan's cache has no 5-hour row, and the 0 is not drawn as 0 percent used", () => {
  const real = JSON.parse(usageJson);
  assert.equal(real.sessionUsage, 0);
  assert.equal("sessionResetAt" in real, false);
  const meters = limitMeters(usageJson, Date.parse("2026-09-19T20:00:00Z"));
  assert.equal(meters.some((m) => m.label === "Current session"), false);
  assert.deepEqual(meters.map((m) => m.label), ["Current week", "Week, Fable"]);
});

test("a plan with a 5-hour limit still gets its row, first, with the weekly ones after it", () => {
  const meters = limitMeters(fixture("ccstatusline-usage-5h.json"), Date.parse("2026-09-19T20:41:00Z"));
  assert.deepEqual(meters.map((m) => m.label), ["Current session", "Current week", "Week, Fable"]);
  const [session] = meters;
  assert.equal(session.used, 29);
  assert.equal(session.resetIn, "3h 0m");
  assert.equal(landing(session), 73);
});

test("a real 0 percent on a limit that has a reset time still shows", () => {
  const text = JSON.stringify({ sessionUsage: 0, sessionResetAt: "2026-10-31T19:41:00Z" });
  const [m] = limitMeters(text, Date.parse("2026-10-31T16:41:00Z"));
  assert.equal(m.label, "Current session");
  assert.equal(m.used, 0);
});

test("a limit that isn't held gives no row, whatever way it is missing", () => {
  const reset = "2026-11-02T04:00:00Z", now = 0;
  for (const bad of [
    { sessionUsage: 0 }, { sessionUsage: 0, sessionResetAt: null }, { sessionUsage: 0, sessionResetAt: "" },
    { sessionUsage: 0, sessionResetAt: "not a date" }, { sessionUsage: null, sessionResetAt: reset }, { sessionResetAt: reset },
    { sessionUsage: "10", sessionResetAt: reset }, { sessionUsage: NaN, sessionResetAt: reset }, { sessionUsage: -1, sessionResetAt: reset },
    { sessionUsage: 10, sessionResetAt: 12345 },
  ]) assert.deepEqual(limitMeters(JSON.stringify(bad), now), [], JSON.stringify(bad));
  assert.deepEqual(limitMeters("{}", now), []);
  assert.deepEqual(limitMeters("nope", now), []);
  assert.deepEqual(limitMeters("null", now), []);
  assert.deepEqual(limitMeters("[]", now), []);
  assert.deepEqual(limitMeters(JSON.stringify({ weeklyUsage: "x", weeklyResetAt: reset }), now), []);
});

test("the projected bar never passes the track", () => {
  assert.equal(landingBar({ used: 60, projected: 150 }), 100);
  assert.equal(landingBar({ used: 60, projected: 71.4 }), 71);
  assert.equal(landingBar({ used: 6, projected: null }), 6);
  assert.equal(landing({ used: 6, projected: null }), null);
});

// ---- Stats ----

test("All time matches what the cache holds", () => {
  const f = statsFigures(cache, "all");
  assert.equal(f.favourite, "Opus 5.5");
  assert.equal(f.tokens, 67_571_101_902);
  assert.equal(f.sessions, 6399);
  assert.equal(f.longest, 391_522_310);
  assert.equal(duration(f.longest), "4d 12h");
  assert.equal(f.activeDays, 120);
  assert.equal(f.span, 130);
  assert.equal(f.longestStreak, 27);
  assert.equal(f.currentStreak, 25);
  assert.equal(f.topDay, "2026-09-10");
  assert.equal(f.to, "2026-09-17");
});

test("Last 7 days sums the seven days to the cache's last", () => {
  const f = statsFigures(cache, "d7");
  assert.equal(f.from, "2026-09-11");
  assert.equal(f.sessions, 530);
  assert.equal(f.tokens, 11_019_415_241);
  assert.equal(f.activeDays, 7);
  assert.equal(f.span, 7);
  assert.equal(f.longestStreak, 7);
  assert.equal(f.currentStreak, 7);
  assert.equal(f.topDay, "2026-09-11");
  assert.equal(f.longest, undefined, "not in the cache, so it waits for longestRanges (tests/chat/longest.test.mjs)");
});

test("Last 30 days", () => {
  const f = statsFigures(cache, "d30");
  assert.equal(f.from, "2026-08-19");
  assert.equal(f.sessions, 2558);
  assert.equal(f.tokens, 36_506_543_119);
  assert.equal(f.activeDays, 29);
  assert.equal(f.span, 30);
  assert.equal(f.longestStreak, 25);
  assert.equal(f.currentStreak, 25);
});

test("the sums agree with the cache's own rows, worked out here a second way", () => {
  const rows = cache.dailyActivity.filter((d) => d.date >= "2026-09-11");
  assert.equal(rows.reduce((a, d) => a + d.sessionCount, 0), 530);
  const days = cache.dailyModelTokens.filter((d) => d.date >= "2026-09-11");
  assert.equal(days.reduce((a, d) => a + Object.values(d.tokensByModel).reduce((x, y) => x + y, 0), 0), 11_019_415_241);
});

test("streaks count days in a row and end on the last day", () => {
  const dates = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-05", "2026-10-06"];
  assert.deepEqual(streaks(dates, "2026-10-01", "2026-10-06"), { best: 3, current: 2 });
  assert.deepEqual(streaks(dates, "2026-10-01", "2026-10-07"), { best: 3, current: 0 });
  assert.deepEqual(streaks([], "2026-10-01", "2026-10-07"), { best: 0, current: 0 });
  assert.deepEqual(streaks(dates, "2026-10-05", "2026-10-06"), { best: 2, current: 2 });
  // Across a month and a year.
  assert.deepEqual(streaks(["2026-12-30", "2026-12-31", "2027-01-01"], "2026-12-01", "2027-01-02"), { best: 3, current: 0 });
});

test("a cache that isn't the shape this reads is refused", () => {
  assert.equal(parseStatsCache("nope"), null);
  assert.equal(parseStatsCache("{}"), null);
  assert.equal(parseStatsCache(JSON.stringify({ dailyActivity: [] })), null);
  assert.ok(parseStatsCache(JSON.stringify({ dailyActivity: [], lastComputedDate: "2026-10-30" })));
});

test("an empty cache gives zeros, not an error", () => {
  const f = statsFigures({ dailyActivity: [], lastComputedDate: "2026-10-30" }, "all");
  assert.equal(f.activeDays, 0);
  assert.equal(f.favourite, null);
  assert.equal(f.topDay, null);
  assert.equal(f.longestStreak, 0);
});

test("model names read as a person says them", () => {
  assert.equal(modelName("claude-opus-5-5"), "Opus 5.5");
  assert.equal(modelName("claude-fable-5"), "Fable 5");
  assert.equal(modelName("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(modelName("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
  assert.equal(modelName("something-else"), "something-else");
});

test("counts and times", () => {
  assert.equal(compact(67_571_101_902), "67.6b");
  assert.equal(compact(11_019_415_241), "11.0b");
  assert.equal(compact(33_816_288), "33.8m");
  assert.equal(compact(4_200), "4.2k");
  assert.equal(compact(999), "999");
  assert.equal(duration(391_522_310), "4d 12h");
  assert.equal(duration(5 * 3600e3 + 12 * 60e3), "5h 12m");
  assert.equal(duration(9 * 60e3), "9m");
  assert.equal(duration(40e3), "40s");
  assert.equal(duration(-1), "-");
  assert.equal(dayLabel("2026-09-10"), "Sep 10");
  assert.equal(dayLabel(null), "-");
});

test("the album line", () => {
  assert.equal(albumRatio(391_522_310), 139);
  assert.equal(albumRatio(0), null);
});

test("token totals add up the models", () => {
  const t = tokenTotals(cache);
  assert.equal(t.input + t.output + t.cacheRead + t.cacheWrite, 67_571_101_902);
});

// ---- the heat grid ----

test("the grid is 27 weeks of 7 days, which is 189 cells", () => {
  const g = heatGrid(cache);
  assert.equal(WEEKS, 27);
  assert.equal(g.weeks.length, 27);
  assert.ok(g.weeks.every((w) => w.length === 7));
  assert.equal(g.cells, 189);
});

test("every column starts on a Sunday and the last holds the cache's last day", () => {
  const g = heatGrid(cache);
  assert.ok(g.weeks.every((w) => new Date(`${w[0].date}T12:00:00Z`).getUTCDay() === 0));
  const last = g.weeks[26];
  assert.equal(last.find((c) => c.date === "2026-09-17").future, false);
  assert.equal(last.find((c) => c.date === "2026-09-18").future, true);
  assert.equal(last[6].level, 0);
  assert.deepEqual(last.map((c) => c.level), [1, 2, 4, 3, 4, 0, 0]);
});

test("levels are quartiles of the active days, and quiet days are 0", () => {
  const g = heatGrid(cache);
  const levels = new Set(g.weeks.flat().map((c) => c.level));
  assert.deepEqual([...levels].sort(), [0, 1, 2, 3, 4]);
  const cells = g.weeks.flat().filter((c) => !c.future);
  const by = (n) => cells.filter((c) => c.level === n).map((c) => c.count);
  assert.ok(Math.max(...by(1)) <= Math.min(...by(2)) + 0);
  assert.ok(Math.max(...by(3)) <= Math.min(...by(4)));
  assert.ok(by(0).every((n) => n === 0));
});

test("a range's first day says which days to dim, and the grid is the same for every range", () => {
  assert.equal(statsFigures(cache, "d7").from, "2026-09-11");
  const g = heatGrid(cache);
  assert.equal(g.weeks.flat().filter((c) => !c.future && c.date >= "2026-09-11").length, 7);
  assert.equal(g.weeks.flat().filter((c) => !c.future && c.date >= statsFigures(cache, "all").from).length, g.weeks.flat().filter((c) => !c.future && c.date >= "2026-05-11").length);
  assert.equal(statsView(cache, "d7", g).heat, g);
});

test("month labels sit over the first week of a month and never run together", () => {
  const { months } = heatGrid(cache);
  assert.deepEqual(months.map((m) => m.name), ["Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"]);
  for (let i = 1; i < months.length; i++) assert.ok(months[i].col - months[i - 1].col >= 3);
});

test("a grid with no activity is all zeros", () => {
  const g = heatGrid({ dailyActivity: [], lastComputedDate: "2026-10-30" });
  assert.equal(g.weeks.flat().filter((c) => c.level > 0).length, 0);
});

test("the Stats tab's data is worked out in one call", () => {
  const v = statsView(cache, "all");
  assert.equal(v.heat.cells, 189);
  assert.equal(v.albumRatio, 139);
  assert.equal(v.favourite, "Opus 5.5");
  assert.equal(statsView(cache, "d7").albumRatio, null);
});

// ---- colour and size ----

import { blend, heatColors, usageHeight } from "../../mods/claude-chat/usage-data.js";

test("blend lays one colour over another", () => {
  assert.equal(blend("#ffffff", "#000000", 0.5), "#808080");
  assert.equal(blend("#4fd08a", "#20262b", 1), "#4fd08a");
  assert.equal(blend("#4fd08a", "#20262b", 0), "#20262b");
  assert.equal(blend("red", "#000000", 0.5), "red");
  assert.equal(blend("#ffffff12", "#000000", 1), "#ffffff");
});

test("the heat fills climb from the well to the full colour", () => {
  const c = heatColors("#4fd08a", "#20262b");
  assert.equal(c.length, 5);
  assert.equal(c[0], "#20262b");
  assert.equal(c[4], "#4fd08a");
  const green = c.map((x) => parseInt(x.slice(3, 5), 16));
  assert.deepEqual(green, [...green].sort((a, b) => a - b));
});

test("the panel's height follows what it shows and stops at the most it can have", () => {
  const detail = parseUsageText(text);
  const big = 9999;
  const using = usageHeight({ tab: "using", detail, range: "Last 24h" }, big);
  const week = usageHeight({ tab: "using", detail, range: "Last 7d" }, big);
  const loading = usageHeight({ tab: "using", detail: null }, big);
  assert.ok(loading < week && loading < using);
  assert.equal(week, using, "five names a list is the most either range shows, so the tops set the height");
  const stats = usageHeight({ tab: "stats", statsFigures: statsView(cache, "all") }, big);
  assert.ok(stats > loading);
  assert.ok(usageHeight({ tab: "stats", statsFigures: statsView(cache, "d7") }, big) < stats, "no album line outside All time");
  assert.equal(usageHeight({ tab: "stats", statsFigures: statsView(cache, "all") }, 300), 300);
  assert.equal(usageHeight({ tab: "stats", statsFigures: null }, big), loading);
  assert.equal(usageHeight({ tab: "using", detail, range: "no such range" }, big), using, "an unknown range falls back to the first");
});

test("buildStats works out all three ranges, sharing one grid, and pauses between steps", async () => {
  let pauses = 0;
  const stats = await buildStats(cache, async () => { pauses++; });
  assert.deepEqual(Object.keys(stats), ["all", "d7", "d30"]);
  assert.equal(stats.all.heat, stats.d7.heat);
  assert.equal(stats.d7.heat, stats.d30.heat);
  assert.equal(stats.all.heat.cells, 189);
  assert.equal(stats.d7.sessions, 530);
  assert.equal(pauses, 4);
  assert.equal((await buildStats(cache)).all.sessions, 6399);
});

import { keptOn, sharedDetail } from "../../mods/claude-chat/usage-data.js";

test("opening the panel twice runs one headless read per folder at a time", async () => {
  let runs = 0, finish;
  const exec = () => { runs++; return new Promise((resolve) => { finish = resolve; }); };
  const a = sharedDetail(exec, "/x", true).catch(() => "failed");
  const b = sharedDetail(exec, "/x", true).catch(() => "failed");
  await new Promise((r) => setTimeout(r));
  assert.equal(runs, 1);
  finish({ code: 1, stdout: "" });
  assert.deepEqual([await a, await b], ["failed", "failed"]);
  const c = sharedDetail(exec, "/x", true).catch(() => "failed");
  await new Promise((r) => setTimeout(r));
  assert.equal(runs, 2, "a refresh after it ended runs again");
  finish({ code: 1, stdout: "" });
  await c;
});

test("another folder has its own read", async () => {
  let runs = 0;
  const finish = [];
  const exec = () => { runs++; return new Promise((resolve) => finish.push(resolve)); };
  const all = [sharedDetail(exec, "/y", true), sharedDetail(exec, "/z", true)].map((p) => p.catch(() => null));
  await new Promise((r) => setTimeout(r));
  assert.equal(runs, 2);
  for (const f of finish) f({ code: 1, stdout: "" });
  await Promise.all(all);
});

test("something costly to build is held until what it's built from changes", () => {
  const box = {};
  let built = 0;
  const make = () => ({ n: ++built });
  const first = keptOn(box, "grid", "a", make);
  assert.equal(keptOn(box, "grid", "a", make), first);
  assert.equal(built, 1);
  assert.notEqual(keptOn(box, "grid", "b", make), first);
  assert.equal(built, 2);
});
