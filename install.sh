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
#   FORJA_NO_PROGRESS=1  — force plain, append-only output (also honors
#                          NO_COLOR and TERM=dumb)
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
# explicit checks. The progress UI (step list + download bar) renders
# only on an interactive TTY and degrades to plain lines otherwise, so
# `curl | sh > log 2>&1` and CI stay clean.

set -eu

REPO="${FORJA_REPO:-lex0c/forja}"
VERSION="${FORJA_VERSION:-}"
PREFIX="${FORJA_PREFIX:-$HOME/.local/bin}"

# Network timeouts: fail a stalled connect (30s) or a stalled transfer
# (< 1 KiB/s for 30s) instead of hanging forever. Deliberately NO overall cap
# on body downloads — a large asset over a slow-but-progressing link must not
# be killed mid-transfer. Word-split intentionally at each use site (the flags
# expand to multiple argv entries), so leave $NET_* unquoted there.
NET_CURL='--connect-timeout 30 --speed-limit 1024 --speed-time 30'
NET_WGET='--timeout=30'

# Populated once the temp dir exists; the trap references it, so keep it
# defined (empty) up front for `set -u` safety on an early interrupt.
tmp=''

# ---------------------------------------------------------------------------
# UI layer
#
# "Rich" mode (colors, in-place download bar, step markers, hidden cursor)
# engages only when stderr is an interactive terminal and the user hasn't
# opted out. Everything else — pipes, files, CI, dumb/non-UTF-8 terminals —
# gets plain append-only lines with no control characters.
#
# All progress goes to stderr: stdout carries no installer data, and this
# keeps `curl | sh` pipelines uncluttered.
# ---------------------------------------------------------------------------

UI_TTY=0
if [ -t 2 ] && [ "${FORJA_NO_PROGRESS:-}" = "" ] && [ "${NO_COLOR:-}" = "" ] \
   && [ "${TERM:-}" != "dumb" ]; then
  UI_TTY=1
fi

if [ "$UI_TTY" -eq 1 ]; then
  C_RESET=$(printf '\033[0m')
  C_DIM=$(printf '\033[2m')
  C_BOLD=$(printf '\033[1m')
  C_RED=$(printf '\033[31m')
  C_GREEN=$(printf '\033[32m')
  C_CYAN=$(printf '\033[36m')
else
  C_RESET=''; C_DIM=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_CYAN=''
fi

# Prefer Unicode glyphs, but only when the locale advertises UTF-8 — an
# xterm on a C/POSIX locale would render mojibake otherwise.
is_utf8() {
  case "${LC_ALL:-}${LC_CTYPE:-}${LANG:-}" in
    *[Uu][Tt][Ff]*) return 0 ;;
    *) return 1 ;;
  esac
}
if [ "$UI_TTY" -eq 1 ] && is_utf8; then
  SYM_OK='✓'; SYM_FAIL='✗'; SYM_ACTIVE='▸'; SYM_ELLIPSIS='…'; SYM_SEP='·'
  BAR_FILL='█'; BAR_EMPTY='░'
  SPIN='⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏'
else
  SYM_OK='v'; SYM_FAIL='x'; SYM_ACTIVE='>'; SYM_ELLIPSIS='...'; SYM_SEP='/'
  BAR_FILL='#'; BAR_EMPTY='-'
  SPIN='| / - .'
fi

# Fractional sleep isn't in POSIX; every real sleep (GNU, BSD, busybox)
# supports it, but probe once and fall back to whole seconds if not, so a
# strict sleep can't kill the draw loop under `set -e`.
SLEEP_FRAC='0.1'
if [ "$UI_TTY" -eq 1 ]; then
  if (sleep 0.1) >/dev/null 2>&1; then SLEEP_FRAC='0.1'; else SLEEP_FRAC='1'; fi
fi

SPIN_I=0
STEP_TOTAL=6
STEP_N=0
STEP_TAG=''
STEP_LABEL=''

ui_cursor_hide() { [ "$UI_TTY" -eq 1 ] && printf '\033[?25l' >&2 || true; }
ui_cursor_show() { [ "$UI_TTY" -eq 1 ] && printf '\033[?25h' >&2 || true; }

