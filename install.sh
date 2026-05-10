#!/usr/bin/env sh
# Forja installer — fetches a release binary from GitHub, verifies it
# against the published SHA256SUMS, and installs into a destination
# on PATH.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | sh -s -- v0.1.0
#   ./install.sh [--version <tag>] [--prefix <dir>] [--repo <owner/repo>]
#
# Defaults:
#   version  = latest release tag (resolved via GitHub API)
#   prefix   = $HOME/.local/bin
#   repo     = lex0c/forja
#
# Environment overrides (handy for piping):
#   FORJA_VERSION, FORJA_PREFIX, FORJA_REPO
#
# Verification chain:
#   1. download <asset>
#   2. download SHA256SUMS
#   3. compute sha256 of <asset>; compare against SHA256SUMS line
#   4. install only if matched
#
# We deliberately use plain POSIX sh so the script works on macOS's
# bundled /bin/sh and on Alpine/musl distros that lack bash by
# default. No `set -o pipefail` (not POSIX); errors surface via
# explicit checks.

set -eu

REPO="${FORJA_REPO:-lex0c/forja}"
VERSION="${FORJA_VERSION:-}"
PREFIX="${FORJA_PREFIX:-$HOME/.local/bin}"

print_help() {
  cat <<'USAGE'
Forja installer — fetches a release binary from GitHub, verifies the
SHA256 against the published SHA256SUMS, and installs into a directory
on PATH.

Usage:
  install.sh [--version <tag>] [--prefix <dir>] [--repo <owner/repo>]
  install.sh <tag>

Defaults:
  version  latest release tag (resolved via GitHub API)
  prefix   $HOME/.local/bin
  repo     lex0c/forja

Environment overrides:
  FORJA_VERSION, FORJA_PREFIX, FORJA_REPO
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --prefix)  PREFIX="$2";  shift 2 ;;
    --repo)    REPO="$2";    shift 2 ;;
    --help|-h)
      # Bake the help text in. `sed -n '2,30p' $0` would work for a
      # filesystem-resident copy but not for `curl | sh`, where $0 is
      # the shell name and there's no script file to read.
      print_help
      exit 0
      ;;
    -*) printf 'install.sh: unknown flag: %s\n' "$1" >&2; exit 2 ;;
    *)
      # Positional: treat as version (matches the curl|sh -s -- v0.1.0 form).
      VERSION="$1"; shift
      ;;
  esac
done

# Validate `--repo` shape early. Not a shell-injection vector (every
# interpolation is quoted) but a non-conforming value just produces a
# 404 deeper in the script; loud failure here is more actionable.
case "$REPO" in
  */*) ;;
  *)
    printf 'install.sh: --repo must be <owner>/<repo>, got: %s\n' "$REPO" >&2
    exit 2
    ;;
esac

# Detect tooling. We need EITHER curl or wget for HTTP, and either
# sha256sum (Linux) or shasum (macOS) for verification.
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  printf 'install.sh: need curl or wget on PATH\n' >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  hash256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  hash256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  printf 'install.sh: need sha256sum or shasum on PATH\n' >&2
  exit 1
fi

# Detect OS / arch and map to our asset naming. Match the table in
# scripts/targets.ts. Kept inline (no external lookup) because the
# install script must work without the repo cloned.
uname_s=$(uname -s)
uname_m=$(uname -m)

case "$uname_s" in
  Linux)   os="linux" ;;
  Darwin)  os="darwin" ;;
  MINGW*|MSYS*|CYGWIN*) os="windows" ;;
  *)
    printf 'install.sh: unsupported OS: %s\n' "$uname_s" >&2
    exit 1
    ;;
esac

case "$uname_m" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *)
    printf 'install.sh: unsupported arch: %s\n' "$uname_m" >&2
    exit 1
    ;;
esac

# Windows-on-arm64 isn't in the matrix. Fail loudly rather than
# downloading the wrong asset.
if [ "$os" = "windows" ] && [ "$arch" = "arm64" ]; then
  printf 'install.sh: windows-arm64 is not in the release matrix yet\n' >&2
  exit 1
fi

target_id="${os}-${arch}"
asset="agent-${target_id}"
[ "$os" = "windows" ] && asset="${asset}.exe"

# Resolve version. The latest-release endpoint follows redirects to
# the actual tag URL; we extract the tag from the Location header so
# we don't need jq for the JSON payload.
if [ -z "$VERSION" ]; then
  if command -v curl >/dev/null 2>&1; then
    redirect=$(curl -fsSI "https://github.com/${REPO}/releases/latest" \
      | awk 'tolower($1) == "location:" { print $2 }' \
      | tr -d '\r')
  else
    # wget --max-redirect=0 errors on the redirect; the URL we want
    # is in the response.
    redirect=$(wget --max-redirect=0 -qS "https://github.com/${REPO}/releases/latest" 2>&1 \
      | awk 'tolower($1) == "location:" { print $2 }' \
      | tr -d '\r')
  fi
  VERSION=$(printf '%s\n' "$redirect" | awk -F/ '{print $NF}')
  if [ -z "$VERSION" ]; then
    printf 'install.sh: could not resolve latest version (redirect: %s)\n' "$redirect" >&2
    exit 1
  fi
fi

base="https://github.com/${REPO}/releases/download/${VERSION}"
asset_url="${base}/${asset}"
sums_url="${base}/SHA256SUMS"

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t forja-install)
trap 'rm -rf "$tmp"' EXIT INT TERM

printf 'install.sh: downloading %s\n' "$asset_url" >&2
fetch "$asset_url" "$tmp/$asset"
# Some `wget` builds write a 0-byte file and exit 0 on partial
# failures; `curl -fsSL` is stricter but we belt-and-suspenders.
[ -s "$tmp/$asset" ] || { printf 'install.sh: empty download for %s\n' "$asset" >&2; exit 1; }
printf 'install.sh: downloading SHA256SUMS\n' >&2
fetch "$sums_url" "$tmp/SHA256SUMS"
[ -s "$tmp/SHA256SUMS" ] || { printf 'install.sh: empty download for SHA256SUMS\n' >&2; exit 1; }

# Pull the line matching our asset and compare hashes. Use awk to
# extract the expected hash; never feed the raw SHA256SUMS to
# sha256sum -c because GNU's -c is strict about path resolution and
# would reject our temp-dir layout.
expected=$(awk -v want="$asset" '$2 == want { print $1 }' "$tmp/SHA256SUMS")
if [ -z "$expected" ]; then
  printf 'install.sh: %s not listed in SHA256SUMS — refusing to install\n' "$asset" >&2
  exit 1
fi

actual=$(hash256 "$tmp/$asset")
if [ "$expected" != "$actual" ]; then
  printf 'install.sh: hash mismatch for %s\n  expected %s\n  got      %s\n' \
    "$asset" "$expected" "$actual" >&2
  exit 1
fi

printf 'install.sh: hash verified (%s)\n' "$actual" >&2

mkdir -p "$PREFIX"
dest="$PREFIX/agent"
[ "$os" = "windows" ] && dest="${dest}.exe"

mv "$tmp/$asset" "$dest"
chmod +x "$dest"

printf 'install.sh: installed %s %s\n' "$dest" "$VERSION" >&2

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *)
    printf 'install.sh: NOTE — %s is not on PATH. Add to your shell rc:\n  export PATH="%s:$PATH"\n' \
      "$PREFIX" "$PREFIX" >&2
    ;;
esac
