"""Outside text, safe to show at a terminal.

Names, titles, states, labels and bodies from Linear and GitHub, text from legwork and Markdown files, and a server's
reply in an error can hold escape codes. Written as they came, those would act on the terminal (retitle the window,
move the cursor, clear the screen). plain() is the one place that turns them into text, and every place orchi writes
such text to a terminal goes through it, or through dumps() for JSON.
"""
import json
import re

# C0 controls other than tab and newline, DEL, and C1 controls (ESC is one of the first; 0x9b is CSI on its own).
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
# What ensure_ascii=False leaves raw in a JSON string: DEL, the C1 controls (json escapes the rest of C0 itself) and
# the surrogates of a file name that isn't UTF-8, which a terminal can't be written.
RAW = re.compile(r"[\x7f-\x9f\ud800-\udfff]")


def plain(text, lines=False):
    """Text a terminal shows as text: control characters become spaces, and on one line unless `lines`."""
    # A file name that isn't UTF-8 holds surrogates, which can't be printed; they show as \udcff escapes instead.
    text = CONTROL.sub(" ", ("" if text is None else str(text))).encode("utf-8", "backslashreplace").decode("utf-8")
    return text if lines else re.sub(r"[\t\n]", " ", text)


def dumps(value, **kw):
    """JSON for a terminal: ensure_ascii off, as the reports have it, but with DEL, C1 controls and surrogates escaped too. It
    reads back as exactly the value."""
    kw.setdefault("ensure_ascii", False)
    return RAW.sub(lambda m: "\\u%04x" % ord(m.group()), json.dumps(value, **kw))