# Replace $HOME with ~ for friendlier paths in messages.
tilde() {
  case "$1" in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Bytes -> human units. awk is already a hard dependency of this script.
human_bytes() {
  awk -v b="${1:-0}" 'BEGIN{
    if (b < 1024)            printf "%d B",   b;
    else if (b < 1048576)    printf "%.0f KB", b/1024;
    else if (b < 1073741824) printf "%.1f MB", b/1048576;
    else                     printf "%.2f GB", b/1073741824;
  }'
}

# One spinner frame by index (frames are space-separated words). Capture the
# index BEFORE `set --` clobbers the positional parameters with the frames.
spin_char() {
  frame_idx=$(( $1 ))
  # shellcheck disable=SC2086 # deliberate word-split into frames
  set -- $SPIN
  frame_idx=$(( frame_idx % $# ))
  shift "$frame_idx"
  printf '%s' "$1"
}

ui_banner() {
  if [ "$UI_TTY" -eq 1 ]; then
    printf '\n  %sForja%s %sinstaller%s\n\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$C_RESET" >&2
  else
    printf 'Forja installer\n' >&2
  fi
}

# Draw the current step's line in its "in progress" state (no newline, so a
# later ok/fail/bar overwrites it in place). No-op off-TTY.
step_active() {
  [ "$UI_TTY" -eq 1 ] || return 0
  printf '\r  %s%s%s %s%s%s %s\033[K' \
    "$C_CYAN" "$STEP_TAG" "$C_RESET" \
    "$C_DIM" "$SYM_ACTIVE" "$C_RESET" \
    "$STEP_LABEL" >&2
}

step_start() {
  STEP_N=$(( STEP_N + 1 ))
  STEP_TAG="[$STEP_N/$STEP_TOTAL]"
  STEP_LABEL="$1"
  step_active
}

# Off-TTY breadcrumb for long network operations, so a piped log shows the
# work is progressing (on-TTY the bar/marker already conveys that).
step_note() {
  [ "$UI_TTY" -eq 1 ] || printf '  %s %s...\n' "$STEP_TAG" "$1" >&2
}

step_ok() {
  detail="${1:-}"
  if [ "$UI_TTY" -eq 1 ]; then
    printf '\r  %s%s%s %s%s%s %-20s %s%s%s\033[K\n' \
      "$C_CYAN" "$STEP_TAG" "$C_RESET" \
      "$C_GREEN" "$SYM_OK" "$C_RESET" \
      "$STEP_LABEL" \
      "$C_DIM" "$detail" "$C_RESET" >&2
  elif [ -n "$detail" ]; then
    printf '  %s %s %s (%s)\n' "$STEP_TAG" "$SYM_OK" "$STEP_LABEL" "$detail" >&2
  else
    printf '  %s %s %s\n' "$STEP_TAG" "$SYM_OK" "$STEP_LABEL" >&2
  fi
}

step_fail() {
  if [ "$UI_TTY" -eq 1 ]; then
    printf '\r  %s%s%s %s%s%s %-20s\033[K\n' \
      "$C_CYAN" "$STEP_TAG" "$C_RESET" \
      "$C_RED" "$SYM_FAIL" "$C_RESET" \
      "$STEP_LABEL" >&2
  else
    printf '  %s %s %s ... failed\n' "$STEP_TAG" "$SYM_FAIL" "$STEP_LABEL" >&2
  fi
}

# code, message... -> print styled error and exit. Leading newline closes any
# half-drawn bar line above it.
die() {
  code="$1"; shift
  printf '\n  %s%serror%s %s\n' "$C_RED" "$C_BOLD" "$C_RESET" "$*" >&2
  exit "$code"
}

# Redraw the download line: proportional bar when total is known, otherwise a
# spinner + byte counter. In place, no newline. All locals are `rd_`-prefixed:
# `sh` has no `local`, and plain names like `total`/`have` would clobber the
# caller's loop state (that bug froze the bar at 0 whenever headers arrived
# after the first frame).
render_dl() {
  rd_have=$(( ${1:-0} + 0 ))
  rd_total="${2:-0}"
  case "$rd_total" in ''|*[!0-9]*) rd_total=0 ;; esac
  rd_w=22
  rd_bar=''
  if [ "$rd_total" -gt 0 ]; then
    rd_pct=$(( rd_have * 100 / rd_total ))
    [ "$rd_pct" -gt 100 ] && rd_pct=100
    rd_fill=$(( rd_pct * rd_w / 100 ))
    rd_i=0
    while [ "$rd_i" -lt "$rd_w" ]; do
      if [ "$rd_i" -lt "$rd_fill" ]; then rd_bar="$rd_bar$BAR_FILL"; else rd_bar="$rd_bar$BAR_EMPTY"; fi
      rd_i=$(( rd_i + 1 ))
    done
    rd_meta=$(printf '%3d%%  %s / %s' "$rd_pct" "$(human_bytes "$rd_have")" "$(human_bytes "$rd_total")")
  else
    SPIN_I=$(( SPIN_I + 1 ))
    rd_bar=$(spin_char "$SPIN_I")
    rd_meta="downloading  $(human_bytes "$rd_have")"
  fi
  printf '\r  %s%s%s %-20s %s%s%s %s%s%s\033[K' \
    "$C_CYAN" "$STEP_TAG" "$C_RESET" \
    "$STEP_LABEL" \
    "$C_GREEN" "$rd_bar" "$C_RESET" \
    "$C_DIM" "$rd_meta" "$C_RESET" >&2
}

# Content-Length of the FINAL 2xx response from a curl `-D` header dump. Empty
# until the post-redirect headers land, and — crucially — never returns the
# body length of an error response: `curl -fSLI`/`-D` still prints a 404's
# `content-length: 9` header, so we gate on the last status line being 2xx.
clen_from_headers() {
  awk '
    toupper($1) ~ /^HTTP\// { st = $2 + 0; v = "" }
    tolower($1) == "content-length:" { v = $2 }
    END { gsub(/\r/, "", v); if (st >= 200 && st < 300) print v }
  ' "$1" 2>/dev/null
}

# Download with a live bar (TTY) or a single silent fetch (off-TTY). Returns
# the fetch exit status so the caller can fail the step. The total for the
# proportional bar comes from the SAME GET that downloads the body (curl `-D`
# header dump) — no extra HEAD round-trip, and the size can never disagree
# with the bytes actually arriving. On the wget path (no clean header dump)
# the bar runs indeterminate (spinner + byte counter).
download_binary() {
  url="$1"; out="$2"

  if [ "$UI_TTY" -ne 1 ]; then
    fetch "$url" "$out"
    return $?
  fi

  hdr="${out}.hdr"
  : > "$hdr"
  ui_cursor_hide
  if [ "$HAVE_CURL" -eq 1 ]; then
    curl -fsSL $NET_CURL -D "$hdr" "$url" -o "$out" &
  else
    wget $NET_WGET -qO "$out" "$url" &
  fi
  dl_pid=$!
  total=''
  while kill -0 "$dl_pid" 2>/dev/null; do
    # Parse the size once, as soon as the final response headers arrive; the
    # bar shows a spinner until then (during connect/redirect).
    [ -n "$total" ] || total=$(clen_from_headers "$hdr")
    have=$(wc -c 2>/dev/null < "$out" || echo 0)
    render_dl "$have" "$total"
    sleep "$SLEEP_FRAC"
  done
  dl_rc=0
  wait "$dl_pid" || dl_rc=$?
  ui_cursor_show
  rm -f "$hdr" 2>/dev/null
  [ "$dl_rc" -eq 0 ] || return "$dl_rc"

  # Snap to a final 100% frame; the step_ok that follows overwrites it.
  have=$(wc -c 2>/dev/null < "$out" || echo 0)
  [ -n "$total" ] || total="$have"
  render_dl "$have" "$total"
  return 0
}

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
  FORJA_VERSION, FORJA_PREFIX, FORJA_REPO, FORJA_NO_PROGRESS
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

ui_banner

# --- Step 1: environment ----------------------------------------------------
# Tooling + OS/arch detection. We need EITHER curl or wget for HTTP, and
# either sha256sum (Linux) or shasum (macOS) for verification.
step_start "Detect environment"

if command -v curl >/dev/null 2>&1; then
  HAVE_CURL=1; TOOL_HTTP='curl'
  fetch() { curl -fsSL $NET_CURL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  HAVE_CURL=0; TOOL_HTTP='wget'
  fetch() { wget $NET_WGET -qO "$2" "$1"; }
else
  step_fail; die 1 "need curl or wget on PATH"
fi

if command -v sha256sum >/dev/null 2>&1; then
  TOOL_HASH='sha256sum'
  hash256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  TOOL_HASH='shasum'
  hash256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  step_fail; die 1 "need sha256sum or shasum on PATH"
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
  *) step_fail; die 1 "unsupported OS: $uname_s" ;;
esac

case "$uname_m" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) step_fail; die 1 "unsupported arch: $uname_m" ;;
esac

