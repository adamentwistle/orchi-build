// What a press in Orchi sends: answers, the clipboard, pasting into a terminal and the pending states.
// No Herdr imports, so `node --test` can load this file. `exec`, `run` and `focused` are passed in.
import { appBin } from "./launch.js";
import { ABSOLUTE } from "./sessions.js";
import { orchiDir } from "./settings.js";

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const ID = /^\w[\w.-]*$/;
const PANE = /^\w[\w:./-]*$/;
const FOCUS_TRIES = 10;

// A control character or newline could act on the terminal, so Put in terminal stays off for it.
export const pasteable = (command) => Boolean(command) && !CONTROL.test(command);

export function answerText(option, reply) {
  const text = reply.trim();
  return option && text ? `${option}: ${text}` : option ?? text;
}

// Words in an action's field are Adam's reply, sent as typed. With none, the press says the step is done.
export const actionAnswer = (reply) => reply.trim() || "completed: done";

// The main button on a decision's card.
export function decisionButton({ kind, option, reply, sending }) {
  const typed = Boolean(reply.trim() || (kind !== "ACTION" && option));
  const label = sending ? "Sending…" : kind === "ACTION" && !typed ? "Mark as completed" : "Send";
  return { label, enabled: !sending && (typed || kind === "ACTION") };
}

// `switchboard-answer` refuses these too, but the panel says so before anything runs.
export function answerProblem(text) {
  if (!text) return "Choose an option or type a reply";
  return CONTROL.test(text) ? "A reply has to be one plain line" : null;
}

// What `/usr/bin/env` runs, every value its own argument. `d` is an open entry from `liveDecisions`. Null if a value that
// reaches a command isn't the shape it should be. `s` is Orchi's settings, which say where its scripts are.
export function answerArgv(home, d, text, s) {
  if (answerProblem(text) || !ID.test(d.id ?? "") || !PANE.test(d.pane ?? "") || !ABSOLUTE.test(d.board ?? "")) return null;
  const where = d.planner || d.where === "app" ? "app" : "terminal";
  const path = [appBin(home), `${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  const script = `${orchiDir(s, home)}/bin/switchboard-answer`;
  return [`ORCHI_HERDR=${where}`, `PATH=${path}`, script, ...(d.planner ? ["--board", d.board] : [d.board]), d.pane, d.id, text];
}

// On Windows the script runs under `python`, from Orchi's checkout there. There's no env wrapper or PATH to set: Orchi's
// scripts reach the app through herdr-adapter on Windows, and there's no terminal Herdr to choose.
export const windowsAnswer = (s, home) => `${orchiDir(s, home)}/bin/switchboard-answer`;

export function windowsAnswerArgv(home, d, text, s) {
  if (answerProblem(text) || !ID.test(d.id ?? "") || !PANE.test(d.pane ?? "") || !ABSOLUTE.test(d.board ?? "")) return null;
  return [windowsAnswer(s, home), ...(d.planner ? ["--board", d.board] : [d.board]), d.pane, d.id, text];
}

const firstLine = (text) => String(text ?? "").trim().split("\n")[0];

export async function sendAnswer(exec, home, d, text, s, windows = false) {
  const argv = windows ? windowsAnswerArgv(home, d, text, s) : answerArgv(home, d, text, s);
  if (!argv) throw new Error(answerProblem(text) ?? `Can't reply to ${d.orch} from here`);
  const r = await exec(windows ? "python" : "/usr/bin/env", argv);
  if (r.code !== 0) throw new Error(firstLine(r.stderr) || firstLine(r.stdout) || "The reply didn't send");
}

// Ends a run on Adam's word: closes what's open on its board and writes its `DONE`, which a run that went quiet never did.
export async function finishRun(exec, home, repo, why, s, windows = false) {
  if (!ABSOLUTE.test(repo ?? "")) throw new Error("That run has no repo to write to");
  if (windows) {
    const r = await exec("python", [windowsAnswer(s, home), "--finish", repo, why]);
    if (r.code !== 0) throw new Error(firstLine(r.stderr) || firstLine(r.stdout) || "The run didn't finish");
    return;
  }
  const path = [`${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  const r = await exec("/usr/bin/env", [`PATH=${path}`, `${orchiDir(s, home)}/bin/switchboard-answer`, "--finish", repo, why]);
  if (r.code !== 0) throw new Error(firstLine(r.stderr) || firstLine(r.stdout) || "The run didn't finish");
}

// `exec` takes no input, so a small fixed script pipes its argument. The text stays an argument, never shell text.
// On Windows `win` is the path of win.py, which puts it on the clipboard instead of pbcopy.
export async function copyText(exec, text, win = null) {
  const r = win ? await exec("python", ["-I", "-S", win, "copy-text", text]) : await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "sh", text]);
  if (r.code !== 0) throw new Error("Could not copy that");
}

// Copies, shows the terminal and pastes with no Enter. It pastes only once that terminal has the keyboard, because
// `terminal.paste` goes wherever focus is. False if it never did, with the text still on the clipboard.
export async function pasteInto({ exec, run, focused, win = null }, terminal, text) {
  if (!pasteable(text)) throw new Error("That has a control character or newline, so it can't go in a terminal");
  await copyText(exec, text, win);
  run("pane.focus", { terminal });
  for (let i = 0; i < FOCUS_TRIES; i++) {
    if (focused()?.terminal === terminal) { run("terminal.paste"); return true; }
    await (win ? exec("python", ["-I", "-S", win, "sleep", "0.1"]) : exec("sleep", ["0.1"]));
  }
  return false;
}

// What Discuss in chat leaves in the switchboard's prompt. The id and session come from a file, so they're checked.
export const discussLine = (d) => (ID.test(d.id ?? "") && ID.test(d.orch ?? "") ? `Let's talk through ${d.id} from ${d.orch} before I answer.` : null);

// Pending presses keyed by project, kept in shared state so a window restart keeps them. Each clears when state.md
// shows the switchboard did it. There's no timeout, because a safe pause waits for workers to finish their step.
// An orchestrator that has gone has nothing left to wait on, but a window that has just started reads no terminals yet.
export function settlePending(pending, paused, running, { terminalsRead = true } = {}) {
  const waiting = ([project, value]) => (value === "pausing" ? !paused.includes(project) : paused.includes(project));
  const keep = (entry) => waiting(entry) && (!terminalsRead || running.includes(entry[0]));
  return Object.fromEntries(Object.entries(pending).filter(keep));
}

// How long a press's note or error stays in the header, where it pushes every card down. Dismiss clears it sooner, and
// the next press replaces it.
export const NOTICE_MS = 30000;

// Whether a notice put up at `at` has had its time. None put up is never due.
export const noticeExpired = (at, now) => at != null && now - at >= NOTICE_MS;

// The button an app orchestrator shows: "spinner", "play" or "pause". Terminal Herdr runs stay read-only.
export function pauseControl(o, pending) {
  if (o.where !== "app") return null;
  if (pending) return "spinner";
  return o.paused ? "play" : "pause";
}
