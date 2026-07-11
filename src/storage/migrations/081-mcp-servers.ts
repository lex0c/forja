// mcp_servers + mcp_manifest_history — MCP client subsystem state +
// trust history, per AUDIT.md §1.5 and MCP.md §9.1. First storage slice
// of the MCP subsystem (the spec's single declared tool-catalog
// extension path, CONTRACTS §2.6.7).
//
// Two tables, two lifetimes:
//
//   mcp_servers — ONE row per configured server name (PRIMARY KEY
//   `name`). MUTABLE: `state` walks the STATE_MACHINE §6.5 machine
//   (disconnected → handshaking → trust_pending → trusted → active →
//   degraded, plus denied/error); counters accumulate. Retained while
//   the server is in config; removed by `forja gc` when it leaves
//   config — exceptional for an audit table because it is STATE, not
//   history (AUDIT §1.5). UPDATE is allowed on state / manifest hash /
//   protocol+server version / last_connected_at / last_error /
//   counters; `name`, `transport`, `command`, `url`, `source` are
//   immutable (a transport/command change is remove + insert, per
//   spec). `state` + `transport` are CHECK-constrained at the DB layer
//   — same defensive pattern as failure_events.classe (migration 041):
//   a new state/transport = ALTER in a successor migration, forcing an
//   explicit PR. `source` is intentionally un-CHECKed (matches the
//   authored AUDIT §1.5 schema; the writer constrains the vocabulary
//   'user' | 'project_shared' | 'project_local').
//
//   mcp_manifest_history — APPEND-ONLY, FOREVER retention (like
//   prompt_versions, migration 068). One row per (server, manifest
//   hash) trust decision. `manifest_json` is the canonical content that
//   was hashed; `decision` records the outcome. This is the
//   defense-in-depth audit lane behind adversarial.mcp_server.changed_
//   manifest (FAILURE_MODES §14.2): every hash the operator ever saw,
//   with the decision, kept forever. The `forja gc` retention sweep
//   MUST skip this table (no prune primitive is exported below).
//
// Env-value redaction (AUDIT §1.5) is a WRITER-layer concern, not a
// schema one: the writer substitutes ${VAR_NAME} for resolved secrets
// in `command` before persist; `url` is stored literal (expected
// public). The schema carries no secret material of its own.

export const migration081McpServers = {
  id: 81,
  name: '081-mcp-servers',
  sql: `
    CREATE TABLE mcp_servers (
      name                  TEXT PRIMARY KEY,
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
      total_calls           INTEGER NOT NULL DEFAULT 0,
      total_tokens_in       INTEGER NOT NULL DEFAULT 0,
      audit_schema_version  INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE mcp_manifest_history (
      id                    INTEGER PRIMARY KEY,
      server_name           TEXT NOT NULL,
      hash                  TEXT NOT NULL,
      previous_hash         TEXT,
      manifest_json         TEXT NOT NULL,
      protocol_version      TEXT NOT NULL,
      server_version        TEXT,
      decision              TEXT NOT NULL CHECK (decision IN (
                              'granted','denied','revoked','superseded'
                            )),
      decided_by            TEXT NOT NULL,
      decided_at            INTEGER NOT NULL,
      approval_id           INTEGER,
      audit_schema_version  INTEGER NOT NULL DEFAULT 1
    );

    CREATE UNIQUE INDEX idx_mcp_manifest_unique
      ON mcp_manifest_history(server_name, hash);

    CREATE INDEX idx_mcp_manifest_decided
      ON mcp_manifest_history(server_name, decided_at DESC);
  `,
} as const;
