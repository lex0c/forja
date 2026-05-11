// policy_archive — PERMISSION_ENGINE.md §17 prerequisite.
//
// Stores the canonical JSON bytes of every policy the engine ever
// booted with, indexed by hash. Future replay modes
// (`--against-current-policy`, `--without-classifier`,
// `permission diff <id1> <id2>`) reconstruct the original policy
// from its hash by reading `canonical_json` here, parsing it back,
// and re-executing the decision pipeline against it.
//
// Why a separate table instead of inlining bytes into approvals_log:
// the same policy hash usually applies to thousands of audit rows
// (every decision under one boot uses the same policy_hash). Storing
// the bytes once per UNIQUE hash keeps the audit table lean and
// the canonical bytes themselves de-duplicated automatically.
//
// Write path:
//   bootstrap-engine.ts → archivePolicy(db, { hash, canonical, now })
//   once per engine boot, AFTER the engine is constructed and the
//   state machine has settled into `ready` / `degraded`. The
//   `refusing` branch deliberately skips the archive — an engine
//   that never accepted decisions has no replayable history.
//
// Read path:
//   getPolicyArchive(db, hash) → canonical_json string or null.
//   Caller does JSON.parse to recover the Policy object; round-trip
//   determinism (canonicalHash(parsed) === hash) is the invariant
//   tests pin.
//
// Upsert semantics: identical hashes (same policy boot-after-boot)
// only update `last_seen_ms`. `first_seen_ms` is immutable per
// hash so retention queries can show "how long has this policy
// been in use".

export const migration037PolicyArchive = {
  id: 37,
  name: '037-policy-archive',
  sql: `
    CREATE TABLE policy_archive (
      policy_hash    TEXT PRIMARY KEY,
      canonical_json TEXT NOT NULL,
      first_seen_ms  INTEGER NOT NULL,
      last_seen_ms   INTEGER NOT NULL
    );

    CREATE INDEX idx_policy_archive_last_seen
      ON policy_archive(last_seen_ms);
  `,
} as const;
