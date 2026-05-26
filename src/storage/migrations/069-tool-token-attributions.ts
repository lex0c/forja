// Migration 069: `tool_token_attributions` table. Spec:
// `docs/spec/TOKEN_ATTRIBUTION.md` + `AGENTIC_CLI.md §13`.
//
// ────────────────────────────────────────────────────────────────────
// WHY THIS TABLE EXISTS
//
// Per-tool cost attribution closes the last gap from the 3-layer
// token telemetry roadmap. The chip / footer surfaces show what's
// happening RIGHT NOW; this table answers "in this session, which
// tool calls drove the cost?". Operator runs `agent stats --tools`
// post-mortem and sees totals grouped by tool name (bash, read_file,
// grep, task, ...) — the data is the same `tool_use_id` granularity
// the harness already routes, just with token estimates attached.
//
// ────────────────────────────────────────────────────────────────────
// SCHEMA
//
// - session_id            FK with CASCADE — purge a session, drop
//                         attributions. No orphan rows.
// - step_n                Step number within the session loop.
//                         Indexed alongside session_id for the
//                         `agent stats --tools --step N` drill-down.
// - tool_use_id           The provider's correlation id (ULID-shape).
//                         UNIQUE — defends double-INSERT in retry
//                         paths via INSERT OR IGNORE at the writer.
// - tool_name             Indexed alongside session_id for the
//                         "aggregate by tool" query (default view of
//                         `agent stats --tools`).
// - result_input_tokens   Estimated tokens contributed by the
//                         `tool_result` content via
//                         `estimateTextTokensFor(family, content)` —
//                         the same path that feeds the live chip's
//                         `↑ ~N` cell and the tokenizer-discrepancy
//                         detector (TOKEN_TUNING §8.5).
// - call_output_tokens    Estimated tokens the assistant turn spent
//                         emitting the `tool_use` block (name + JSON
//                         args). Same estimator; honest about source.
//                         Spec §1.2 explains why not provider-reported
//                         `usage.output_tokens` (per-message, not
//                         per-block — proportional split would feign
//                         precision).
// - estimated_cost_usd    Optional. Filled by the writer when
//                         provider capabilities are in hand;
//                         left NULL when caller deferred to
//                         on-the-fly compute in the reader.
// - created_at            Epoch ms, Date.now()-shaped. Stamp is at
//                         INSERT time (post-tool-execution).
//
// `UNIQUE(tool_use_id)` is the load-bearing invariant. The writer
// uses `INSERT OR IGNORE`, so a retry path that re-enters the
// capture site for the same call is silently a no-op — first
// emission wins. Without UNIQUE, retry paths would silently
// double-count.
//
// Append-only (§0 princípio 7): no UPDATE / DELETE in the writer
// surface. Schema doesn't enforce that via trigger today — the
// repo module is the boundary.

export const migration069ToolTokenAttributions = {
  id: 69,
  name: '069-tool-token-attributions',
  sql: `
    CREATE TABLE tool_token_attributions (
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
      UNIQUE(tool_use_id)
    );

    CREATE INDEX idx_tool_token_attributions_session_step
      ON tool_token_attributions(session_id, step_n);
    CREATE INDEX idx_tool_token_attributions_session_tool
      ON tool_token_attributions(session_id, tool_name);
  `,
} as const;
