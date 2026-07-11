import type { DB } from '../db.ts';

// Repo for `cost_progress_events` (migration 022). Captures the
// cost-update IPC stream from each child subagent so postmortem
// queries can reconstruct the cumulative-spend curve over time
// — not just the final settled cost.
//
// Writers: the harness's `onChildEventForwarder` calls
// `insertCostProgressEvent` every time a `cost_update`
// HarnessEvent arrives via IPC. Inserts are best-effort: a
// SQLITE_BUSY or schema-mismatch throw is caught and stderr-
// warned by the caller. The audit row is the only consumer of
// this data; losing one event degrades resolution but does not
// break the run.
//
// Readers: audit / postmortem code (no caller in v1, surface
// is built so the operator can hand-craft `agent dump-cost
// <session>` later, or external tooling can SELECT directly).

export interface CostProgressEvent {
  id: number;
  handleId: string;
  parentSessionId: string;
  // The latest charge alone (`delta` field of the source
  // `cost_update` HarnessEvent). Always > 0 — the emitter at
  // `loop.ts:emitCostUpdate` skips zero/negative deltas.
  delta: number;
  // The child's running self-cost AT THIS POINT. Monotonic
  // within a single handle (the handle store enforces that on
  // the live tracker; we persist what was emitted).
  cumulative: number;
  // Parent's wall-clock at receive time (Date.now() at the IPC
  // handler), NOT the child's emit time. See migration comment
  // for rationale.
  recordedAt: number;
}

interface CostProgressEventRow {
  id: number;
  handle_id: string;
  parent_session_id: string;
  delta: number;
  cumulative: number;
  recorded_at: number;
}

const fromRow = (row: CostProgressEventRow): CostProgressEvent => ({
  id: row.id,
  handleId: row.handle_id,
  parentSessionId: row.parent_session_id,
  delta: row.delta,
  cumulative: row.cumulative,
  recordedAt: row.recorded_at,
});

export interface InsertCostProgressEventInput {
  handleId: string;
  parentSessionId: string;
  delta: number;
  cumulative: number;
  recordedAt?: number;
}

// Insert one row. Throws on FK violations (handle row was
// dropped via cascade mid-run), CHECK violations (none in v1),
// or SQLITE_BUSY under WAL contention. Caller (harness IPC
// handler) wraps in try/catch — losing a row degrades the
// audit curve but doesn't break the run.
export const insertCostProgressEvent = (db: DB, input: InsertCostProgressEventInput): void => {
  const recordedAt = input.recordedAt ?? Date.now();
  db.query(
    `INSERT INTO cost_progress_events
       (handle_id, parent_session_id, delta, cumulative, recorded_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.handleId, input.parentSessionId, input.delta, input.cumulative, recordedAt);
};

// Per-handle reconstruction. Ordered by `recorded_at` then by
// `id` so ties within the same ms tick stay deterministic.
export const listCostProgressByHandle = (db: DB, handleId: string): CostProgressEvent[] => {
  const rows = db
    .query<CostProgressEventRow, [string]>(
      `SELECT id, handle_id, parent_session_id, delta, cumulative, recorded_at
         FROM cost_progress_events
        WHERE handle_id = ?
        ORDER BY recorded_at ASC, id ASC`,
    )
    .all(handleId);
  return rows.map(fromRow);
};

// Whole-session reconstruction. Useful for "show me every
// cost spike in session X" without joining through handles.
// Same deterministic ordering as the per-handle variant.
export const listCostProgressByParent = (db: DB, parentSessionId: string): CostProgressEvent[] => {
  const rows = db
    .query<CostProgressEventRow, [string]>(
      `SELECT id, handle_id, parent_session_id, delta, cumulative, recorded_at
         FROM cost_progress_events
        WHERE parent_session_id = ?
        ORDER BY recorded_at ASC, id ASC`,
    )
    .all(parentSessionId);
  return rows.map(fromRow);
};
