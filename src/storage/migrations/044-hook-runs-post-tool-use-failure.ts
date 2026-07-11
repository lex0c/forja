export const migration044HookRunsPostToolUseFailure = {
  id: 44,
  name: '044-hook-runs-post-tool-use-failure',
  // Slice 181 (review fix): the hook_runs.event CHECK constraint
  // pre-dates PostToolUseFailure and rejected any row written for
  // it. Slice 181 added PostToolUseFailure to the HookEvent union,
  // the dispatcher, and the config validator, but missed the DB
  // schema constraint — so audit rows for the new event silently
  // dropped (the dispatcher emitAudit closure caught the throw and
  // logged a "AUDIT DRIFT" stderr line). Forensic queries for
  // PostToolUseFailure runs returned empty.
  //
  // SQLite doesn't support ALTER TABLE for CHECK constraints, so
  // we rebuild the table: copy rows into a new shape, drop the
  // old, rename. Indices are recreated post-swap. There's no data
  // migration concern — the dropped rows never made it to disk in
  // the first place; this just unblocks new writes.
  sql: `
    CREATE TABLE hook_runs_new (
      id            TEXT PRIMARY KEY,
      session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      event         TEXT NOT NULL
                    CHECK (event IN (
                      'SessionStart', 'UserPromptSubmit', 'PreToolUse',
                      'PostToolUse', 'PostToolUseFailure', 'PreCompact',
                      'Notification', 'PreCheckpoint', 'MemoryWrite', 'Stop'
                    )),
      layer         TEXT NOT NULL
                    CHECK (layer IN ('enterprise', 'user', 'project')),
      source_path   TEXT NOT NULL,
      hook_index    INTEGER NOT NULL,
      command       TEXT NOT NULL,
      expanded      TEXT NOT NULL,
      exit_code     INTEGER,
      outcome       TEXT NOT NULL
                    CHECK (outcome IN (
                      'allow', 'block_silent', 'block_message',
                      'error', 'timeout'
                    )),
      duration_ms   INTEGER NOT NULL,
      stdout        TEXT,
      stderr        TEXT,
      matched_tool  TEXT,
      created_at    INTEGER NOT NULL
    );

    INSERT INTO hook_runs_new
      SELECT id, session_id, event, layer, source_path, hook_index,
             command, expanded, exit_code, outcome, duration_ms,
             stdout, stderr, matched_tool, created_at
      FROM hook_runs;

    DROP TABLE hook_runs;
    ALTER TABLE hook_runs_new RENAME TO hook_runs;

    CREATE INDEX idx_hook_runs_session
      ON hook_runs(session_id, created_at DESC)
      WHERE session_id IS NOT NULL;

    CREATE INDEX idx_hook_runs_event
      ON hook_runs(event, created_at DESC);
  `,
} as const;
