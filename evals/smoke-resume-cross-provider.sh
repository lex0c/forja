#!/usr/bin/env bash
# Cross-provider resume smoke. Tests whether a session started on
# one provider can be resumed on another — the abstract
# ProviderContentBlock format is supposed to be provider-agnostic
# (each adapter translates abstract ↔ native at generate time),
# but this hasn't been verified end-to-end. The historical
# tool_use_id formats differ between providers (Anthropic emits
# `toolu_01...`, OpenAI `call_...`); cross-provider resume puts
# original-format ids on the wire to a different provider.
#
# 1. Run 1 against Claude (Haiku 4.5): plant a token.
# 2. Run 2 RESUMING the same session against GPT (gpt-4o-mini):
#    ask it to recall the token.
#
# Pass criterion: GPT recalls the token verbatim.
# Cost: ~$0.001-0.005.
# Requires ANTHROPIC_API_KEY and OPENAI_API_KEY (auto-sourced
# from $ROOT/.env when present).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

for var in ANTHROPIC_API_KEY OPENAI_API_KEY; do
  if [[ -z "${!var:-}" ]]; then
    echo "$var not set (checked env and $ROOT/.env); cannot run cross-provider smoke." >&2
    exit 1
  fi
done

TMPDIR="$(mktemp -d -t forja-smoke-cross-XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT
export XDG_DATA_HOME="$TMPDIR/xdg"
mkdir -p "$XDG_DATA_HOME/forja"

cd "$TMPDIR"
mkdir -p workspace
cd workspace

TOKEN="HARNESS_CROSS_$(date +%s)"
CLAUDE_MODEL="anthropic/claude-haiku-4-5"
OPENAI_MODEL="openai/gpt-4o-mini"

echo "=== Run 1: initial session on $CLAUDE_MODEL ===" >&2
bun run "$ROOT/src/cli/index.ts" \
  --model "$CLAUDE_MODEL" \
  --json \
  "Please remember this exact token: $TOKEN. Reply with just 'memorized'." \
  > run1.ndjson 2> run1.err || {
    echo "Run 1 failed. stderr:" >&2
    cat run1.err >&2
    exit 1
  }

SESSION_ID=$(jq -r 'select(.type == "session_finished") | .result.sessionId' < run1.ndjson | head -1)
if [[ -z "$SESSION_ID" || "$SESSION_ID" == "null" ]]; then
  echo "Could not extract sessionId from run 1." >&2
  exit 1
fi
echo "Session id: $SESSION_ID" >&2

echo "=== Run 2: resume on $OPENAI_MODEL (cross-provider) ===" >&2
bun run "$ROOT/src/cli/index.ts" \
  --model "$OPENAI_MODEL" \
  --json \
  --resume "$SESSION_ID" \
  "What was the exact token I asked you to remember? Reply with just the token, nothing else." \
  > run2.ndjson 2> run2.err || {
    echo "Run 2 failed. stderr:" >&2
    cat run2.err >&2
    echo "--- run2.ndjson tail ---" >&2
    tail -20 run2.ndjson >&2
    exit 1
  }

RESPONSE=$(jq -r 'select(.type == "provider_event") | .event | select(.kind == "text_delta") | .text' \
            < run2.ndjson | tr -d '\n')

if [[ "$RESPONSE" == *"$TOKEN"* ]]; then
  echo "PASS: $OPENAI_MODEL recalled '$TOKEN' from a $CLAUDE_MODEL-originated session." >&2
  exit 0
else
  echo "FAIL: $OPENAI_MODEL did not recall '$TOKEN'. Concatenated response:" >&2
  echo "  $RESPONSE" >&2
  exit 1
fi
