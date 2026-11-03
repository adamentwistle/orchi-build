// What the progress button can do. No Herdr imports, so `node --test` can load this file. Shown only in a tab that holds
// an orchestrator, a Claude Code session named orch-<project>.
const PROGRESS = "orch-pane";
const CHAT = "claude-chat";
const CLAUDE = "claude-code";

const isLocal = (address) => Boolean(address) && !address.includes("/");

// `nameOf` gives a terminal's name. A name can go when Claude Code restarts, so the pane's title counts too.
const isOrchestrator = (p, nameOf) => p.app === CLAUDE && isLocal(p.terminal) && [nameOf(p.terminal), p.title].some((n) => n?.startsWith("orch-"));

export function progressState(panes, nameOf) {
  const here = panes.find((p) => p.focused);
  if (!here) return null;
  const tab = panes.filter((p) => p.tab === here.tab);
  const session = tab.find((p) => isOrchestrator(p, nameOf));
  if (!session) return null;
  return {
    tab: here.tab, terminal: session.terminal, terminalPane: session.pane, progressPane: tab.find((p) => p.mod === PROGRESS)?.pane ?? null,
    chatPane: tab.find((p) => p.mod === CHAT)?.pane ?? null, zoomed: tab.find((p) => p.zoomed)?.pane ?? null,
  };
}

export const openSteps = (state) => [["pane.split", { direction: "right", pane: state.terminalPane, mod: PROGRESS, props: { terminal: state.terminal } }]];

// A press that closes. A zoomed progress pane first hands the view back to what's behind it.
export function closeSteps(state) {
  const back = state.chatPane ?? state.terminalPane;
  return [
    ...(state.zoomed === state.progressPane ? [["pane.zoom", { pane: back }], ["pane.focus", { pane: back }]] : []),
    ["pane.close", { pane: state.progressPane }],
  ];
}

// The split shows on a later render. Behind a zoom a split pane stays hidden, so it's zoomed to, as the chat is. Beside the
// terminal, the keyboard stays where it was.
export function openedSteps(wait, pane) {
  return wait.zoomed ? [["pane.zoom", { pane }], ["pane.focus", { pane }]] : [["pane.focus", { pane: wait.from }]];
}

export const newPane = (panes, wait) => panes.find((p) => p.mod === PROGRESS && p.tab === wait.tab && !wait.known.includes(p.pane));
