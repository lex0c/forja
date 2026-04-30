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
// table. Used by `agent worktree gc` (Step 4.2d) to enumerate
// candidates; here in 4.2a, primarily for tests and for future
// read-side tooling. Order: oldest first, so a sweep can act on
// the longest-orphaned ones up front.
export const listActiveSubagentWorktrees = (db: DB): SubagentWorktree[] => {
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
