#!/usr/bin/env bash
# Smoke for the hard-interrupt wire path against a real provider.
# Operator presses Ctrl+C while a subagent is mid-run; parent's
# SIGINT handler aborts the AbortController, runSubagent's
# wait loop fires `interrupt:hard` IPC + SIGTERM at the child,
# child's signalController aborts the harness mid-stream, child
# publishes envelope with `abort_cause: 'hard'`, parent's
# subagent_finished UIEvent reflects the interrupt.
#
# Why this matters: S3 unit tests use AbortControllers + fake
# transports — they prove the routing logic. They don't prove
# AbortSignal actually propagates through Anthropic SDK's real
# `fetch` stream, or that SIGTERM lands on a real subprocess that
# has buffered SQLite writes pending. Both are silent failure
# modes if regressed.
#
# Headless `--json` mode maps SIGINT to controller.abort() (cli/
# signal.ts). That's the HARD path. Soft (single Esc, cooperative
# exit at step boundary) is REPL-only and requires TTY emulation
# — covered at unit level via tests/cli/subagent-child.test.ts
# and tests/subagents/runtime.test.ts (S3 describe block).
#
# Cost: ~$0.03 per run on Haiku 4.5.
# Requires: ANTHROPIC_API_KEY, jq, sqlite3.

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
smoke_require_key "$(smoke_model)"

TMPDIR="$(mktemp -d -t forja-smoke-interrupt-XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT

export XDG_DATA_HOME="$TMPDIR/xdg"
export XDG_CONFIG_HOME="$TMPDIR/xdg-config"
mkdir -p "$XDG_DATA_HOME/forja" "$XDG_CONFIG_HOME"

WORKSPACE="$TMPDIR/workspace"
mkdir -p "$WORKSPACE"
cd "$WORKSPACE"

# A few seed files for the explore subagent to scan. The more it
# has to read, the longer it runs, the wider our window to
# interrupt mid-run.
for n in $(seq 1 8); do
  echo "package $n" > "file_$n.txt"
done

mkdir -p .forja/playbooks
cat > .forja/playbooks/explore.md <<'MD'
---
name: explore
description: Read-only file discovery. Read every file once.
tools: [read_file, glob]
budget:
  max_steps: 20
  max_cost_usd: 0.05
---
You are an exploration subagent. Use glob to list every file in
the working tree, then read EACH one with read_file (one
read_file call per file). Report every file's contents
verbatim. Do not summarize — show full contents.
MD

cat > .forja/permissions.yaml <<'YAML'
defaults:
  mode: bypass
YAML

MODEL="${SMOKE_MODEL:-anthropic/claude-haiku-4-5}"

# Run the parent in the background. The prompt asks for an
# elaborate task so the subagent has plenty of work to interrupt.
echo "=== Spawn parent in background ===" >&2
bun run "$ROOT/src/cli/index.ts" \
  --model "$MODEL" \
  --json \
  "Use the task tool to spawn the 'explore' subagent. Pass it: 'List and read every file in the current directory.' Wait for the subagent's complete output and then echo it back verbatim." \
  > run.ndjson 2> run.err &
PARENT_PID=$!
echo "Parent PID: $PARENT_PID" >&2

# Wait for the parent to enter the subagent run. We can detect
# this by polling the SQLite DB for a child session row (the
# parent's runSubagent inserts before spawning). Cap at 20s — if
# a child row never appears in that window something is wrong
# with the parent's task() invocation, and the smoke fails noisily
# rather than hanging.
DB="$XDG_DATA_HOME/forja/sessions.db"
SUBAGENT_VISIBLE=0
for _ in $(seq 1 40); do
  if [[ -f "$DB" ]]; then
    COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM sessions WHERE parent_session_id IS NOT NULL" 2>/dev/null || echo "0")
    if [[ "$COUNT" -gt 0 ]]; then
      SUBAGENT_VISIBLE=1
      break
    fi
  fi
  sleep 0.5
done

if [[ "$SUBAGENT_VISIBLE" -eq 0 ]]; then
  echo "FAIL: parent never spawned a subagent within 20s; killing." >&2
  kill -9 "$PARENT_PID" 2>/dev/null || true
  wait "$PARENT_PID" 2>/dev/null || true
  cat run.err >&2
  exit 1
