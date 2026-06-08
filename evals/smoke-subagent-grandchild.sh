#!/usr/bin/env bash
# Smoke for nested-subagent IPC under a real provider. A
# coordinator subagent (whose toolset includes `task`) spawns
# a worker subagent. The smoke validates the cross-process
# invariants that aren't testable with two-level fakes:
#
#   - subagentDepth threads correctly across two Bun.spawn hops
#     (parent → coordinator at depth 1 → worker at depth 2). The
#     spawn factory's `--subagent-depth <n>` argv flag is the
#     only mechanism; a propagation bug at hop 2 would let a
#     deep chain bypass MAX_SUBAGENT_DEPTH (=4).
#   - The IPC `event` filter holds at the boundary on BOTH sides:
#     the coordinator (acting as parent to worker) sees
#     subagent_progress events, but those NEVER leak to the
#     top-level parent. Spec §3.2 says the parent renders only
#     its DIRECT children; a regression that forwards inner
#     `subagent_*` HarnessEvents up the chain would let a
#     coordinator with a chatty worker blow up the top-level
#     renderer.
#   - Each parent↔child pair has its OWN IPC channel (separate
#     Bun.spawn pipes per hop). A bug that re-uses the parent's
#     pipe for the grandchild would surface as cross-talk.
#   - `parent_session_id` linkage is correct across three
#     levels: parent has none, coordinator points at parent,
#     worker points at coordinator.
#
# Cost: ~$0.06 per run on Haiku 4.5 (3 sessions, 2 task() calls).
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

TMPDIR="$(mktemp -d -t forja-smoke-grandchild-XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT

export XDG_DATA_HOME="$TMPDIR/xdg"
export XDG_CONFIG_HOME="$TMPDIR/xdg-config"
mkdir -p "$XDG_DATA_HOME/forja" "$XDG_CONFIG_HOME"

WORKSPACE="$TMPDIR/workspace"
mkdir -p "$WORKSPACE"
cd "$WORKSPACE"

echo "alpha contents" > alpha.txt
echo "beta contents"  > beta.txt
echo "gamma contents" > gamma.txt

mkdir -p .agent/agents

# Coordinator: can spawn other subagents via task. Tools are just
# `task` — no fs tools — so its only useful action is delegation.
cat > .agent/agents/coordinator.md <<'MD'
---
name: coordinator
description: Coordinator that delegates filesystem work to worker subagents.
tools: [task]
budget:
  max_steps: 10
  max_cost_usd: 0.05
---
You are a coordinator. The user will ask you to do something
that requires reading the workspace. Use the `task` tool to
spawn a `worker` subagent and pass it the user's request
verbatim. Wait for the worker's output, then summarize it
briefly.
MD

# Worker: read-only fs tools.
cat > .agent/agents/worker.md <<'MD'
---
name: worker
description: Read-only file discovery and reading.
tools: [read_file, glob, grep]
budget:
  max_steps: 8
  max_cost_usd: 0.03
---
You are a worker subagent. Use glob/grep/read_file to answer
the user's request. Be concise; return a short answer.
MD

cat > .agent/permissions.yaml <<'YAML'
defaults:
  mode: bypass
YAML

MODEL="${SMOKE_MODEL:-anthropic/claude-haiku-4-5}"

echo "=== Run parent: spawn coordinator → spawn worker ===" >&2
bun run "$ROOT/src/cli/index.ts" \
  --model "$MODEL" \
  --json \
  "Use the task tool with subagent name 'coordinator' and prompt 'list every .txt file in the working directory and report their names'. Echo the coordinator's reply." \
  > run.ndjson 2> run.err || {
    echo "Agent run failed. stderr:" >&2
    cat run.err >&2
    exit 1
  }

PARENT_SESSION=$(jq -r 'select(.type == "session_finished") | .result.sessionId' < run.ndjson | head -1)
if [[ -z "$PARENT_SESSION" || "$PARENT_SESSION" == "null" ]]; then
  echo "FAIL: could not extract parent session id." >&2
  cat run.ndjson >&2
  exit 1
fi
echo "Parent session: $PARENT_SESSION" >&2

DB="$XDG_DATA_HOME/forja/sessions.db"

# === Three-level lineage check ===
#
# Walk parent → coordinator → worker via parent_session_id.
# Each step must yield exactly one row; deviation means the
# chain didn't form correctly (model didn't call task at one
# of the levels, or parent_session_id linkage is broken).

