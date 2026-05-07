export const migration026SubagentRunsReferences = {
  id: 26,
  name: '026-subagent-runs-references',
  // Per-playbook reference paths (`PLAYBOOKS.md` §1.1). The
  // loader normalizes the YAML `references: [path]` into a
  // string array (slice 1); `runSubagent` snapshots it into this
  // column so the subprocess child appends a "References (read on
  // demand)" block to its system prompt — telling the model
  // which docs to consult via `read_file`, NOT embedding them
  // eagerly.
  //
  // Same drift-prevention story as the other snapshots
  // (policy_snapshot 015 / hooks_snapshot 020 /
  // tool_restrictions 024 / sampling 025): the parent committed
  // the path list at spawn, the child sees exactly that list.
  //
  // Column name avoids SQL reserved word `REFERENCES` (foreign-
  // key syntax). SQLite tolerates the literal in column position
  // when quoted, but unquoted DDL would silently parse as a
  // foreign-key clause and fail in confusing ways. `reference_paths`
  // is unambiguous.
  //
  // Storage as TEXT (JSON-serialized string[]). NULL = no
  // snapshot taken (legacy row, definition without references).
  // `'[]'` = snapshot taken but empty (author declared an empty
  // list deliberately) — same runtime effect as null but
  // distinguishable in audit.
  sql: `
    ALTER TABLE subagent_runs
      ADD COLUMN reference_paths TEXT;
  `,
} as const;
