// subagent_runs scope widening + parent_approval_id (R3, round-2
// review B-CRIT-2 / B-HIGH-4 / B-HIGH-6).
//
// ────────────────────────────────────────────────────────────────────
// WHY THIS MIGRATION
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
// REBUILD SHAPE
//
// The wrinkle: `migrate.ts` runs every migration inside a single
// `db.transaction(...)` block, AND `db.ts` keeps `PRAGMA
// foreign_keys = ON`. SQLite ignores `PRAGMA foreign_keys = OFF`
// emitted from inside a transaction (silent no-op per docs), so the
// usual "disable FK around the rebuild" trick is unavailable.
//
// Consequence: `DROP TABLE subagent_runs` with FK ON triggers the
// `ON DELETE SET NULL` on `memory_verify_attempts.subagent_run_
// session_id` for every referring row — silently severing the
// forensic chain from the dedup cache to the audit row. The fresh
// table is repopulated, but the references in `memory_verify_attempts`
// are gone.
//
// Fix: snapshot the (mva.id, mva.subagent_run_session_id) tuples
// into a TEMP table BEFORE the drop, then UPDATE them back AFTER
// the rename. Since we copy every subagent_runs row into the new
// table verbatim (session_id is preserved as the PK), the restored
// FK targets exist; no orphans.
//
// Steps:
// 1. CREATE TEMP TABLE mva_fk_snapshot — save the FK pointers.
// 2. CREATE TABLE subagent_runs_new with widened scope CHECK +
//    new `parent_approval_id` column (ON DELETE SET NULL).
// 3. INSERT … SELECT from the old table; `parent_approval_id`
//    NULL for every pre-existing row (the chain was unrecoverable).
// 4. DROP old table — FK SET NULL fires on memory_verify_attempts,
//    but the snapshot has the original pointers.
// 5. RENAME new → subagent_runs.
// 6. UPDATE memory_verify_attempts restoring the FK pointers from
//    the snapshot.
// 7. DROP TEMP TABLE.
// 8. Recreate the (name, captured_at DESC) index and add a
//    (parent_approval_id) index for the new chain query.
//
// FK target: `approvals(id)`. ON DELETE SET NULL — an approval purge
// keeps the run row intact (the run was real; the approval lineage
// is just no longer reachable). The FK is unenforced for rows where
// `parent_approval_id` is NULL, which is the legacy path for
// fixtures + the verify-semantic synthetic-approval bypass when
// disabled.

export const migration058SubagentRunsScopeBuiltinAndApproval = {
  id: 58,
  name: '058-subagent-runs-scope-builtin-and-approval',
  sql: `
    CREATE TEMP TABLE mva_fk_snapshot AS
      SELECT id, subagent_run_session_id
        FROM memory_verify_attempts
       WHERE subagent_run_session_id IS NOT NULL;

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

    UPDATE memory_verify_attempts
       SET subagent_run_session_id = (
         SELECT s.subagent_run_session_id
           FROM mva_fk_snapshot s
          WHERE s.id = memory_verify_attempts.id
       )
     WHERE id IN (SELECT id FROM mva_fk_snapshot);

    DROP TABLE mva_fk_snapshot;

    CREATE INDEX idx_subagent_runs_name_captured
      ON subagent_runs(name, captured_at DESC);

    CREATE INDEX idx_subagent_runs_parent_approval
      ON subagent_runs(parent_approval_id);
  `,
} as const;
