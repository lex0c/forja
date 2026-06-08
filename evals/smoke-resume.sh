#!/usr/bin/env bash
# Smoke test for --resume against a real model.
#
# Mocks lie: they don't emit usage events, don't reject malformed
# tool_use_id / tool_result pairings, don't enforce role
# alternation strictly. A real provider catches what mocks miss.
#
# This script:
#   1. Runs an initial session with a prompt that triggers a tool
#      call (so the persisted log has [user, assistant_with_tool_use,
#      user_tool_result, assistant_text]).
#   2. Captures the session id.
#   3. Resumes that session with a follow-up that references the
#      prior context — verifies the model has the conversation
#      history, not a fresh start.
#
# Cost: ~$0.001-0.005 per run on Haiku 4.5 (two short turns).
# Requires: ANTHROPIC_API_KEY in the environment.
#
# Usage: ./evals/smoke-resume.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Auto-source $ROOT/.env if present (developer convention) so
# users don't have to manually export keys before invoking.
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

# shellcheck source=evals/smoke-lib.sh
source "$ROOT/evals/smoke-lib.sh"
smoke_require_key "$(smoke_model)"
TMPDIR="$(mktemp -d -t forja-smoke-resume-XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT

# Use an isolated XDG path so this smoke doesn't pollute or read
# the developer's actual session log.
export XDG_DATA_HOME="$TMPDIR/xdg"
mkdir -p "$XDG_DATA_HOME/forja"

cd "$TMPDIR"
mkdir -p workspace
cd workspace

# Test conversation continuity at the PROVIDER level — no tools,
# no permissions, just whether the model remembers context across
# a session boundary. A token in the prompt + a recall question
# is sufficient: if resume properly threads the prior messages
# back into the new request, the model recalls; if not, it
# admits ignorance or hallucinates.
TOKEN="HARNESS_SMOKE_RESUME_$(date +%s)"
MODEL="${SMOKE_MODEL:-anthropic/claude-haiku-4-5}"

echo "=== Run 1: initial session ===" >&2
bun run "$ROOT/src/cli/index.ts" \
  --model "$MODEL" \
  --json \
  "Please remember this exact token: $TOKEN. Reply with just 'memorized'." \
  > run1.ndjson 2> run1.err || {
    echo "Run 1 failed. stderr:" >&2
    cat run1.err >&2
    exit 1
  }

# Get the session id from the session_finished event.
SESSION_ID=$(jq -r 'select(.type == "session_finished") | .result.sessionId' < run1.ndjson | head -1)
if [[ -z "$SESSION_ID" || "$SESSION_ID" == "null" ]]; then
  echo "Could not extract sessionId from run 1 output:" >&2
  cat run1.ndjson >&2
  exit 1
fi
echo "Session id: $SESSION_ID" >&2

echo "=== Run 2: resume + ask for the remembered token ===" >&2
bun run "$ROOT/src/cli/index.ts" \
  --model "$MODEL" \
  --json \
  --resume "$SESSION_ID" \
  "What was the exact token I asked you to remember? Reply with just the token, nothing else." \
  > run2.ndjson 2> run2.err || {
    echo "Run 2 failed. stderr:" >&2
    cat run2.err >&2
    exit 1
  }

# Did the model recall the token from the resumed conversation?
# Concatenate text_delta chunks (the provider streams in pieces,
# so a token can span multiple events) before searching, otherwise
# grep -q misses tokens that landed across chunk boundaries.
RESPONSE=$(jq -r 'select(.type == "provider_event") | .event | select(.kind == "text_delta") | .text' \
            < run2.ndjson | tr -d '\n')

if [[ "$RESPONSE" == *"$TOKEN"* ]]; then
  echo "PASS: model recalled '$TOKEN' from the resumed context." >&2
  exit 0
else
  echo "FAIL: model did not recall '$TOKEN'. Concatenated response:" >&2
  echo "  $RESPONSE" >&2
  exit 1
fi
