// approvals_log — v2 audit ledger per PERMISSION_ENGINE.md §7.1.
//
// Distinct from the v1 `approvals` table (migration 002): that one
// captures the per-tool-call user decision (allow/deny/confirm_yes/
// confirm_no) and is foreign-keyed to `tool_calls`. This table is
// the append-only hash-chained ledger of every engine decision —
// not just user-modal answers — and stands independently of the
// tool_calls lifecycle. Both tables coexist; CONTRACTS §9 stays the
// authoritative external contract while approvals_log is the
// internal record for replay, calibration, and chain integrity.
//
// Column shape mirrors the spec exactly. Columns the current slice
// doesn't populate (capabilities/score/classifier/sandbox) have
// stable defaults documented inline so later slices fill them
// without altering the table. Once a row is appended the chain hash
// covers all 21 columns — changing the schema later would require
// recomputing every existing hash or accepting a chain split.
//
// CHECK constraint on `decision` accepts the engine's three live
// values (`allow`, `deny`, `confirm`) plus the two post-modal
// resolutions (`confirm-allowed`, `confirm-denied`) the spec
// §6.6 calls out. The post-modal update path lands when the modal
// bridge slice does — for now only the three live values are
// emitted; the constraint pre-declares the resolved forms so adding
// them later doesn't require ALTER TABLE.

export const migration034ApprovalsLog = {
  id: 34,
  name: '034-approvals-log',
  sql: `
    CREATE TABLE approvals_log (
      seq                    INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                     INTEGER NOT NULL,
      install_id             TEXT NOT NULL,
      session_id             TEXT NOT NULL,
      parent_approval_id     TEXT,
      tool_name              TEXT NOT NULL,
      tool_version           TEXT NOT NULL DEFAULT 'v1',
      resolver_version       TEXT NOT NULL DEFAULT 'v1',
      args_hash              TEXT NOT NULL,
      capabilities_json      TEXT NOT NULL DEFAULT '[]',
      decision               TEXT NOT NULL
                                CHECK (decision IN ('allow','deny','confirm','confirm-allowed','confirm-denied')),
      score                  REAL NOT NULL DEFAULT 0,
      score_components_json  TEXT NOT NULL DEFAULT '{}',
      confidence             TEXT NOT NULL DEFAULT 'high'
                                CHECK (confidence IN ('high','medium','low')),
      classifier_hash        TEXT,
      classifier_adjust      REAL,
      policy_hash            TEXT NOT NULL,
      sandbox_profile        TEXT,
      ttl_expires_at         INTEGER,
      reason_chain_json      TEXT NOT NULL,
      prev_hash              TEXT NOT NULL,
      this_hash              TEXT NOT NULL UNIQUE
    );

    CREATE INDEX idx_approvals_log_session ON approvals_log(session_id);
    CREATE INDEX idx_approvals_log_ts ON approvals_log(ts);
    CREATE INDEX idx_approvals_log_install ON approvals_log(install_id);
  `,
} as const;
