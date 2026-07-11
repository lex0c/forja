// memory_events.action CHECK rebuild — adds 'deferred' for the
// /memory governance defer surface (MEMORY.md §11.3, post-#5 code
// review #1).
//
// `defer` mutates a pending governance proposal's `deferred_until`
// + `defer_count` columns (migration 062). Without an audit row,
// `/memory audit --name <memory>` doesn't reflect the operator's
// action: forensic answer to "when did this proposal's expiry get
// extended, by whom, and why?" lives only in the proposal row.
// Operators inspecting per-memory history miss it.
//
// Same shape as migration 048 (lifecycle actions): SQLite can't
// ALTER CHECK in place, so rebuild the table — copy rows into a
// new shape, drop the old, rename, recreate indexes.
//
// One row per defer, attributed to the memory the proposal would
// transition on approve: `target_payload.target_key` when set
// (multi-memory quarantine carve-out for S13 pair), else
// `source_memory_keys[0]` (single-memory S11 path). The slash
// command (`src/cli/slash/commands/memory.ts:handleGovernanceDefer`)
// is the only call site; `details` carries `{proposal_id, kind,
// additional_days, new_deferred_until, defer_count, reason?}`.

export const migration063MemoryEventsDeferredAction = {
  id: 63,
  name: '063-memory-events-deferred-action',
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
