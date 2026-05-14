// Adds `subagent_escalation` to the `subagent_gate_decisions.decision_type`
// CHECK constraint (PERMISSION_ENGINE.md §10.1). When the §10
// intersection guard refuses a spawn because `declared_caps ⊄
// parent_caps`, the audit row carries the `excess` capability
// strings in `details` so postmortem queries can SELECT every
// escalation attempt without JSON-scanning `messages.content`.
//
// SQLite has no `ALTER TABLE ... DROP CHECK`, so the migration
// follows the canonical "create new table, copy, drop old, rename":
//
//   1. CREATE TABLE subagent_gate_decisions_new with the extended
//      CHECK clause.
//   2. INSERT … SELECT every existing row.
//   3. DROP the old table.
//   4. RENAME the new table to the canonical name.
//   5. Recreate the index (DROP-with-table drops the index too).
//
// The schema otherwise matches migration 023 byte-for-byte —
// columns, types, defaults, FK CASCADE. Only the CHECK constraint
// changes.

export const migration036SubagentGateEscalation = {
  id: 36,
  name: '036-subagent-gate-escalation',
  sql: `
    CREATE TABLE subagent_gate_decisions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      decision_type TEXT NOT NULL CHECK (
        decision_type IN (
          'budget_exhausted',
          'unknown_subagent',
          'depth_exceeded',
          'subagent_escalation'
        )
      ),
      tool_name TEXT NOT NULL CHECK (
        tool_name IN ('task', 'task_sync', 'task_async')
      ),
      requested_name TEXT NOT NULL,
      details TEXT NOT NULL,
      decided_at INTEGER NOT NULL
    );

    INSERT INTO subagent_gate_decisions_new (
      id, parent_session_id, decision_type, tool_name,
      requested_name, details, decided_at
    )
    SELECT
      id, parent_session_id, decision_type, tool_name,
      requested_name, details, decided_at
    FROM subagent_gate_decisions;

    DROP TABLE subagent_gate_decisions;
    ALTER TABLE subagent_gate_decisions_new RENAME TO subagent_gate_decisions;

    CREATE INDEX idx_subagent_gate_decisions_parent
      ON subagent_gate_decisions(parent_session_id, decided_at);
  `,
} as const;
