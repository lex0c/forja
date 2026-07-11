// memory_events.source CHECK rebuild — adds 'seed' for the vendor
// seed-catalog surface (MEMORY.md §5.7).
//
// Seed memories ship with the binary (or via team / install opt-in)
// and must show up in the audit trail with `source: 'seed'` so
// operators can answer "did this entry come from the seed catalog
// or did I/the model save it?". Without 'seed' in the CHECK
// constraint, any memory_events emit for a seed lifecycle action
// (created on install, edited on upgrade, deleted via /memory delete)
// would fail the constraint and lose the audit row — silently
// breaking the §5.7.5 upgrade traceability.
//
// Same shape as migrations 048 and 063: SQLite can't ALTER CHECK in
// place, so rebuild the table — copy rows into a new shape, drop
// the old, rename, recreate indexes.
//
// Action CHECK is preserved verbatim from migration 063 (proposed,
// created, edited, deleted, read, refused, promoted, demoted,
// expired, quarantined, invalidated, evicted, restored, purged,
// deferred). Scope CHECK is preserved verbatim from migration 016
// (user, project_local, project_shared).

export const migration069MemoryEventsSeedSource = {
  id: 69,
  name: '069-memory-events-seed-source',
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
                    'restored', 'purged', 'deferred'
                  )),
      memory_name TEXT NOT NULL,
      source      TEXT NOT NULL
                  CHECK (source IN ('user_explicit', 'seed', 'inferred', 'imported')),
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
