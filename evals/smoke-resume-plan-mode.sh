#!/usr/bin/env bash
# Resume + plan-mode interaction. Two paths to verify:
#
# A. Run 1 in plan mode → run 2 RESUMING in plan mode.
#    The persisted log includes a system-prompt-aware planning
#    response. The plan-mode system prompt re-applies on resume;
#    the model should still produce a structured plan-style reply.
#
# B. Run 1 in plan mode → run 2 RESUMING WITHOUT plan mode.
#    The model can now actually act. The bug shape we're guarding
#    against: plan-mode state leaks across the resume boundary
#    somehow, or the harness gets confused by a session that
#    started in plan and continues out of it.
#
# Verification: both runs return exit 0 (plan mode + resume don't
# crash on the integration). Plan-mode correctness itself is
# covered by other evals.
#
# Cost: ~$0.001-0.005.

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

TMPDIR="$(mktemp -d -t forja-smoke-plan-XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT
export XDG_DATA_HOME="$TMPDIR/xdg"
mkdir -p "$XDG_DATA_HOME/forja"
cd "$TMPDIR"
mkdir -p workspace
cd workspace

MODEL="anthropic/claude-haiku-4-5"

echo "=== Path A: plan → resume in plan ===" >&2
bun run "$ROOT/src/cli/index.ts" \
  --model "$MODEL" \
  --json \
  --plan \
  "Outline a 2-step plan for writing a hello-world script in python. Just outline; do not execute." \
  > runA1.ndjson 2> runA1.err || {
    echo "Path A run 1 failed. stderr:" >&2
    cat runA1.err >&2
    exit 1
  }

SESSION_A=$(jq -r 'select(.type == "session_finished") | .result.sessionId' < runA1.ndjson | head -1)
echo "Session A: $SESSION_A" >&2

bun run "$ROOT/src/cli/index.ts" \
  --model "$MODEL" \
  --json \
  --plan \
  --resume "$SESSION_A" \
  "Now refine step 1: what specific filename would you use?" \
  > runA2.ndjson 2> runA2.err || {
    echo "Path A run 2 (resume in plan) failed. stderr:" >&2
    cat runA2.err >&2
    tail -10 runA2.ndjson >&2
    exit 1
  }
echo "Path A: PASS" >&2

echo "=== Path B: plan → resume out of plan ===" >&2
bun run "$ROOT/src/cli/index.ts" \
  --model "$MODEL" \
  --json \
  --plan \
  "Outline a 2-step plan for listing files. Just outline; do not execute." \
  > runB1.ndjson 2> runB1.err || {
    echo "Path B run 1 failed. stderr:" >&2
    cat runB1.err >&2
    exit 1
  }

SESSION_B=$(jq -r 'select(.type == "session_finished") | .result.sessionId' < runB1.ndjson | head -1)
echo "Session B: $SESSION_B" >&2

# Resume WITHOUT --plan: the harness should not be in plan mode
# anymore; the planMode flag is per-run, not per-session.
bun run "$ROOT/src/cli/index.ts" \
  --model "$MODEL" \
  --json \
  --resume "$SESSION_B" \
  "Just say 'continuing'. Do not call any tools." \
  > runB2.ndjson 2> runB2.err || {
    echo "Path B run 2 (resume out of plan) failed. stderr:" >&2
    cat runB2.err >&2
    tail -10 runB2.ndjson >&2
    exit 1
  }
echo "Path B: PASS" >&2

echo "PASS: resume + plan-mode integration works in both directions." >&2
