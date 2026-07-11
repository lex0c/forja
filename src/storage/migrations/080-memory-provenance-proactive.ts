// memory_provenance.surface CHECK rebuild — adds 'proactive' for the
// §4.4 proactive-injection exposure surface.
//
// When proactive memory injection (MEMORY.md §4.4) appends a recalled
// memory body to a turn, that exposure must be auditable like any other
// — "the model received memory X proactively when it produced Y" (§4.4
// I5, principle 2: user-auditable). The proactive surface is shaped like
// `eager`: no tool_call and no retrieval_trace link (it bypasses the
// retrieve_context pipeline), so tool_call_id + the retrieval grouping
// fields stay NULL.
//
// Same shape as migrations 048/063/069: SQLite can't ALTER CHECK in
// place, so rebuild the table — copy rows into the widened shape, drop
// the old, rename, recreate the four indexes. FKs + scope CHECK are
// preserved verbatim from migration 054.

export const migration080MemoryProvenanceProactive = {
  id: 80,
  name: '080-memory-provenance-proactive',
  sql: `
    CREATE TABLE memory_provenance_new (
      id                         TEXT PRIMARY KEY,
      session_id                 TEXT NOT NULL,
      tool_call_id               TEXT,
      memory_scope               TEXT NOT NULL CHECK (memory_scope IN (
                                    'user',
                                    'project_shared',
                                    'project_local'
                                  )),
      memory_name                TEXT NOT NULL,
      surface                    TEXT NOT NULL CHECK (surface IN (
                                    'eager',
                                    'memory_read',
                                    'retrieve_context',
                                    'proactive'
                                  )),
      retrieval_query_id         TEXT,
      position_in_corpus         INTEGER,
      memory_content_hash        TEXT,
      memory_state_at_exposure   TEXT,
      created_at                 INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (tool_call_id) REFERENCES tool_calls(id) ON DELETE CASCADE,
      FOREIGN KEY (retrieval_query_id) REFERENCES retrieval_trace(id) ON DELETE SET NULL
    );

    INSERT INTO memory_provenance_new
      SELECT id, session_id, tool_call_id, memory_scope, memory_name,
             surface, retrieval_query_id, position_in_corpus,
             memory_content_hash, memory_state_at_exposure, created_at
      FROM memory_provenance;

    DROP TABLE memory_provenance;
    ALTER TABLE memory_provenance_new RENAME TO memory_provenance;

    CREATE INDEX idx_memory_provenance_session_created
      ON memory_provenance(session_id, created_at DESC, id DESC);

    CREATE INDEX idx_memory_provenance_session_scope_name_created
      ON memory_provenance(session_id, memory_scope, memory_name, created_at DESC, id DESC);

    CREATE INDEX idx_memory_provenance_tool_call
      ON memory_provenance(tool_call_id)
      WHERE tool_call_id IS NOT NULL;

    CREATE INDEX idx_memory_provenance_retrieval
      ON memory_provenance(retrieval_query_id)
      WHERE retrieval_query_id IS NOT NULL;
  `,
} as const;
