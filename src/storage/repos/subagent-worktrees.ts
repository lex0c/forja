import type { DB } from '../db.ts';

export type SubagentWorktreeStatus = 'active' | 'preserved' | 'cleaned';

export interface SubagentWorktree {
  sessionId: string;
  path: string;
  branch: string;
  status: SubagentWorktreeStatus;
  createdAt: number;
  // Stamped on the transition out of 'active'. Null while the
  // child is still running or the cleanup pass hasn't fired yet.
  cleanedAt: number | null;
}

interface SubagentWorktreeRow {
  session_id: string;
  path: string;
  branch: string;
  status: SubagentWorktreeStatus;
  created_at: number;
  cleaned_at: number | null;
}

const fromRow = (row: SubagentWorktreeRow): SubagentWorktree => ({
  sessionId: row.session_id,
  path: row.path,
  branch: row.branch,
  status: row.status,
  createdAt: row.created_at,
  cleanedAt: row.cleaned_at,
});

export interface InsertSubagentWorktreeInput {
  sessionId: string;
  path: string;
  branch: string;
  // Terminal status at insert time. 4.2a is fully synchronous —
  // worktree create + child run + cleanup happen in one call, so
  // the audit row lands AFTER cleanup with the resolved state
  // (`cleaned` or `preserved`). The `active` value is reserved
  // for 4.2b+ when subprocess execution introduces a window
  // where the row exists before the run completes; including it
  // in the schema CHECK now keeps that future migration a one-row
  // change instead of a constraint rewrite.
  status: SubagentWorktreeStatus;
  // Stamps when the row's status reached its current value. For
  // `active` rows this is the worktree creation time; for
  // `cleaned`/`preserved` it's the cleanup time. 4.2a only ever
  // inserts terminal rows so this stamps cleanup; the audit
  // consumer reads it as "row finalized at <ts>".
  createdAt?: number;
  cleanedAt?: number;
}

