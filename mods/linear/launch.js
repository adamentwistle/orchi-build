// Starts Claude Code in a new tab and labels its terminal. The tab comes from a labelled terminal, which Herdr
// shows as a tab of its own, because tab.new selects the tab and takes focus, even in a space that isn't shown.
// `zsh -i` gives it the shell's profile, the task stays one argument, never shell text, and a shell stays when it ends.
// `PATH` is set after zsh starts, because ~/.zshenv puts Homebrew first. It gives this session and all it starts
// orchi's herdr wrapper, and nothing else in the app gets it. `HERDR_ENV=1` marks an app session for `/fanout`.
// `exec` and `hc` are passed in for `node --test`.
// With no model or effort, Claude Code starts on its own defaults, as Pickup and Go in the Legwork panel do.
export const claudeArgv = (model, effort, task, flags = []) =>
  ["claude", ...flags, ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : []), task];

export const appBin = (home) => `${home}/.local/libexec/orchi-app`;

const OPEN = 'export PATH="$1:$PATH" HERDR_ENV=1; shift; "$@"; exec zsh -i';
const NAME_TRIES = 20;

// A space on this Mac: the folder's, else the shown one. Terminals here can't join another machine's space.
export const localSpace = (list, folder) => {
  const here = list.filter((s) => !s.machine);
  return (here.find((s) => s.folder === folder) ?? here.find((s) => s.active) ?? here[0])?.id ?? null;
};

// A new tab or space appears a moment after its terminal. One that stays unnamed keeps Herdr's name, and the session
// still runs. `kind` is "tab" or "space". Windows has no sleep program, so win.py waits there.
async function nameIt(exec, kind, id, name, win) {
  for (let i = 0; i < NAME_TRIES; i++) {
    const r = await exec("herdr-app", ["do", `${kind}.rename`, JSON.stringify({ id, name })]);
    if (r.code === 0 || !String(r.stdout).includes(`no ${kind}`)) return;
    await (win ? exec("python", ["-I", "-S", win, "sleep", "0.25"]) : exec("sleep", ["0.25"]));
  }
}

// One PowerShell word: single quotes, with any inside doubled, so nothing in it is read as code.
export const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

// What PowerShell 7 runs on Windows, in place of the zsh line above: the same environment, then claude. The app's
// terminals run pwsh there, and `-NoExit` leaves the shell when Claude Code ends. Every argument is quoted.
export const windowsScript = (home, argv) => [
  "$env:HERDR_ENV = '1'", "$env:DISABLE_AUTO_UPDATE = 'true'",
  `$env:PATH = ${psQuote(`${appBin(home).replace(/\//g, "\\")};`)} + $env:PATH`,
  `& ${argv.map(psQuote).join(" ")}`,
].join("; ");

// `name` is the terminal's unique name, and `labels` its `key=value` labels. `spaceName` names a space this start opens.
// `focus` shows the new tab and its space once it's there, for a start Adam asked to look at.
// On Windows `windows` is true and `win` is the path of win.py.
export async function startClaude({ exec, hc, home, windows = false, win = null }, { model, effort, flags, task, tab, folder, space, spaceName, name, labels = [], focus = false }) {
  if (!space) throw new Error("Could not start Claude Code: there's no space on this Mac");
  const id = `tb${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const shell = windows
    ? ["pwsh.exe", "-NoLogo", "-NoExit", "-Command", windowsScript(home(), claudeArgv(model, effort, task, flags))]
    : ["/bin/zsh", "-ic", OPEN, "zsh", appBin(home()), ...claudeArgv(model, effort, task, flags)];
  const r = await hc(["run", "--json", "--bg", "--keep", "--no-parent", "--outlive-parent", ...(name ? ["--name", name] : []), "--cwd", folder,
    "--label", `herdr.space=${space}`, "--label", `herdr.tab=${id}`, ...labels.flatMap((label) => ["--label", label]),
    "--", ...shell]);
  let terminal = null;
  try { terminal = JSON.parse(r.stdout).address; } catch { /* reported below */ }
  if (r.code !== 0 || !terminal) throw new Error("Could not start Claude Code");
  await nameIt(exec, "tab", id, tab, win);
  if (spaceName) await nameIt(exec, "space", space, spaceName, win);
  if (focus) {
    await exec("herdr-app", ["do", "space.select", JSON.stringify({ id: space })]).catch(() => null);
    await exec("herdr-app", ["do", "tab.select", JSON.stringify({ id })]).catch(() => null);
  }
  return terminal;
}