COORDINATOR_ID=$(sqlite3 "$DB" "
  SELECT id FROM sessions
  WHERE parent_session_id = '$PARENT_SESSION'
")
COORD_COUNT=$(echo "$COORDINATOR_ID" | grep -c . || true)
if [[ "$COORD_COUNT" -ne 1 ]]; then
  echo "FAIL: expected 1 coordinator session, got $COORD_COUNT." >&2
  echo "All sessions:" >&2
  sqlite3 "$DB" "SELECT id, parent_session_id, status FROM sessions" >&2
  exit 1
fi
echo "Coordinator session: $COORDINATOR_ID (parent=$PARENT_SESSION)" >&2

WORKER_ID=$(sqlite3 "$DB" "
  SELECT id FROM sessions
  WHERE parent_session_id = '$COORDINATOR_ID'
")
WORKER_COUNT=$(echo "$WORKER_ID" | grep -c . || true)
if [[ "$WORKER_COUNT" -ne 1 ]]; then
  echo "FAIL: expected 1 worker session under coordinator, got $WORKER_COUNT." >&2
  echo "Children of coordinator:" >&2
  sqlite3 "$DB" "SELECT id, parent_session_id, status FROM sessions WHERE parent_session_id = '$COORDINATOR_ID'" >&2
  exit 1
fi
echo "Worker session: $WORKER_ID (parent=$COORDINATOR_ID)" >&2

# Sanity: worker must NOT directly link to top-level parent.
WORKER_VS_PARENT=$(sqlite3 "$DB" "
  SELECT COUNT(*) FROM sessions
  WHERE id = '$WORKER_ID' AND parent_session_id = '$PARENT_SESSION'
")
if [[ "$WORKER_VS_PARENT" -ne 0 ]]; then
  echo "FAIL: worker's parent_session_id points at top-level parent — chain collapsed." >&2
  exit 1
fi

# === audit snapshot at every level ===
COORD_AUDIT=$(sqlite3 "$DB" "SELECT name FROM subagent_runs WHERE session_id = '$COORDINATOR_ID'")
WORKER_AUDIT=$(sqlite3 "$DB" "SELECT name FROM subagent_runs WHERE session_id = '$WORKER_ID'")
if [[ "$COORD_AUDIT" != "coordinator" ]]; then
  echo "FAIL: coordinator's subagent_runs.name = '$COORD_AUDIT', expected 'coordinator'." >&2
  exit 1
fi
if [[ "$WORKER_AUDIT" != "worker" ]]; then
  echo "FAIL: worker's subagent_runs.name = '$WORKER_AUDIT', expected 'worker'." >&2
  exit 1
fi
echo "Audit snapshots present at both subagent levels ✓" >&2

# === IPC boundary filter check ===
#
# The top-level parent's NDJSON should reflect EXACTLY ONE
# subagent_start / subagent_finished pair (the coordinator's
# bracket). The worker's bracket fires inside the coordinator's
# IPC channel — the top-level parent must NOT see it.

START_COUNT=$(jq -c 'select(.type == "subagent_start")' < run.ndjson | wc -l | tr -d ' ')
FINISH_COUNT=$(jq -c 'select(.type == "subagent_finished")' < run.ndjson | wc -l | tr -d ' ')
if [[ "$START_COUNT" -ne 1 ]]; then
  echo "FAIL: parent NDJSON has $START_COUNT subagent_start events; expected exactly 1 (coordinator only)." >&2
  echo "If >1, the worker's bracket leaked through the IPC filter." >&2
  jq -c 'select(.type | startswith("subagent_")) | {type, subagentId, name}' < run.ndjson >&2
  exit 1
fi
if [[ "$FINISH_COUNT" -ne 1 ]]; then
  echo "FAIL: parent NDJSON has $FINISH_COUNT subagent_finished events; expected exactly 1." >&2
  exit 1
fi

START_NAME=$(jq -r 'select(.type == "subagent_start") | .name' < run.ndjson | head -1)
START_ID=$(jq -r 'select(.type == "subagent_start") | .subagentId' < run.ndjson | head -1)
if [[ "$START_NAME" != "coordinator" ]]; then
  echo "FAIL: top-level subagent_start.name = '$START_NAME', expected 'coordinator'." >&2
  echo "If 'worker', the bracket leaked from the coordinator's IPC channel into the parent's." >&2
  exit 1
fi
if [[ "$START_ID" != "$COORDINATOR_ID" ]]; then
  echo "FAIL: top-level subagent_start.subagentId = '$START_ID', expected coordinator session id '$COORDINATOR_ID'." >&2
  exit 1
fi
echo "IPC boundary holds: parent sees only direct child (coordinator), worker bracket filtered ✓" >&2

# === subagent_progress filter ===
#
# Inside the parent's NDJSON, the subagent_progress events
# (which carry the coordinator's HarnessEvents over IPC) must
# NEVER carry an inner `subagent_*` variant. The coordinator
# fires subagent_start / subagent_progress / subagent_finished
# for the worker — those are valid HarnessEvents on the
# coordinator's local emitter, and a careless `onEvent` wrapper
# would forward them up the wire. The filter on BOTH sides
# (subagent-child.ts onEvent + runtime.ts onMessage handler)
# must keep them off the parent's stream.

LEAKED=$(jq -c 'select(.type == "subagent_progress" and (.lastEvent.type | startswith("subagent_")))' < run.ndjson)
if [[ -n "$LEAKED" ]]; then
  echo "FAIL: subagent_progress carrying inner subagent_* event leaked to top-level parent." >&2
  echo "$LEAKED" >&2
  exit 1
fi

# Also: subagent_progress.lastEvent.type should never be
# session_finished — that's filtered too.
SF_LEAK=$(jq -c 'select(.type == "subagent_progress" and .lastEvent.type == "session_finished")' < run.ndjson)
if [[ -n "$SF_LEAK" ]]; then
  echo "FAIL: subagent_progress carrying inner session_finished leaked." >&2
  echo "$SF_LEAK" >&2
  exit 1
fi
echo "Inner-event filter holds: no subagent_* or session_finished crossed the boundary ✓" >&2

# Variety: the coordinator's progress should at minimum show that
# it invoked task (its only tool). A single tool_invoking event
# in the parent's progress stream proves the coordinator was
# observable AND the wire delivered live events.
TASK_INVOKINGS=$(jq -r 'select(.type == "subagent_progress" and .lastEvent.type == "tool_invoking" and .lastEvent.toolName == "task") | .lastEvent.toolName' < run.ndjson | wc -l | tr -d ' ')
if [[ "$TASK_INVOKINGS" -lt 1 ]]; then
  echo "WARN: parent never observed coordinator invoke task() over IPC — coordinator may have answered without delegating." >&2
  # Not a hard fail: Haiku might decide to answer directly from
  # the prompt without delegating. The lineage check above is the
  # load-bearing assertion.
fi
echo "Coordinator's task invocation visible to parent: $TASK_INVOKINGS event(s)." >&2

echo "PASS: 3-level subagent chain + IPC boundary filter + audit lineage against $MODEL." >&2
exit 0
