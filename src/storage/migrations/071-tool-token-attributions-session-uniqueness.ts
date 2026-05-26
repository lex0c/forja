// Migration 071: scope `tool_token_attributions.tool_use_id` uniqueness
// to (session_id, tool_use_id) instead of globally.
//
// ────────────────────────────────────────────────────────────────────
// WHY THIS MIGRATION EXISTS
//
// Migration 069 declared `UNIQUE(tool_use_id)` (database-wide) on the
// theory that provider correlation ids are universally unique. They
// aren't, in three realistic scenarios:
//
//   1. Test fixtures / mocked providers commonly use deterministic
//      ids like `toolu_test_1` across many synthetic sessions.
//   2. Eval replay harnesses copy ids verbatim from captured traces;
//      a single trace replayed under multiple session contexts
//      collides.
//   3. Long-running providers can recycle id space across distant
//      sessions (Anthropic ULIDs are quasi-unique within reason
//      but no documented uniqueness guarantee across all time).
//
// Under the global UNIQUE, the second session's
// `appendToolAttribution(... toolUseId: <duplicate> ...)` hits the
// constraint, `INSERT OR IGNORE` silently no-ops with no stderr
// signal, and `agent stats --tools` under-counts that tool's
// calls — silent data loss with no operator-visible trail.
//
// The correct constraint is `(session_id, tool_use_id)` — uniqueness
// per session, which still defends the original use case (retry path
// within ONE session re-entering the capture site for the same call)
// without conflating distinct sessions.
//
// ────────────────────────────────────────────────────────────────────
// REBUILD PATTERN
//
// SQLite doesn't support `ALTER TABLE ... DROP CONSTRAINT`. Same
// rebuild flow as migration 070: create new + INSERT SELECT verbatim
// + DROP old + RENAME + recreate indexes. The table is empty in
// production (069 just shipped on the same branch as 071), so the
// rebuild is effectively a no-op cost-wise. We do it via SQL anyway
// so dev installs that already ran 069 against a populated DB get
// their data carried over cleanly.
//
// No PRAGMA foreign_keys wrap: migrator runs each migration inside
// `db.transaction()` where the PRAGMA is a documented no-op anyway.
// The table has an outbound FK (session_id → sessions.id ON DELETE
// CASCADE); SQLite preserves outbound FK semantics across the
// rebuild because we recreate the column constraint verbatim.

export const migration071ToolTokenAttributionsSessionUniqueness = {
  id: 71,
  name: '071-tool-token-attributions-session-uniqueness',
  sql: `
    CREATE TABLE tool_token_attributions_new (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id            TEXT    NOT NULL
                                      REFERENCES sessions(id) ON DELETE CASCADE,
      step_n                INTEGER NOT NULL,
      tool_use_id           TEXT    NOT NULL,
      tool_name             TEXT    NOT NULL,
      result_input_tokens   INTEGER NOT NULL,
      call_output_tokens    INTEGER NOT NULL,
      estimated_cost_usd    REAL,
      created_at            INTEGER NOT NULL,
      UNIQUE(session_id, tool_use_id)
    );

    INSERT INTO tool_token_attributions_new
      (id, session_id, step_n, tool_use_id, tool_name,
       result_input_tokens, call_output_tokens, estimated_cost_usd, created_at)
    SELECT id, session_id, step_n, tool_use_id, tool_name,
           result_input_tokens, call_output_tokens, estimated_cost_usd, created_at
      FROM tool_token_attributions;

    DROP TABLE tool_token_attributions;
    ALTER TABLE tool_token_attributions_new RENAME TO tool_token_attributions;

    CREATE INDEX idx_tool_token_attributions_session_step
      ON tool_token_attributions(session_id, step_n);
    CREATE INDEX idx_tool_token_attributions_session_tool
      ON tool_token_attributions(session_id, tool_name);
  `,
} as const;
