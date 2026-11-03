// Reaching the one switchboard from a panel: its lock, the requests it reads and starting it when the lock is free.
// No Herdr imports, so `node --test` can load this file. `mods/linear` and `mods/orchi` carry the same copy.
import { sendAside } from "./draft.js";
import { localSpace, startClaude } from "./launch.js";
import { orchiDir, switchboardDir } from "./settings.js";

export const NAME = /^[\w-]+$/;
const TERMINAL = /^\w[\w:./-]*$/;
const VERBS = ["start", "run", "pause", "resume"];
const MODELS = ["fable", "opus", "sonnet", "haiku"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const WAKE = "SWITCHBOARD REQUESTS";

// `s` is Orchi's settings, and `io.orchi` carries them. They say where the switchboard's files and Orchi's checkout are.
export { switchboardDir };
export const planningDir = (s, home) => `${switchboardDir(s, home)}/planning`;

// A model choice from the review screen as `claude` flags. Shared state isn't trusted to reach argv unchecked.
export function claudeChoice(choice) {
  const model = String(choice?.model ?? "").toLowerCase(), effort = String(choice?.effort ?? "").toLowerCase();
  return { model: MODELS.includes(model) ? model : "opus", effort: EFFORTS.includes(effort) ? effort : "high" };
}

export function parseLock(text) {
  try {
    const { terminal, herdr, started } = JSON.parse(text);
    return TERMINAL.test(terminal ?? "") && ["app", "terminal"].includes(herdr) ? { terminal, herdr, started: started ?? null } : null;
  } catch { return null; }
}

// Who holds the switchboard: `where` is "app", "terminal" or null when it's free. A lock whose terminal is gone is stale,
// as the lock says. A live terminal named `switchboard` counts with no lock, because a new one takes the lock a
// moment after it starts, and a terminal Herdr one from before the lock has no entry at all.
export function holderOf(lock, live, agents) {
  const inApp = (id) => live.some((t) => t.state === "live" && (t.address === id || t.name === id));
  if (lock?.herdr === "app" && inApp(lock.terminal)) return { where: "app", terminal: lock.terminal };
  if (lock?.herdr === "terminal" && agents.some((a) => a.pane === lock.terminal)) return { where: "terminal", terminal: lock.terminal };
  const named = live.find((t) => t.state === "live" && t.name === "switchboard");
  if (named) return { where: "app", terminal: named.address };
  const old = agents.find((a) => a.name === "switchboard");
  return old ? { where: "terminal", terminal: old.pane } : { where: null, terminal: null };
}

const safeLive = (io) => { try { return io.terminals(); } catch { return []; } };

// Read at the moment it matters, never from a panel's last load.
async function holderNow(io) {
  const [text, agents] = await Promise.all([io.readTextFile(`${switchboardDir(io.orchi, io.home())}/lock`).catch(() => null), io.agents()]);
  return holderOf(parseLock(text ?? ""), safeLive(io), agents);
}

// Starts a switchboard only when the lock is free. `hc run --name` refuses a second live `switchboard`, so two presses
// racing here start one: the loser fails, then finds the winner.
export async function ensureSwitchboard(io, choice) {
  const holder = await holderNow(io);
  if (holder.where) return { ...holder, started: false };
  const folder = orchiDir(io.orchi, io.home());
  try {
    const terminal = await startClaude(io, {
      ...claudeChoice(choice), task: "/switchboard resume", tab: "Switchboard", folder, space: localSpace(io.spaces(), folder),
      name: "switchboard", labels: ["orchi.switchboard=1"], pinProfile: true,
    });
    return { where: "app", terminal, started: true };
  } catch (e) {
    const again = await holderNow(io);
    if (again.where) return { ...again, started: false };
    throw e;
  }
}

// One line for the switchboard, or null for anything it would refuse.
export function requestLine(verb, name) {
  return VERBS.includes(verb) && NAME.test(name ?? "") ? `${verb} ${name}` : null;
}

// What Adam chose at Start. The switchboard reads it for this request, and the orchestrator after every cycle, so it
// stays until the next Start replaces it. `name` is the session or project on the request line.
export const runRulesFile = (s, home, name) => `${switchboardDir(s, home)}/run-rules/${name}.json`;

export async function writeRunRules(io, name, rules) {
  if (!NAME.test(name ?? "")) throw new Error("That plan's name can't be a file name");
  const path = runRulesFile(io.orchi, io.home(), name);
  await io.exec("mkdir", ["-p", `${switchboardDir(io.orchi, io.home())}/run-rules`]);
  const old = await io.readTextFile(path).catch(() => null);
  await io.writeTextFile(path, `${JSON.stringify(rules, null, 2)}\n`, old ?? null);
  return path;
}

export const requestFile = (s, home, ms, random) => `${switchboardDir(s, home)}/requests/${ms}-${random}.req`;

// Writes the request whatever happens next, so it waits for the session. A switchboard started just now reads
// requests/ on `/switchboard resume`, and one in terminal Herdr finds it from `switchboard-wait`.
// A send that fails leaves the file for that same wait.
export async function sendRequest(io, line, choice) {
  if (!line) throw new Error("That request isn't one the switchboard takes");
  const holder = await ensureSwitchboard(io, choice), root = switchboardDir(io.orchi, io.home());
  await io.exec("mkdir", ["-p", `${root}/requests`]);
  await io.writeTextFile(requestFile(io.orchi, io.home(), io.now(), io.random()), `${line}\n`, null);
  if (holder.where === "app" && !holder.started) await sendAside(io, holder.terminal, WAKE);
  return holder;
}
