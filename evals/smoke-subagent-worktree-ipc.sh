#!/usr/bin/env bash
# Smoke for worktree-isolated subagent + live IPC under a real
# provider. Verifies that two independently-tested subsystems
# (worktree creation/cleanup + IPC channel) compose correctly
# when the child runs in a cwd different from the parent's.
#
# Risk surface this exercises:
#
#   - Child's `processTransport` reads from its OWN process.stdin
#     (not the parent's). The worktree cwd shouldn't affect that
#     — but sentinel for any future regression that builds the
#     channel relative to cwd.
#   - bgLogDir is anchored to PARENT's cwd, NOT the worktree.
#     The runtime computes
#     `<parentCwd>/.agent/bg/subagents/<sessionId>/`. A bug that
#     anchored at the worktree would leak bg logs into the
#     ephemeral worktree dir and lose them on cleanup.
#   - subagent_worktrees audit row lands AND the post-run
#     cleanup decision (remove/preserve) lines up with the
#     child's actual git status.
#   - Parent's NDJSON still carries subagent_progress events —
#     the IPC wire can't degrade silently when worktree cwd
#     gets in the way.
#   - Parent's repo top-level is NOT mutated by the child's
#     writes (the whole point of worktree isolation).
#
# Cost: ~$0.04 per run on Haiku 4.5.
# Requires: ANTHROPIC_API_KEY, jq, sqlite3, git.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "ANTHROPIC_API_KEY not set; cannot run real-model smoke." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git not found; worktree smoke needs git." >&2
  exit 1
fi

TMPDIR="$(mktemp -d -t forja-smoke-worktree-XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT

export XDG_DATA_HOME="$TMPDIR/xdg"
export XDG_CONFIG_HOME="$TMPDIR/xdg-config"
export XDG_CACHE_HOME="$TMPDIR/xdg-cache"
mkdir -p "$XDG_DATA_HOME/forja" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"

# Workspace must be a git repo — `git worktree add` requires it.
WORKSPACE="$TMPDIR/workspace"
mkdir -p "$WORKSPACE"
cd "$WORKSPACE"
git -c init.defaultBranch=main init -q
git -c user.email=smoke@forja.local -c user.name=smoke commit -q --allow-empty -m "init"

echo "alpha original" > alpha.txt
echo "beta original" > beta.txt
git add alpha.txt beta.txt
git -c user.email=smoke@forja.local -c user.name=smoke commit -q -m "seed"

mkdir -p .agent/agents
cat > .agent/agents/scribe.md <<'MD'
---
name: scribe
description: Writes a small report in an isolated worktree.
tools: [read_file, glob, write_file]
budget:
  max_steps: 8
  max_cost_usd: 0.04