# Windows-on-arm64 isn't in the matrix. Fail loudly rather than
# downloading the wrong asset.
if [ "$os" = "windows" ] && [ "$arch" = "arm64" ]; then
  step_fail; die 1 "windows-arm64 is not in the release matrix yet"
fi

target_id="${os}-${arch}"
# Release assets are named `forja-<version>-<target_id>[.exe]`
# (scripts/targets.ts `assetName`). We do NOT reconstruct the `<version>`
# segment here: it comes from the build's version.ts, which is not guaranteed
# to equal the git tag. Instead we read the exact filename from the published
# SHA256SUMS (below), matching this host's target by suffix — so the installer
# can never drift from the naming scheme the release actually shipped.
asset_suffix="-${target_id}"
[ "$os" = "windows" ] && asset_suffix="${asset_suffix}.exe"

step_ok "$target_id $SYM_SEP $TOOL_HTTP $SYM_SEP $TOOL_HASH"

# --- Step 2: resolve version ------------------------------------------------
# The latest-release endpoint follows redirects to the actual tag URL; we
# extract the tag from the Location header so we don't need jq for the JSON.
step_start "Resolve version"
if [ -n "$VERSION" ]; then
  step_ok "$VERSION  (pinned)"
else
  step_note "querying $REPO latest release"
  if [ "$HAVE_CURL" -eq 1 ]; then
    redirect=$(curl -fsSI $NET_CURL "https://github.com/${REPO}/releases/latest" \
      | awk 'tolower($1) == "location:" { print $2 }' \
      | tr -d '\r')
  else
    # wget --max-redirect=0 errors on the redirect; the URL we want
    # is in the response.
    redirect=$(wget $NET_WGET --max-redirect=0 -qS "https://github.com/${REPO}/releases/latest" 2>&1 \
      | awk 'tolower($1) == "location:" { print $2 }' \
      | tr -d '\r')
  fi
  VERSION=$(printf '%s\n' "$redirect" | awk -F/ '{print $NF}')
  [ -n "$VERSION" ] || { step_fail; die 1 "could not resolve latest version (redirect: $redirect)"; }
  step_ok "$VERSION"
