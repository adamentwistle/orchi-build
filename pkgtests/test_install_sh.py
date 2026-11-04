"""install.sh, the one line a stranger runs, against a local server that plays GitHub and uv's installer, with a fake uv
and a fake orchi. Nothing leaves this computer: every address the script uses is one of its settings."""
import io
import json
import os
import shutil
import subprocess
import tarfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from conftest import ROOT
from engine_help import in_terminal

SCRIPT = ROOT / "install.sh"
TOKEN = "ghp_secretTOKENvalue1234567890"

FAKE_UV = """#!/bin/sh
echo "uv $*" >> "$MARKS/uv.log"
case "$1 $2 $3" in
  "tool dir --bin") echo "$HOME/.local/bin" ;;
  "tool install "*)
    shift 2
    for a in "$@"; do last=$a; done
    tar -tzf "$last" > /dev/null || exit 1
    cat > "$HOME/.local/bin/orchi" <<'EOS'
#!/bin/sh
if [ -t 0 ]; then echo tty > "$MARKS/orchi.stdin"; else echo notty > "$MARKS/orchi.stdin"; fi
echo "$@" > "$MARKS/orchi.args"
EOS
    chmod +x "$HOME/.local/bin/orchi" ;;
esac
"""

UV_INSTALLER = """#!/bin/sh
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/uv" <<'EOUV'
%s
EOUV
chmod +x "$HOME/.local/bin/uv"
echo "installed uv" >> "$MARKS/uv-installer.log"
""" % FAKE_UV


class Site:
    def __init__(self):
        self.seen = []
        self.tag = "v9.9.9"
        self.token = None
        self.tarball = None
        site = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                site.seen.append((self.path, self.headers.get("Authorization")))
                if site.token and self.headers.get("Authorization") != f"Bearer {site.token}" and self.path.startswith("/repos"):
                    self.send_response(404)
                    self.end_headers()
                    return
                if self.path == "/repos/o/r/releases/latest":
                    body = json.dumps({"tag_name": site.tag, "name": "x"}, indent=2).encode()
                elif self.path == f"/repos/o/r/tarball/{site.tag}" and site.tarball:
                    body = site.tarball
                elif self.path == f"/repos/o/r/tarball/{site.tag}":
                    out = io.BytesIO()
                    with tarfile.open(fileobj=out, mode="w:gz") as tar:
                        info = tarfile.TarInfo("o-r-abc123/pyproject.toml")
                        data = b"[project]\nname = 'orchi'\n"
                        info.size = len(data)
                        tar.addfile(info, io.BytesIO(data))
                    body = out.getvalue()
                elif self.path == "/uv/install.sh":
                    body = UV_INSTALLER.encode()
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


@pytest.fixture
def site():
    made = Site()
    yield made
    made.server.shutdown()
    made.server.server_close()


class Box:
    def __init__(self, tmp_path, site):
        self.home, self.marks, self.tmp = tmp_path / "home", tmp_path / "marks", tmp_path / "tmp"
        for folder in (self.home / ".local" / "bin", self.marks, self.tmp):
            folder.mkdir(parents=True)
        self.site = site
        self.wrappers = tmp_path / "wrappers"
        self.wrappers.mkdir()
        real = shutil.which("curl")
        # curl, recording every argument it is given, so a token on a command line would show.
        (self.wrappers / "curl").write_text(f'#!/bin/sh\nprintf "%s\\n" "$@" >> "{self.marks}/curl.args"\nexec {real} "$@"\n')
        (self.wrappers / "curl").chmod(0o755)

    def env(self, with_uv=False, **extra):
        env = {"HOME": str(self.home), "MARKS": str(self.marks), "TMPDIR": str(self.tmp),
               "PATH": f"{self.wrappers}:/usr/bin:/bin", "ORCHI_API_URL": self.site.url, "ORCHI_REPO": "o/r",
               "ORCHI_UV_INSTALL_URL": f"{self.site.url}/uv/install.sh", "TERM": "dumb"}
        if with_uv:
            (self.home / ".local" / "bin" / "uv").write_text(FAKE_UV)
            (self.home / ".local" / "bin" / "uv").chmod(0o755)
            env["PATH"] = f"{self.home}/.local/bin:{env['PATH']}"
        env.update(extra)
        return env

    def mark(self, name):
        path = self.marks / name
        return path.read_text() if path.exists() else None

    def run(self, env, piped=False):
        if piped:
            return subprocess.run(["/bin/sh"], input=SCRIPT.read_bytes(), env=env, capture_output=True, timeout=60,
                                  start_new_session=True)
        return subprocess.run(["/bin/sh", str(SCRIPT)], env=env, capture_output=True, timeout=60, stdin=subprocess.DEVNULL,
                              start_new_session=True)


@pytest.fixture
def box(tmp_path, site):
    if shutil.which("uv", path="/usr/bin:/bin"):
        pytest.skip("a uv in /usr/bin would stand in for the one this test leaves out")
    return Box(tmp_path, site)


