#!/bin/sh
# Installs Orchi: uv if it is missing, then the latest release, then runs `orchi`.
#   curl -fsSL https://raw.githubusercontent.com/adamentwistle/orchi-build/main/install.sh | sh
# While the repo is private, ORCHI_GITHUB_TOKEN holds a token that can read it. It goes in a request header and nowhere else.
set -eu

repo=${ORCHI_REPO:-adamentwistle/orchi-build}
api=${ORCHI_API_URL:-https://api.github.com}
uv_installer=${ORCHI_UV_INSTALL_URL:-https://astral.sh/uv/install.sh}
fail() { printf 'orchi install: %s\n' "$*" >&2; exit 1; }

# curl, with the token as a header read from standard input, so it is on no command line.
get() {
  if [ -n "${ORCHI_GITHUB_TOKEN:-}" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$ORCHI_GITHUB_TOKEN" | curl -fsSL -K - "$@"
  else
    curl -fsSL "$@"
  fi
}

command -v curl >/dev/null 2>&1 || fail "needs curl"
command -v tar >/dev/null 2>&1 || fail "needs tar"
started_with=$PATH

# uv, from uv's own installer, and on PATH for the rest of this script.
if ! command -v uv >/dev/null 2>&1; then
  echo "Installing uv"
  curl -fsSL "$uv_installer" | sh >/dev/null || fail "uv did not install"
  PATH="${UV_INSTALL_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}:$PATH"
  command -v uv >/dev/null 2>&1 || fail "uv is not on PATH after its installer ran"
fi

tag=$(get "$api/repos/$repo/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1) || true
[ -n "$tag" ] || fail "no latest release found for $repo (while it is private, set ORCHI_GITHUB_TOKEN)"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
echo "Installing Orchi $tag"
get "$api/repos/$repo/tarball/$tag" -o "$work/orchi.tar.gz" || fail "could not download Orchi $tag"
uv tool install --force "$work/orchi.tar.gz" >/dev/null || fail "uv could not install Orchi $tag"
rm -rf "$work"
trap - EXIT

bin=$(uv tool dir --bin)
PATH="$bin:$PATH"
export PATH
case ":$started_with:" in *":$bin:"*) ;; *) echo "Open a new terminal afterwards, or run: uv tool update-shell" ;; esac

# Orchi asks its questions at the terminal itself, so it works when this script came in through a pipe.
if (exec </dev/tty) 2>/dev/null; then orchi </dev/tty; else orchi; fi
