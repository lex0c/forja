#!/usr/bin/env bash
# MCP end-to-end smoke against the COMPILED binary (dist/forja-*).
#
# The MCP client stack is covered under `bun test` (tests/mcp/real-subprocess.test.ts
# drives the real SDK stdio adapter, incl. bwrap). What NOTHING covers is whether
# that stack — the @modelcontextprotocol/sdk pulling Node child_process/stream/zod —
# actually bundles AND RUNS inside `bun build --compile` (dist/forja). That was the
# #1 risk when MCP was scoped ("gates the whole feature"). This smoke closes it by
# pointing a project mcp.toml at the REAL fixture stdio server
# (evals/mcp/fixtures/echo-server.ts) and running the compiled binary against it.
#
# Two parts:
#   A. NO API KEY, deterministic — boot the binary far enough to init MCP (which
#      SPAWNS the fixture server to fetch its manifest), forcing an invalid model
#      key so the turn fails right after init. Assert the SDK spawned + handshook
#      the server INSIDE dist/forja (the server's `ready` line reaches its trace
#      log, and init logs no MCP warning). This is the go/no-go for the #1 risk and
#      runs anywhere (CI included).
#   B. REAL MODEL, opt-in (~$0.005) — the model calls the tool; assert it was
#      invoked and FINISHED without error, i.e. the SDK tools/call round-tripped.
#      Skipped (not failed) when the model's provider key is absent.
#
# Reuse a prebuilt binary with FORJA_BIN=/path/to/forja to skip the build.
# Model override for Part B via SMOKE_MODEL.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

# shellcheck source=evals/smoke-lib.sh
source "$ROOT/evals/smoke-lib.sh"
MODEL="$(smoke_model)"

