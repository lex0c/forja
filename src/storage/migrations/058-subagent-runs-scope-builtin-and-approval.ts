// subagent_runs scope widening + parent_approval_id (R3, round-2
// review B-CRIT-2 / B-HIGH-4 / B-HIGH-6).
//
// ────────────────────────────────────────────────────────────────────
// WHAT THIS MIGRATION DOES
//
// (1) `subagent_runs.scope` CHECK pre-dates the `builtin` scope
// introduced in S11. Every builtin spawn was recorded as `'user'` via
// a runtime mapping at insert time — forensic queries that filter
// "what definition shipped vs. what the operator authored" could not
// distinguish them, contradicting the AUDIT.md §0 ground-truth
// invariant. The runtime mapping is removed in the same slice; the
// CHECK now admits the third value the loader actually produces.
//
// (2) `subagent_runs` lacked the spec-prescribed back-pointer to the
// approval row that authorized the spawn (PERMISSION_ENGINE.md
// §10.2). The forensic chain "subagent run → approval → tool call →
// message" required a multi-hop traversal via `sessions.parent_
// session_id` + `messages.tool_call_id` + `tool_calls.id` →
// `approvals.tool_call_id`. The hop chain was fragile under retention
// sweeps and outright impossible for the verify-semantic scheduler
// path (which has no `tool_call` in the chain at all — see R3
// `verify-semantic-scheduler` synthetic approval emission).
//
// SQLite cannot ALTER an existing CHECK constraint in place, and the
// FK addition is best landed in the same table-rebuild rather than
// chained as two separate swaps. Combined into a single migration.
//
// ────────────────────────────────────────────────────────────────────
// KNOWN ISSUE — preserved for append-only discipline
//
// This migration originally severed `memory_verify_attempts.subagent_
// run_session_id` pointers on DBs that had pre-existing rows: the
// rebuild's `DROP TABLE subagent_runs` runs with PRAGMA foreign_
// keys=ON (migrate.ts wraps each migration in a transaction; SQLite
// ignores `PRAGMA foreign_keys=OFF` emitted inside a transaction),
// so the drop fires `ON DELETE SET NULL` on every referring row in
// `memory_verify_attempts` BEFORE the new table is repopulated. The
// dedup cache pointers to the audit rows are lost for any session
// that was active when this migration first ran.
//
// The fix WAS attempted by editing this migration's SQL to snapshot
// the FK pointers into a TEMP table before the drop — but that
// violates CLAUDE.md's hard rule "Append-only everywhere": editing
// a migration that has already been applied to ANY DB produces a
// hash mismatch and a refusal-to-proceed in `migrate.ts`, breaking
// every existing operator install. The edit was reverted.
//
// The correct fix lives in a SEPARATE migration that runs AFTER 058
// (see `059-subagent-runs-fk-preservation.ts`). The data loss for
// pre-058 rows is unrecoverable (NULL values can't be reconstructed),
// but the discipline for future subagent_runs rebuilds is now
// codified in 059's commentary as a binding pattern.
//
// ────────────────────────────────────────────────────────────────────
// REBUILD SHAPE
//
// 1. CREATE TABLE subagent_runs_new with:
//    - widened scope CHECK including `'builtin'`
//    - new `parent_approval_id TEXT` column NULL-allowed (ON DELETE
//      SET NULL preserves the row when the approval is retention-
//      swept; verify-semantic synthetic approvals or programmatic
//      callers without an approval surface continue to land rows)
//    - every other column carried verbatim from the post-040 shape
//      (012 base + 015 / 020 / 024 / 025 / 026 / 027 / 028 / 040)
// 2. INSERT … SELECT from the old table; `parent_approval_id` stays
//    NULL for every pre-existing row (the chain was unrecoverable).
// 3. DROP old table.
// 4. RENAME new → subagent_runs.
// 5. Recreate the (name, captured_at DESC) index and add a
//    (parent_approval_id) index for the new chain query.

export const migration058SubagentRunsScopeBuiltinAndApproval = {
  id: 58,
  name: '058-subagent-runs-scope-builtin-and-approval',
  sql: `
    CREATE TABLE subagent_runs_new (
      session_id            TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      name                  TEXT NOT NULL,
      scope                 TEXT NOT NULL CHECK (scope IN ('user','project','builtin')),
      source_path           TEXT NOT NULL,
      source_sha256         TEXT NOT NULL,
      system_prompt         TEXT NOT NULL,
      tools_whitelist       TEXT NOT NULL,
      budget_max_steps      INTEGER NOT NULL,
      budget_max_cost_usd   REAL NOT NULL,
      budget_max_wall_ms    INTEGER,
      captured_at           INTEGER NOT NULL,
      policy_snapshot       TEXT NOT NULL DEFAULT '{}',
      hooks_snapshot        TEXT,
      tool_restrictions     TEXT,
      sampling              TEXT,
      reference_paths       TEXT,
      output_schema         TEXT,
      context_recipe        TEXT,
      effective_capabilities TEXT,
      parent_approval_id    TEXT REFERENCES approvals(id) ON DELETE SET NULL
    );

    INSERT INTO subagent_runs_new (
      session_id, name, scope, source_path, source_sha256,
      system_prompt, tools_whitelist,
      budget_max_steps, budget_max_cost_usd, budget_max_wall_ms,
      captured_at, policy_snapshot, hooks_snapshot, tool_restrictions,
      sampling, reference_paths, output_schema, context_recipe,
      effective_capabilities, parent_approval_id
    )
    SELECT
      session_id, name, scope, source_path, source_sha256,
      system_prompt, tools_whitelist,
      budget_max_steps, budget_max_cost_usd, budget_max_wall_ms,
      captured_at, policy_snapshot, hooks_snapshot, tool_restrictions,
      sampling, reference_paths, output_schema, context_recipe,
      effective_capabilities, NULL
    FROM subagent_runs;

    DROP TABLE subagent_runs;
    ALTER TABLE subagent_runs_new RENAME TO subagent_runs;

    CREATE INDEX idx_subagent_runs_name_captured
      ON subagent_runs(name, captured_at DESC);

    CREATE INDEX idx_subagent_runs_parent_approval
      ON subagent_runs(parent_approval_id);
  `,
} as const;
