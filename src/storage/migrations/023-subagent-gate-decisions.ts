export const migration023SubagentGateDecisions = {
  id: 23,
  name: '023-subagent-gate-decisions',
  // Persistence layer for pre-spawn refusals (spec
  // ORCHESTRATION.md §3.5, audit fix #3). When `task_async`
  // refuses a spawn at its pre-flight gate (or the dispatcher
  // refuses for `task` / `task_sync`), the refusal lives only
  // in the resulting `tool_result` block of the assistant
  // turn — recoverable via JSON scan over `messages.content`
  // but unwieldy for queries like "how often did we hit the
  // budget cap last week?" or "which subagent typos did the
  // model retry into?".
  //
  // This table captures every gate-level "no" with first-class
  // columns so postmortem queries can run plain SQL. The three
  // refusal kinds map to discriminated columns of the
  // `SpawnSubagentResult` discriminated union:
  //
  //   - `budget_exhausted`: cumulative cost projection would
  //     cross `maxCostUsd`. Details carry `spent`, `estimate`,
  //     `projected`, `cap` (matching the envelope shape).
  //   - `unknown_subagent`: caller passed a subagent name that
  //     doesn't resolve. Details carry `available[]` (the
  //     sorted list of registered names at decision time).
  //   - `depth_exceeded`: would-be spawn would nest past
  //     MAX_SUBAGENT_DEPTH. Details carry `depth`, `max_depth`.
  //
  // Schema decisions:
  //   - `decision_type` is a closed enum via CHECK so a future
  //     refusal kind doesn't silently land as a free string.
  //     Adding a new kind requires a new migration that ALTERs
  //     the constraint — small but intentional friction.
  //   - `tool_name` distinguishes `task` (sync), `task_sync`
  //     (alias), and `task_async`. Lets analytics tell apart
  //     "the model tried the sync path and got blocked" from
  //     "the async path's pre-flight caught it" — useful for
  //     understanding model behavior across surfaces.
  //   - `requested_name` denormalized off the call site so a
  //     "show every typo of `explorer`" query doesn't have to
  //     parse JSON.
  //   - `details` is JSON. Per-kind shape is documented in the
  //     repo type definitions; the column itself is opaque
  //     TEXT so future kinds can carry their own fields
  //     without schema churn.
  //   - `decided_at` ms epoch from `Date.now()` — same
  //     convention as `subagent_handles.created_at`.
  //
  // FK CASCADE on `parent_session_id`: dropping a session
  // reaps its gate decisions, same lifecycle as
  // `subagent_handles` and `cost_progress_events`.
  //
  // Index on `parent_session_id, decided_at` for the typical
  // query "show every refusal in session X in chronological
  // order"; secondary lookups by decision_type don't need an
  // explicit index at v1 cardinality (refusals are rare per
  // session).
  sql: `
    CREATE TABLE subagent_gate_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      decision_type TEXT NOT NULL CHECK (
        decision_type IN ('budget_exhausted', 'unknown_subagent', 'depth_exceeded')
      ),
      tool_name TEXT NOT NULL CHECK (
        tool_name IN ('task', 'task_sync', 'task_async')
      ),
      requested_name TEXT NOT NULL,
      details TEXT NOT NULL,
      decided_at INTEGER NOT NULL
    );
    CREATE INDEX idx_subagent_gate_decisions_parent
      ON subagent_gate_decisions(parent_session_id, decided_at);
  `,
} as const;
