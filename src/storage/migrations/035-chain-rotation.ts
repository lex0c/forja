// approvals_log_archived + chain_meta — PERMISSION_ENGINE.md §7.2
// "Quebra de chain → --rotate-chain". When the operator invokes
// `agent permission rotate-chain`, the current `approvals_log` rows
// for the active install_id are atomically moved to
// `approvals_log_archived` with a rotation_id segment marker, and a
// `chain_meta` row records the forensics (motive, pre-rotation tip,
// quarantine flag).
//
// Design notes:
//   1. Same column shape as `approvals_log` for the archive — a
//      rotated row remains forensically inspectable in its original
//      form. The two extra columns (`archive_rotation_id`,
//      `archived_at_ms`) identify the rotation event.
//   2. `chain_meta` is the system-of-record for "did this install
//      ever rotate?". A fresh install has no rows here; the first
//      rotation inserts rotation_id=1; subsequent rotations
//      auto-increment. The latest row's `quarantined` flag surfaces
//      in `agent permission verify` output until an explicit clear.
//   3. The `quarantined` flag does NOT degrade the engine — spec
//      §7.2 calls it a "quarantine flag em queries até inspeção",
//      i.e. forensic-only. Engine operation continues normally
//      under the new chain.
//   4. Indices: archive table indexed by (install_id, rotation_id)
//      so per-rotation listings stay O(rows-in-segment). chain_meta
//      indexed by (install_id, rotation_id DESC) so the
//      `getLatestChainMeta` lookup is a single index seek even with
//      many rotations on file.

export const migration035ChainRotation = {
  id: 35,
  name: '035-chain-rotation',
  sql: `
    CREATE TABLE approvals_log_archived (
      seq                    INTEGER NOT NULL,
      ts                     INTEGER NOT NULL,
      install_id             TEXT NOT NULL,
      session_id             TEXT NOT NULL,
      parent_approval_id     TEXT,
      tool_name              TEXT NOT NULL,
      tool_version           TEXT NOT NULL,
      resolver_version       TEXT NOT NULL,
      args_hash              TEXT NOT NULL,
      capabilities_json      TEXT NOT NULL,
      decision               TEXT NOT NULL
                                CHECK (decision IN ('allow','deny','confirm','confirm-allowed','confirm-denied')),
      score                  REAL NOT NULL,
      score_components_json  TEXT NOT NULL,
      confidence             TEXT NOT NULL
                                CHECK (confidence IN ('high','medium','low')),
      classifier_hash        TEXT,
      classifier_adjust      REAL,
      policy_hash            TEXT NOT NULL,
      sandbox_profile        TEXT,
      ttl_expires_at         INTEGER,
      reason_chain_json      TEXT NOT NULL,
      prev_hash              TEXT NOT NULL,
      this_hash              TEXT NOT NULL,
      archive_rotation_id    INTEGER NOT NULL,
      archived_at_ms         INTEGER NOT NULL,
      PRIMARY KEY (install_id, archive_rotation_id, seq)
    );

    CREATE INDEX idx_approvals_log_archived_install_rotation
      ON approvals_log_archived(install_id, archive_rotation_id);
    CREATE INDEX idx_approvals_log_archived_archived_at
      ON approvals_log_archived(archived_at_ms);

    CREATE TABLE chain_meta (
      rotation_id              INTEGER PRIMARY KEY AUTOINCREMENT,
      install_id               TEXT NOT NULL,
      rotated_at_ms            INTEGER NOT NULL,
      reason                   TEXT NOT NULL,
      pre_rotation_tip_hash    TEXT NOT NULL,
      pre_rotation_seq_max     INTEGER NOT NULL,
      quarantined              INTEGER NOT NULL DEFAULT 1
                                  CHECK (quarantined IN (0, 1))
    );

    CREATE INDEX idx_chain_meta_install_rotation
      ON chain_meta(install_id, rotation_id DESC);
  `,
} as const;