fi

# Give the subagent another second to fully settle into its run
# (let it issue at least one tool_invoking) so the interrupt
# lands MID-step rather than at the boundary right after spawn.
sleep 1

echo "=== Send SIGINT to parent ===" >&2
kill -INT "$PARENT_PID"

# Wait for parent to exit. The parent's SIGINT handler aborts
# the controller; runSubagent's waitForChild detects, sends
# interrupt:hard + SIGTERM, eventually the child publishes (or
# is SIGKILLed) and the parent's harness exits cleanly with
# reason: 'aborted'. Worst case: 5s grace + 5s cushion.
EXIT_WAIT_TIMEOUT=15
WAITED=0
while kill -0 "$PARENT_PID" 2>/dev/null; do
  sleep 0.5
  WAITED=$((WAITED + 1))
  if [[ "$WAITED" -ge $((EXIT_WAIT_TIMEOUT * 2)) ]]; then
    echo "FAIL: parent didn't exit within ${EXIT_WAIT_TIMEOUT}s after SIGINT." >&2
    kill -9 "$PARENT_PID" 2>/dev/null || true
    wait "$PARENT_PID" 2>/dev/null || true
    exit 1
  fi
done
wait "$PARENT_PID" 2>/dev/null || true

echo "Parent exited after interrupt." >&2

# Assertions on the captured NDJSON.
#
# 1. The parent's session_finished MUST carry reason: 'aborted' and
#    abortCause: 'hard' (UI surface confirmed the interrupt
#    propagated through the parent's own loop).
PARENT_SESSION_REASON=$(jq -r 'select(.type == "session_finished") | .result.reason' < run.ndjson | head -1)
PARENT_SESSION_ABORT_CAUSE=$(jq -r 'select(.type == "session_finished") | .result.abortCause' < run.ndjson | head -1)
if [[ "$PARENT_SESSION_REASON" != "aborted" ]]; then
  echo "FAIL: parent's session_finished.reason = '$PARENT_SESSION_REASON', expected 'aborted'." >&2
  exit 1
fi
if [[ "$PARENT_SESSION_ABORT_CAUSE" != "hard" ]]; then
  echo "FAIL: parent's session_finished.result.abortCause = '$PARENT_SESSION_ABORT_CAUSE', expected 'hard'." >&2
  exit 1
fi
echo "Parent's session_finished: reason=aborted, abortCause=hard ✓" >&2

# 2. The parent's subagent_finished for the in-flight child MUST
#    reflect the interrupt — status: 'interrupted' (mapped to
#    'error' in the UIEvent layer; we read the raw HarnessEvent
#    from NDJSON which carries the original).
SUBAGENT_FINISH_STATUS=$(jq -r 'select(.type == "subagent_finished") | .status' < run.ndjson | head -1)
if [[ -z "$SUBAGENT_FINISH_STATUS" ]]; then
  echo "FAIL: no subagent_finished event in parent's NDJSON." >&2
  exit 1
fi
if [[ "$SUBAGENT_FINISH_STATUS" != "interrupted" ]]; then
  echo "FAIL: subagent_finished.status = '$SUBAGENT_FINISH_STATUS', expected 'interrupted'." >&2
  exit 1
fi
echo "Subagent's lifecycle bracket reflects the interrupt: status=interrupted ✓" >&2

# 3. SQLite child session row should have status 'error' or
#    'interrupted'. The runtime's `completeSession` call after
#    waitForChild stamps the terminal status; an aborted child
#    must NOT be left as 'running'.
CHILD_DB_STATUS=$(sqlite3 "$DB" "
  SELECT status FROM sessions
  WHERE parent_session_id IS NOT NULL
  ORDER BY started_at DESC
  LIMIT 1
")
if [[ "$CHILD_DB_STATUS" == "running" ]]; then
  echo "FAIL: child session left as 'running' after interrupt — finalize gap." >&2
  exit 1
fi
echo "Child session finalized in DB (status=$CHILD_DB_STATUS) ✓" >&2

echo "PASS: hard interrupt propagated parent→IPC→child→envelope→parent UI against $MODEL." >&2
exit 0
