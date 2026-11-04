// What a test in a private Herdr can ask of the tickets panel, because presses on the app aren't reliable from a script.
// Only a home under /.config/hd/ counts, so none of this can run in the real window. No Herdr imports, so
// `node --test` can load this file.
import { isRef } from "./refs.js";

export const testing = (appHome) => String(appHome ?? "").includes("/.config/hd/");

// `tickets-script.json` in a private home is a list of steps for `herdr-app do tickets.script`, such as
// [{ "do": "source", "value": "linear" }, { "do": "open", "ref": "linear:ENG-12" }]. A command can't carry
// arguments, so they wait in this file. A step the panel doesn't know is left out.
const VALUE = ["source", "category"];
const REF = ["open", "tick", "send"];
const REF_VALUE = ["move", "act"];
const BARE = ["back", "review", "go", "refresh"];

export function scriptSteps(text) {
  let steps;
  try { steps = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(steps)) return [];
  return steps.filter((s) => s && typeof s === "object" && (
    (VALUE.includes(s.do) && typeof s.value === "string")
    || ((REF.includes(s.do) || (REF_VALUE.includes(s.do) && typeof s.value === "string")) && isRef(s.ref))
    || BARE.includes(s.do)));
}

export const scriptFile = (appHome) => `${appHome}/tickets-script.json`;
export const dumpFile = (appHome) => `${appHome}/tickets-state.json`;
