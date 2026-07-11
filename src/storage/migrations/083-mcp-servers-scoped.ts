export const migration083McpServersScoped = {
  id: 83,
  name: '083-mcp-servers-scoped',
  // Scope MCP state + history by PROJECT (AUDIT §1.5). `sessions.db` is
  // user-global, but project MCP config is per-repo, so keying `mcp_servers` by
  // `name` alone makes a common name (`db`, `postgres`) COLLIDE across repos:
  // approving repo B's server overwrites repo A's identity row + cached trust, so
  // A re-prompts / fails closed on its next run despite a prior approval. Add a
  // `scope` column and re-key on `(scope, name)` — `scope` = the project root for
  // project servers, `''` (global) for `user` servers (shared across repos).
  //
  // `mcp_servers` needs a composite PRIMARY KEY, which SQLite can't ALTER in
  // place — rebuild the table (create → copy → drop → rename). Existing rows get
  // `scope = ''`; a project server re-confirms its identity through the trust gate
  // on the next boot (this is the still-unreleased feat/mcp — no operator data to
  // preserve). `mcp_manifest_history` only needs the column + its indexes re-keyed.
  // Runs inside the migration transaction (migrate.ts), so the rebuild is atomic.
  sql: `
    CREATE TABLE mcp_servers_scoped (
      scope                 TEXT NOT NULL DEFAULT '',
      name                  TEXT NOT NULL,
      transport             TEXT NOT NULL CHECK (transport IN ('stdio','sse','http')),
      command               TEXT,
      url                   TEXT,
      source                TEXT NOT NULL,
      state                 TEXT NOT NULL CHECK (state IN (
                              'disconnected','handshaking','trust_pending',
                              'trusted','active','degraded','denied','error'
                            )),
      current_manifest_hash TEXT,
      protocol_version      TEXT,
      server_version        TEXT,
      last_connected_at     INTEGER,
      last_error            TEXT,
      revoked_at            INTEGER,
      total_calls           INTEGER NOT NULL DEFAULT 0,
      total_tokens_in       INTEGER NOT NULL DEFAULT 0,
      audit_schema_version  INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (scope, name)
    );

    INSERT INTO mcp_servers_scoped
      (scope, name, transport, command, url, source, state, current_manifest_hash,
       protocol_version, server_version, last_connected_at, last_error, revoked_at,
       total_calls, total_tokens_in, audit_schema_version)
    SELECT '', name, transport, command, url, source, state, current_manifest_hash,
           protocol_version, server_version, last_connected_at, last_error, revoked_at,
           total_calls, total_tokens_in, audit_schema_version
    FROM mcp_servers;

    DROP TABLE mcp_servers;
    ALTER TABLE mcp_servers_scoped RENAME TO mcp_servers;

    ALTER TABLE mcp_manifest_history ADD COLUMN scope TEXT NOT NULL DEFAULT '';

    DROP INDEX idx_mcp_manifest_unique;
    CREATE UNIQUE INDEX idx_mcp_manifest_unique
      ON mcp_manifest_history(scope, server_name, hash);

    DROP INDEX idx_mcp_manifest_decided;
    CREATE INDEX idx_mcp_manifest_decided
      ON mcp_manifest_history(scope, server_name, decided_at DESC);
  `,
} as const;
