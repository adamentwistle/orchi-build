"""In CI a missing uv is a failure, not a skip, so the packaging tests cannot go quiet."""
import pytest

from conftest import find_uv


def test_missing_uv_skips_on_a_laptop(monkeypatch):
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.setenv("PATH", "")
    with pytest.raises(pytest.skip.Exception) as stop:
        find_uv()
    assert "uv is not installed" in str(stop.value)


def test_missing_uv_fails_in_ci(monkeypatch):
    monkeypatch.setenv("CI", "true")
    monkeypatch.setenv("PATH", "")
    with pytest.raises(pytest.fail.Exception):
        find_uv()
