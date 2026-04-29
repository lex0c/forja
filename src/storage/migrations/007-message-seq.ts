export const migration007MessageSeq = {
  id: 7,
  name: '007-message-seq',
  // M3 / Step 2.4 code review fix. Resume reconstitutes
  // ProviderMessage[] from listMessagesBySession, which previously
  // ordered by `created_at, id`. created_at is millisecond-granular
  // (Date.now), so two messages appended within the same ms tie on
  // the timestamp; the secondary sort by id is LEXICAL on UUID v4,
  // which is RANDOM. Reorderings are observable: an assistant
  // message containing tool_use blocks can land AFTER the user
  // message containing the matching tool_result blocks, sending an
  // invalid conversation history to the provider on resume.
  //
  // Fix: add a strictly monotonic per-session sequence column. New
  // inserts compute next seq via a subquery in the INSERT, atomic
  // under SQLite's single-writer model. Existing rows are
  // backfilled by stable ordering on (created_at, id) — best-effort
  // since the precise insertion order has been lost; the result is
  // at least consistent with what queries returned before, so
  // sessions that resumed cleanly before will resume cleanly after.
  //
  // Index updated to (session_id, seq) so listMessagesBySession's
  // new ORDER BY hits an index seek, not a sort.
  sql: `
    ALTER TABLE messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;

    -- Backfill: assign seq within each session by stable ordering.
    -- ROW_NUMBER() over a window gives a contiguous 0..N-1 per
    -- session matching the prior listMessagesBySession ordering.
    UPDATE messages
    SET seq = (
      SELECT rn FROM (
        SELECT id AS mid,
               ROW_NUMBER() OVER (
                 PARTITION BY session_id
                 ORDER BY created_at ASC, id ASC
               ) - 1 AS rn
        FROM messages
      ) ordered
      WHERE ordered.mid = messages.id
    );

    CREATE INDEX idx_messages_session_seq ON messages(session_id, seq);
  `,
} as const;