command -v jq >/dev/null 2>&1 || { echo "jq is required for this smoke." >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { echo "bun is required (the fixture server runs via bun)." >&2; exit 1; }

# Build (or reuse) the compiled binary — the whole point is to exercise the MCP
# SDK stack inside `bun build --compile`, not `bun run src/...`.
BIN="${FORJA_BIN:-}"
if [[ -z "$BIN" ]]; then
  echo "=== building the compiled binary (bun run build) ===" >&2
  (cd "$ROOT" && bun run build) >&2
  # Newest by mtime — the build we just ran — not alphabetical, so a leftover
  # `-dev` binary from a previous build isn't picked ahead of the fresh one.
  BIN="$(ls -1t "$ROOT"/dist/forja-*-linux-x64 2>/dev/null | head -1 || true)"
fi
if [[ -z "$BIN" || ! -x "$BIN" ]]; then
  echo "compiled binary not found (looked for dist/forja-*-linux-x64); set FORJA_BIN to a prebuilt binary." >&2
  exit 1
fi
echo "binary: $BIN" >&2

TMPDIR="$(mktemp -d -t forja-smoke-mcp-XXXXXX)"
trap 'cd "$ROOT"; rm -rf "$TMPDIR"' EXIT
# Isolate the user-global sessions.db so the smoke never touches the real store.
# XDG_CONFIG_HOME is left alone on purpose — the boot needs the real model catalog.
export XDG_DATA_HOME="$TMPDIR/xdg"
mkdir -p "$XDG_DATA_HOME/forja"
mkdir -p "$TMPDIR/workspace/.forja"
cd "$TMPDIR/workspace"

MARKER="MCP_SMOKE_$(date +%s)"
TRACE="$XDG_DATA_HOME/forja/traces/mcp-fixture.log"

# A project mcp.toml pointing at the REAL fixture stdio server. Sandbox is left
# at its DEFAULT (on where bwrap/sandbox-exec exists): a sandboxed stdio server
# (`cwd-rw`, no network) is the `mcp` permission category → auto-allowed, so the
# model can call it headless. `sandbox = false` would run it unconfined (full host
# + network) → the `mcp.egress` category → confirm → denied headless (correct — an
# unsandboxed server can exfil), which is why Part B also requires a sandbox tool.
# `surface = "base"` puts the tool on the wire directly (no tool_search hop). The
# fixture must be spawned from the repo so `@modelcontextprotocol/sdk` resolves.
cat > .forja/mcp.toml <<TOML
[servers.fixture]
transport = "stdio"
command = ["bun", "$ROOT/evals/mcp/fixtures/echo-server.ts"]
cwd = "$ROOT"
surface = "base"
TOML

# ─── Part A — SDK-in-binary proof, no API key ───────────────────────────────
echo "=== Part A: MCP init inside the compiled binary (no model call) ===" >&2
# Force an INVALID key so bootstrap resolves the provider (key present) + runs MCP
# init (which spawns the fixture to fetch its manifest), then the model turn 401s.
env ANTHROPIC_API_KEY=invalid-key-part-a "$BIN" \
  --model anthropic/claude-haiku-4-5 \
  --json \
  --auto-approve-mcp fixture \
  "noop" \
  > a.ndjson 2> a.err || true   # the model turn is EXPECTED to fail; MCP init already ran

if ! grep -q 'echo-server: ready' "$TRACE" 2>/dev/null; then
  echo "FAIL: the compiled binary did not spawn the fixture MCP server (no 'ready' in its trace log)." >&2
  echo "  (If the stderr below says 'run forja init' the local model catalog is missing — an env issue, not MCP.)" >&2
  echo "--- stderr ---" >&2
  cat a.err >&2
  exit 1
fi
if grep -qiE 'mcp:.*(handshake|failed|unreadable|UNSANDBOXED will|is not set)' a.err; then
  echo "FAIL: MCP init warned in the compiled binary:" >&2
  grep -iE 'mcp:' a.err >&2
  exit 1
fi
echo "PASS (A): dist/forja spawned + handshook the SDK server, fetched the manifest, registered the tool." >&2

# ─── Part B — full tools/call round-trip via a real model (opt-in) ──────────
# Needs BOTH a provider key AND a sandbox tool: the fixture must resolve to the
# `mcp` (allow) category, which requires a working sandbox (`cwd-rw`); without one
# it degrades to `mcp.egress` (confirm → denied headless). Skipped, not failed.
HAVE_SANDBOX=0
if command -v bwrap >/dev/null 2>&1 || command -v sandbox-exec >/dev/null 2>&1; then
  HAVE_SANDBOX=1
fi
if ( smoke_require_key "$MODEL" ) 2>/dev/null && [[ "$HAVE_SANDBOX" == 1 ]]; then
  echo "=== Part B: real model calls the tool (round-trip over stdio) ===" >&2
  "$BIN" \
    --model "$MODEL" \
    --json \
    --auto-approve-mcp fixture \
    "Call the echo tool with the exact text '$MARKER'. Then reply with ONLY the tool's exact output, nothing else." \
    > b.ndjson 2> b.err || {
      echo "run failed. stderr:" >&2
      cat b.err >&2
      echo "--- ndjson tail ---" >&2
      tail -20 b.ndjson >&2
      exit 1
    }

  # 1) The MCP tool was invoked.
  if ! jq -r 'select(.type == "tool_invoking") | .toolName' < b.ndjson | grep -qx 'mcp__fixture__echo'; then
    echo "FAIL: mcp__fixture__echo was never invoked." >&2
    echo "tools invoked:" >&2
    jq -r 'select(.type == "tool_invoking") | .toolName' < b.ndjson >&2
    exit 1
  fi
  # 2) It finished WITHOUT error → the SDK tools/call round-tripped in dist/forja.
  if ! jq -r 'select(.type == "tool_finished" and .toolName == "mcp__fixture__echo" and (.failed | not)) | "ok"' \
         < b.ndjson | grep -qx 'ok'; then
    echo "FAIL: mcp__fixture__echo did not finish successfully (the SDK round-trip broke)." >&2
    jq -c 'select(.type == "tool_finished")' < b.ndjson >&2
    exit 1
  fi
  # 3) Bonus: the server prefixes 'echo:' and the model relays it (result bytes
  #    round-tripped). Non-fatal — 1+2 already prove the round-trip.
  RESPONSE="$(jq -r 'select(.type == "provider_event") | .event | select(.kind == "text_delta") | .text' \
               < b.ndjson | tr -d '\n')"
  if [[ "$RESPONSE" == *"echo:$MARKER"* ]]; then
    echo "PASS (B): the model called the tool and round-tripped echo:$MARKER through dist/forja." >&2
  else
    echo "PASS (B, round-trip proven by 1+2): the model did not relay 'echo:$MARKER' verbatim." >&2
    echo "  response: '$RESPONSE'" >&2
  fi
else
  echo "Part B skipped: needs a provider key for '$MODEL' AND a sandbox tool (bwrap/sandbox-exec)." >&2
  echo "  The SDK-in-binary proof (Part A) still ran — that is the #1-risk go/no-go." >&2
fi

echo "smoke-mcp: ok" >&2
exit 0
