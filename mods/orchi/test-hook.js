// What a test in a private Herdr can ask of the Orchi panel, because presses on the app aren't reliable from a script.
// Only a home under /.config/hd/ counts, so none of this can run in the real window. No Herdr imports, so
// `node --test` can load this file.

export const testing = (appHome) => String(appHome ?? "").includes("/.config/hd/");

// `orchi-script.json` in a private home is a list of steps for `herdr-app do orchi.script`, such as
// [{ "do": "option", "value": "C" }, { "do": "send" }]. They act on the decision on screen, as presses would.
export function scriptSteps(text) {
  let steps;
  try { steps = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(steps)) return [];
  return steps.filter((s) => s && typeof s === "object" && (
    (s.do === "option" && typeof s.value === "string" && /^[A-Z]$/.test(s.value))
    || (s.do === "reply" && typeof s.text === "string")
    || s.do === "send"));
}

export const scriptFile = (appHome) => `${appHome}/orchi-script.json`;
