#!/usr/bin/env bash
# Resume + tool calls smoke. The first two real-model smokes were
# text-only — they validated provider-level conversation
# continuity but not the trickier path: tool_use blocks emitted
# by run 1 must round-trip through DB persistence and replay
# back to the provider on run 2 with the original tool_use_ids
# intact. Mocks didn't catch any tool-related bugs but neither
# did they assert correctness; this smoke uses todo_create
# (category='misc', no filesystem access needed, no permission
# config required) to exercise tool_use → tool_result pairing
# across the resume boundary.
#
# Run 1 (Haiku): ask the model to use todo_create to plan tasks.
# Run 2 (Haiku, resumed): ask what was added to the todo list.
#   The reply must reference what run 1 actually planned, proving
#   the tool_use+tool_result pair survived persistence and replay
#   without orphaning either side.
#
# Cost: ~$0.005-0.010 (two short turns, one with tool call).

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

TMPDIR="$(mktemp -d -t forja-smoke-tools-XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT
export XDG_DATA_HOME="$TMPDIR/xdg"
mkdir -p "$XDG_DATA_HOME/forja"
cd "$TMPDIR"
mkdir -p workspace
cd workspace

# A specific phrase the model must include in a todo_create item;
# we'll grep run 2's response for evidence the model recalled it.
MARKER="WIDGET_$(date +%s)"
MODEL="anthropic/claude-haiku-4-5"

echo "=== Run 1: plan a task via todo_create ===" >&2
bun run "$ROOT/src/cli/index.ts" \
  --model "$MODEL" \
  --json \
  "Use the todo_create tool to add exactly one task with this exact content: 'Implement the $MARKER feature'. The status should be 'pending' and the active_form should be 'Implementing the $MARKER feature'. Reply with just 'planned'." \
  > run1.ndjson 2> run1.err || {
    echo "Run 1 failed. stderr:" >&2
    cat run1.err >&2
    exit 1
  }

# Confirm run 1 actually called todo_create (otherwise the test
# is verifying nothing).
if ! jq -r 'select(.type == "tool_invoking") | .toolName' < run1.ndjson | grep -qx 'todo_create'; then
  echo "Run 1 did NOT call todo_create — model ignored the prompt." >&2
  jq -r 'select(.type == "tool_invoking") | .toolName' < run1.ndjson >&2
  exit 1
fi

SESSION_ID=$(jq -r 'select(.type == "session_finished") | .result.sessionId' < run1.ndjson | head -1)
echo "Session id: $SESSION_ID" >&2

echo "=== Run 2: resume and recall the planned task ===" >&2
bun run "$ROOT/src/cli/index.ts" \
  --model "$MODEL" \
  --json \
  --resume "$SESSION_ID" \
  "Without using any tools, what task did you add to the todo list earlier? Reply with just the task content (the imperative form), nothing else." \
  > run2.ndjson 2> run2.err || {
    echo "Run 2 failed. stderr:" >&2
    cat run2.err >&2
    echo "--- run2.ndjson tail ---" >&2
    tail -20 run2.ndjson >&2
    exit 1
  }

RESPONSE=$(jq -r 'select(.type == "provider_event") | .event | select(.kind == "text_delta") | .text' \
            < run2.ndjson | tr -d '\n')

if [[ "$RESPONSE" == *"$MARKER"* ]]; then
  echo "PASS: model recalled '$MARKER' from a tool_use+tool_result pair across resume." >&2
  exit 0
else
  echo "FAIL: model did not recall '$MARKER'. Response:" >&2
  echo "  $RESPONSE" >&2
  exit 1
fi
