// grants — §8 TTL / persisted permission grants per PERMISSION_ENGINE.md.
//
// Distinct from the in-memory session-allow map (which lives in the
// engine for the `session` scope per spec §8). This table covers the
// TWO PERSISTED scope kinds:
//
//   - `pattern:<glob>`  — any tool call matching the glob is grant-
//                          covered. Default TTL 24h, max 30d.
//   - `capability:<cap>+<scope>` — a specific capability tuple is
//                          grant-covered. Default TTL 24h, max 7d.
//
// `session` and `once` scopes do NOT use this table:
//   - `session` lives in the engine's in-memory allowlist; expires
//     with the process.
//   - `once` doesn't need persistence — single use, then forgotten.
//
// Grants survive across sessions but stay per-install (an install_id
// column scopes them so a future multi-install machine can't bleed
// grants between agents). The `revoked_at IS NULL AND expires_at > now`
// predicate filters the live set; the `idx_grants_active` index lets
// the query stay sub-ms even with thousands of historical rows.
//
// CHECK constraints pin the spec's enums:
//   - scope_kind ∈ {pattern, capability}  (`once`/`session` excluded —
//     they're not persisted, and accidentally inserting them would
//     orphan the row).
//   - granted_by ∈ {user, enterprise, project}  (the layer that
//     authorized the grant; the modal layer fills this in based on
//     who approved — typically `user`, but enterprise / project YAML
//     can pre-seed grants via a future config slice).

export const migration039Grants = {
  id: 39,
  name: '039-grants',
  sql: `
    CREATE TABLE grants (
      id              TEXT PRIMARY KEY,
      install_id      TEXT NOT NULL,
      scope_kind      TEXT NOT NULL
                        CHECK (scope_kind IN ('pattern','capability')),
      scope_value     TEXT NOT NULL,
      capability      TEXT NOT NULL,
      granted_at      INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL,
      granted_by      TEXT NOT NULL
                        CHECK (granted_by IN ('user','enterprise','project')),
      granted_reason  TEXT,
      revoked_at      INTEGER,
      revoked_reason  TEXT
    );

    CREATE INDEX idx_grants_install ON grants(install_id);
    CREATE INDEX idx_grants_active ON grants(install_id, revoked_at, expires_at);
  `,
} as const;
