"""Writing to the keychain: the password goes down a pipe, never on a command line. The real `security` is never started;
subprocess.run is replaced where the module calls it."""
import pytest

from conftest import REAL
from orchi.tickets import keychain

KEY = "made-up-linear-key-0001"


class Done:
    def __init__(self, code=0):
        self.returncode, self.stdout, self.stderr = code, "", ""


@pytest.fixture
def on(monkeypatch):
    monkeypatch.delenv("ORCHI_NO_SYSTEM")
    calls = []

    def run(argv, **kw):
        calls.append((argv, kw))
        return Done(kw.pop("code", 0))

    monkeypatch.setattr(keychain.subprocess, "run", run)
    return calls


def test_the_password_goes_in_the_input_of_security_dash_i_and_in_no_argument(on):
    assert keychain.store_password("orchi-linear", KEY) is True
    (argv, kw), = on
    assert argv == ["/usr/bin/security", "-i"]
    assert kw["input"] == f"add-generic-password -a orchi -s orchi-linear -w {KEY}\n"
    assert KEY not in " ".join(argv) and "env" not in kw
    assert "-U" not in kw["input"].split()


@pytest.mark.parametrize("bad", ['lin"quote', "with space", "semi;colon", "new\nline", "", "back\\slash", "$(x)"])
def test_a_password_security_dash_i_might_read_differently_is_not_passed(on, bad):
    assert keychain.store_password("orchi-linear", bad) is False
    assert on == []


def test_a_service_with_odd_characters_is_not_passed(on):
    assert keychain.store_password("a b", KEY) is False and on == []


def test_security_missing_or_slow_is_false_not_an_error(monkeypatch):
    monkeypatch.delenv("ORCHI_NO_SYSTEM")

    def missing(argv, **kw):
        raise FileNotFoundError

    monkeypatch.setattr(keychain.subprocess, "run", missing)
    assert keychain.store_password("orchi-linear", KEY) is False


def test_with_the_switch_on_nothing_reaches_security(monkeypatch):
    def boom(*a, **kw):
        raise AssertionError("started security")

    monkeypatch.setattr(keychain.subprocess, "run", boom)
    assert REAL["keychain.find_password"]("orchi-linear") is None
    assert keychain.store_password("orchi-linear", KEY) is False


def test_the_keychain_follows_the_one_system_switch(monkeypatch):
    from orchi import system
    monkeypatch.delenv("ORCHI_NO_SYSTEM")
    monkeypatch.setattr(system, "SWITCH_OFF", "SOME_OTHER_SWITCH")
    monkeypatch.setenv("SOME_OTHER_SWITCH", "1")
    assert REAL["keychain.find_password"]("orchi-linear") is None
    assert keychain.store_password("orchi-linear", KEY) is False
