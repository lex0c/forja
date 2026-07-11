#!/usr/bin/env bash
# Smoke test for checkpoint + --undo against a real model.
# CHECKPOINTS.md §5 criterion 6: agent refactors 3 files, --undo
# restores them to the pre-refactor state.
#
# Mocks lie: they don't trigger real tool_use sequences end-to-end,
# don't exercise actual git commit-tree on real working trees, and
# don't validate that --undo's working tree reset matches a model-
# initiated edit pattern. This script wires the whole loop together
# so we have evidence that the audit row, the git ref, and the
# read-tree --reset path all agree under a real provider stream.
#
# Flow:
#   1. Init a fresh git repo with 3 seed files.
#   2. Capture initial sha-256 of each file.
#   3. Run the agent with a prompt asking it to add a header comment
#      to all 3 files via write_file. enableCheckpoints is on by
#      default for non-plan CLI runs, so a snapshot fires before the
#      first write step.
#   4. Capture sessionId from session_finished.
#   5. Verify the 3 files differ from initial (proof the agent did the work).
#   6. Run `--undo --yes <sessionId>`.
#   7. Verify each file's sha-256 matches the initial capture.
#
# Cost: ~$0.005-0.02 per run on Haiku 4.5 (one tool-heavy turn +
#       one closing turn). Requires: ANTHROPIC_API_KEY.
#
# Usage: ./evals/smoke-checkpoint-undo.sh

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

TMPDIR="$(mktemp -d -t forja-smoke-ckpt-XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT

# Isolated XDG so the smoke doesn't pollute the developer's session log.
export XDG_DATA_HOME="$TMPDIR/xdg"
mkdir -p "$XDG_DATA_HOME/forja"

WORKSPACE="$TMPDIR/workspace"
mkdir -p "$WORKSPACE"
cd "$WORKSPACE"

# Init git so checkpoints engage. The detect probe in the harness
# reports `available=false` outside a git repo and snapshots become
# no-ops — defeating the whole purpose of this smoke.
git init -b main >/dev/null 2>&1
git config user.email "smoke@local"
git config user.name "smoke"

# Drop bypass-mode policy so write_file isn't policy-denied.
# Without this the harness exits with no checkpoints because the
# tool calls would be denied before the snapshot's write step.
mkdir -p .forja
cat > .forja/permissions.yaml <<'YAML'
defaults:
  mode: bypass
YAML

# Three seed files with distinct contents. We commit them to anchor
# the working-tree state — that way `git status` is clean before the
# agent runs, and the post-undo dirty-detection (working tree vs
# HEAD) is unambiguous.
echo "Hello, world!" > greeting.txt
echo "Color: blue" > color.txt
echo "Fruit: apple" > fruit.txt
git add . >/dev/null
git commit -m "seed" >/dev/null 2>&1

# Capture initial sha-256s. Using sha256sum (Linux) — fall back to
# shasum -a 256 (macOS) when the former isn't installed.
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

GREET_BEFORE=$(hash_file greeting.txt)
COLOR_BEFORE=$(hash_file color.txt)
FRUIT_BEFORE=$(hash_file fruit.txt)
echo "before: greeting=$GREET_BEFORE color=$COLOR_BEFORE fruit=$FRUIT_BEFORE" >&2

MODEL="${SMOKE_MODEL:-anthropic/claude-haiku-4-5}"

echo "=== Run agent: refactor 3 files ===" >&2
bun run "$ROOT/src/cli/index.ts" \
  --model "$MODEL" \
  --json \
  "Use the write_file tool to prepend the line '# updated by smoke' (followed by a newline) to each of these three files: greeting.txt, color.txt, fruit.txt. Do all three edits then stop. Do not ask questions. Do not modify any other file." \
  > run.ndjson 2> run.err || {
    echo "Agent run failed. stderr:" >&2
    cat run.err >&2
    exit 1
  }

SESSION_ID=$(jq -r 'select(.type == "session_finished") | .result.sessionId' < run.ndjson | head -1)
if [[ -z "$SESSION_ID" || "$SESSION_ID" == "null" ]]; then
  echo "Could not extract sessionId from forja run:" >&2
  cat run.ndjson >&2
  exit 1
fi
echo "Session id: $SESSION_ID" >&2

# At least one checkpoint_created event proves the harness actually
# snapshotted before a write step. Zero events would mean checkpoints
# were never engaged (probe reported unavailable, or the model never
# invoked write_file).
CKPT_COUNT=$(jq -r 'select(.type == "checkpoint_created") | .checkpointId' < run.ndjson | wc -l)
if [[ "$CKPT_COUNT" -eq 0 ]]; then
  echo "FAIL: no checkpoint_created events — harness did not snapshot." >&2
  cat run.ndjson >&2
  exit 1
fi
echo "Checkpoints recorded: $CKPT_COUNT" >&2

# Files should now differ from the seed.
GREET_AFTER=$(hash_file greeting.txt)
COLOR_AFTER=$(hash_file color.txt)
FRUIT_AFTER=$(hash_file fruit.txt)

if [[ "$GREET_AFTER" == "$GREET_BEFORE" ]] && \
   [[ "$COLOR_AFTER" == "$COLOR_BEFORE" ]] && \
   [[ "$FRUIT_AFTER" == "$FRUIT_BEFORE" ]]; then
  echo "FAIL: agent did not modify any file. Smoke needs the model to actually edit; cannot validate undo." >&2
  echo "greeting:" >&2; cat greeting.txt >&2
  echo "color:"    >&2; cat color.txt >&2
  echo "fruit:"    >&2; cat fruit.txt >&2
  exit 1
fi
echo "after-edit: greeting=$GREET_AFTER color=$COLOR_AFTER fruit=$FRUIT_AFTER" >&2

echo "=== --undo --yes $SESSION_ID ===" >&2
bun run "$ROOT/src/cli/index.ts" \
  --undo "$SESSION_ID" \
  --yes \
  --json \
  > undo.ndjson 2> undo.err || {
    echo "Undo failed. stderr:" >&2
    cat undo.err >&2
    exit 1
  }

# Working tree should match the seed contents byte-for-byte.
GREET_FINAL=$(hash_file greeting.txt)
COLOR_FINAL=$(hash_file color.txt)
FRUIT_FINAL=$(hash_file fruit.txt)
echo "after-undo: greeting=$GREET_FINAL color=$COLOR_FINAL fruit=$FRUIT_FINAL" >&2

FAIL=0
if [[ "$GREET_FINAL" != "$GREET_BEFORE" ]]; then
  echo "FAIL: greeting.txt did not revert" >&2
  echo "  expected: $GREET_BEFORE" >&2
  echo "  got:      $GREET_FINAL" >&2
  cat greeting.txt >&2
  FAIL=1
fi
if [[ "$COLOR_FINAL" != "$COLOR_BEFORE" ]]; then
  echo "FAIL: color.txt did not revert" >&2
  echo "  expected: $COLOR_BEFORE" >&2
  echo "  got:      $COLOR_FINAL" >&2
  cat color.txt >&2
  FAIL=1
fi
if [[ "$FRUIT_FINAL" != "$FRUIT_BEFORE" ]]; then
  echo "FAIL: fruit.txt did not revert" >&2
  echo "  expected: $FRUIT_BEFORE" >&2
  echo "  got:      $FRUIT_FINAL" >&2
  cat fruit.txt >&2
  FAIL=1
fi

if [[ "$FAIL" -eq 1 ]]; then
  exit 1
fi

echo "PASS: agent refactored 3 files, --undo restored each to its pre-refactor sha-256." >&2
exit 0
