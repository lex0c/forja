import type { DB } from '../db.ts';

export interface Checkpoint {
  id: string;
  sessionId: string;
  stepId: string;
  gitRef: string;
  createdAt: number;
  hadBash: boolean;
}

interface CheckpointRow {
  id: string;
  session_id: string;
  step_id: string;
  git_ref: string;
  created_at: number;
  had_bash: number;
}

const fromRow = (row: CheckpointRow): Checkpoint => ({
  id: row.id,
  sessionId: row.session_id,
  stepId: row.step_id,
  gitRef: row.git_ref,
  createdAt: row.created_at,
  hadBash: row.had_bash === 1,
});

export interface InsertCheckpointInput {
  id?: string;
  sessionId: string;
  stepId: string;
  gitRef: string;
  hadBash: boolean;
  createdAt?: number;
}

export const insertCheckpoint = (db: DB, input: InsertCheckpointInput): Checkpoint => {
  const id = input.id ?? crypto.randomUUID();
  const createdAt = input.createdAt ?? Date.now();
  db.query(
    `INSERT INTO checkpoints (id, session_id, step_id, git_ref, created_at, had_bash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.sessionId, input.stepId, input.gitRef, createdAt, input.hadBash ? 1 : 0);
  return {
    id,
    sessionId: input.sessionId,
    stepId: input.stepId,
    gitRef: input.gitRef,
    createdAt,
    hadBash: input.hadBash,
  };
};

export const getCheckpoint = (db: DB, id: string): Checkpoint | null => {
  const row = db
    .query(
      `SELECT id, session_id, step_id, git_ref, created_at, had_bash
       FROM checkpoints WHERE id = ?`,
    )
    .get(id) as CheckpointRow | null;
  return row === null ? null : fromRow(row);
};

// Newest first. Drives `--checkpoints list` and `--undo` (which takes
// the head of this listing). Tied created_at falls back to id which
// is a UUID — random but stable, so a tie at the millisecond level
// resolves consistently across calls. The harness emits at most one
// checkpoint per step, so ties happen only when two sessions interleave
// or a clock-skewed test produces same-ms inserts; both are deterministic
// here.
export const listCheckpointsBySession = (db: DB, sessionId: string): Checkpoint[] => {
  const rows = db
    .query(
      `SELECT id, session_id, step_id, git_ref, created_at, had_bash
       FROM checkpoints
       WHERE session_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(sessionId) as CheckpointRow[];
  return rows.map(fromRow);
};

// Latest checkpoint of a session, or null when none exist. Convenience
// over listCheckpointsBySession()[0] — the SQL form lets SQLite stop
// after one row.
export const getLatestCheckpointBySession = (db: DB, sessionId: string): Checkpoint | null => {
  const row = db
    .query(
      `SELECT id, session_id, step_id, git_ref, created_at, had_bash
       FROM checkpoints
       WHERE session_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(sessionId) as CheckpointRow | null;
  return row === null ? null : fromRow(row);
};

export const deleteCheckpoint = (db: DB, id: string): void => {
  db.query('DELETE FROM checkpoints WHERE id = ?').run(id);
};

// Bulk delete by session — used by `--checkpoints purge --session=<id>`.
// Returns row count for cleanup logging.
export const deleteCheckpointsBySession = (db: DB, sessionId: string): number => {
  const result = db.query('DELETE FROM checkpoints WHERE session_id = ?').run(sessionId);
  return Number(result.changes);
};

// Bulk delete by age — drives the lazy startup cleanup of refs whose
// audit row crosses the retention horizon. Ref deletion is the caller's
// responsibility (separate concern from the DB row); returns the deleted
// rows so the caller can issue matching `git update-ref -d` calls.
export const listCheckpointsOlderThan = (db: DB, cutoffMs: number): Checkpoint[] => {
  const rows = db
    .query(
      `SELECT id, session_id, step_id, git_ref, created_at, had_bash
       FROM checkpoints
       WHERE created_at < ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(cutoffMs) as CheckpointRow[];
  return rows.map(fromRow);
};
