export const migration011SessionsIsSubagent = {
  id: 11,
  name: '011-sessions-is-subagent',
  // M3 / Step 4.1 review fix. Migration 010 added
  // `parent_session_id` with ON DELETE SET NULL, which is the right
  // shape for the audit-survives-parent-purge property. But that
  // creates a second problem: `parent_session_id IS NULL` was being
  // used as the "top-level user session" predicate, and after a
  // purge orphaned children share that predicate with genuine
  // top-level rows. Default listings then mix orphaned subagents
  // into the user view, and `--resume last` can attach to a former
  // subagent child whose system prompt and toolset don't match a
  // normal user follow-up — the resume would surface confusing
  // failures.
  //
  // Fix: a separate `is_subagent` flag captures the IDENTITY of the
  // row (was-it-spawned-as-a-subagent), which never changes,
  // independent from the parent_session_id FK that captures the
  // LIVE relationship. The two columns answer different questions
  // and need to be persisted separately.
  //
  // Backfill: any existing row with a non-null parent_session_id
  // is, by definition, a subagent — set is_subagent=1 there. Rows
  // with parent_session_id IS NULL stay at the default 0; if any
  // of those were already orphaned children, we have no way to
  // recover the distinction (the parent_session_id was already
  // cleared), so they ship as top-level. The corruption is
  // pre-existing; the migration doesn't make it worse.
  //
  // Forward listing predicate becomes `is_subagent = 0`. The
  // index supports the dominant top-level filter without a full
  // table scan after retention purges accumulate orphans.
  sql: `
    ALTER TABLE sessions ADD COLUMN is_subagent INTEGER NOT NULL DEFAULT 0
      CHECK (is_subagent IN (0, 1));

    UPDATE sessions SET is_subagent = 1 WHERE parent_session_id IS NOT NULL;

    CREATE INDEX idx_sessions_is_subagent_started
      ON sessions(is_subagent, started_at DESC);
  `,
} as const;
