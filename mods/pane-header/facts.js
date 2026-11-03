// What a pane's header shows. A mod pane can't set its own title, and `panes()` gives it no folder, so a chat pane takes
// its name, folder and status from its terminal. No Herdr imports, so `node --test` can load this file.
const CHAT = "claude-chat";
const PROGRESS = "orch-pane";
// What claude-chat publishes under this key: { [terminal address]: count } of what landed while the chat wasn't showing.
// A mod can't import from another mod's folder, so the key is repeated here and a test keeps the two equal.
export const UNSEEN_KEY = "chat.unseen";

const countOf = (unseen, terminal) => {
  const count = terminal && unseen && typeof unseen === "object" ? unseen[terminal] : 0;
  return Number.isInteger(count) && count > 0 ? count : 0;
};

export const unseenLabel = (count) => (count > 0 ? `${count > 99 ? "99+" : count} new` : null);

// `unseen` is the shared map. A chat's count shows on its own header and on its terminal's, because a swap puts the
// terminal in the chat's place.
export function headerFacts(pane, all, pairs, unseen = {}) {
  if (pane.mod === PROGRESS) return { chat: false, name: "Orchestrator progress", cwd: null, program: null, status: null, unseen: 0 };
  if (pane.mod !== CHAT) {
    const name = ((pane.program?.agent || pane.program?.shell) && pane.program.name) || pane.title || pane.program?.name || "shell";
    const paired = Boolean(pane.terminal) && Object.values(pairs ?? {}).includes(pane.terminal);
    return { chat: false, name, cwd: pane.cwd, program: pane.program, status: pane.status, unseen: paired ? countOf(unseen, pane.terminal) : 0 };
  }
  const address = pairs?.[pane.pane];
  const terminal = all.find((p) => p.terminal && p.terminal === address);
  return { chat: true, name: "Claude Code", cwd: terminal?.cwd ?? null, program: terminal?.program ?? null, status: terminal?.status ?? null, unseen: countOf(unseen, terminal?.terminal) };
}