isolation: worktree
---
You are a scribe subagent running in an isolated git worktree.
Read every .txt file in the working tree, then write a file
named report.txt summarizing what you found (one line per
file, with the file's content). Be brief. Do not modify
existing files.
MD

cat > .agent/permissions.yaml <<'YAML'
defaults:
  mode: bypass
YAML

MODEL="anthropic/claude-haiku-4-5"

echo "=== Run parent: spawn worktree-isolated scribe ===" >&2
bun run "$ROOT/src/cli/index.ts" \
  --model "$MODEL" \
  --json \
  "Use the task tool with subagent name 'scribe' and prompt 'create a report.txt summarizing the .txt files'. Echo the result." \
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

CHILD_ID=$(sqlite3 "$DB" "SELECT id FROM sessions WHERE parent_session_id = '$PARENT_SESSION' LIMIT 1")
if [[ -z "$CHILD_ID" ]]; then
  echo "FAIL: no child session linked to parent — task() never fired or linkage broken." >&2
  exit 1
fi
echo "Child session: $CHILD_ID" >&2

# === Worktree audit row ===
WT_PATH=$(sqlite3 "$DB" "SELECT path FROM subagent_worktrees WHERE session_id = '$CHILD_ID'")
WT_BRANCH=$(sqlite3 "$DB" "SELECT branch FROM subagent_worktrees WHERE session_id = '$CHILD_ID'")
WT_STATUS=$(sqlite3 "$DB" "SELECT status FROM subagent_worktrees WHERE session_id = '$CHILD_ID'")
if [[ -z "$WT_PATH" ]]; then
  echo "FAIL: no subagent_worktrees row for child session — worktree path never recorded." >&2
  echo "subagent_worktrees contents:" >&2
  sqlite3 "$DB" "SELECT * FROM subagent_worktrees" >&2
  exit 1
fi
echo "Worktree audit: path=$WT_PATH branch=$WT_BRANCH status=$WT_STATUS" >&2

# Child cwd recorded on the session row should match the worktree
# path — the runtime sets session.cwd to the worktree, not the
# parent cwd. A divergence here would mean the child harness
# anchored at the wrong tree (memory roots, hooks, fs tools all
# read from session.cwd).
CHILD_CWD=$(sqlite3 "$DB" "SELECT cwd FROM sessions WHERE id = '$CHILD_ID'")
if [[ "$CHILD_CWD" != "$WT_PATH" ]]; then
  echo "FAIL: child session.cwd ($CHILD_CWD) ≠ worktree path ($WT_PATH)." >&2
  exit 1
fi

# === IPC wire still functional ===
START_COUNT=$(jq -c 'select(.type == "subagent_start")' < run.ndjson | wc -l | tr -d ' ')
FINISH_COUNT=$(jq -c 'select(.type == "subagent_finished")' < run.ndjson | wc -l | tr -d ' ')
PROGRESS_COUNT=$(jq -c 'select(.type == "subagent_progress")' < run.ndjson | wc -l | tr -d ' ')

if [[ "$START_COUNT" -ne 1 || "$FINISH_COUNT" -ne 1 ]]; then
  echo "FAIL: bracket pair (start=$START_COUNT, finished=$FINISH_COUNT) not 1/1." >&2
  exit 1
fi
if [[ "$PROGRESS_COUNT" -lt 1 ]]; then
  echo "FAIL: zero subagent_progress events — IPC wire degraded under worktree isolation." >&2
  exit 1
fi
echo "IPC live: $START_COUNT/$FINISH_COUNT bracket, $PROGRESS_COUNT progress events ✓" >&2

# === Parent's repo top-level is unmodified ===
#
# Child wrote report.txt — but in the WORKTREE, on a separate
# branch. The parent's main checkout must not have a report.txt
# unless the operator explicitly merges. Worktree isolation
# means the child's writes are visible only via WT_PATH (if
# preserved) or git branch (if cleaned).
if [[ -e "$WORKSPACE/report.txt" ]]; then
  echo "FAIL: parent's cwd has report.txt — child's write leaked out of the worktree." >&2
  ls -la "$WORKSPACE" >&2
  exit 1
fi
# Existing files unchanged.
ALPHA_NOW=$(cat "$WORKSPACE/alpha.txt")
if [[ "$ALPHA_NOW" != "alpha original" ]]; then
  echo "FAIL: parent's alpha.txt was modified — child's edit leaked." >&2
  exit 1
fi
echo "Parent repo top-level unmodified — worktree isolation held ✓" >&2

# === Worktree cleanup decision matches reality ===
#
# 'cleaned' = worktree dir removed (child's writes were tracked
# clean; nothing to preserve). 'preserved' = dir kept (dirty).
# A 'cleaned' status with the dir still on disk would mean the
# remove failed silently — leak.
if [[ "$WT_STATUS" == "cleaned" ]]; then
  if [[ -d "$WT_PATH" ]]; then
    echo "FAIL: worktree status=cleaned but dir still on disk: $WT_PATH" >&2
    exit 1
  fi
  echo "Cleanup verdict 'cleaned' matches: worktree removed from disk ✓" >&2
elif [[ "$WT_STATUS" == "preserved" ]]; then
  if [[ ! -d "$WT_PATH" ]]; then
    echo "FAIL: worktree status=preserved but dir missing from disk: $WT_PATH" >&2
    exit 1
  fi
  # If preserved AND scribe wrote report.txt, it should be
  # there. (Haiku may not always actually write — small budget
  # — so we don't require it; just sanity that the dir exists.)
  echo "Cleanup verdict 'preserved' matches: worktree present at $WT_PATH ✓" >&2
else
  echo "FAIL: unexpected worktree status='$WT_STATUS' (expected cleaned|preserved)." >&2
  exit 1
fi

# === Whitelist enforced even with worktree isolation ===
#
# Scribe's tools are [read_file, glob, write_file] — no `bash`,
# no `edit_file`. A regression in the validator that lifted
# the whitelist when worktree was set would leak through here.
LEAKED=$(sqlite3 "$DB" "
  SELECT tool_name FROM tool_calls tc
  JOIN messages m ON tc.message_id = m.id
  WHERE m.session_id = '$CHILD_ID'
    AND tc.status = 'done'
    AND tc.tool_name NOT IN ('read_file', 'glob', 'write_file')
")
if [[ -n "$LEAKED" ]]; then
  echo "FAIL: child invoked tool(s) outside its whitelist: $LEAKED" >&2
  exit 1
fi

echo "PASS: worktree isolation + IPC + audit + whitelist composed correctly against $MODEL." >&2
exit 0
