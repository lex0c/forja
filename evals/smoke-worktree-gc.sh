#!/usr/bin/env bash
# Smoke test for `forja --worktrees list / gc` (Step 4.2d).
#
# Unit tests cover the engine classification + CLI argument
# parsing with stubs. This smoke exercises the real production
# surface: actual `git rev-parse --show-toplevel`, actual
# `git worktree list --porcelain` parsing, actual
# `git worktree remove --force`, real filesystem mutations, and
# the operator-facing CLI dispatch end-to-end.
#
# Flow:
#   1. Init isolated XDG dirs + a fresh git repo (the parent).
#   2. Inline bun script seeds parent+child sessions + a
#      preserved `subagent_worktrees` row, AND creates the
#      actual `git worktree` on disk pointing at it.
#   3. `--worktrees list` → verifies the row appears with
#      kind=ready_to_remove (clean tree at this point).
#   4. `--worktrees list --json` → verifies every line parses
#      as JSON; final summary closes the stream.
#   5. `--worktrees gc --dry-run` → verifies plan rendered, no
#      filesystem mutation.
#   6. `--worktrees gc` → verifies worktree dir removed, branch
#      deleted, audit row flipped to 'cleaned'.
#   7. `--worktrees gc` (second time) → empty plan, no work.
#
# Cost: $0. No provider call. Requires: bun, git, sqlite3 (or
# inline bun script does the DB work — preferred since we know
# bun is on PATH for the project).
#
# Usage: ./evals/smoke-worktree-gc.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

TMPDIR="$(mktemp -d -t forja-smoke-wtgc-XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT

# Isolated XDG so the smoke doesn't see (or pollute) the
# developer's session DB. defaultDbPath() resolves under
# XDG_DATA_HOME; defaultWorktreeRoot() under XDG_CACHE_HOME.
export XDG_DATA_HOME="$TMPDIR/xdg-data"
export XDG_CACHE_HOME="$TMPDIR/xdg-cache"
mkdir -p "$XDG_DATA_HOME/agent" "$XDG_CACHE_HOME/agent/worktrees"

PARENT_REPO="$TMPDIR/parent-repo"
mkdir -p "$PARENT_REPO"
cd "$PARENT_REPO"

git init -b main >/dev/null 2>&1
git config user.email "smoke@example.com"
git config user.name "Smoke Test"
echo "# parent" > README.md
git add README.md
git commit -q -m "init"

# Constants the seed script reuses. Pinning the IDs makes the
# downstream JSON / table output assertions deterministic.
PARENT_ID="11111111-1111-1111-1111-111111111111"
CHILD_ID="22222222-2222-2222-2222-222222222222"
WORKTREE_BRANCH="agent/smoke-deadbeef"
WORKTREE_PATH="$XDG_CACHE_HOME/agent/worktrees/$CHILD_ID"

# Seed via a small bun script. We re-use the project's storage
# helpers so the schema matches whatever migrations are current —
# raw SQL would drift when migrations land.
SEED_SCRIPT="$TMPDIR/seed.ts"
cat > "$SEED_SCRIPT" <<EOF
import { defaultDbPath, openDb, migrate } from '${ROOT}/src/storage/index.ts';
import { createSession } from '${ROOT}/src/storage/repos/sessions.ts';
import { insertSubagentWorktree } from '${ROOT}/src/storage/repos/subagent-worktrees.ts';

const db = openDb(defaultDbPath());
migrate(db);
// Force known IDs so the bash assertions can pin them.
const parent = createSession(db, { model: 'mock/m', cwd: '${PARENT_REPO}' });
db.query('UPDATE sessions SET id = ? WHERE id = ?').run('${PARENT_ID}', parent.id);
const child = createSession(db, {
  model: 'mock/m',
  cwd: '${WORKTREE_PATH}',
  parentSessionId: '${PARENT_ID}',
});
db.query('UPDATE sessions SET id = ? WHERE id = ?').run('${CHILD_ID}', child.id);
insertSubagentWorktree(db, {
  sessionId: '${CHILD_ID}',
  path: '${WORKTREE_PATH}',
  branch: '${WORKTREE_BRANCH}',
  status: 'preserved',
});
db.close();
console.log('seeded');
EOF

bun run "$SEED_SCRIPT" >/dev/null

# Create the actual worktree on disk (clean tree → engine
# classifies as ready_to_remove).
git worktree add -q "$WORKTREE_PATH" -b "$WORKTREE_BRANCH"

