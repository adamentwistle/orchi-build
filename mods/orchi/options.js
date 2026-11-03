// What Start asks before a plan runs: the same choices Go asks when a plan is made. A plan made in chat has never been
// asked, and a plan made earlier may not be what Adam wants now. No Herdr imports, so `node --test` can load this file.
export const MODELS = ["Fable", "Opus", "Sonnet", "Haiku"];
export const EFFORTS = ["Low", "Medium", "High", "Xhigh", "Max"];
export const PR_HINT = "Leave them open for me to merge";
const DEFAULT = { model: "Opus", effort: "High" }, AUTO = { model: "Auto", effort: "Auto" };

// Shared state and a brief are files, so only the names the switchboard takes get through.
function role(choice, fallback, auto = false) {
  if (auto && choice?.model === "Auto") return AUTO;
  return MODELS.includes(choice?.model) && EFFORTS.includes(choice?.effort) ? { model: choice.model, effort: choice.effort } : fallback;
}

const words = (value) => (typeof value === "string" ? value.trim() : "");

// `saved` is a brief's choices, or the choices last used on the review screen.
export function startOptions(saved) {
  return {
    switchboard: role(saved?.switchboard, DEFAULT), orchestrator: role(saved?.orchestrator, DEFAULT), workers: role(saved?.workers, AUTO, true),
    prs: words(saved?.prs) === PR_HINT ? "" : words(saved?.prs), extra: words(saved?.extra),
  };
}

export function pickModel(choice, model) {
  if (model === "Auto") return AUTO;
  return { model, effort: choice.effort === "Auto" ? DEFAULT.effort : choice.effort };
}

export const pickEffort = (choice, effort) => (choice.model === "Auto" ? choice : { ...choice, effort });

// What goes in the run rules file. The switchboard reads these names, and `prs` and `extra` are Adam's own words.
export const runRules = ({ orchestrator, workers, prs, extra }) => ({ orchestrator, workers, prs: words(prs), extra: words(extra) });
