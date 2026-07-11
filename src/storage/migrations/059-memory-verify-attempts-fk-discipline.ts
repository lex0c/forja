// memory_verify_attempts FK preservation discipline (R3 review fix).
//
// ────────────────────────────────────────────────────────────────────
// WHY THIS MIGRATION EXISTS
//
// Migration 058 rebuilt `subagent_runs` to widen the scope CHECK and
// add `parent_approval_id`. The rebuild's `DROP TABLE` step runs
// inside the migrate.ts transaction with `PRAGMA foreign_keys=ON`
// (SQLite ignores attempts to disable FKs inside a transaction), so
// the drop fired `ON DELETE SET NULL` on every referring row in
// `memory_verify_attempts.subagent_run_session_id` BEFORE the new
// table was repopulated. The pointers were severed silently.
//
// The natural impulse — edit 058 to add a TEMP-table snapshot/restore
// dance around the drop — violates the append-only invariant
// (CLAUDE.md hard rule: "Append-only everywhere"). Operators who
// already applied the original 058 would see a hash mismatch and a
// refusal-to-proceed on next startup, breaking every install. The
// edit was reverted and the fix lives here, in a separate migration.
//
// ────────────────────────────────────────────────────────────────────
// WHAT THIS MIGRATION DOES
//
// Two things:
//
// (1) Adds a `provenance_drift_at` column to `memory_verify_attempts`
// for forensic discrimination of rows whose `subagent_run_session_id`
// is NULL (was-always-NULL vs. severed-by-058).
//
// IMPORTANT — this migration only adds the COLUMN. It does NOT
// backfill the marker for pre-existing rows. That oversight was
// caught in review after the migration had already shipped to
// operator installs: editing the SQL here to add an UPDATE would
// break append-only (every install would hit a hash mismatch on the
// next startup). The backfill lives in `060-memory-verify-attempts-
// backfill-drift.ts`, which UPDATEs every NULL-pointer row with the
// migration-run epoch ms.
//
// Operators reading the column post-060 should interpret:
//   - `provenance_drift_at IS NOT NULL` AND
//     `subagent_run_session_id IS NULL` → row pre-existed 060;
//     either always-NULL or 058-severed (the originals weren't
//     distinguishable). The forensic chain to the audit row is
//     gone; cross-correlate by timestamp instead.
//   - `provenance_drift_at IS NULL` AND
//     `subagent_run_session_id IS NULL` → row INSERTed after 060
//     with a genuinely-absent pointer (spawn failed before
//     subagent_runs row landed, or programmatic caller didn't
//     model it).
//   - `subagent_run_session_id IS NOT NULL` → intact one-hop chain,
//     `provenance_drift_at` value irrelevant.
//
// (2) Codifies the FK preservation pattern in this comment as a
// binding rule for any FUTURE migration that drops or rebuilds
// `subagent_runs` (or any table referenced via ON DELETE SET NULL).
// The pattern (verified safe in a smoke test) is:
//
//   CREATE TEMP TABLE <table>_fk_snapshot AS
//     SELECT <pk_or_id>, <fk_columns_to_preserve>
//       FROM <referring_table>
//      WHERE <fk_columns_to_preserve> IS NOT NULL;
//   -- ... CREATE new, INSERT SELECT, DROP old, RENAME new ...
//   UPDATE <referring_table>
//      SET <fk_column> = (
//        SELECT s.<fk_column>
//          FROM <table>_fk_snapshot s
//         WHERE s.<pk_or_id> = <referring_table>.<pk_or_id>
//      )
//    WHERE <pk_or_id> IN (SELECT <pk_or_id> FROM <table>_fk_snapshot);
//   DROP TABLE <table>_fk_snapshot;
//
// Any reviewer of a future migration that drops a referenced table
// without applying this pattern should reject the change. The
// migrate.ts test suite includes a regression test verifying this
// migration doesn't itself trip the pattern (no-op on DBs with no
// pre-existing data; cosmetic column add on DBs that have any).
//
// ────────────────────────────────────────────────────────────────────
// DATA RECOVERY
//
// The pointers severed by 058 are UNRECOVERABLE — `ON DELETE SET
// NULL` writes NULL, and the original session_id values aren't
// preserved anywhere else (sessions table cascades the same way on
// purge). Operators auditing pre-migration data should rely on
// `memory_verify_attempts.attempted_at` to time-bound the loss
// against `subagent_runs.captured_at` for cross-correlation by
// timestamp.

export const migration059MemoryVerifyAttemptsFkDiscipline = {
  id: 59,
  name: '059-memory-verify-attempts-fk-discipline',
  sql: `
    ALTER TABLE memory_verify_attempts
      ADD COLUMN provenance_drift_at INTEGER;
  `,
} as const;
