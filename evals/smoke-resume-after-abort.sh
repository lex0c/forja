#!/usr/bin/env bash
# Resume after a Ctrl+C / SIGINT mid-stream. The fix at commit
# 2e08033 (stranded-turn placeholder) handles the case where a
# session was interrupted before producing an assistant turn —
# persisted log ends with `user`, and the resumed run synthesizes
# an in-memory assistant placeholder so user→user alternation
# doesn't break.
#
# This smoke validates that fix end-to-end:
#
# 1. Start an agent with a prompt that will keep the model
#    streaming for several seconds.
# 2. SIGINT it ~1s in (mid-stream, before the assistant turn
#    finishes persisting).
# 3. Inspect the DB: the persisted log should end with the
#    user prompt and either no assistant message or a partial
#    one. Either way, the next resume must not 400.
# 4. Resume with a follow-up; verify the run completes cleanly
#    and the model produces a coherent reply.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "ANTHROPIC_API_KEY not set." >&2
  exit 1
fi

TMPDIR="$(mktemp -d -t forja-smoke-abort-XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT
export XDG_DATA_HOME="$TMPDIR/xdg"
mkdir -p "$XDG_DATA_HOME/forja"
cd "$TMPDIR"
mkdir -p workspace
cd workspace

MODEL="${SMOKE_MODEL:-anthropic/claude-haiku-4-5}"

echo "=== Run 1: start a long-ish stream and abort mid-flight ===" >&2
# Long prompt to keep the model emitting tokens for a few seconds.
bun run "$ROOT/src/cli/index.ts" \
  --model "$MODEL" \
  --json \
  "Please count from 1 to 100, one number per line, with a brief poetic comment after each. Take your time." \
  > run1.ndjson 2> run1.err &
RUN1_PID=$!

# Wait long enough for the request to start streaming, then SIGINT.
sleep 1
kill -INT "$RUN1_PID" 2>/dev/null || true
# Give the harness a moment to handle the abort cleanly. A second
# SIGINT would force-quit (exit 130) which we don't want.
wait "$RUN1_PID" || true
echo "Run 1 exit: $? (130 = interrupted, expected)" >&2

# The session id may or may not be in the NDJSON depending on
# how far the run got. Look for the most recent one.
SESSION_ID=$(jq -r 'select(.type == "session_start") | .sessionId' < run1.ndjson | tail -1)
if [[ -z "$SESSION_ID" || "$SESSION_ID" == "null" ]]; then
  echo "Could not extract sessionId from aborted run." >&2
  echo "--- run1.ndjson ---" >&2
  cat run1.ndjson >&2
  exit 1
fi
echo "Aborted session id: $SESSION_ID" >&2

# Inspect: persisted log might end with `user` (interrupted before
# assistant landed) or `assistant` (interrupted between assistant
# and tool_result, or after assistant completed but before exit).
# Either shape should be resumable.
TAIL_ROLE=$(bun run "$ROOT/src/cli/index.ts" --list-sessions --json \
            2>/dev/null | head -5 || echo "")

echo "=== Run 2: resume the aborted session ===" >&2
bun run "$ROOT/src/cli/index.ts" \
  --model "$MODEL" \
  --json \
  --resume "$SESSION_ID" \
  "Forget the counting; just say 'continuing'. Don't call any tools." \
  > run2.ndjson 2> run2.err || {
    echo "Run 2 (resume after abort) failed. stderr:" >&2
    cat run2.err >&2
    echo "--- run2.ndjson tail ---" >&2
    tail -20 run2.ndjson >&2
    exit 1
  }

# Verify the run completed (status=done) and produced text.
STATUS=$(jq -r 'select(.type == "session_finished") | .result.status' < run2.ndjson | head -1)
RESPONSE=$(jq -r 'select(.type == "provider_event") | .event | select(.kind == "text_delta") | .text' \
            < run2.ndjson | tr -d '\n')

if [[ "$STATUS" != "done" ]]; then
  echo "FAIL: resumed run finished with status='$STATUS' (expected 'done')" >&2
  exit 1
fi

if [[ -z "$RESPONSE" ]]; then
  echo "FAIL: resumed run produced no text response" >&2
  exit 1
fi

echo "PASS: resumed an aborted session cleanly. Response:" >&2
echo "  $RESPONSE" >&2
