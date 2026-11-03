// How wide the chat runs in its pane. No Herdr imports, so `node --test` can load this file.
// On the Mac it takes most of a wide pane, but stops short of lines too long to read. On Windows it fills the
// pane, less a small margin each side. A narrow pane just fills either way, because every column is a max width. Sizes are
// the app's own units, so a window's zoom doesn't change the share.
import { isWindows } from "./platform.js";

const SMALLEST = 800, SHARE = 0.85, LARGEST = 1400, MARGIN = 24;

export const chatWidth = (pane, fill = isWindows()) =>
  Math.round(fill ? Math.max(SMALLEST, pane - MARGIN * 2) : Math.min(LARGEST, Math.max(SMALLEST, pane * SHARE)));
