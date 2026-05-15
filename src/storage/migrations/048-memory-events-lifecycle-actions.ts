// memory_events.action CHECK rebuild — adds the five lifecycle
// actions documented in MEMORY.md §5.3 (Phase 0 stitching):
// `quarantined`, `invalidated`, `evicted`, `restored`, `purged`.
//
// Phase 0 added these to the SPEC vocabulary; the actual SQL
// CHECK was never updated, so any INSERT carrying one would have
// failed with `CHECK constraint failed: action IN (...)`. Same
// shape as migration 044 (PostToolUseFailure) and 047
// (hook_runs.event = 'Eviction'): SQLite doesn't ALTER CHECK,
// so we rebuild the table — copy rows into a new shape, drop
// the old, rename, recreate indexes.
//
// Lands BEFORE the first transition that needs the new actions
// (Phase 1.3.c1 transitionMemoryState). Without it, every
// transition would fail-and-stderr through registry.recordEvent's
// catch-and-log, dropping audit silently.

export const migration048MemoryEventsLifecycleActions = {
  id: 48,
  name: '048-memory-events-lifecycle-actions',
  sql: `
    CREATE TABLE memory_events_new (
      id          TEXT PRIMARY KEY,
      scope       TEXT NOT NULL
                  CHECK (scope IN ('user', 'project_local', 'project_shared')),
      action      TEXT NOT NULL
                  CHECK (action IN (
                    'proposed', 'created', 'edited', 'deleted',
                    'read', 'refused', 'promoted', 'demoted', 'expired',
                    'quarantined', 'invalidated', 'evicted',
                    'restored', 'purged'
                  )),
      memory_name TEXT NOT NULL,
      source      TEXT NOT NULL
                  CHECK (source IN ('user_explicit', 'inferred', 'imported')),
      session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      cwd         TEXT,
      created_at  INTEGER NOT NULL,
      details     TEXT
    );

    INSERT INTO memory_events_new
      SELECT id, scope, action, memory_name, source,
             session_id, cwd, created_at, details
      FROM memory_events;

    DROP TABLE memory_events;
    ALTER TABLE memory_events_new RENAME TO memory_events;

    CREATE INDEX idx_memory_events_session
      ON memory_events(session_id)
      WHERE session_id IS NOT NULL;

    CREATE INDEX idx_memory_events_name
      ON memory_events(memory_name, created_at DESC);
  `,
} as const;
