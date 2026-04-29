export const migration008SessionSeq = {
  id: 8,
  name: '008-session-seq',
  // Symmetric fix to migration 007 (messages.seq). listSessions
  // ordered by `started_at DESC` only — millisecond-granular
  // Date.now means two sessions started within the same tick tie
  // on the timestamp, and SQLite's implicit tiebreaker is rowid
  // ordering which is correct in practice but not guaranteed.
  // The user-facing symptom: `--resume last` could attach to an
  // older session when two starts collided in the same ms.
  //
  // Fix: explicit monotonic seq, populated atomically at INSERT
  // time. Same shape as the messages.seq fix — the subquery
  // `SELECT COALESCE(MAX(seq), -1) + 1 FROM sessions` is safe
  // under SQLite's single-writer model.
  //
  // Index on seq DESC supports listSessions's newest-first order.
  // Backfill orders by (started_at, id) — preserves what the
  // listing returned before this migration so existing tooling
  // sees the same shape.
  sql: `
    ALTER TABLE sessions ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;

    UPDATE sessions
    SET seq = (
      SELECT rn FROM (
        SELECT id AS sid,
               ROW_NUMBER() OVER (ORDER BY started_at ASC, id ASC) - 1 AS rn
        FROM sessions
      ) ordered
      WHERE ordered.sid = sessions.id
    );

    CREATE INDEX idx_sessions_seq ON sessions(seq);
  `,
} as const;
