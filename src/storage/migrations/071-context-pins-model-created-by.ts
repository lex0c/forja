// context_pins.created_by — add 'model' (direct model-created pins).
//
// The pin_context tool was reworked from a modal-confirmed proposal
// ("model proposes, operator approves") into a direct, always-available
// tool (like the todolist): the model creates pins itself, no modal. The
// honest created_by for those rows is therefore 'model', not the old
// 'model_proposed_user_approved' — which asserted an approval that no
// longer happens. SQLite can't ALTER a CHECK, so the table is recreated
// (same recreate-with-FK pattern as migration 058).
//
// 'model_proposed_user_approved' is kept in the CHECK as a LEGACY value:
// the modal flow never shipped, so no row carries it, but keeping it
// avoids any copy failure and keeps older tests/fixtures valid. New pins
// from the tool use 'model'; /pin (operator) still uses 'user'.

export const migration071ContextPinsModelCreatedBy = {
  id: 71,
  name: '071-context-pins-model-created-by',
  sql: `
    CREATE TABLE context_pins_new (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      text            TEXT NOT NULL CHECK (length(text) <= 500),
      kind            TEXT NOT NULL
                        CHECK (kind IN ('constraint', 'workflow', 'invariant', 'reminder')),
      created_at      INTEGER NOT NULL,
      created_by      TEXT NOT NULL
                        CHECK (created_by IN ('user', 'model_proposed_user_approved', 'model')),
      expires_at      INTEGER,
      source_step_id  TEXT
    );

    INSERT INTO context_pins_new (
      id, session_id, text, kind, created_at, created_by, expires_at, source_step_id
    )
    SELECT
      id, session_id, text, kind, created_at, created_by, expires_at, source_step_id
    FROM context_pins;

    DROP TABLE context_pins;
    ALTER TABLE context_pins_new RENAME TO context_pins;

    CREATE INDEX idx_context_pins_session
      ON context_pins(session_id);

    CREATE INDEX idx_context_pins_session_active
      ON context_pins(session_id, expires_at);
  `,
} as const;
