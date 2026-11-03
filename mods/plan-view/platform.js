// What differs on Windows. The same file sits in each mod that needs it, because a mod can't import from outside its
// folder. No Herdr imports, so `node --test` can load this file.
import { platform } from "os";

export const isWindows = () => /^win/i.test(String(platform()));

// Windows has no python3.exe. That name runs the Microsoft Store's stand-in, which exits 9009 and runs nothing.
export const pythonName = (windows = isWindows()) => (windows ? "python" : "python3");

// The helper that stands in for sh, ls, cp and the rest on Windows, or null on the Mac.
export const winHelper = (appHome, mod, windows = isWindows()) => (windows ? `${appHome}/mods/${mod}/win.py` : null);

// Windows reports paths with backslashes, maybe with a `\\?\` prefix, and in any case, because its folders ignore case.
export const samePath = (a, b) => normalPath(a) === normalPath(b);
export const normalPath = (p) => {
  const s = String(p ?? "").replace(/\\/g, "/").replace(/^\/\/[?.]\//, "");
  return /^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s;
};
