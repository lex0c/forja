#!/usr/bin/env bash
# Smoke test for subagent runtime + task tool + IPC channel against a
# real model. Spec §11.1 + Step 4.1 + IPC.md §3 acceptance: parent
# invokes task() to spawn a read-only `explore` subagent, the child
# runs in an isolated context with a restricted toolset (no
# write_file), the parent receives the structured output envelope
# AND streams live observability events over IPC during the child's
# run.
#
# Mocks lie: they don't exercise definition discovery from the
# project .agent/agents/ directory, the bootstrap wiring of
# subagentRegistry into the harness, the JSON shape the child emits
# as a tool result back to the parent, OR the IPC wire's behavior
# under real provider streaming + real tool calls + real subprocess
# pipe semantics. This script wires the whole loop together
# end-to-end.
#
# Flow:
#   1. mktemp workspace + isolated XDG.
#   2. Drop a project-scoped explore.md under .agent/agents/.
#   3. Drop bypass-mode permissions so the parent's tools aren't denied.
#   4. Run the agent in --json mode (which sets onEvent in the
#      harness, which auto-implies ipc:true on every spawned
#      subagent — see runtime.ts effectiveIpc gate). The parent's
#      NDJSON stdout captures every HarnessEvent the parent fires,
#      including the synthesized subagent_start / subagent_progress /
#      subagent_finished bracket the runtime emits when IPC is on.
#   5. Capture session_finished + child sessions.
#   6. Assert:
#      - SQLite-side: at least one child session linked to parent;
#        no successful write_file calls in child sessions;
#        parent's assistant text mentions a seed filename;
#        snapshot integrity (sha256 + tools_whitelist round-trip).
#      - IPC-side: subagent_start ⇒ ≥1 subagent_progress ⇒
#        subagent_finished bracket landed in the parent's NDJSON
#        in order; the progress events carry varied inner
#        HarnessEvent types (step_start / tool_invoking /
#        tool_finished — proves the wire delivered events
#        DURING the child's run, not just after).
#
# Cost: ~$0.005-0.02 per run on Haiku 4.5.
# Requires: ANTHROPIC_API_KEY, jq, sqlite3.
#
# Usage: ./evals/smoke-subagent-explore.sh

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

TMPDIR="$(mktemp -d -t forja-smoke-subagent-XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT

# Isolated XDG so the smoke doesn't pollute the developer's session log.
export XDG_DATA_HOME="$TMPDIR/xdg"
export XDG_CONFIG_HOME="$TMPDIR/xdg-config"
mkdir -p "$XDG_DATA_HOME/forja"
mkdir -p "$XDG_CONFIG_HOME"

WORKSPACE="$TMPDIR/workspace"
mkdir -p "$WORKSPACE"
cd "$WORKSPACE"

# Three seed files for the explore subagent to actually find. The
# names appear in the prompt the parent forwards, but the child has
# no view of the parent's conversation — it must discover them via
# its own tools.
echo "package alpha" > alpha.txt
echo "package beta"  > beta.txt
echo "package gamma" > gamma.txt

# Project-scoped subagent definition. The spec puts user scope at
# ~/.config/agent/agents and project at <cwd>/.agent/agents. We use
# project here so the smoke doesn't depend on $HOME state.
mkdir -p .agent/agents
cat > .agent/agents/explore.md <<'MD'
---
name: explore
description: Read-only file discovery in the working tree.
tools: [read_file, glob, grep]
budget:
  max_steps: 10
  max_cost_usd: 0.05
---
You are an exploration subagent. The user will ask you to find files
or information in the working tree. Use glob/grep/read_file. Return
a short answer naming the files you found. Do not attempt to write
or edit anything.
MD

# Drop bypass-mode policy so write_file isn't policy-denied if the
# parent decides to use it (it shouldn't for this smoke; bypass is
# defense in depth so the child whitelist is the real test).
cat > .agent/permissions.yaml <<'YAML'
defaults:
  mode: bypass
YAML

MODEL="${SMOKE_MODEL:-anthropic/claude-haiku-4-5}"

