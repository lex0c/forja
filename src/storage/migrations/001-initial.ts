export const migration001Initial = {
  id: 1,
  name: '001-initial',
  sql: `
    CREATE TABLE sessions (
      id              TEXT PRIMARY KEY,
      started_at      INTEGER NOT NULL,
      ended_at        INTEGER,
      model           TEXT NOT NULL,
      cwd             TEXT NOT NULL,
      status          TEXT NOT NULL
                        CHECK (status IN ('running','done','interrupted','exhausted','error')),
      total_cost_usd  REAL NOT NULL DEFAULT 0
    );

    CREATE INDEX idx_sessions_started_at      ON sessions(started_at DESC);
    CREATE INDEX idx_sessions_cwd_started     ON sessions(cwd, started_at DESC);
    CREATE INDEX idx_sessions_status_started  ON sessions(status, started_at DESC);

    CREATE TABLE messages (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      parent_id       TEXT REFERENCES messages(id),
      role            TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
      content         TEXT NOT NULL,
      tokens_in       INTEGER,
      tokens_out      INTEGER,
      cached_tokens   INTEGER,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX idx_messages_session_created ON messages(session_id, created_at);

    CREATE TABLE tool_calls (
      id              TEXT PRIMARY KEY,
      message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      tool_name       TEXT NOT NULL,
      input           TEXT NOT NULL,
      output          TEXT,
      status          TEXT NOT NULL
                        CHECK (status IN ('pending','running','done','error','denied')),
      duration_ms     INTEGER,
      error           TEXT,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX idx_tool_calls_name_status     ON tool_calls(tool_name, status);
    CREATE INDEX idx_tool_calls_message_created ON tool_calls(message_id, created_at);
  `,
} as const;
