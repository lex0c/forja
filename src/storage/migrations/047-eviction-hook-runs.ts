// Bundles two schema-level fixes surfaced by the post-1.2 code
// review:
//
//   C1 — `hook_runs.event` CHECK rejected the new 'Eviction' event.
//        Same shape as 044's PostToolUseFailure rebuild: SQLite
//        doesn't ALTER CHECK, so we copy into a new table with the
//        expanded enum, drop, rename. Index recreation matches the
//        prior migration set verbatim.
//
//   H2 — `detectTriggerThrashing` (eviction-events repo) was doing
//        a full table scan (SCAN eviction_events USING INDEX
//        idx_evict_obj + USE TEMP B-TREE FOR GROUP BY). With 365d
//        retention this is the heaviest query of the table. Adding
//        a partial index keyed by the `trigger_fired_no_action`
//        outcome lets the GROUP BY use the index directly. Partial
//        keeps the index small — `applied` rows (the common case)
//        don't enter it.
//
// Both changes ship together because the audit-write path that
// hook_runs guards is what Phase 1.3 (memory lifecycle) will
// exercise; the partial index is independent but small enough to
// justify single-migration cost over two.

export const migration047EvictionHookRuns = {
  id: 47,
  name: '047-eviction-hook-runs',
  sql: `
    -- C1: rebuild hook_runs with 'Eviction' in the event CHECK.
    -- BACKLOG entry for Phase 1.2.b claimed (incorrectly) that the
    -- column wasn't enum-constrained at SQL level. It is. Without
    -- this migration, every Eviction hook_runs INSERT fails the
    -- CHECK and the dispatcher's emitAudit catches the throw,
    -- writing a "AUDIT DRIFT" line to stderr — forensic queries
    -- for Eviction runs would return empty.
    CREATE TABLE hook_runs_new (
      id            TEXT PRIMARY KEY,
      session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      event         TEXT NOT NULL
                    CHECK (event IN (
                      'SessionStart', 'UserPromptSubmit', 'PreToolUse',
                      'PostToolUse', 'PostToolUseFailure', 'PreCompact',
                      'Notification', 'PreCheckpoint', 'MemoryWrite',
                      'Eviction', 'Stop'
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

    -- H2: partial index for detectTriggerThrashing. The query
    -- groups by (substrate, object_id, trigger) with
    -- WHERE outcome='trigger_fired_no_action' AND recorded_at > ?.
    -- A covering index on that exact predicate eliminates the
    -- table scan AND the temp B-tree GROUP BY. Partial WHERE
    -- keeps it small — only thrashing rows enter, which is the
    -- only rows the query reads anyway.
    CREATE INDEX idx_evict_thrash
      ON eviction_events(substrate, object_id, trigger, recorded_at)
      WHERE outcome = 'trigger_fired_no_action';
  `,
} as const;
