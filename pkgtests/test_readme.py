"""The README is what a stranger reads first: install, update, uninstall and the settings."""
import json
import re

from conftest import ROOT

README = (ROOT / "README.md").read_text()
INSTALL_LINE = "curl -fsSL https://raw.githubusercontent.com/adamentwistle/orchi-build/main/install.sh | sh"


def section(name):
    found = re.search(rf"^## {name}\n(.*?)(?=^## |\Z)", README, re.M | re.S)
    assert found, f"README has no '## {name}' section"
    return found.group(1)


def test_the_readme_has_install_update_uninstall_and_settings_in_that_order():
    heads = re.findall(r"^## (.+)$", README, re.M)
    wanted = ["Install", "Update", "Uninstall", "Settings"]
    assert [h for h in heads if h in wanted] == wanted


def test_install_is_the_one_line():
    assert INSTALL_LINE in section("Install")


def test_the_install_line_is_the_script_in_this_repo():
    script = (ROOT / "install.sh").read_text()
    assert "adamentwistle/orchi-build" in script and "install.sh" in INSTALL_LINE


def test_update_names_the_command():
    assert "orchi update" in section("Update")


def test_uninstall_names_the_command_the_yes_flag_and_what_removes_the_tool():
    text = section("Uninstall")
    assert "orchi uninstall" in text and "--yes" in text and "uv tool uninstall orchi" in text


def test_uninstall_says_what_it_keeps():
    text = section("Uninstall").lower()
    for word in ("backups", "keychain", "settings"):
        assert word in text


def test_every_setting_in_the_schema_is_in_the_table():
    schema = json.loads((ROOT / "src" / "orchi" / "settings.schema.json").read_text())

    def keys(properties, prefix=""):
        for name, spec in properties.items():
            if spec.get("type") == "object" and "properties" in spec:
                yield from keys(spec["properties"], f"{prefix}{name}.")
            else:
                yield prefix + name

    table = section("Settings")
    for key in keys(schema["properties"]):
        assert f"`{key}`" in table, key


def test_the_readme_has_no_dashes_for_commas():
    assert "\u2014" not in README and "\u2013" not in README
