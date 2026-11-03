// Starts Claude Code in a new tab and labels its terminal. The tab comes from a labelled terminal, which Herdr
// shows as a tab of its own, because tab.new selects the tab and takes focus, even in a space that isn't shown.
// `zsh -i` gives it the shell's profile, the task stays one argument, never shell text, and a shell stays when it ends.
// `PATH` is set after zsh starts, because ~/.zshenv puts Homebrew first. It gives this session and all it starts
// orchi's herdr wrapper, and nothing else in the app gets it. `HERDR_ENV=1` marks an app session for `/fanout`.
// When Orchi's settings set claude_dir (`orchi` is the read settings), the shell exports it as CLAUDE_CONFIG_DIR after
// ~/.zshrc, so the session runs under the folder the panels read, and a `claude` shell function still runs. `pinProfile`
// gives it ~/.claude even when claude_dir is unset, for the switchboard, whose files are there, as the watcher does. `exec` and `hc` are passed in for `node --test`.
import { claudeDir, profileDir } from "./settings.js";

export const claudeArgv = (model, effort, task, flags = []) => ["claude", ...flags, "--model", model, "--effort", effort, task];

export const appBin = (home) => `${home}/.local/libexec/orchi-app`;

const OPEN = 'export PATH="$1:$PATH" HERDR_ENV=1; shift; "$@"; exec zsh -i';
const OPEN_AS = 'export PATH="$1:$PATH" HERDR_ENV=1 CLAUDE_CONFIG_DIR="$2"; shift 2; "$@"; exec zsh -i';
const NAME_TRIES = 20;

// A space on this Mac: the folder's, else the shown one. Terminals here can't join another machine's space.
export const localSpace = (list, folder) => {
  const here = list.filter((s) => !s.machine);
  return (here.find((s) => s.folder === folder) ?? here.find((s) => s.active) ?? here[0])?.id ?? null;
};

// A new tab or space appears a moment after its terminal. One that stays unnamed keeps Herdr's name, and the session
// still runs. `kind` is "tab" or "space".
async function nameIt(exec, kind, id, name) {
  for (let i = 0; i < NAME_TRIES; i++) {
    const r = await exec("herdr-app", ["do", `${kind}.rename`, JSON.stringify({ id, name })]);
    if (r.code === 0 || !String(r.stdout).includes(`no ${kind}`)) return;
    await exec("sleep", ["0.25"]);
  }
}

// `name` is the terminal's unique name, and `labels` its `key=value` labels. `spaceName` names a space this start opens.
export async function startClaude({ exec, hc, home, orchi }, { model, effort, flags, task, tab, folder, space, spaceName, name, labels = [], pinProfile = false }) {
  if (!space) throw new Error("Could not start Claude Code: there's no space on this Mac");
  const profile = pinProfile ? claudeDir(orchi, home()) : profileDir(orchi, home());
  const id = `tb${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const r = await hc(["run", "--json", "--bg", "--keep", "--no-parent", "--outlive-parent", ...(name ? ["--name", name] : []), "--cwd", folder,
    "--label", `herdr.space=${space}`, "--label", `herdr.tab=${id}`, ...labels.flatMap((label) => ["--label", label]),
    "--", "/bin/zsh", "-ic", profile ? OPEN_AS : OPEN, "zsh", appBin(home()), ...(profile ? [profile] : []), ...claudeArgv(model, effort, task, flags)]);
  let terminal = null;
  try { terminal = JSON.parse(r.stdout).address; } catch { /* reported below */ }
  if (r.code !== 0 || !terminal) throw new Error("Could not start Claude Code");
  await nameIt(exec, "tab", id, tab);
  if (spaceName) await nameIt(exec, "space", space, spaceName);
  return terminal;
}
