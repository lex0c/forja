// approval_call_links — PERMISSION_ENGINE.md §17 prerequisite for
// re-execution-based replay modes.
//
// The audit row in `approvals_log` carries `args_hash` (not args
// raw — PII/secret hygiene per spec §7.1). Raw args live in
// `tool_calls.input` (session SQLite, TTL by session retention).
// For replay modes like `--against-current-policy` to re-execute
// the decision pipeline deterministically, they need to recover
// args raw from the matching tool_calls row.
//
// `args_hash` alone is NOT a sound lookup key — two distinct
// tool_calls with identical args (e.g. the model called `ls` twice
// with the same path) produce the same hash; replay would resolve
// ambiguously. This table records the direct (approval_seq →
// tool_call_id) edge that the harness already has at decision time
// (it computes the audit row's seq from the sink's emit return,
// AND creates the tool_calls row in the same transaction).
//
// Why a separate table instead of adding `tool_call_id` directly
// to `approvals_log`: the column would enter the canonical hash
// payload (`PERSISTED_COLUMNS` in approvals-log.ts), which would
// invalidate every existing `this_hash` value on the chain — a
// global chain break on the migration. Auxiliary table is OUTSIDE
// the chain: row content is byte-stable across this migration's
// addition.
//
// PRIMARY KEY on approval_seq: `approvals_log.seq` is AUTOINCREMENT
// (globally unique within an install's DB), so a single column is
// sufficient. The reverse index lets lookups by tool_call_id stay
// O(log n) for forensic tooling that walks from tool execution
// backwards to the gating decision.

export const migration038ApprovalCallLinks = {
  id: 38,
  name: '038-approval-call-links',
  sql: `
    CREATE TABLE approval_call_links (
      approval_seq INTEGER PRIMARY KEY,
      tool_call_id TEXT NOT NULL
    );

    CREATE INDEX idx_approval_call_links_tool_call
      ON approval_call_links(tool_call_id);
  `,
} as const;
