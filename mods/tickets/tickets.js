// One list over every source: logos, the source and category filters, the project cards and each card's actions.
// No Herdr imports, so `node --test` can load this file.
import { shortRef } from "./refs.js";
import { safeUrl } from "./urls.js";

// A card shows its source's logo, never the prefix.
export const SOURCE_ICONS = {
  legwork: "mods/tickets/legwork.svg",
  github: "mods/tickets/github.svg",
  linear: "mods/tickets/linear.svg",
  markdown: "mods/tickets/markdown.svg",
};

export const CATEGORIES = [["all", "All"], ["work", "Work"], ["personal", "Personal"], ["business", "Business"]];

// The id a row shows beside the title. A legwork project's title is its name and a Markdown task's anchor is made from
// its text, so those show none.
export const rowId = (ticket) => (ticket.source === "linear" || ticket.source === "github" ? shortRef(ticket.ref) : "");

const OPEN_IN = { linear: "Open in Linear", github: "Open in GitHub" };

// What a card offers, in order. Status is Linear's alone.
export function actionsFor(ticket) {
  const actions = [];
  if (ticket.source === "legwork") actions.push("Pickup", "Go");
  if (ticket.source === "linear") actions.push("Status");
  if (OPEN_IN[ticket.source] && safeUrl(ticket.url)) actions.push(OPEN_IN[ticket.source]);
  actions.push("Send to Orchi");
  return actions;
}

const matches = (ticket, needle) => !needle || `${ticket.ref} ${ticket.title} ${ticket.project ?? ""}`.toLowerCase().includes(needle);

// `categoryOf(ticket)` is its project's category, or null. A ticket with none shows under All only.
export function filterTickets(tickets, { source = "all", category = "all", text = "" }, categoryOf) {
  const needle = text.trim().toLowerCase();
  return tickets.filter((t) => (source === "all" || t.source === source)
    && (category === "all" || categoryOf(t) === category) && matches(t, needle));
}

export function sourceCounts(tickets, sources) {
  const counts = { all: tickets.length, ...Object.fromEntries(sources.map((s) => [s, 0])) };
  for (const t of tickets) if (t.source in counts) counts[t.source]++;
  return counts;
}

export function categoryCounts(tickets, categoryOf) {
  const counts = Object.fromEntries(CATEGORIES.map(([id]) => [id, 0]));
  counts.all = tickets.length;
  for (const t of tickets) { const c = categoryOf(t); if (c && c !== "all" && c in counts) counts[c]++; }
  return counts;
}

const NO_PROJECT = "No project";
const newest = (a, b) => String(b.updated ?? "").localeCompare(String(a.updated ?? ""));

// One card a project, by name, with No project last. In a card the project's own legwork ticket comes first, then the
// newest. `projectOf(ticket)` is the ticket's project or null.
export function projectGroups(tickets, projectOf) {
  const groups = new Map();
  for (const ticket of tickets) {
    const project = projectOf(ticket), key = project ? `project:${project.file}` : "project:";
    if (!groups.has(key)) groups.set(key, { key, label: project ? project.name || project.file : NO_PROJECT, project, tickets: [] });
    groups.get(key).tickets.push(ticket);
  }
  const own = (g, t) => t.source === "legwork" && g.project && t.id === g.project.file;
  for (const g of groups.values()) g.tickets.sort((a, b) => own(g, b) - own(g, a) || newest(a, b));
  return [...groups.values()].sort((a, b) => (!a.project) - (!b.project) || a.label.localeCompare(b.label));
}

// "5m", "3h", "2d" since a time or a date, or "" when there's none.
export function ago(when, now = Date.now()) {
  const at = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(when ?? "") ? `${when}T00:00:00Z` : when ?? "");
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

// The list with one ticket's state as read just now, or the same list when there's nothing new.
export function withState(tickets, ref, state) {
  if (!state || !tickets.some((t) => t.ref === ref && t.state !== state)) return tickets;
  return tickets.map((t) => (t.ref === ref ? { ...t, state } : t));
}

// Whether what was read for a ticket is older than the ticket as listed now.
export const changedSince = (have, ticket) => !have || have.updated !== ticket.updated;

// A source that had a problem and listed nothing this time keeps the tickets it listed last time, so a moment's failure
// doesn't untick them or close one that's open. Its problem still shows above the list.
export function keepFailed(before, now, failed) {
  const kept = failed.filter((s) => !now.some((t) => t.source === s));
  return [...now, ...before.filter((t) => kept.includes(t.source))];
}