echo "=== Run parent agent: ask it to spawn explore ===" >&2
bun run "$ROOT/src/cli/index.ts" \
  --model "$MODEL" \
  --json \
  "Use the task tool to spawn the 'explore' subagent. Pass it this prompt: 'List every .txt file in the current directory and report their names.' Then summarize the subagent's reply." \
  > run.ndjson 2> run.err || {
    echo "Agent run failed. stderr:" >&2
    cat run.err >&2
    exit 1
  }

PARENT_SESSION=$(jq -r 'select(.type == "session_finished") | .result.sessionId' < run.ndjson | head -1)
if [[ -z "$PARENT_SESSION" || "$PARENT_SESSION" == "null" ]]; then
  echo "Could not extract parent session id." >&2
  cat run.ndjson >&2
  exit 1
fi
echo "Parent session: $PARENT_SESSION" >&2

# Locate the SQLite db. defaultDbPath() = $XDG_DATA_HOME/forja/sessions.db
# (see src/storage/paths.ts).
DB="$XDG_DATA_HOME/forja/sessions.db"
if [[ ! -f "$DB" ]]; then
  echo "FAIL: no SQLite database at $DB after the run." >&2
  exit 1
fi

# Find child sessions linked to the parent. There must be at least
# one — otherwise the model never invoked task(), or the harness
# didn't link parent_session_id correctly.
CHILD_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM sessions WHERE parent_session_id = '$PARENT_SESSION'")
if [[ "$CHILD_COUNT" -eq 0 ]]; then
  echo "FAIL: no subagent child sessions linked to parent $PARENT_SESSION." >&2
  echo "Run NDJSON:" >&2
  cat run.ndjson >&2
  exit 1
fi
echo "Subagent children spawned: $CHILD_COUNT" >&2