# --- 1. list (table mode) -----------------------------------
echo "[1/6] list (table)"
LIST_OUT="$(bun run "$ROOT/src/cli/index.ts" --worktrees list 2>/dev/null)"
echo "$LIST_OUT" | grep -q "ready_to_remove" || {
  echo "FAIL: expected 'ready_to_remove' in list output, got:"
  echo "$LIST_OUT"
  exit 1
}
echo "$LIST_OUT" | grep -q "$WORKTREE_PATH" || {
  echo "FAIL: expected worktree path in list output"
  exit 1
}

# --- 2. list (json mode, NDJSON contract) -------------------
echo "[2/6] list --json (NDJSON contract)"
JSON_OUT="$(bun run "$ROOT/src/cli/index.ts" --worktrees list --json 2>/dev/null)"
# Every non-empty line must parse as JSON. Use jq's strict mode.
LINE_COUNT="$(printf '%s\n' "$JSON_OUT" | grep -c .)"
[[ "$LINE_COUNT" -ge 2 ]] || {
  echo "FAIL: expected at least 2 NDJSON lines (entry + summary), got $LINE_COUNT"
  exit 1
}
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  echo "$line" | bun -e 'JSON.parse(await new Response(Bun.stdin).text())' >/dev/null || {
    echo "FAIL: line is not valid JSON: $line"
    exit 1
  }
done <<< "$JSON_OUT"

# --- 3. gc --dry-run --------------------------------------
echo "[3/6] gc --dry-run (no mutation)"
DRY_OUT="$(bun run "$ROOT/src/cli/index.ts" --worktrees gc --dry-run 2>/dev/null)"
echo "$DRY_OUT" | grep -q "dry-run summary" || {
  echo "FAIL: expected 'dry-run summary' in dry-run output"
  exit 1
}
# Worktree must still exist.
[[ -d "$WORKTREE_PATH" ]] || {
  echo "FAIL: dry-run mutated the filesystem ($WORKTREE_PATH gone)"
  exit 1
}

# --- 4. gc (actual removal) ---------------------------------
echo "[4/6] gc (real removal)"
GC_OUT="$(bun run "$ROOT/src/cli/index.ts" --worktrees gc 2>/dev/null)"
echo "$GC_OUT" | grep -q "1 removed" || {
  echo "FAIL: expected '1 removed' summary, got:"
  echo "$GC_OUT"
  exit 1
}

# --- 5. verify worktree gone --------------------------------
echo "[5/6] verify removal"
[[ ! -d "$WORKTREE_PATH" ]] || {
  echo "FAIL: worktree dir still exists after gc"
  exit 1
}
# Branch deleted from parent repo.
if git -C "$PARENT_REPO" branch --list "$WORKTREE_BRANCH" | grep -q "."; then
  echo "FAIL: agent branch '$WORKTREE_BRANCH' still exists after gc"
  exit 1
fi
# Audit row flipped to 'cleaned' — verified via a second seed script
# that reads the row.
VERIFY_SCRIPT="$TMPDIR/verify.ts"
cat > "$VERIFY_SCRIPT" <<EOF
import { defaultDbPath, openDb } from '${ROOT}/src/storage/index.ts';
import { getSubagentWorktree } from '${ROOT}/src/storage/repos/subagent-worktrees.ts';

const db = openDb(defaultDbPath());
const row = getSubagentWorktree(db, '${CHILD_ID}');
console.log(JSON.stringify({ status: row?.status ?? null }));
db.close();
EOF
AUDIT_STATUS="$(bun run "$VERIFY_SCRIPT" 2>/dev/null | bun -e \
  'const j = JSON.parse(await new Response(Bun.stdin).text()); process.stdout.write(j.status ?? "null");')"
[[ "$AUDIT_STATUS" == "cleaned" ]] || {
  echo "FAIL: expected audit row status='cleaned', got '$AUDIT_STATUS'"
  exit 1
}

# --- 6. second gc → no work ---------------------------------
echo "[6/6] second gc (idempotent, empty plan)"
GC2_OUT="$(bun run "$ROOT/src/cli/index.ts" --worktrees gc 2>/dev/null)"
echo "$GC2_OUT" | grep -qE "0 removed.*0 reconciled.*0 skipped.*0 failed" || {
  echo "FAIL: expected empty-plan summary on second gc, got:"
  echo "$GC2_OUT"
  exit 1
}

echo "OK — worktree gc smoke passed."
