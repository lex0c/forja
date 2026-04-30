#!/usr/bin/env bash
# Smoke test for subagent runtime + task tool against a real model.
# Spec §11.1 + Step 4.1 acceptance: parent invokes task() to spawn a
# read-only `explore` subagent, the child runs in an isolated context
# with a restricted toolset (no write_file), and the parent receives
# the structured output envelope.
#
# Mocks lie: they don't exercise definition discovery from the
# project .agent/agents/ directory, the bootstrap wiring of
# subagentRegistry into the harness, or the JSON shape the child
# emits as a tool result back to the parent. This script wires the
# whole loop together end-to-end.
#
# Flow:
#   1. mktemp workspace + isolated XDG.
#   2. Drop a project-scoped explore.md under .agent/agents/.
#   3. Drop bypass-mode permissions so the parent's tools aren't denied.
#   4. Run the agent with a prompt asking it to use task(subagent: 'explore', prompt: '...').
#   5. Capture session_finished + child sessions.
#   6. Assert: at least one child session row with parent_session_id
#      pointing at the parent; the child's tool_calls table never
#      mentions write_file (whitelist enforcement); the parent's
#      output mentions one of the seed filenames (the explore child
#      actually inspected the workspace).
#
# Cost: ~$0.005-0.02 per run on Haiku 4.5.
# Requires: ANTHROPIC_API_KEY.
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

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "ANTHROPIC_API_KEY not set (checked env and $ROOT/.env); cannot run real-model smoke." >&2
  exit 1
fi

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

MODEL="anthropic/claude-haiku-4-5"

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

echo "PASS: subagent runtime + task tool wired end-to-end against $MODEL." >&2
exit 0