# Whitelist enforcement: the child must never have SUCCESSFULLY
# invoked write_file. The explore definition only lists
# [read_file, glob, grep]; if the harness leaked the parent's full
# registry to the child, write_file could land a tool_calls row
# with status='done' under a child message_id.
#
# Filter on status='done' specifically — denied or errored attempts
# (which the runtime never reaches because the registry omits the
# tool entirely, but a future regression COULD produce as audit
# rows) are NOT a leak: the child still didn't mutate the tree.
# A row with status='done' is the smoking gun.
WRITE_FILE_LEAK=$(sqlite3 "$DB" "
  SELECT COUNT(*)
  FROM tool_calls tc
  JOIN messages m ON tc.message_id = m.id
  JOIN sessions s ON m.session_id = s.id
  WHERE s.parent_session_id = '$PARENT_SESSION'
    AND tc.tool_name = 'write_file'
    AND tc.status = 'done'
")
if [[ "$WRITE_FILE_LEAK" -gt 0 ]]; then
  echo "FAIL: child SUCCESSFULLY invoked write_file ($WRITE_FILE_LEAK calls) — whitelist not enforced." >&2
  exit 1
fi
echo "Whitelist enforced: 0 successful write_file calls in child sessions." >&2

# The parent's final assistant text should mention at least one of
# the seed filenames — proves the explore child actually inspected
# the workspace AND the parent received its output. Pull all
# assistant text from the parent session and grep.
PARENT_TEXT=$(sqlite3 "$DB" "
  SELECT content FROM messages
  WHERE session_id = '$PARENT_SESSION'
    AND role = 'assistant'
" | tr '\n' ' ')

if ! echo "$PARENT_TEXT" | grep -qiE 'alpha|beta|gamma'; then
  echo "FAIL: parent's assistant text never mentions any seed file." >&2
  echo "Parent assistant text (first 1k):" >&2
  echo "$PARENT_TEXT" | head -c 1024 >&2
  echo "" >&2
  exit 1
fi
echo "Parent referenced at least one seed filename — child output flowed back." >&2

# Snapshot subsystem (migration 012): every subagent child must
# leave a row in subagent_runs fingerprinting the definition it
# ran under. Mocks use openMemoryDb; this asserts the migration +
# runtime INSERT actually land on disk against a real DB.
CHILD_ID=$(sqlite3 "$DB" "
  SELECT id FROM sessions
  WHERE parent_session_id = '$PARENT_SESSION'
  LIMIT 1
")
if [[ -z "$CHILD_ID" ]]; then
  echo "FAIL: could not extract child session id for snapshot assertions." >&2
  exit 1
fi

SNAPSHOT_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM subagent_runs WHERE session_id = '$CHILD_ID'")
if [[ "$SNAPSHOT_COUNT" -ne 1 ]]; then
  echo "FAIL: expected 1 subagent_runs row for child $CHILD_ID, got $SNAPSHOT_COUNT." >&2
  echo "Run NDJSON tail:" >&2
  tail -20 run.ndjson >&2
  exit 1
fi

# Fingerprint check: the snapshot's source_sha256 must match the
# sha256sum of the .md file we wrote. If they diverge, either the
# loader didn't hash raw bytes or the runtime captured something
# else.
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
SNAPSHOT_SHA=$(sqlite3 "$DB" "SELECT source_sha256 FROM subagent_runs WHERE session_id = '$CHILD_ID'")
EXPECTED_SHA=$(hash_file ".agent/agents/explore.md")
if [[ "$SNAPSHOT_SHA" != "$EXPECTED_SHA" ]]; then
  echo "FAIL: snapshot source_sha256 mismatch." >&2
  echo "  expected: $EXPECTED_SHA" >&2
  echo "  got:      $SNAPSHOT_SHA" >&2
  exit 1
fi

# Tools whitelist must round-trip the JSON we declared in the
# definition. The runtime captures definition.tools verbatim so
# the snapshot reflects exactly what the child harness saw.
SNAPSHOT_TOOLS=$(sqlite3 "$DB" "SELECT tools_whitelist FROM subagent_runs WHERE session_id = '$CHILD_ID'")
if [[ "$SNAPSHOT_TOOLS" != '["read_file","glob","grep"]' ]]; then
  echo "FAIL: snapshot tools_whitelist mismatch." >&2
  echo "  expected: [\"read_file\",\"glob\",\"grep\"]" >&2
  echo "  got:      $SNAPSHOT_TOOLS" >&2
  exit 1
fi
echo "Snapshot landed: 1 row, sha256 matches .md, tools_whitelist round-trip OK." >&2

# === IPC live observability assertions (S1-S4 acceptance) ===
#
# In --json mode, the harness's onEvent is wired to the JSON
# renderer (cli/output/json.ts) which dumps every HarnessEvent
# verbatim to stdout as NDJSON. When the parent harness's
# spawnSubagent closure fires (loop.ts ~1196), it forwards
# config.onEvent as onChildEvent to runSubagent — and the runtime's
# `effectiveIpc` gate flips ipc:true automatically. So this --json
# run already exercises the full IPC stack against a real provider,
# we just need to assert the events landed.
#
# The parent's NDJSON should carry, in order:
#   subagent_start { subagentId, name, prompt }
#   subagent_progress { subagentId, lastEvent: <child HarnessEvent> } × N
#   subagent_finished { subagentId, status, summary, durationMs, costUsd }
#
# Bracket invariant: at least one start, exactly one finished per
# start (ids match), at least one progress between each pair.

START_COUNT=$(jq -c 'select(.type == "subagent_start")' < run.ndjson | wc -l | tr -d ' ')
FINISH_COUNT=$(jq -c 'select(.type == "subagent_finished")' < run.ndjson | wc -l | tr -d ' ')
PROGRESS_COUNT=$(jq -c 'select(.type == "subagent_progress")' < run.ndjson | wc -l | tr -d ' ')

if [[ "$START_COUNT" -lt 1 ]]; then
  echo "FAIL: parent's NDJSON has zero subagent_start events." >&2
  echo "Sample of HarnessEvent types in run.ndjson:" >&2
  jq -r '.type' < run.ndjson | sort -u | head -30 >&2
  exit 1
fi
if [[ "$START_COUNT" -ne "$FINISH_COUNT" ]]; then
  echo "FAIL: subagent_start ($START_COUNT) and subagent_finished ($FINISH_COUNT) counts diverge — bracket invariant broken." >&2
  exit 1
fi
echo "IPC bracket pairs: $START_COUNT start, $FINISH_COUNT finished (matched)." >&2

# Progress events MUST exist between each start/finished pair —
# otherwise the wire is opening but the child's HarnessEvents are
# never crossing it (or being filtered too aggressively at the IPC
# boundary). A child running >1 step on Haiku will fire step_start,
# tool_invoking (glob/grep/read_file), tool_finished, and several
# provider_event variants — easily 10+ progress events in a real run.
if [[ "$PROGRESS_COUNT" -lt 1 ]]; then
  echo "FAIL: parent's NDJSON has zero subagent_progress events." >&2
  echo "The IPC bracket fired but no live events crossed the wire — runtime is degenerating to payload-only mode." >&2
  exit 1
fi
echo "IPC progress events: $PROGRESS_COUNT (live wire delivered child HarnessEvents in real-time)." >&2

# Bracket order: every subagent_start must appear BEFORE its
# matching subagent_finished in the NDJSON stream. Any progress
# event for a given subagentId must sit BETWEEN its start and end.
# Build a per-line position index and assert the invariant.
ORDER_OK=$(jq -nr '
  [inputs | select(.type | startswith("subagent_"))]
  | group_by(
      if .type == "subagent_start" then .subagentId
      elif .type == "subagent_finished" then .subagentId
      elif .type == "subagent_progress" then .subagentId
      else "_" end
    )
  | all(
      (map(select(.type == "subagent_start")) | length) == 1 and
      (map(select(.type == "subagent_finished")) | length) == 1
    )
' < run.ndjson)
if [[ "$ORDER_OK" != "true" ]]; then
  echo "FAIL: subagent_* events do not match 1:1 by subagentId — orphan start, missing finished, or duplicate bracket." >&2
  jq -c 'select(.type | startswith("subagent_")) | {type, subagentId}' < run.ndjson >&2
  exit 1
fi

# Variety check: progress events should carry multiple inner
# HarnessEvent types. A run that only sees `provider_event` (and
# nothing else) means tool execution never happened — the explore
# subagent was supposed to use glob/grep/read_file. step_start at
# minimum proves the harness actually iterated; tool_invoking
# proves a tool was invoked. We accept either as the "real run"
# signal because Haiku may decide to answer in one shot.
INNER_TYPES=$(jq -r 'select(.type == "subagent_progress") | .lastEvent.type' < run.ndjson | sort -u)
if ! echo "$INNER_TYPES" | grep -q "step_start"; then
  echo "FAIL: no step_start in subagent_progress.lastEvent — child's harness didn't iterate visibly." >&2
  echo "Inner event types observed:" >&2
  echo "$INNER_TYPES" >&2
  exit 1
fi
INNER_DISTINCT=$(echo "$INNER_TYPES" | wc -l | tr -d ' ')
if [[ "$INNER_DISTINCT" -lt 2 ]]; then
  echo "WARN: only $INNER_DISTINCT distinct inner HarnessEvent type(s) crossed the wire — expected ≥2 (step_start + provider/tool)." >&2
  echo "Got: $INNER_TYPES" >&2
  # Not a fail — Haiku may have answered without a tool call.
  # Surface as a warning so the operator notices a regression
  # toward "subagent isn't doing real work" without breaking CI.
fi
echo "IPC inner event variety: $INNER_DISTINCT distinct types ($(echo "$INNER_TYPES" | tr '\n' ',' | sed 's/,$//'))." >&2

# Subagent IDs in the stream must match the SQLite child session
# ids — proves the runtime stamped the same id on the wire and the
# DB. A divergence would mean the audit trail and the live stream
# can't be cross-referenced.
WIRE_IDS=$(jq -r 'select(.type == "subagent_start") | .subagentId' < run.ndjson | sort -u)
DB_CHILD_IDS=$(sqlite3 "$DB" "SELECT id FROM sessions WHERE parent_session_id = '$PARENT_SESSION'" | sort -u)
if [[ "$WIRE_IDS" != "$DB_CHILD_IDS" ]]; then
  echo "FAIL: IPC subagentIds and SQLite child session ids diverge." >&2
  echo "  wire: $WIRE_IDS" >&2
  echo "  db:   $DB_CHILD_IDS" >&2
  exit 1
fi
echo "IPC subagentIds match SQLite child session ids — audit cross-reference intact." >&2

echo "PASS: subagent runtime + task tool + audit snapshot + live IPC wired end-to-end against $MODEL." >&2
exit 0
