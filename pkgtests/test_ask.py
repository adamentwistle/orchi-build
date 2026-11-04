"""The questions setup asks at the terminal: a pick from a list, several picks, and a secret that is never shown."""
import io
import os
import termios

import pytest

from orchi import screen


class Tty:
    def __init__(self, lines, fd=None):
        self.lines, self.out, self.fd, self.during = list(lines), [], fd, None

    def readline(self):
        if self.fd is not None:
            self.during = termios.tcgetattr(self.fd)[3] & termios.ECHO
        return self.lines.pop(0) if self.lines else ""

    def write(self, text):
        self.out.append(text)

    def flush(self):
        pass

    def fileno(self):
        return self.fd

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        pass


def asking(monkeypatch, tty):
    monkeypatch.setattr(screen, "open_tty", lambda: tty)
    return screen.Screen(io.StringIO(), env={"NO_COLOR": "1"})


CHOICES = ["ENG  Engineering", "OPS  Operations", "WEB  Web"]


@pytest.mark.parametrize("line, picked", [("1", [CHOICES[0]]), ("3, 1", [CHOICES[0], CHOICES[2]]), ("1,1,2", CHOICES[:2]),
                                          ("2 3", CHOICES[1:]), ("\n", [])])
def test_several_picks_come_back_in_list_order_once_each_and_enter_alone_is_none(monkeypatch, line, picked):
    got = asking(monkeypatch, Tty([line if line == "\n" else line + "\n"])).ask_many("Teams", CHOICES)
    assert got == picked


def test_a_number_off_the_list_or_a_word_is_asked_again_up_to_three_times(monkeypatch):
    tty = Tty(["9\n", "one\n", "2\n"])
    assert asking(monkeypatch, tty).ask_many("Teams", CHOICES) == [CHOICES[1]]
    tty = Tty(["9\n", "x\n", "0\n"])
    with pytest.raises(screen.NoAnswer):
        asking(monkeypatch, tty).ask_many("Teams", CHOICES)


def test_a_closed_terminal_is_no_answer_and_no_terminal_is_named(monkeypatch):
    with pytest.raises(screen.NoAnswer):
        asking(monkeypatch, Tty([])).ask_many("Teams", CHOICES)

    def none():
        raise OSError

    monkeypatch.setattr(screen, "open_tty", none)
    with pytest.raises(screen.NoTerminal, match="needs a terminal to answer: Teams"):
        screen.Screen(io.StringIO()).ask_many("Teams", CHOICES)
    with pytest.raises(screen.NoTerminal, match="needs a terminal to answer: Key"):
        screen.Screen(io.StringIO()).ask_secret("Key")


def test_a_secret_is_read_with_echo_off_and_echo_is_back_afterwards(monkeypatch):
    master, slave = os.openpty()
    try:
        before = termios.tcgetattr(slave)[3] & termios.ECHO
        assert before
        tty = Tty(["  lin_api_secret \n"], fd=slave)
        got = asking(monkeypatch, tty).ask_secret("Linear API key")
        assert got == "lin_api_secret"
        assert tty.during == 0
        assert termios.tcgetattr(slave)[3] & termios.ECHO
        assert "lin_api_secret" not in "".join(tty.out)
    finally:
        os.close(master)
        os.close(slave)


def test_echo_comes_back_when_reading_a_secret_fails(monkeypatch):
    master, slave = os.openpty()
    try:
        class Failing(Tty):
            def readline(self):
                raise KeyboardInterrupt

        with pytest.raises(KeyboardInterrupt):
            asking(monkeypatch, Failing([], fd=slave)).ask_secret("Key")
        assert termios.tcgetattr(slave)[3] & termios.ECHO
    finally:
        os.close(master)
        os.close(slave)


def test_an_empty_secret_is_no_answer(monkeypatch):
    master, slave = os.openpty()
    try:
        with pytest.raises(screen.NoAnswer):
            asking(monkeypatch, Tty(["\n"], fd=slave)).ask_secret("Key")
    finally:
        os.close(master)
        os.close(slave)


def test_a_terminal_that_cannot_hide_typing_is_refused_rather_than_echoed(monkeypatch):
    class Plain(Tty):
        def fileno(self):
            return 99999

    with pytest.raises(screen.NoTerminal, match="hides what you type"):
        asking(monkeypatch, Plain(["secret\n"])).ask_secret("Key")


def test_a_secret_without_termios_is_no_terminal_not_a_crash(monkeypatch):
    monkeypatch.setattr(screen, "termios", None)
    with pytest.raises(screen.NoTerminal):
        asking(monkeypatch, Tty(["secret\n"])).ask_secret("Key")
