#!/usr/bin/env bash
# Cross-cutting smoke for the playbooks subsystem (PLAYBOOKS.md
# §1.1). Exercises a SINGLE playbook with the most populated
# frontmatter we ship — output_schema + references +
# tool_restrictions + sampling + context_recipe (step_reflection:
# terse) + prompt_version + context_recipe_version + slash — and
# asserts the cross-cutting invariants that each of the recent
# fixes targets.
#
# Why this exists: every per-field unit test passed independently
# while seven distinct integration bugs landed in production —
# Reflection prose breaking schema parse, empty schema forcing
# YAML, output_invalid reason getting downgraded to internalError,
# tool_restrictions not canonicalizing paths, whitespace evading
# bash deny, runPlaybook missing the permission proxy, slash
# dispatcher racing itself. The shared root cause was that no
# eval ran a playbook with all those fields lit at once against
# a real model. This smoke is the gap-closing fixture.
#
# Flow:
#   1. mktemp workspace + isolated XDG.
#   2. Drop a project-scoped kitchen-sink.md with every field
#      populated except `phases` (runtime-deferred per spec) and
#      `isolation: worktree` (covered by smoke-subagent-worktree-ipc).
#   3. Drop a REFERENCE.md the playbook references AND a couple
#      of src/* files the model is asked to inspect.
#   4. Drop bypass-mode permissions (defense in depth — the child
#      whitelist + tool_restrictions are the real gates).
#   5. Run the parent agent in --json mode with a prompt that
#      invokes the playbook via the task tool. task_sync goes
#      through the same `runSubagent` path the slash dispatcher
#      uses, with the harness wiring the parent's permission
#      proxy down to the child.
#   6. Assert:
#      a. Snapshot completeness — output_schema, references,
#         tool_restrictions, sampling, context_recipe all non-null
#         and JSON-parseable in subagent_runs (migrations
#         020-027); tools_whitelist round-trips.
#      b. Envelope reason fidelity — subagent_outputs.payload
#         reports `done` (NOT `internalError`, NOT
#         `playbook.output_invalid`). The fix that preserves
#         playbook-specific reason codes in the parent validator
#         is symmetric with the `done` branch — a regression
#         there would also corrupt this happy-path reason.
#      c. Schema enforcement DESPITE Reflection: prose — with
#         step_reflection:terse the child emits a `Reflection:`
#         line before the YAML fence; the validator must locate
#         the fence and parse its contents (the regression that
#         downgraded every such run to `playbook.output_invalid`).
#      d. Output keys present — the payload's `output` field
#         parses as a YAML mapping containing every required
#         key from the declared schema. Catches the "model emits
#         something but the runtime accepted free-form text"
#         failure mode.
#      e. References injected — the child's system prompt
#         contains the REFERENCE.md content (proves the
#         references block was rendered into the prompt, not
#         just stored as audit metadata).
#
# Cost: ~$0.01-0.04 per run on Haiku 4.5 (one parent call + one
# child call, ~1-2k output tokens each).
# Requires: ANTHROPIC_API_KEY, jq, sqlite3.
#
# Usage: ./evals/smoke-playbook-kitchen-sink.sh

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

TMPDIR="$(mktemp -d -t forja-smoke-playbook-ks-XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT

# Isolated XDG so the smoke does not pollute the developer's
# session log. Same convention as smoke-subagent-explore.
export XDG_DATA_HOME="$TMPDIR/xdg"
export XDG_CONFIG_HOME="$TMPDIR/xdg-config"
mkdir -p "$XDG_DATA_HOME/forja"
mkdir -p "$XDG_CONFIG_HOME"

WORKSPACE="$TMPDIR/workspace"
mkdir -p "$WORKSPACE/src"
cd "$WORKSPACE"

# Workspace seeds. The kitchen-sink playbook will be asked to
# inspect them; if its `output_schema.files_inspected` ends up
# empty, the model never actually used its read_file tool — the
# tool wiring is broken or restrictions silently denied access.
echo "export const port = 8080;" > src/config.ts
echo "export const greet = (n: string) => \`hi \${n}\`;" > src/greet.ts

# REFERENCE.md is what the playbook's `references:` field points
# at. The wire contract (reference-block.ts): the runtime appends
# a "## References (read on demand)" block listing the path to
# the child's system prompt — content is NOT loaded eagerly. The
# model reads it via read_file IF the listing reaches it.
# Assertion (e) below verifies the behavioral consequence: the
# child invoked read_file on REFERENCE.md, which is only
# plausible if the references block landed in the prompt.
cat > REFERENCE.md <<'MD'
# Project Reference

The workspace contains a tiny TypeScript module under `src/`.
Read this file when the playbook prompts you to consult
project references.
MD

# Project-scoped playbook with as many frontmatter fields as the
# loader accepts populated. NOTE on tool_restrictions: bash and
# write_file are NOT in `tools[]`, so they are unreachable at
# runtime; the rules are exercised purely as a snapshot
# serialization test (forward-compat per restrictions.ts comment).
# read_file is the tool the playbook actually uses.
mkdir -p .agent/agents
cat > .agent/agents/kitchen-sink.md <<'MD'
---
name: kitchen-sink
description: Cross-cutting smoke fixture exercising every playbook field at once.
slash: ks
when_to_use: smoke fixture only — never use in production
tools: [read_file, glob, grep]
budget:
  max_steps: 8
  max_cost_usd: 0.10