def test_it_installs_uv_when_it_is_missing_then_the_latest_release_then_runs_orchi(box):
    done = box.run(box.env())
    assert done.returncode == 0, done.stdout + done.stderr
    assert box.mark("uv-installer.log") == "installed uv\n"
    log = box.mark("uv.log").splitlines()
    assert log[0] == "uv tool dir --bin" or log[0].startswith("uv tool install")
    install = next(line for line in log if line.startswith("uv tool install"))
    assert "o-r" in install or ".tar.gz" in install
    assert box.mark("orchi.args") == "\n"
    assert [p for p, _ in box.site.seen] == ["/uv/install.sh", "/repos/o/r/releases/latest", "/repos/o/r/tarball/v9.9.9"]


def test_it_leaves_uv_alone_when_it_is_there(box):
    done = box.run(box.env(with_uv=True))
    assert done.returncode == 0, done.stdout + done.stderr
    assert box.mark("uv-installer.log") is None
    assert "/uv/install.sh" not in [p for p, _ in box.site.seen]


def test_run_piped_from_curl_with_no_terminal_still_installs_and_runs_orchi(box):
    done = box.run(box.env(with_uv=True), piped=True)
    assert done.returncode == 0, done.stdout + done.stderr
    assert box.mark("orchi.stdin") == "notty\n"


def test_run_piped_from_curl_with_a_terminal_gives_orchi_the_terminal(box, tmp_path):
    env = box.env(with_uv=True)
    code, shown = in_terminal(["-c", f"import os; os.execv('/bin/sh', ['sh', '-c', 'cat {SCRIPT} | sh'])"], env, pipe_stdin=True)
    assert code == 0, shown
    assert box.mark("orchi.stdin") == "tty\n"


def test_the_token_goes_only_in_a_header_and_is_never_printed_or_written_or_on_a_command_line(box):
    box.site.token = TOKEN
    env = box.env(with_uv=True, ORCHI_GITHUB_TOKEN=TOKEN)
    done = box.run(env)
    assert done.returncode == 0, done.stdout + done.stderr
    assert TOKEN.encode() not in done.stdout + done.stderr
    assert [a for p, a in box.site.seen if p.startswith("/repos")] == [f"Bearer {TOKEN}"] * 2
    assert TOKEN not in box.mark("curl.args")
    for folder in (box.home, box.marks, box.tmp):
        for here, _, files in os.walk(folder):
            for name in files:
                assert TOKEN.encode() not in (Path(here) / name).read_bytes(), name


def test_without_the_token_a_private_repo_is_refused_with_one_plain_line(box):
    box.site.token = TOKEN
    done = box.run(box.env(with_uv=True))
    assert done.returncode == 1
    assert b"latest release" in done.stderr + done.stdout
    assert box.mark("orchi.args") is None


def test_a_release_with_no_tag_stops_before_anything_is_installed(box):
    box.site.tag = ""
    done = box.run(box.env(with_uv=True))
    assert done.returncode == 1 and box.mark("orchi.args") is None


def test_the_temporary_download_is_removed_and_nothing_is_left_in_the_working_folder(box, tmp_path):
    done = subprocess.run(["/bin/sh", str(SCRIPT)], env=box.env(with_uv=True), cwd=tmp_path, capture_output=True,
                          stdin=subprocess.DEVNULL, start_new_session=True, timeout=60)
    assert done.returncode == 0
    assert list(box.tmp.iterdir()) == []
    assert not [p for p in tmp_path.iterdir() if p.name.endswith(".tar.gz")]


def test_the_script_is_short_and_readable():
    lines = SCRIPT.read_text().splitlines()
    assert len(lines) <= 80
    assert lines[0] == "#!/bin/sh" and "set -eu" in lines
    assert "git " not in SCRIPT.read_text().replace("GitHub", "")


def test_the_archive_of_this_checkout_installs_with_the_real_uv_and_orchi_runs(uv, tmp_path, site):
    """The same script, with the real uv in scratch folders and the checkout as the release's source archive."""
    from conftest import scratch_env
    listed = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"], cwd=ROOT, capture_output=True, text=True,
                            check=True).stdout.splitlines()
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:gz") as tar:
        for name in listed:
            if (ROOT / name).exists():
                tar.add(ROOT / name, arcname=f"o-r-abc123/{name}")
    site.tarball = out.getvalue()
    env = scratch_env(tmp_path)
    env.update(PATH=f"{Path(uv).parent}:/usr/bin:/bin", TMPDIR=str(tmp_path), ORCHI_API_URL=site.url, ORCHI_REPO="o/r",
               ORCHI_NO_SYSTEM="1", TERM="dumb")
    done = subprocess.run(["/bin/sh", str(SCRIPT)], env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL,
                          start_new_session=True, timeout=300, cwd=tmp_path)
    exe = Path(env["UV_TOOL_BIN_DIR"]) / "orchi"
    assert exe.exists(), done.stdout + done.stderr
    # Bare orchi ran: it has no real system to work with here, so it stops with a plain line, never a traceback.
    assert "Traceback" not in done.stdout + done.stderr
    assert "Orchi" in done.stdout, done.stdout
    version = subprocess.run([str(exe), "--version"], env=env, capture_output=True, text=True)
    assert version.stdout.startswith("orchi ")
