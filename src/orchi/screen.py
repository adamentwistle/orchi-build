"""What `orchi` shows: one line per step, a mark and the name in aligned columns, then one closing line.

On a terminal the marks are coloured and the running step has a spinner. With NO_COLOR set, TERM=dumb, or output
that isn't a terminal, the same lines come with no escape codes at all. --json prints one JSON object instead.

The colours are the terminal's own sixteen, which Orchi's themes set (themes/*.json "ansi", built by
scripts/build-themes.py), so in Herdr they are Orchi's palette in dark and light alike. No colour is defined here.

Questions are a numbered list read from /dev/tty, never stdin, so they work under `curl | sh`.
"""
import json
import os
import sys
import threading

OK, NEEDS_FIX, BROKEN, FIXED, STOPPED = "ok", "needs-fix", "broken", "fixed", "stopped"

# ANSI colour slots: the theme's green, yellow, red, blue, magenta and bright black.
GREEN, YELLOW, RED, BLUE, MAGENTA, DIM = "32", "33", "31", "34", "35", "90"
MARKS = {OK: ("✓", GREEN), FIXED: ("✓", GREEN), NEEDS_FIX: ("!", YELLOW), BROKEN: ("✗", RED), STOPPED: ("-", DIM)}
FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
TRIES = 3


class NoTerminal(Exception):
    pass


class NoAnswer(Exception):
    pass


def open_tty():
    """The terminal, for questions. Raises OSError when there is none."""
    return _Tty()


class _Tty:
    """/dev/tty opened once to read and once to write, since a terminal can't seek, which one file open for both
    would need."""

    def __init__(self):
        self._in = open("/dev/tty", encoding="utf-8")
        try:
            self._out = open("/dev/tty", "w", encoding="utf-8")
        except OSError:
            self._in.close()
            raise

    def readline(self):
        return self._in.readline()

    def write(self, text):
        self._out.write(text)

    def flush(self):
        self._out.flush()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self._in.close()
        self._out.close()


def _isatty(stream):
    try:
        return stream.isatty()
    except (AttributeError, ValueError, OSError):
        return False


class Screen:
    def __init__(self, stream=None, as_json=False, env=None):
        self.out = stream or sys.stdout
        env = os.environ if env is None else env
        self.as_json = as_json
        self.colour = not env.get("NO_COLOR") and env.get("TERM") != "dumb"
        self.live = self.colour and not as_json and _isatty(self.out)
        self.width = 0
        self._spinning = None
        self._write_lock = threading.Lock()
        self._gone = False

    def begin(self, names):
        self.width = max((len(n) for n in names), default=0)

    def running(self, name):
        """Show the step as running: a spinner on a terminal, nothing otherwise."""
        if not self.live:
            return
        self._stop_spinner()
        stop = threading.Event()
        thread = threading.Thread(target=self._spin, args=(name, stop), daemon=True)
        self._spinning = (name, stop, thread)
        thread.start()

    def result(self, name, status, detail=""):
        self._stop_spinner()
        if self.as_json:
            return
        mark, colour = MARKS[status]
        line = f"{self._paint(mark, colour)}  {name}"
        if detail:
            line = f"{self._paint(mark, colour)}  {name.ljust(self.width)}  {self._paint(detail, DIM)}"
        self._write(line + "\n")

    def finish(self, report):
        """The closing line, or the whole report as JSON."""
        self._stop_spinner()
        if self.as_json:
            self._write(json.dumps(report, ensure_ascii=False) + "\n")
        else:
            self._write(report["summary"] + "\n")

    def ask(self, question, choices):
        """One of choices, picked by number (or typed in full) at the terminal. Raises NoTerminal when there is no
        terminal to ask, and NoAnswer when the terminal closes or gives no usable answer."""
        running = self._spinning[0] if self._spinning else None
        self._stop_spinner()
        try:
            try:
                tty = open_tty()
            except OSError:
                raise NoTerminal(f"needs a terminal to answer: {question}") from None
            with tty:
                tty.write(f"{self._paint('?', MAGENTA)}  {question}\n")
                for n, choice in enumerate(choices, 1):
                    tty.write(f"   {n}  {choice}\n")
                for _ in range(TRIES):
                    tty.write(">  ")
                    tty.flush()
                    line = tty.readline()
                    if not line:
                        break
                    picked = _pick(line.strip(), choices)
                    if picked is not None:
                        return picked
            raise NoAnswer(f"no answer: {question}")
        finally:
            if running:
                self.running(running)

    def _paint(self, text, colour):
        return f"\x1b[{colour}m{text}\x1b[0m" if self.colour and _isatty(self.out) and text else text

    def _write(self, text):
        """Write, unless whatever reads the output has gone (`orchi | head`): then the run goes on unseen."""
        with self._write_lock:
            if self._gone:
                return
            try:
                self.out.write(text)
                self.out.flush()
            except BrokenPipeError:
                self._gone = True
                _send_to_null(self.out)

    def _spin(self, name, stop):
        n = 0
        while True:
            self._write(f"\r\x1b[2K{self._paint(FRAMES[n % len(FRAMES)], BLUE)}  {name}")
            if stop.wait(0.08):
                return
            n += 1

    def _stop_spinner(self):
        if not self._spinning:
            return
        _, stop, thread = self._spinning
        self._spinning = None
        stop.set()
        try:
            thread.join()
        finally:
            self._write("\r\x1b[2K")


def _send_to_null(stream):
    """Point a stream whose reader has gone at /dev/null, so what is still in its buffer doesn't fail again when
    Python flushes it at exit."""
    try:
        fd = stream.fileno()
    except (AttributeError, OSError, ValueError):
        return
    null = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(null, fd)
    finally:
        os.close(null)


def _pick(answer, choices):
    if answer.isdecimal() and answer.isascii() and 1 <= int(answer) <= len(choices):
        return choices[int(answer) - 1]
    folded = {c.casefold(): c for c in choices}
    return folded.get(answer.casefold())
