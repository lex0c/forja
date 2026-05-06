import type { DB } from '../db.ts';

// Repo for `subagent_handles` (migration 021). The persistence
// layer that lets `task_async` handles survive a parent crash
// → resume cycle. See migration comment for the lifecycle.

export type SubagentHandleStatus = 'running' | 'settled';

export interface SubagentHandleRecord {
  handleId: string;
  parentSessionId: string;
  // Null until `runSubagent` returns with the child's session id.
  // Settled rows that took the cancelled-before-dispatch fast
  // path keep this null — no child session was created.
  childSessionId: string | null;
  name: string;
  spawnedAt: number;
  status: SubagentHandleStatus;
  // Parsed JSON. Settled rows always carry a payload (the
  // synthesized SpawnSubagentResult envelope); running rows have
  // null. The repo parses defensively — corrupted JSON returns
  // null and the consumer treats it like a missing payload.
  settledPayload: Record<string, unknown> | null;
  createdAt: number;
}

interface SubagentHandleRow {
  handle_id: string;
  parent_session_id: string;
  child_session_id: string | null;
  name: string;
  spawned_at: number;
  status: SubagentHandleStatus;
  settled_payload: string | null;
  created_at: number;
}

const parsePayload = (raw: string | null): Record<string, unknown> | null => {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const fromRow = (row: SubagentHandleRow): SubagentHandleRecord => ({
  handleId: row.handle_id,
  parentSessionId: row.parent_session_id,
  childSessionId: row.child_session_id,
  name: row.name,
  spawnedAt: row.spawned_at,
  status: row.status,
  settledPayload: parsePayload(row.settled_payload),
  createdAt: row.created_at,
});

export interface InsertSubagentHandleInput {
  handleId: string;
  parentSessionId: string;
  name: string;
  spawnedAt: number;
  createdAt?: number;
}

// Insert a fresh handle row. Called synchronously when
// `task_async` issues a handle id, BEFORE the spawn dispatches —
// so a crash between issuance and dispatch leaves a recoverable
// 'running' row that resume converts to interrupted.
export const insertSubagentHandle = (db: DB, input: InsertSubagentHandleInput): void => {
  const createdAt = input.createdAt ?? Date.now();
  db.query(
    `INSERT INTO subagent_handles
       (handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at)
     VALUES (?, ?, NULL, ?, ?, 'running', NULL, ?)`,
  ).run(input.handleId, input.parentSessionId, input.name, input.spawnedAt, createdAt);
};

// Bind the child session id once the spawn dispatched. Separate
// from settle so that a parent crash mid-run still has the
// linkage when resume looks up subagent_outputs by child id.
//
// Write-once on the row's settled state: the UPDATE only fires
// while `status='running'`. A row already settled (by a competing
// writer in the crash-resume race, or by `settleSubagentHandle`
// itself if the late spawn wakes after the IIFE settled an
// `interrupted` envelope) is left immutable. Without this guard,
// a late `updateSubagentHandleChildSession` would mutate
// `child_session_id` while `settled_payload.reason ===
// 'resumed_session'` — internal inconsistency for any audit /
// debug tooling that correlates the two columns.
//
// Returns true when this call was the writer; false when the row
// was already settled (race-loser; safe to ignore). Throws ONLY
// on missing row — that's a programmer / sequencing bug
// (insert MUST precede update).
export const updateSubagentHandleChildSession = (
  db: DB,
  handleId: string,
  childSessionId: string,
): boolean => {
  const result = db
    .query(
      `UPDATE subagent_handles
          SET child_session_id = ?
        WHERE handle_id = ? AND status = 'running'`,
    )
    .run(childSessionId, handleId);
  if (result.changes > 0) return true;
  const exists = db
    .query<{ n: number }, [string]>(
      'SELECT COUNT(*) AS n FROM subagent_handles WHERE handle_id = ?',
    )
    .get(handleId);
  if (exists !== null && exists.n > 0) return false;
  throw new Error(
    `updateSubagentHandleChildSession: no subagent_handles row for handle ${handleId}`,
  );
};

// Settle a handle exactly once. The UPDATE only fires when the
// row is still `running`; a row that was already settled by a
// prior write (e.g. by `settleRunningSubagentHandles` during
// resume rehydration, or by a sibling settle from a different
// process / replayed promise) is left intact. Returns true if
// this call was the writer; false if a prior settle won the
// race.
//
// Why write-once instead of "latest write wins": when a parent
// crashes mid-run with a child still alive, resume mass-settles
// the row to `resumed_session`. The original child eventually
// finishes (its subprocess outlives the parent crash) and tries
// to settle the same row to `done`. Without the write-once
// guard the resumed parent's view (`resumed_session`) gets
// silently overwritten by the eventual `done`, and audit
// readers replaying the timeline see a contradiction with the
// transient `subagent_outputs` row that the child published.
//
// Throws on missing row only — that's a programmer / sequencing
// bug (settle before insert). The "row exists but is already
// settled" case is the legitimate race we want to absorb.
export const settleSubagentHandle = (
  db: DB,
  handleId: string,
  payload: Record<string, unknown>,
): boolean => {
  const result = db
    .query(
      `UPDATE subagent_handles
          SET status = 'settled',
              settled_payload = ?
        WHERE handle_id = ? AND status = 'running'`,
    )
    .run(JSON.stringify(payload), handleId);
  if (result.changes > 0) return true;
  // Distinguish "row exists but already settled" (fine, race)
  // from "no row at all" (programmer bug).
  const exists = db
    .query<{ n: number }, [string]>(
      'SELECT COUNT(*) AS n FROM subagent_handles WHERE handle_id = ?',
    )
    .get(handleId);
  if (exists !== null && exists.n > 0) return false;
  throw new Error(`settleSubagentHandle: no subagent_handles row for handle ${handleId}`);
};

// Mass-settle every running row owned by a parent session.
// Called by the resume path: a fresh runAgent inherits the
// previous run's still-running handles as `interrupted`
// (reason=resumed_session). The payload is the same shape
// `awaitHandle` would have produced for an in-flight cancel,
// so re-await rehydrates a coherent envelope.
//
// Why mass-update instead of one-at-a-time: avoids N round
// trips when a parent dies with several handles in flight, and
// the synthesized envelope is identical for every interrupted
// row at this layer (the per-handle metadata — name, spawned_at
// — is already in the row, not in the envelope).
export const settleRunningSubagentHandles = (
  db: DB,
  parentSessionId: string,
  payload: Record<string, unknown>,
): number => {
  const result = db
    .query(
      `UPDATE subagent_handles
          SET status = 'settled',
              settled_payload = ?
        WHERE parent_session_id = ? AND status = 'running'`,
    )
    .run(JSON.stringify(payload), parentSessionId);
  return result.changes;
};

export const listSubagentHandlesByParent = (
  db: DB,
  parentSessionId: string,
): SubagentHandleRecord[] => {
  const rows = db
    .query<SubagentHandleRow, [string]>(
      `SELECT handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at
         FROM subagent_handles
        WHERE parent_session_id = ?
        ORDER BY spawned_at ASC`,
    )
    .all(parentSessionId);
  return rows.map(fromRow);
};

export const getSubagentHandle = (db: DB, handleId: string): SubagentHandleRecord | null => {
  const row = db
    .query<SubagentHandleRow, [string]>(
      `SELECT handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at
         FROM subagent_handles
        WHERE handle_id = ?`,
    )
    .get(handleId);
  return row !== null ? fromRow(row) : null;
};