// Insert a worktree audit row. 4.2a inserts ONCE post-cleanup with
// the terminal status — the FK to `sessions(id)` requires the
// child session to exist, and that happens inside `runAgent`, so
// pre-creation insertion isn't possible without restructuring the
// harness's session lifecycle. The intermediate `active` state
// matters only when the subprocess work in 4.2b lets the audit
// row outlive a parent crash; for in-process execution the post-
// cleanup row is the honest record.
export const insertSubagentWorktree = (
  db: DB,
  input: InsertSubagentWorktreeInput,
): SubagentWorktree => {
  const createdAt = input.createdAt ?? Date.now();
  // For terminal rows we default cleanedAt to createdAt; for
  // 'active' rows it stays null (the cleanup pass will UPDATE
  // when 4.2b wires that path).
  const cleanedAt = input.cleanedAt ?? (input.status === 'active' ? null : createdAt);
  db.query(
    `INSERT INTO subagent_worktrees
       (session_id, path, branch, status, created_at, cleaned_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.sessionId, input.path, input.branch, input.status, createdAt, cleanedAt);
  return {
    sessionId: input.sessionId,
    path: input.path,
    branch: input.branch,
    status: input.status,
    createdAt,
    cleanedAt,
  };
};

// Lookup helper. Returns null when no row exists for `sessionId`
// (the session never had a worktree, or its row was cascaded out
// of existence by a session delete). Audit consumers must always
// pair this with `sessions.is_subagent` + the definition's
// `isolation` field to disambiguate "never had one" from "had one
// and lost it to a cascade".
export const getSubagentWorktree = (db: DB, sessionId: string): SubagentWorktree | null => {
  const row = db
    .query<SubagentWorktreeRow, [string]>(
      `SELECT session_id, path, branch, status, created_at, cleaned_at
         FROM subagent_worktrees
        WHERE session_id = ?`,
    )
    .get(sessionId);
  return row !== null ? fromRow(row) : null;
};

// Surface every worktree currently on disk according to the audit
// table — both `active` (the 4.2b subprocess path will use this
// status while a child runs) and `preserved` (4.2a's "child wrote
// something, kept for inspection"). 'cleaned' rows are excluded
// because the worktree dir + branch were already dropped. Used by
// `agent worktree gc` (Step 4.2d); here in 4.2a, primarily for
// tests and future read-side tooling. Order: oldest first, so a
// sweep can act on the longest-orphaned ones up front.
//
// The earlier name was `listActiveSubagentWorktrees`, which
// suggested the result was scoped to the 'active' status. It
// wasn't — the function returns everything not yet cleaned. The
// rename makes the contract match the behavior.
export const listOnDiskSubagentWorktrees = (db: DB): SubagentWorktree[] => {
  const rows = db
    .query<SubagentWorktreeRow, []>(
      `SELECT session_id, path, branch, status, created_at, cleaned_at
         FROM subagent_worktrees
        WHERE status IN ('active','preserved')
        ORDER BY created_at ASC`,
    )
    .all();
  return rows.map(fromRow);
};

// Return every audit row, including 'cleaned'. The gc reconciler
// (Step 4.2d) needs this because a 'cleaned' row whose worktree
// path still exists on disk indicates a previously-failed cleanup
// — the gc retries removal in that case. `listOnDiskSubagentWorktrees`
// excludes 'cleaned' rows by construction, which would hide that
// inconsistency. Order by created_at ASC keeps the oldest-first
// presentation that the operator's eyeball-scan benefits from.
export const listAllSubagentWorktrees = (db: DB): SubagentWorktree[] => {
  const rows = db
    .query<SubagentWorktreeRow, []>(
      `SELECT session_id, path, branch, status, created_at, cleaned_at
         FROM subagent_worktrees
        ORDER BY created_at ASC`,
    )
    .all();
  return rows.map(fromRow);
};

// Scope worktree audit rows to a single parent-repo root.
// `agent --worktrees gc` MUST run scoped: the DB and the cache
// root are global resources shared across every repository the
// operator works in, so an unscoped query would pull in
// worktrees created from other repos. The CLI then sees them
// as candidates and `--force` (or even auto-removal of clean
// preserved entries) silently destroys preserved work from
// repo B while the operator was running gc in repo A.
//
// Scoping path: subagent_worktrees.session_id → sessions.id
// (the child session) → sessions.parent_session_id →
// sessions.id (the parent session) → sessions.cwd (where the
// parent ran from). A row qualifies when the parent's cwd is
// equal to OR under `repoRoot`.
//
// `repoRoot` MUST be canonical (e.g., already passed through
// `git rev-parse --show-toplevel`).
//
// LIKE wildcard escape: SQLite's LIKE treats `%` as
// match-any-string and `_` as match-single-char, both legal
// characters in Linux paths. Without escaping, a repoRoot of
// `/home/user/test_dir` would match parent cwds like
// `/home/user/testXdir/anything` — cross-repo leak via
// wildcard. We escape `%`, `_`, and `\` (the escape char
// itself) before binding, and pin the ESCAPE clause so SQLite
// honors the chosen escape character. Equality match (first
// `WHERE`) is a safe direct comparison and doesn't need
// escaping.
//
// Known limitations:
//   - Rows whose parent_session_id is NULL (parent session was
//     deleted or the row is top-level somehow — worktrees are
//     subagent territory so this is unusual) are EXCLUDED.
//     Operator can't gc them via this CLI; manual cleanup
//     (rm dir + DB UPDATE) is needed for that edge case.
//   - Nested repos (repo B physically inside repo A) appear in
//     gc invoked from repo A — the LIKE doesn't distinguish
//     "subdirectory" from "nested git repo". Rare; operator
//     running gc in the inner repo gets the precise scope.
const escapeLikePattern = (s: string): string =>
  // Order matters: escape backslash first so the subsequent
  // wildcard escapes don't double-escape the inserted slashes.
  s
    .replace(/\\/g, '\\\\')
    .replace(/[%_]/g, '\\$&');

export const listSubagentWorktreesByRepo = (db: DB, repoRoot: string): SubagentWorktree[] => {
  const rows = db
    .query<SubagentWorktreeRow, [string, string]>(
      `SELECT sw.session_id, sw.path, sw.branch, sw.status, sw.created_at, sw.cleaned_at
         FROM subagent_worktrees sw
         JOIN sessions cs ON cs.id = sw.session_id
         JOIN sessions ps ON ps.id = cs.parent_session_id
        WHERE ps.cwd = ? OR ps.cwd LIKE ? ESCAPE '\\'
        ORDER BY sw.created_at ASC`,
    )
    .all(repoRoot, `${escapeLikePattern(repoRoot)}/%`);
  return rows.map(fromRow);
};

// Mark a row as 'cleaned' AFTER an out-of-band cleanup pass (gc)
// removed the worktree directory and branch. Idempotent: a row
// already 'cleaned' is left alone (UPDATE WHERE status<>'cleaned'
// returns 0 changes silently). The exit timestamp is bumped so
// audit reflects when gc reconciled, not when the original
// cleanup pass tried.
export const markSubagentWorktreeCleaned = (db: DB, sessionId: string): boolean => {
  const now = Date.now();
  const result = db
    .query(
      `UPDATE subagent_worktrees
          SET status = 'cleaned',
              cleaned_at = ?
        WHERE session_id = ? AND status <> 'cleaned'`,
    )
    .run(now, sessionId);
  return Number(result.changes) > 0;
};
