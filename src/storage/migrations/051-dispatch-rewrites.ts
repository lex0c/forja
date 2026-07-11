// dispatch_rewrites — audit table for L1 alias dispatch rewrites
// (FEEDBACK_ADAPTATION §9.1 + §10.4).
//
// Phase 3.5b wires `maybeRewriteBashCommand` into the harness loop:
// when an active L1 alias policy matches the operator's scope, the
// bash command is rewritten BEFORE the permission engine + tool
// dispatch see it. Without an audit row, the only trace of the
// rewrite is a stderr line — lost on log rotation, non-queryable.
//
// This table closes the gap. Every dispatch rewrite lands a row
// linking the tool_call_id to the policy_id that drove it, plus
// the BEFORE and AFTER command strings. Operators tracing "why
// did my grep become ripgrep?" follow the trail:
//
//   tool_calls.id      → dispatch_rewrites.tool_call_id
//   policy_id          → /agent policy history <id>
//   action_signature   → loop frio context (which signature got
//                         promoted, with what evidence)
//   original_command   → what the model asked for
//   rewritten_command  → what actually ran (matches tool_calls.input)
//   matched_scope      → which level in the scope chain won
//
// Schema rationale:
//
// - `id` (TEXT PRIMARY KEY UUID). Same shape as every other
//   audit-shaped repo.
//
// - `tool_call_id` (TEXT NOT NULL FK CASCADE). Every rewrite
//   maps to exactly one tool_call. CASCADE because rewrites are
//   audit-derived from the call; if the call is purged, the
//   rewrite goes with it.
//
// - `session_id` (TEXT NOT NULL FK CASCADE). Convenience: per-
//   session forensic queries don't need to JOIN through
//   tool_calls. Same CASCADE rule (rewrites are per-session
//   operational signals, not cross-session forensic intent).
//
// - `policy_id` (TEXT NOT NULL). The active policy that drove
//   the rewrite. NO FK to `policies` because policy rows can be
//   invalidated (state→invalidated) post-rewrite — we want the
//   audit row to survive even when the policy is later
//   invalidated. Future hardening: add a partial FK with SET
//   NULL semantics if needed.
//
// - `action_signature` (TEXT NOT NULL). The L1 signature that
//   was resolved (e.g., `alias:grep:ripgrep`). Captured here so
//   queries can `GROUP BY action_signature` without joining
//   policies.
//
// - `original_command`, `rewritten_command` (TEXT NOT NULL).
//   Both stored. Spec §9.1 doesn't strictly require it but
//   forensic queries need both ends of the diff. Size is
//   bounded by the operator's typical bash command length;
//   no truncation here.
//
// - `matched_scope` (TEXT NOT NULL CHECK). 5-element enum
//   matching `policies.scope_kind`.
//
// - `recorded_at` (INTEGER NOT NULL). Epoch ms.
//
// Indices:
//
// - `(tool_call_id)` — "did this tool call get rewritten?" Single-
//   row lookup, but FK-driven cascade also relies on it.
// - `(session_id, recorded_at)` — session timeline view.
// - `(policy_id)` — "what calls did THIS policy rewrite?" for
//   evaluating policy effectiveness from outside the loop frio.

export const migration051DispatchRewrites = {
  id: 51,
  name: '051-dispatch-rewrites',
  sql: `
    CREATE TABLE dispatch_rewrites (
      id                  TEXT PRIMARY KEY,
      tool_call_id        TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
      session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      policy_id           TEXT NOT NULL,
      action_signature    TEXT NOT NULL,
      original_command    TEXT NOT NULL,
      rewritten_command   TEXT NOT NULL,
      matched_scope       TEXT NOT NULL
                            CHECK (matched_scope IN ('global', 'language', 'repo', 'user', 'session')),
      recorded_at         INTEGER NOT NULL
    );

    CREATE INDEX idx_dispatch_rewrites_tool_call
      ON dispatch_rewrites(tool_call_id);

    CREATE INDEX idx_dispatch_rewrites_session
      ON dispatch_rewrites(session_id, recorded_at);

    CREATE INDEX idx_dispatch_rewrites_policy
      ON dispatch_rewrites(policy_id);
  `,
} as const;
