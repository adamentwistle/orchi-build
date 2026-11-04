// One list over every source: the source and category filters, the project cards, and which actions a card offers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { SOURCE_ICONS, CATEGORIES, rowId, actionsFor, filterTickets, sourceCounts, categoryCounts, projectGroups, ago } from "../../mods/tickets/tickets.js";
import { shortRef } from "../../mods/tickets/refs.js";

const t = (ref, source, title, extra = {}) => ({ ref, source, id: ref.slice(ref.indexOf(":") + 1), title, state: "open", open: true, url: null, updated: null, project: null, labels: [], ...extra });
const birch = t("legwork:birch", "legwork", "Birch", { labels: ["work"] });
const cedar = t("legwork:cedar", "legwork", "Cedar", { labels: ["personal"] });
const login = t("linear:ENG-12", "linear", "Fix login", { url: "https://linear.app/acme/issue/ENG-12", updated: "2026-11-02T00:00:00Z" });
const crash = t("gh:acme/app#7", "github", "Crash on start", { url: "https://github.com/acme/app/issues/7" });
const milk = t("md:~/notes/todo.md#buy-milk", "markdown", "Buy milk");
const loose = t("linear:OPS-3", "linear", "Rotate keys");
const all = [birch, cedar, login, crash, milk, loose];

const projects = { birch: { file: "birch", name: "Birch", category: "work" }, cedar: { file: "cedar", name: "Cedar", category: "personal" } };
const links = { "legwork:birch": "birch", "linear:ENG-12": "birch", "gh:acme/app#7": "birch", "legwork:cedar": "cedar", "md:~/notes/todo.md#buy-milk": "cedar" };
const projectOf = (ticket) => projects[links[ticket.ref]] ?? null;
const categoryOf = (ticket) => projectOf(ticket)?.category ?? null;

test("each source has a logo the panel ships, and no card shows a prefix", () => {
  for (const [source, path] of Object.entries(SOURCE_ICONS)) {
    assert.match(path, /^mods\/tickets\/[a-z]+\.svg$/, source);
    assert.ok(existsSync(new URL(`../../${path}`, import.meta.url)), path);
  }
  assert.deepEqual(Object.keys(SOURCE_ICONS).sort(), ["github", "legwork", "linear", "markdown"]);
  assert.deepEqual([rowId(login), rowId(crash), rowId(birch), rowId(milk)], ["ENG-12", "app#7", "", ""]);
});

test("a reference reads short beside its logo", () => {
  assert.deepEqual(["linear:ENG-12", "ENG-12", "gh:acme/app#7", "legwork:birch", "md:~/notes/todo.md#buy-milk"].map(shortRef),
    ["ENG-12", "ENG-12", "app#7", "birch", "buy-milk"]);
  assert.equal(shortRef("not a ref"), "not a ref");
});

test("Linear's actions are on Linear cards only, and every card can go to Orchi", () => {
  assert.deepEqual(actionsFor(login), ["Status", "Open in Linear", "Send to Orchi"]);
  assert.deepEqual(actionsFor(crash), ["Open in GitHub", "Send to Orchi"]);
  assert.deepEqual(actionsFor(birch), ["Pickup", "Go", "Send to Orchi"]);
  assert.deepEqual(actionsFor(milk), ["Send to Orchi"]);
  for (const ticket of [crash, birch, milk]) assert.ok(!actionsFor(ticket).some((a) => a === "Status" || a.includes("Linear")), ticket.ref);
});

test("a ticket with no web address offers no Open", () => {
  assert.deepEqual(actionsFor({ ...login, url: null }), ["Status", "Send to Orchi"]);
  assert.deepEqual(actionsFor({ ...crash, url: "file:///x" }), ["Send to Orchi"]);
});

test("the category filters are work, personal and business, after All", () => {
  assert.deepEqual(CATEGORIES.map(([id]) => id), ["all", "work", "personal", "business"]);
});

test("a source filter keeps that source's tickets", () => {
  const shown = (source) => filterTickets(all, { source, category: "all", text: "" }, categoryOf).map((x) => x.ref);
  assert.deepEqual(shown("linear"), ["linear:ENG-12", "linear:OPS-3"]);
  assert.deepEqual(shown("github"), ["gh:acme/app#7"]);
  assert.deepEqual(shown("legwork"), ["legwork:birch", "legwork:cedar"]);
  assert.deepEqual(shown("markdown"), ["md:~/notes/todo.md#buy-milk"]);
  assert.equal(shown("all").length, 6);
});

test("a category filter keeps the tickets whose project is in it; one with no project shows under All only", () => {
  const shown = (category) => filterTickets(all, { source: "all", category, text: "" }, categoryOf).map((x) => x.ref);
  assert.deepEqual(shown("work"), ["legwork:birch", "linear:ENG-12", "gh:acme/app#7"]);
  assert.deepEqual(shown("personal"), ["legwork:cedar", "md:~/notes/todo.md#buy-milk"]);
  assert.deepEqual(shown("business"), []);
  assert.ok(shown("all").includes("linear:OPS-3"));
});

test("the two filters and the search work together", () => {
  assert.deepEqual(filterTickets(all, { source: "linear", category: "work", text: "" }, categoryOf).map((x) => x.ref), ["linear:ENG-12"]);
  assert.deepEqual(filterTickets(all, { source: "all", category: "all", text: "app#7" }, categoryOf).map((x) => x.ref), ["gh:acme/app#7"]);
  assert.deepEqual(filterTickets(all, { source: "all", category: "all", text: "LOGIN" }, categoryOf).map((x) => x.ref), ["linear:ENG-12"]);
});

test("each filter counts what it would show under the other", () => {
  assert.deepEqual(sourceCounts(all, ["legwork", "github", "linear", "markdown"]), { all: 6, legwork: 2, github: 1, linear: 2, markdown: 1 });
  assert.deepEqual(categoryCounts(all, categoryOf), { all: 6, work: 3, personal: 2, business: 0 });
});

test("tickets sit in their project's card, the project's own ticket first, and No project last", () => {
  const groups = projectGroups(all, projectOf);
  assert.deepEqual(groups.map((g) => g.label), ["Birch", "Cedar", "No project"]);
  assert.deepEqual(groups[0].tickets.map((x) => x.ref), ["legwork:birch", "linear:ENG-12", "gh:acme/app#7"]);
  assert.deepEqual(groups[2].tickets.map((x) => x.ref), ["linear:OPS-3"]);
  assert.equal(groups[0].key, "project:birch");
});

test("ago reads a time or a date, and nothing for none", () => {
  const now = Date.parse("2026-11-04T00:00:00Z");
  assert.equal(ago("2026-11-03T23:00:00Z", now), "1h");
  assert.equal(ago("2026-11-01", now), "3d");
  assert.equal(ago(null, now), "");
  assert.equal(ago("soon", now), "");
});

test("the panel is named Tickets", () => {
  assert.equal(JSON.parse(readFileSync(new URL("../../mods/tickets/mod.json", import.meta.url), "utf8")).title, "Tickets");
});
