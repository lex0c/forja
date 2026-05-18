// Backfill `memory_verify_attempts.provenance_drift_at` for rows
// whose `subagent_run_session_id` is NULL at the moment this
// migration runs (review follow-up to 059).
//
// ────────────────────────────────────────────────────────────────────
// WHY THIS MIGRATION EXISTS
//
// Migration 059 added the `provenance_drift_at` column intending it
// as a forensic discriminator: "did this NULL pointer come from
// migration 058's silent severing, or was it always NULL?" But 059
// only added the column — it never UPDATEd existing rows. Result:
// every pre-existing NULL-pointer row stayed indistinguishable from
// any future NULL-pointer row, defeating 059's stated purpose.
//
// The natural impulse — edit 059 to add an UPDATE — violates
// CLAUDE.md's append-only rule (every install that already applied
// 059 would hit a hash mismatch). The fix lives here, in a fresh
// migration that runs AFTER 059.
//
// ────────────────────────────────────────────────────────────────────
// WHAT THIS MIGRATION DOES
//
// Single UPDATE: every row in `memory_verify_attempts` whose
// `subagent_run_session_id IS NULL` AND `provenance_drift_at IS
// NULL` at migration time gets `provenance_drift_at` set to the
// epoch-ms moment the migration runs (SQLite `strftime('%s', 'now')
// * 1000` — accurate to the second; ms granularity isn't needed for
// a one-shot historical marker).
//
// ────────────────────────────────────────────────────────────────────
// SEMANTIC HONESTY
//
// The backfill cannot tell apart two real cases:
//   (a) the row pre-dated 058 and had a session pointer that 058's
//       DROP TABLE silently SET NULL,
//   (b) the row pre-dated 060 with a genuinely-absent pointer
//       (spawn failed before subagent_runs landed, programmatic
//       caller that doesn't model the session id, etc.).
//
// Both classes get the SAME marker. The column name
// (`provenance_drift_at`) admits this — it doesn't say "severed",
// it says "drifted" (the row's provenance is no longer
// reconstructable from the FK alone). Operators triaging post-060
// should:
//
//   - Treat `provenance_drift_at IS NOT NULL` as "pointer is gone,
//     don't try to JOIN; correlate by timestamp instead
//     (memory_verify_attempts.attempted_at against
//     subagent_runs.captured_at)".
//   - Trust `provenance_drift_at IS NULL` on rows INSERTed after
//     this migration as the absence-of-pointer being intentional
//     in the runtime path.
//
// ────────────────────────────────────────────────────────────────────
// IDEMPOTENCY
//
// The UPDATE filters on `provenance_drift_at IS NULL` so re-running
// it (e.g. an operator manually re-issuing migrations after a
// restore) doesn't overwrite values already set. SQLite migrations
// run exactly once per id per DB so this is belt-and-suspenders.

export const migration060MemoryVerifyAttemptsBackfillDrift = {
  id: 60,
  name: '060-memory-verify-attempts-backfill-drift',
  sql: `
    UPDATE memory_verify_attempts
       SET provenance_drift_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
     WHERE subagent_run_session_id IS NULL
       AND provenance_drift_at IS NULL;
  `,
} as const;
