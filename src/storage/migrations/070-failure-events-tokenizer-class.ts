// Migration 070: widen `failure_events.classe` CHECK constraint to
// accept 'tokenizer'.
//
// ────────────────────────────────────────────────────────────────────
// WHY THIS MIGRATION EXISTS
//
// Commit 0cc9021 added the `tokenizer` failure class + two codes
// (`tokenizer.discrepancy.input`, `tokenizer.discrepancy.output`)
// to the TS vocabulary in `src/failures/codes.ts`, but the
// DB-level CHECK constraint in migration 041 was authored before
// the class existed and lists only the original 10 values:
//
//   CHECK (classe IN ('provider','tool','sandbox','permission',
//                     'subagent','parse','mcp','storage','bootstrap',
//                     'compliance'))
//
// Result: every `tokenizer.discrepancy.*` emit hits the CHECK and
// throws — the harness's best-effort try/catch swallows it but
// stderr fills with `CHECK constraint failed` for every step where
// the local estimate diverges >10% from the billed count. Operator
// observed this in real session footer / scrollback context.
//
// ────────────────────────────────────────────────────────────────────
// REBUILD PATTERN
//
// SQLite has no `ALTER TABLE ... ALTER COLUMN` for CHECK constraints
// (sqlite.org/lang_altertable). Standard workaround: build a NEW
// table with the relaxed constraint, copy rows over, drop the old,
// rename. We preserve every persisted column verbatim — the chain
// hashes are content-addressed by `canonicalize(row)` (§4.2 spec),
// so rebuilt rows hash identically to originals as long as we don't
// edit values during copy.
//
// PRAGMA foreign_keys=OFF wrapping the rebuild is the documented
// SQLite pattern; the migrator runs in a transaction so the OFF /
// ON pair survives even on a mid-rebuild abort.
//
// (Operational note, kept as audit trail: the migrator wraps each
// migration in `db.transaction()` where PRAGMA foreign_keys is a
// documented no-op. The lines are kept in the SQL anyway —
// migrations are byte-immutable once any operator has applied them
// per `feedback_never_edit_migration`. Removing or rewording the
// SQL retroactively trips the `_migrations.hash` integrity check
// at the next boot. No table currently has an FK INTO
// failure_events, so the no-op PRAGMAs are also semantically
// harmless even if a future SQLite refactored the migrator out of
// its transaction.)
//
// Indexes are recreated post-rename because dropping the table
// drops the indexes; they're listed verbatim from migration 041 +
// any subsequent that touched the table (currently none).

export const migration070FailureEventsTokenizerClass = {
  id: 70,
  name: '070-failure-events-tokenizer-class',
  sql: `
    PRAGMA foreign_keys=OFF;

    CREATE TABLE failure_events_new (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL,
      step_id         TEXT,
      code            TEXT NOT NULL,
      classe          TEXT NOT NULL
                        CHECK (classe IN (
                          'provider','tokenizer','tool','sandbox','permission',
                          'subagent','parse','mcp','storage','bootstrap','compliance'
                        )),
      recovery_action TEXT NOT NULL,
      user_visible    INTEGER NOT NULL CHECK (user_visible IN (0, 1)),
      payload_json    TEXT,
      created_at      INTEGER NOT NULL,
      prev_chain_hash TEXT NOT NULL,
      this_chain_hash TEXT NOT NULL UNIQUE
    );

    INSERT INTO failure_events_new
      (id, session_id, step_id, code, classe, recovery_action,
       user_visible, payload_json, created_at,
       prev_chain_hash, this_chain_hash)
    SELECT id, session_id, step_id, code, classe, recovery_action,
           user_visible, payload_json, created_at,
           prev_chain_hash, this_chain_hash
      FROM failure_events;

    DROP TABLE failure_events;
    ALTER TABLE failure_events_new RENAME TO failure_events;

    CREATE INDEX idx_failure_events_code    ON failure_events(code, created_at DESC);
    CREATE INDEX idx_failure_events_session ON failure_events(session_id, created_at DESC);

    PRAGMA foreign_keys=ON;
  `,
} as const;
