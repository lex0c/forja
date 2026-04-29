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

// Update a checkpoint's git_ref. Used by the retention rewrite path
// when surviving checkpoints are re-parented onto current HEAD: the
// rebuilt commit has a new sha, and the row must follow so future
// restore/diff/list operations resolve correctly. Throws on unknown
// id rather than silently no-op'ing — a missing row at this point
// signals state corruption that should surface, not silently mask.
export const updateCheckpointGitRef = (db: DB, id: string, gitRef: string): void => {
  const result = db.query('UPDATE checkpoints SET git_ref = ? WHERE id = ?').run(gitRef, id);
  if (result.changes === 0) {
    throw new Error(`checkpoint ${id} not found`);
  }
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
//
// `cwd` scopes the listing to a single project. The lazy sweep at
// session_start runs in the active agent's cwd and must NOT touch
// rows belonging to sessions in other directories — those refs live
// in a different git store, so deleting their DB rows leaves the audit
// log inconsistent with the still-restorable git state. Pass undefined
// only for explicit cross-project administrative cleanup (no current
// caller does this; left available for future tooling).
export const listCheckpointsOlderThan = (db: DB, cutoffMs: number, cwd?: string): Checkpoint[] => {
  if (cwd === undefined) {
    const rows = db
      .query(
        `SELECT id, session_id, step_id, git_ref, created_at, had_bash
         FROM checkpoints
         WHERE created_at < ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(cutoffMs) as CheckpointRow[];
    return rows.map(fromRow);
  }
  const rows = db
    .query(
      `SELECT c.id, c.session_id, c.step_id, c.git_ref, c.created_at, c.had_bash
       FROM checkpoints c
       JOIN sessions s ON c.session_id = s.id
       WHERE c.created_at < ? AND s.cwd = ?
       ORDER BY c.created_at ASC, c.id ASC`,
    )
    .all(cutoffMs, cwd) as CheckpointRow[];
  return rows.map(fromRow);
};
