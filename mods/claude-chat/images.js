// Images waiting in the composer. No Herdr imports, so `node --test` can load this file. `exec` is passed in.
// A pasted image is a PNG in the app's own folder, because `image()` draws only from there. It's deleted once sent
// or removed, or when its pane closes. Claude Code reads the file when the text lands, so a queued message doesn't need it
// after that. Anything left behind is deleted after PRUNE_DAYS, the next time a chat starts.
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
// A line break in a name would split the path, and the rest would go in as text.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// `pbpaste` can't read images. This takes the clipboard's PNG, or turns its TIFF into one. The path stays an argument.
// The second argument names a private pasteboard, so a test never touches the real clipboard.
const READ_CLIPBOARD = `ObjC.import("AppKit");
function run(argv) {
  var board = argv[1] ? $.NSPasteboard.pasteboardWithName(argv[1]) : $.NSPasteboard.generalPasteboard;
  var data = board.dataForType("public.png");
  if (data.isNil()) {
    var tiff = board.dataForType("public.tiff");
    if (tiff.isNil()) return "none";
    var rep = $.NSBitmapImageRep.imageRepWithData(tiff);
    if (rep.isNil()) return "none";
    data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  }
  return data.writeToFileAtomically(argv[0], true) ? "ok" : "none";
}`;

export const IMAGE_FOLDER = "chat-images";
export const isImagePath = (path) => IMAGE.test(String(path ?? "")) && !CONTROL.test(path);
const imageDir = (home) => `${home}/${IMAGE_FOLDER}`;
const inFolder = (home, path) => String(path).startsWith(`${imageDir(home)}/`) && !String(path).includes("/../");

// On Windows `win` is the path of win.py, which does what mkdir, cp, rm and osascript do here. On the Mac it's null.
const py = (exec, win, ...args) => exec("python", ["-I", "-S", win, ...args]);

// The clipboard's image as a file, or null when it holds none. `home` is `appHome()`. Windows has no private clipboard,
// so `board` is the Mac's alone.
export async function clipboardImage(exec, home, name, board = "", win = null) {
  const path = `${imageDir(home)}/${name}.png`;
  if (win) {
    await py(exec, win, "mkdir", imageDir(home));
    const r = await py(exec, win, "clipboard", path);
    return r.code === 0 && r.stdout.trim() === "ok" ? path : null;
  }
  await exec("mkdir", ["-p", "-m", "700", imageDir(home)]);
  const r = await exec("osascript", ["-l", "JavaScript", "-e", READ_CLIPBOARD, path, board]);
  return r.code === 0 && r.stdout.trim() === "ok" ? path : null;
}

// Dropped files: images wait in the composer, and anything else goes in as a path.
export function splitDropped(paths) {
  return { images: paths.filter(isImagePath), others: paths.filter((path) => !isImagePath(path)) };
}

// `image()` draws only from the app's folder, so a dropped image is copied there. If the copy fails it goes by its own
// path, with the chip in place of a picture.
export async function droppedImage(exec, home, path, name, win = null) {
  const copy = `${imageDir(home)}/${name}${path.slice(path.lastIndexOf(".")).toLowerCase()}`;
  if (win) {
    await py(exec, win, "mkdir", imageDir(home)).catch(() => null);
    const r = await py(exec, win, "copy", path, copy).catch(() => null);
    return r?.code === 0 ? copy : path;
  }
  await exec("mkdir", ["-p", "-m", "700", imageDir(home)]).catch(() => null);
  const r = await exec("cp", ["--", path, copy]).catch(() => null);
  return r?.code === 0 ? copy : path;
}

// The path `image()` wants, or null when this file can't be drawn and shows the chip.
export const previewPath = (home, path) => (inFolder(home, path) ? path.slice(home.length + 1) : null);

// Only a file this pane made is ever deleted. A dropped file is the person's own.
export async function forgetImage(exec, home, path, win = null) {
  if (!inFolder(home, path)) return;
  if (win) await py(exec, win, "remove", path).catch(() => null);
  else await exec("rm", ["-f", path]).catch(() => null);
}

// Images a pane was holding when it closed. The same rule: only files in the app's folder.
export async function forgetImages(exec, home, paths) {
  for (const path of paths) await forgetImage(exec, home, path);
}

// How old a file in the folder has to be before a chat starting up deletes it. A pane holds an image only until it's sent
// or removed, so one this old was left behind by a pane that closed without letting go.
export const PRUNE_DAYS = 7;
// The names this file gives: a time in ms, a dash and a few letters, as `fileName` in composer.js makes them.
const OURS = "[0-9]*-*.*";

// Deletes images this mod made that are older than PRUNE_DAYS, and nothing else: one folder deep, plain files, our names.
// It never throws, so a chat always starts.
export async function pruneImages(exec, home, days = PRUNE_DAYS) {
  if (!String(home ?? "").startsWith("/") || String(home).includes("/../")) return false;
  const r = await exec("find", [imageDir(home), "-maxdepth", "1", "-type", "f", "-name", OURS, "-mmin", `+${Math.round(days * 1440)}`, "-delete"]).catch(() => null);
  return r?.code === 0;
}