fi

base="https://github.com/${REPO}/releases/download/${VERSION}"
sums_url="${base}/SHA256SUMS"

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t forja-install)
cleanup() { [ -n "${tmp:-}" ] && rm -rf "$tmp" 2>/dev/null; ui_cursor_show; }
trap 'cleanup' EXIT
trap 'cleanup; printf "\n" >&2; exit 130' INT
trap 'cleanup; printf "\n" >&2; exit 143' TERM

# --- Step 3: checksums + asset derivation -----------------------------------
# Fetch SHA256SUMS first — it's the source of truth for the asset filename.
step_start "Download checksums"
step_note "downloading SHA256SUMS"
fetch "$sums_url" "$tmp/SHA256SUMS" || { step_fail; die 1 "download failed: $sums_url"; }
[ -s "$tmp/SHA256SUMS" ] || { step_fail; die 1 "empty download for SHA256SUMS"; }

# Derive this host's asset filename from SHA256SUMS: the `forja-…` entry whose
# name ends with our target suffix (`-<os>-<arch>[.exe]`). Literal suffix match
# (no regex — `.exe` would otherwise read as "any char + exe"), so the version
# segment stays opaque to the installer.
asset=$(awk -v suf="$asset_suffix" '
  { fn = $2; n = length(fn); s = length(suf)
    if (n >= s && substr(fn, n - s + 1) == suf && substr(fn, 1, 6) == "forja-") {
      print fn; exit
    } }
' "$tmp/SHA256SUMS")
[ -n "$asset" ] || { step_fail; die 1 "no asset for target $target_id found in SHA256SUMS — refusing to install"; }
step_ok "$asset"

# --- Step 4: download binary ------------------------------------------------
asset_url="${base}/${asset}"
step_start "Download binary"
step_note "downloading $asset"
download_binary "$asset_url" "$tmp/$asset" || { step_fail; die 1 "download failed: $asset_url"; }
# Some `wget` builds write a 0-byte file and exit 0 on partial
# failures; `curl -fsSL` is stricter but we belt-and-suspenders.
[ -s "$tmp/$asset" ] || { step_fail; die 1 "empty download for $asset"; }
dl_size=$(wc -c 2>/dev/null < "$tmp/$asset" || echo 0)
step_ok "$(human_bytes "$dl_size")"

# --- Step 5: verify integrity -----------------------------------------------
# Pull the line matching our asset and compare hashes. Use awk to extract the
# expected hash; never feed the raw SHA256SUMS to `sha256sum -c` because GNU's
# -c is strict about path resolution and would reject our temp-dir layout.
step_start "Verify integrity"
expected=$(awk -v want="$asset" '$2 == want { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || { step_fail; die 1 "$asset not listed in SHA256SUMS — refusing to install"; }

actual=$(hash256 "$tmp/$asset")
if [ "$expected" != "$actual" ]; then
  step_fail
  die 1 "hash mismatch for $asset
    expected $expected
    got      $actual"
fi
# TTY: truncated digest keeps the step line tidy. Plain/CI: log the FULL
# verified hash so an install log stays auditable after the fact.
if [ "$UI_TTY" -eq 1 ]; then
  step_ok "sha256 $(printf '%.12s' "$actual")$SYM_ELLIPSIS"
else
  step_ok "sha256 $actual"
fi

# --- Step 6: install --------------------------------------------------------
step_start "Install"
mkdir -p "$PREFIX" || { step_fail; die 1 "cannot create $PREFIX"; }
dest="$PREFIX/forja"
[ "$os" = "windows" ] && dest="${dest}.exe"

mv "$tmp/$asset" "$dest" || { step_fail; die 1 "cannot install to $dest"; }
chmod +x "$dest" || { step_fail; die 1 "cannot make $dest executable"; }
step_ok "$(tilde "$dest")"

# --- Done -------------------------------------------------------------------
if [ "$UI_TTY" -eq 1 ]; then
  printf '\n  %s%s%s  forja %s%s%s installed to %s%s%s\n' \
    "$C_GREEN" "$SYM_OK" "$C_RESET" \
    "$C_BOLD" "$VERSION" "$C_RESET" \
    "$C_BOLD" "$(tilde "$dest")" "$C_RESET" >&2
else
  printf 'installed %s %s\n' "$dest" "$VERSION" >&2
fi

case ":$PATH:" in
  *":$PREFIX:"*)
    [ "$UI_TTY" -eq 1 ] && printf '\n' >&2
    ;;
  *)
    if [ "$UI_TTY" -eq 1 ]; then
      printf '\n  %snote%s %s is not on your PATH. Add to your shell rc:\n      %sexport PATH="%s:$PATH"%s\n\n' \
        "$C_CYAN" "$C_RESET" "$(tilde "$PREFIX")" "$C_BOLD" "$PREFIX" "$C_RESET" >&2
    else
      printf 'NOTE: %s is not on PATH. Add to your shell rc:\n  export PATH="%s:$PATH"\n' \
        "$PREFIX" "$PREFIX" >&2
    fi
    ;;
esac
