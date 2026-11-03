// What the collapsed sidebar, the rail, shows of a space: a short mark from its name and the one status worth seeing from
// across the room. No Herdr imports, so `node --test` can load this file.

// Two letters from a space's name: the first of its first two words ("orchi-build" is OB), else its first two ("Tests" is
// Te). A name with no letters or digits, such as "~", is kept as it is.
export function initials(name) {
  const text = String(name ?? "").trim();
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1) return words[0].length === 1 ? words[0].toUpperCase() : words[0][0].toUpperCase() + words[0][1].toLowerCase();
  return text.slice(0, 2) || "?";
}

// The status a space's tile shows: blocked first, because someone is waiting on Adam, then done, then working. Idle shows
// nothing. `working` covers a worker under an agent, which the agents' own statuses don't.
export function railStatus(members, working = false) {
  const statuses = new Set(members.map((a) => a.status));
  if (statuses.has("blocked")) return "blocked";
  if (statuses.has("done")) return "done";
  if (working || statuses.has("working")) return "working";
  return null;
}

// What a tile's tooltip says: the space's name and the key that selects it.
export const railTip = (name, index, key) => (index < 9 ? `${name}  ·  ${key}+${index + 1}` : String(name));
