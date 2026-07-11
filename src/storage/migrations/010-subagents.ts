export const migration010Subagents = {
  id: 10,
  name: '010-subagents',
  // Spec §11: subagents run in their own session,
  // isolated context, restricted toolset and budget. The spec defers
  // the inter-process detail to a later step (§11.2 worktree); for
  // now we run subagents in-process but still spawn a fresh session
  // row so the audit trail (messages, tool_calls, costs) for the
  // child is fully separated from the parent — `--list-sessions`,
  // `--resume`, and per-session telemetry keep working unchanged.
  //
  // The link to the parent goes here as a self-referential FK:
  // `parent_session_id` is null for top-level user runs and points
  // at the parent's session id when the row was created via
  // `runSubagent`. ON DELETE SET NULL because losing the parent row
  // (e.g. retention purge) must NOT cascade-delete the child's audit
  // trail — the child's spend already happened and is part of the
  // user's billing history.
  //
  // Index supports two queries:
  // - `--list-sessions --include-subagents`: fan out a parent into
  //   its children sorted by start (newest first).
  // - cost rollup: walk children of a parent to sum spend that
  //   the parent invocation incurred but didn't pay directly.
  sql: `
    ALTER TABLE sessions
      ADD COLUMN parent_session_id TEXT
        REFERENCES sessions(id) ON DELETE SET NULL;

    CREATE INDEX idx_sessions_parent_started
      ON sessions(parent_session_id, started_at DESC);
  `,
} as const;