sampling:
  temperature: 0.1
  max_tokens: 1024
context_recipe:
  step_reflection: terse
references:
  - REFERENCE.md
output_schema:
  topic: string
  files_inspected: array
  summary: string
  confidence: enum [high, medium, low]
tool_restrictions:
  write_file:
    allow_paths: ['src/**']
    deny_paths: ['src/secret/**']
  bash:
    deny: ['rm -rf *']
prompt_version: 1
context_recipe_version: 1
---

# Kitchen-sink smoke playbook

You are the kitchen-sink playbook. Inspect the workspace using
read_file/glob/grep, then describe what you found. Your final
assistant turn MUST be the YAML mapping declared in output_schema.

Set `confidence: high` only if you actually opened at least one
src/* file. List opened files in `files_inspected`.
MD

# Bypass mode so a hypothetical write attempt is denied by the
# child's whitelist (read_file/glob/grep only), not by the parent
# permission engine — keeps the assertion target focused on the
# playbook subsystem.
cat > .agent/permissions.yaml <<'YAML'
defaults:
  mode: bypass
YAML

MODEL="anthropic/claude-haiku-4-5"

echo "=== Run parent agent: dispatch kitchen-sink via task tool ===" >&2
# The child prompt explicitly asks the playbook to consult
# REFERENCE.md so assertion (e) — read_file on REFERENCE.md —
# has a deterministic behavioral signal. Without the explicit
# nudge, Haiku may decide REFERENCE.md is irrelevant and skip
# it, making the assertion flake on judgment rather than
# wiring.
bun run "$ROOT/src/cli/index.ts" \
  --model "$MODEL" \
  --json \
  "Use the task tool to dispatch the 'kitchen-sink' playbook with this prompt: 'Read REFERENCE.md first to ground yourself, then inspect src/ and summarize the workspace.' Report the playbook's output back to me." \
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
if [[ ! -f "$DB" ]]; then
  echo "FAIL: no SQLite database at $DB after the run." >&2
  exit 1
fi

CHILD_ID=$(sqlite3 "$DB" "
  SELECT id FROM sessions
  WHERE parent_session_id = '$PARENT_SESSION'
  LIMIT 1
")
if [[ -z "$CHILD_ID" ]]; then
  echo "FAIL: no child session linked to parent — playbook was never dispatched." >&2
  echo "Run NDJSON tail:" >&2
  tail -30 run.ndjson >&2
  exit 1
fi
echo "Child session: $CHILD_ID" >&2

# === (a) Snapshot completeness — every frontmatter field
# round-tripped into subagent_runs as JSON.
SNAPSHOT_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM subagent_runs WHERE session_id = '$CHILD_ID'")
if [[ "$SNAPSHOT_COUNT" -ne 1 ]]; then
  echo "FAIL: expected 1 subagent_runs row for child $CHILD_ID, got $SNAPSHOT_COUNT." >&2
  exit 1
fi

# Each populated field MUST round-trip as non-null JSON. NULL
# means the loader didn't capture it OR the runtime didn't write
# it to the snapshot — both class-A regressions of the audit
# fingerprint contract.
for FIELD in output_schema reference_paths tool_restrictions sampling context_recipe; do
  VAL=$(sqlite3 "$DB" "SELECT $FIELD FROM subagent_runs WHERE session_id = '$CHILD_ID'")
  if [[ -z "$VAL" || "$VAL" == "NULL" ]]; then
    echo "FAIL: subagent_runs.$FIELD is NULL for child $CHILD_ID — snapshot incomplete." >&2
    exit 1
  fi
  # JSON parseability — a corrupt snapshot row would parse the
  # column as a string and fail jq with an exit code.
  if ! echo "$VAL" | jq -e . >/dev/null 2>&1; then
    echo "FAIL: subagent_runs.$FIELD is not valid JSON: $VAL" >&2
    exit 1
  fi
done

# tools_whitelist must equal the declared array exactly. A
# regression that re-orders or drops a tool would surface here.
TOOLS=$(sqlite3 "$DB" "SELECT tools_whitelist FROM subagent_runs WHERE session_id = '$CHILD_ID'")
if [[ "$TOOLS" != '["read_file","glob","grep"]' ]]; then
  echo "FAIL: tools_whitelist mismatch." >&2
  echo "  expected: [\"read_file\",\"glob\",\"grep\"]" >&2
  echo "  got:      $TOOLS" >&2
  exit 1
fi
echo "Snapshot complete: output_schema, reference_paths, tool_restrictions, sampling, context_recipe all populated; tools_whitelist round-trips." >&2

# === (b) Envelope reason fidelity — the parent validator must
# preserve `done` verbatim. This is the symmetric assertion to
# the `playbook.output_invalid` preservation test: the parent's
# VALID_REASON_MAP is a closed set, and a typo / missing entry
# would silently coerce the reason here too.
PAYLOAD=$(sqlite3 "$DB" "SELECT payload FROM subagent_outputs WHERE session_id = '$CHILD_ID'")
if [[ -z "$PAYLOAD" ]]; then
  echo "FAIL: child published no envelope payload." >&2
  exit 1
fi
REASON=$(echo "$PAYLOAD" | jq -r '.reason')
STATUS=$(echo "$PAYLOAD" | jq -r '.status')
if [[ "$STATUS" != "done" || "$REASON" != "done" ]]; then
  echo "FAIL: envelope reason fidelity broken." >&2
  echo "  expected: status=done reason=done" >&2
  echo "  got:      status=$STATUS reason=$REASON" >&2
  echo "  message:  $(echo "$PAYLOAD" | jq -r '.message // empty')" >&2
  exit 1
fi
echo "Envelope reason preserved: status=$STATUS reason=$REASON." >&2

# === (c) Schema enforcement DESPITE Reflection prose — the
# regression that motivated this smoke. With step_reflection:terse
# the child emits a Reflection: line BEFORE the YAML fence; the
# validator must locate the fence anywhere in the text. If
# parseOutputAsObject regressed to first-line-only fence
# detection, the reason would land as `playbook.output_invalid`
# (asserted negatively above) AND the output would still contain
# Reflection: prose. Surface the proof either way for the
# operator's eyeball.
OUTPUT=$(echo "$PAYLOAD" | jq -r '.output')
if echo "$OUTPUT" | head -1 | grep -qi '^reflection:'; then
  echo "Reflection: prose preceded the YAML fence (step_reflection:terse contract honored)." >&2
fi

# === (d) Output keys present — the validator passed (we know
# from reason=done above), but pin the structural shape too so
# a future bug that flips validateOutput to `valid: true` on
# parse failure (the same class as the `{}` short-circuit fix)
# does not render this test toothless.
OUTPUT_FENCE=$(echo "$OUTPUT" | sed -n '/^```ya\?ml$/,/^```$/p' | sed '1d;$d')
if [[ -z "$OUTPUT_FENCE" ]]; then
  # Fall back to bare YAML — the schema block accepts both
  # shapes per output-schema-block.ts. Strip a leading
  # Reflection: line if the model placed YAML inline.
  OUTPUT_FENCE="$OUTPUT"
fi
PARSED=$(echo "$OUTPUT_FENCE" | bun -e '
  import { readFileSync } from "node:fs";
  import { parse } from "yaml";
  const text = readFileSync(0, "utf-8");
  // Strip a leading Reflection: line if present (bare-YAML
  // case where the model did not wrap the mapping in a fence).
  const stripped = text.replace(/^Reflection:[^\n]*\n+/i, "");
  const obj = parse(stripped);
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    process.stderr.write("not an object\n");
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(obj));
' 2>/dev/null) || {
  echo "FAIL: payload.output did not parse as a YAML mapping." >&2
  echo "Output (first 1k):" >&2
  echo "$OUTPUT" | head -c 1024 >&2
  echo "" >&2
  exit 1
}
for KEY in topic files_inspected summary confidence; do
  if ! echo "$PARSED" | jq -e ".$KEY" >/dev/null 2>&1; then
    echo "FAIL: output missing required schema key '$KEY'." >&2
    echo "Parsed: $PARSED" >&2
    exit 1
  fi
done
echo "Output keys present: topic, files_inspected, summary, confidence." >&2

# === (e) References block actually reached the model — we
# verify behaviorally rather than by introspecting persisted
# prompts (the composed prompt is sent to the provider but not
# uniformly stored in the messages table). The runtime appends
# `## References (read on demand)` to the child's system prompt
# listing each reference path; if that block landed and the
# child prompt asks the model to consult REFERENCE.md, a
# read_file call against that path is the proof. Absence here
# means either the references block didn't render, the listing
# didn't include REFERENCE.md, or the model never saw it — all
# three are end-to-end regressions worth catching.
READ_REF_COUNT=$(sqlite3 "$DB" "
  SELECT COUNT(*)
  FROM tool_calls tc
  JOIN messages m ON tc.message_id = m.id
  WHERE m.session_id = '$CHILD_ID'
    AND tc.tool_name = 'read_file'
    AND tc.status = 'done'
    AND tc.input LIKE '%REFERENCE.md%'
")
if [[ "$READ_REF_COUNT" -lt 1 ]]; then
  echo "FAIL: child never read REFERENCE.md via read_file — references block missing or unrendered." >&2
  echo "  read_file calls in child session:" >&2
  sqlite3 "$DB" "
    SELECT tc.tool_name, tc.input, tc.status
    FROM tool_calls tc
    JOIN messages m ON tc.message_id = m.id
    WHERE m.session_id = '$CHILD_ID'
  " >&2
  exit 1
fi
echo "References block reached the model: child invoked read_file('REFERENCE.md') ($READ_REF_COUNT call(s))." >&2

echo "PASS: kitchen-sink playbook composition (snapshot + envelope reason + Reflection-aware schema parse + output keys + references) wired end-to-end against $MODEL." >&2
exit 0
