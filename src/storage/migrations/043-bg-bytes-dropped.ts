export const migration043BgBytesDropped = {
  id: 43,
  name: '043-bg-bytes-dropped',
  // Slice 153 (review): per-stream bytes-dropped bookkeeping.
  // The bg manager's drainer (slice 153) truncates the on-disk
  // log file's head when it would exceed `maxLogBytes`, keeping
  // the tail (most-recent bytes — what the LLM cares about most).
  // Cursors must reflect ABSOLUTE bytes-since-spawn so that
  //   - a cursor past the current file size still maps cleanly
  //     to "all bytes consumed" (the bytes were dropped from the
  //     head, not the tail — the LLM has effectively seen them);
  //   - a `since` value from a previous response is still valid
  //     after a truncate (file_offset = max(0, since - dropped)).
  //
  // The dropped count survives process exit and even session
  // restart, so it goes in the DB row rather than the in-memory
  // LiveHandle (which is cleared when the bg process ends).
  // Cursor semantics flip from file-offset to absolute as of
  // this migration; existing rows have dropped=0 so old cursors
  // are still valid (they had no truncations to reconcile).
  sql: `
    ALTER TABLE background_processes
      ADD COLUMN stdout_bytes_dropped INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE background_processes
      ADD COLUMN stderr_bytes_dropped INTEGER NOT NULL DEFAULT 0;
  `,
} as const;
