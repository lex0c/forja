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
  // Terminal status at insert time. 'active' is set on worktree
  // creation and updated to 'cleaned' / 'preserved' at end-of-run.
  // Callers that perform create + run + cleanup synchronously can
  // insert directly with the terminal status.
  status: SubagentWorktreeStatus;
  // Stamps when the row's status reached its current value. For
  // `active` rows this is the worktree creation time; for
  // `cleaned`/`preserved` it's the cleanup time.
  createdAt?: number;
  cleanedAt?: number;
}

// Insert a worktree audit row. The FK to `sessions(id)` requires
// the child session to exist, and that happens inside `runAgent`.
// The intermediate `active` state matters when the subprocess
// flow lets the audit row outlive a parent crash; for synchronous
// in-process execution the post-cleanup row is the honest record.
export const insertSubagentWorktree = (
  db: DB,
  input: InsertSubagentWorktreeInput,
): SubagentWorktree => {
  const createdAt = input.createdAt ?? Date.now();
  // For terminal rows we default cleanedAt to createdAt; for
  // 'active' rows it stays null (the cleanup pass updates it
  // at end-of-run).
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
// table — both `active` (subprocess path while a child runs) and
// `preserved` ("child wrote something, kept for inspection").
// 'cleaned' rows are excluded because the worktree dir + branch
// were already dropped. Used by `forja worktree gc`. Order:
// oldest first, so a sweep can act on the longest-orphaned ones
// up front.
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
// needs this because a 'cleaned' row whose worktree
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

// SubagentWorktree augmented with the parent session's cwd.
// Scoped gc needs the parent's cwd to filter rows
// to the repo gc was invoked from — but the comparison can't
// happen at SQL level because `sessions.cwd` stores the
// LITERAL path passed at session creation (e.g. an operator's
// symlink path like `/home/user/projA-symlink`) while
// `git rev-parse --show-toplevel` returns the CANONICAL path
// (`/home/user/projA`). A direct string compare excludes
// symlink-equivalent rows, hiding legitimate worktrees from
// gc and leaving them as undeletable orphans in the audit.
//
// We surface the parent's cwd alongside the row so the caller
// can canonicalize via `realpathSync` (or any other host-side
// resolver) and do the equivalence check in JS — SQLite has
// no portable realpath function, so the equivalence has to
// live above the SQL layer.
export interface SubagentWorktreeWithParentCwd extends SubagentWorktree {
  parentCwd: string;
}

interface SubagentWorktreeWithParentCwdRow extends SubagentWorktreeRow {
  parent_cwd: string;
}

const fromRowWithParent = (
  row: SubagentWorktreeWithParentCwdRow,
): SubagentWorktreeWithParentCwd => ({
  ...fromRow(row),
  parentCwd: row.parent_cwd,
});

// Surface every audit row joined with its parent session's cwd.
// Used by `forja --worktrees gc` to scope rows to
// the repo gc was invoked from. The caller is expected to
// canonicalize both `parentCwd` and the resolved repo root
// before comparing.
//
// Known limitations:
//   - Rows whose parent_session_id is NULL (parent session was
//     deleted via cascade-set-null, or — extremely unusual —
//     a top-level session that somehow has a worktree audit
//     row) are EXCLUDED via the inner JOIN on parent_session_id.
//     Operator can't gc them via this CLI; manual cleanup
//     (rm dir + DB UPDATE) is needed for that edge case.
//   - Nested repos (repo B physically inside repo A) all map
//     to repo A's scope when gc runs from A — the path-prefix
//     check doesn't distinguish "subdirectory" from "nested
//     git repo". Operator running gc inside B gets the
//     precise scope.
export const listSubagentWorktreesWithParentCwd = (db: DB): SubagentWorktreeWithParentCwd[] => {
  const rows = db
    .query<SubagentWorktreeWithParentCwdRow, []>(
      `SELECT sw.session_id, sw.path, sw.branch, sw.status, sw.created_at, sw.cleaned_at,
              ps.cwd AS parent_cwd
         FROM subagent_worktrees sw
         JOIN sessions cs ON cs.id = sw.session_id
         JOIN sessions ps ON ps.id = cs.parent_session_id
        ORDER BY sw.created_at ASC`,
    )
    .all();
  return rows.map(fromRowWithParent);
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
