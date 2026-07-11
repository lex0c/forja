#!/usr/bin/env bash
# Mesh end-to-end smoke against the COMPILED binary (dist/forja-*).
#
# The mesh manager / wire / registry are covered under `bun test` (tests/mesh,
# over real Unix sockets). What NOTHING covers is whether the CLIENT stack —
# discovery via the FS registry, the tool_search -> mesh_peers -> mesh_send path,
# and the wire framer — actually works INSIDE `bun build --compile` (dist/forja)
# against a real peer over a real socket.
#
# Unlike MCP, the mesh has no boot-time subprocess to observe, and the SERVING
# side (/relay on) needs an interactive TTY REPL a shell can't drive. So:
#   A. NO API KEY, deterministic — boot the binary far enough to init the mesh
#      subsystem and assert it did NOT disable the mesh (meshRuntimeDir +
#      createMeshManager ran clean in dist/forja). The go/no-go that the mesh
#      loads in the compiled binary; runs anywhere (CI).
#   B. REAL MODEL, opt-in (~cents) — a fixture peer (evals/mesh/fixtures/peer.ts)
#      publishes a descriptor + serves the socket; the model in dist/forja
#      discovers it (mesh_peers) and mesh_sends to it; assert the fixture RECEIVED
#      the message over the wire. Skipped (not failed) without a provider key.
#      This is the real "mesh_send delivers in dist/forja" proof.
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
command -v bun >/dev/null 2>&1 || { echo "bun is required (the fixture peer runs via bun)." >&2; exit 1; }

BIN="${FORJA_BIN:-}"
if [[ -z "$BIN" ]]; then
  echo "=== building the compiled binary (bun run build) ===" >&2
  (cd "$ROOT" && bun run build) >&2
  BIN="$(ls -1t "$ROOT"/dist/forja-*-linux-x64 2>/dev/null | head -1 || true)"
fi
if [[ -z "$BIN" || ! -x "$BIN" ]]; then
  echo "compiled binary not found (looked for dist/forja-*-linux-x64); set FORJA_BIN." >&2
  exit 1
fi
echo "binary: $BIN" >&2

WORK="$(mktemp -d -t forja-smoke-mesh-XXXXXX)"
FIXPID=""
# shellcheck disable=SC2064
trap "cd '$ROOT'; [[ -n \"\$FIXPID\" ]] && kill \"\$FIXPID\" 2>/dev/null; rm -rf '$WORK'" EXIT
# Isolate the user-global store AND the mesh registry: XDG_RUNTIME_DIR is where
# the fixture + the binary meet (meshRuntimeDir prefers it), so the smoke never
# touches the real /run/user/<uid> registry. XDG_CONFIG_HOME is left alone — the
# boot needs the real model catalog.
export XDG_DATA_HOME="$WORK/xdg"
export XDG_RUNTIME_DIR="$WORK/runtime"
mkdir -p "$XDG_DATA_HOME/forja" "$XDG_RUNTIME_DIR" "$WORK/workspace/.forja"
cd "$WORK/workspace"

MESH_DIR="$XDG_RUNTIME_DIR/forja/mesh"

# ─── Part A — mesh init inside the compiled binary, no API key ───────────────
echo "=== Part A: mesh subsystem inits inside the compiled binary (no model call) ===" >&2
# An invalid key lets bootstrap resolve the provider + build the mesh manager,
# then the model turn 401s. We only care that the mesh built clean before that.
env ANTHROPIC_API_KEY=invalid-key-part-a "$BIN" \
  --model anthropic/claude-haiku-4-5 \
  --json \
  "noop" \
  > a.ndjson 2> a.err || true

if grep -qi 'mesh disabled' a.err; then
  echo "FAIL: the compiled binary disabled the mesh at boot:" >&2
  grep -i 'mesh' a.err >&2
  exit 1
fi
if grep -qiE 'run .*forja init|no model catalog' a.err; then
  echo "SKIP (A): local model catalog missing (run 'forja init') — an env issue, not mesh." >&2
else
  echo "PASS (A): dist/forja booted the mesh subsystem clean (no 'mesh disabled')." >&2
fi

# ─── Part B — real model discovers + mesh_sends to a fixture peer (opt-in) ───
if ( smoke_require_key "$MODEL" ) 2>/dev/null; then
  echo "=== Part B: real model discovers + mesh_sends to a fixture peer ===" >&2
  TRACE="$WORK/peer.log"
  MARKER="MESH_SMOKE_$(date +%s)"
  MESH_FIXTURE_DIR="$MESH_DIR" MESH_FIXTURE_TRACE="$TRACE" MESH_FIXTURE_ALIAS=testpeer \
    bun "$ROOT/evals/mesh/fixtures/peer.ts" &
  FIXPID=$!
  # Wait for the fixture to publish its descriptor before the model discovers it.
  for _ in $(seq 1 50); do
    grep -q 'testpeer: ready' "$TRACE" 2>/dev/null && break
    sleep 0.1
  done
  if ! grep -q 'testpeer: ready' "$TRACE" 2>/dev/null; then
    echo "FAIL: the fixture peer never became ready." >&2
    exit 1
  fi

  # --autonomous so mesh_send auto-approves headlessly: the mesh is a same-user
  # local socket, not network egress, so it respects posture (§5.3) — under the
  # default supervised posture a headless run has no operator to confirm the send,
  # and the model loops on "requires user confirmation". (Analogous to the MCP
  # smoke's --auto-approve-mcp: grant the auto-approval so the tool runs headless.)
  "$BIN" \
    --model "$MODEL" \
    --json \
    --autonomous \
    "Run mesh_peers to find local peers, then use mesh_send to send the peer 'testpeer' the exact message '$MARKER'. Report what you did." \
    > b.ndjson 2> b.err || {
      echo "run failed. stderr:" >&2
      cat b.err >&2
      echo "--- ndjson tail ---" >&2
      tail -20 b.ndjson >&2
      exit 1
    }

  # 1) mesh_send was invoked AND finished without error, in dist/forja.
  if ! jq -r 'select(.type == "tool_finished" and .toolName == "mesh_send" and (.failed | not)) | "ok"' \
       < b.ndjson | grep -qx 'ok'; then
    echo "FAIL: mesh_send did not finish successfully in dist/forja." >&2
    echo "tools finished:" >&2
    jq -c 'select(.type == "tool_finished") | {toolName, failed}' < b.ndjson >&2
    exit 1
  fi
  # 2) The fixture RECEIVED the message over the wire — the delivery proof.
  sleep 0.3
  if ! grep -qF "$MARKER" "$TRACE"; then
    echo "FAIL: the fixture never received '$MARKER' (mesh_send didn't deliver over the socket)." >&2
    echo "--- peer trace ---" >&2
    cat "$TRACE" >&2
    exit 1
  fi
  echo "PASS (B): the model discovered the peer and mesh_send delivered '$MARKER' over the socket from dist/forja." >&2
else
  echo "Part B skipped: needs a provider key for '$MODEL'." >&2
  echo "  The mesh-init proof (Part A) still ran — that is the CI go/no-go." >&2
fi

echo "smoke-mesh: ok" >&2
exit 0
