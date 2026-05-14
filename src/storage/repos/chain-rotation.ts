// chain-rotation repo. Owns the `approvals_log_archived` +
// `chain_meta` tables introduced by migration 035.
//
// PERMISSION_ENGINE.md §7.2 "Quebra de chain": the `--rotate-chain`
// flow archives the current `approvals_log` segment under a new
// `archive_rotation_id` and starts a fresh chain (new genesis,
// quarantined until inspected). This module exposes the atomic
// rotation primitive plus the read-side queries the audit sink and
// CLI consume.
//
// Atomicity: rotation MUST be a single transaction — a half-archive
// (rows in archived but still in approvals_log, or vice versa) would
// leave the chain in an unverifiable state. `withTransaction` wraps
// the SAVEPOINT/COMMIT pair via Bun's `db.transaction()`.

import type { DB } from '../db.ts';
import { withTransaction } from '../db.ts';
import type { ApprovalLogRow } from './approvals-log.ts';

// One row of `chain_meta`. A fresh install has zero rows; each
// rotation appends one. The `rotation_id` is DB-assigned monotonic
// (PRIMARY KEY AUTOINCREMENT) so two concurrent rotators on the same
// install can never collide on the segment marker.
export interface ChainMetaRow {
  rotation_id: number;
  install_id: string;
  rotated_at_ms: number;
  reason: string;
  // The `this_hash` of the last row in the pre-rotation chain. Stored
  // here (not in the archived rows themselves) so forensic readers
  // can prove the rotation event landed AFTER a specific chain tip
  // without scanning the entire archived segment.
  pre_rotation_tip_hash: string;
  pre_rotation_seq_max: number;
  // 1 = quarantined (rotation event unread by operator);
  // 0 = inspected. Surfaced by `agent permission verify` until the
  // operator explicitly clears it. Spec §7.2 documents this as
  // "quarantine flag em queries até inspeção".
  quarantined: 0 | 1;
}

// Archived row shape = base `ApprovalLogRow` columns + the two
// rotation-marker columns added by migration 035. Same shape so a
// forensic reader can compare archived-vs-live rows byte-for-byte.
export interface ApprovalLogArchivedRow extends ApprovalLogRow {
  archive_rotation_id: number;
  archived_at_ms: number;
}

const META_INSERT_SQL = `
  INSERT INTO chain_meta (
    install_id, rotated_at_ms, reason,
    pre_rotation_tip_hash, pre_rotation_seq_max, quarantined
  ) VALUES (?, ?, ?, ?, ?, 1)
`;

// Copy every `approvals_log` row for the install into the archive
// table, tagging each with the rotation_id + archived_at_ms. The
// SELECT pulls every column the migration declares to preserve
// the per-row hash payload exactly — a future verifyArchive flow
// can still walk the chain inside an archived segment.
const ARCHIVE_COPY_SQL = `
  INSERT INTO approvals_log_archived (
    seq, ts, install_id, session_id, parent_approval_id, tool_name,
    tool_version, resolver_version, args_hash, capabilities_json,
    decision, score, score_components_json, confidence,
    classifier_hash, classifier_adjust, policy_hash, sandbox_profile,
    ttl_expires_at, reason_chain_json, prev_hash, this_hash,
    archive_rotation_id, archived_at_ms
  )
  SELECT
    seq, ts, install_id, session_id, parent_approval_id, tool_name,
    tool_version, resolver_version, args_hash, capabilities_json,
    decision, score, score_components_json, confidence,
    classifier_hash, classifier_adjust, policy_hash, sandbox_profile,
    ttl_expires_at, reason_chain_json, prev_hash, this_hash,
    ?, ?
  FROM approvals_log
  WHERE install_id = ?
`;

const ARCHIVE_DELETE_SQL = 'DELETE FROM approvals_log WHERE install_id = ?';

const TIP_LOOKUP_SQL = `
  SELECT seq, this_hash
    FROM approvals_log
   WHERE install_id = ?
   ORDER BY seq DESC
   LIMIT 1
`;

const LATEST_META_SQL = `
  SELECT rotation_id, install_id, rotated_at_ms, reason,
         pre_rotation_tip_hash, pre_rotation_seq_max, quarantined
    FROM chain_meta
   WHERE install_id = ?
   ORDER BY rotation_id DESC
   LIMIT 1
`;

const LIST_META_SQL = `
  SELECT rotation_id, install_id, rotated_at_ms, reason,
         pre_rotation_tip_hash, pre_rotation_seq_max, quarantined
    FROM chain_meta
   WHERE install_id = ?
   ORDER BY rotation_id ASC
`;

const CLEAR_QUARANTINE_SQL = `
  UPDATE chain_meta SET quarantined = 0
   WHERE install_id = ? AND rotation_id = ?
`;

const LIST_ARCHIVED_SQL = `
  SELECT seq, ts, install_id, session_id, parent_approval_id, tool_name,
         tool_version, resolver_version, args_hash, capabilities_json,
         decision, score, score_components_json, confidence,
         classifier_hash, classifier_adjust, policy_hash, sandbox_profile,
         ttl_expires_at, reason_chain_json, prev_hash, this_hash,
         archive_rotation_id, archived_at_ms
    FROM approvals_log_archived
   WHERE install_id = ? AND archive_rotation_id = ?
   ORDER BY seq ASC
`;

export interface RotateChainInput {
  install_id: string;
  reason: string;
  // Wall-clock timestamp for the rotation event. Caller-supplied so
  // tests pin the value for deterministic genesis hashing.
  rotated_at_ms: number;
}

export interface RotateChainResult {
  rotation_id: number;
  archived_rows: number;
  pre_rotation_tip_hash: string;
  pre_rotation_seq_max: number;
  rotated_at_ms: number;
}

// Atomically: copy approvals_log rows for the install into the
// archive (tagged with a new rotation_id), delete the originals,
// and append a chain_meta row recording the event. Empty chain is
// supported — a fresh install can still rotate (e.g. preventively
// after an incident scare); the meta row records tip_hash='GENESIS:'
// and seq_max=0 so the post-rotation state is still well-formed.
//
// Returns the rotation_id assigned by the DB so the audit sink can
// rebuild the rotated genesis hash without an extra round-trip.
export const rotateChain = (db: DB, input: RotateChainInput): RotateChainResult => {
  return withTransaction(db, () => {
    const tip = db.query(TIP_LOOKUP_SQL).get(input.install_id) as {
      seq: number;
      this_hash: string;
    } | null;
    const pre_rotation_tip_hash = tip?.this_hash ?? '';
    const pre_rotation_seq_max = tip?.seq ?? 0;

    // INSERT chain_meta first so AUTOINCREMENT assigns the
    // rotation_id we can stamp into the archived rows in the same
    // transaction.
    const metaResult = db
      .query(META_INSERT_SQL)
      .run(
        input.install_id,
        input.rotated_at_ms,
        input.reason,
        pre_rotation_tip_hash,
        pre_rotation_seq_max,
      );
    const rotation_id = Number(metaResult.lastInsertRowid);

    // Bun's `RunResult.changes` counts rows affected by the last run.
    // We use it to report archived_rows back to the caller.
    const copyResult = db
      .query(ARCHIVE_COPY_SQL)
      .run(rotation_id, input.rotated_at_ms, input.install_id);
    const archived_rows = Number(copyResult.changes);
    db.query(ARCHIVE_DELETE_SQL).run(input.install_id);

    return {
      rotation_id,
      archived_rows,
      pre_rotation_tip_hash,
      pre_rotation_seq_max,
      rotated_at_ms: input.rotated_at_ms,
    };
  });
};

// Most-recent chain_meta row for the install. `null` when no rotation
// ever happened (fresh installs / installs that never rotated). The
// audit sink consults this on construction to decide between the
// original genesis hash and the rotated form.
export const getLatestChainMeta = (db: DB, installId: string): ChainMetaRow | null => {
  const row = db.query(LATEST_META_SQL).get(installId) as ChainMetaRow | null;
  if (row === null) return row;
  return { ...row, quarantined: (row.quarantined === 1 ? 1 : 0) as 0 | 1 };
};

// Full rotation history (oldest → newest). Used by future tooling
// (`agent permission history`) and by tests that assert re-rotation
// behavior. Cheap because rotations are rare (operator action only).
export const listChainMetaByInstall = (db: DB, installId: string): ChainMetaRow[] => {
  const rows = db.query(LIST_META_SQL).all(installId) as ChainMetaRow[];
  return rows.map((r) => ({ ...r, quarantined: (r.quarantined === 1 ? 1 : 0) as 0 | 1 }));
};

// Forensic operator action — clear the quarantine flag on a specific
// rotation event after manual inspection of the archived segment.
// Idempotent (re-clearing is a no-op). No-ops silently if the
// rotation_id doesn't exist for that install — caller should have
// validated existence beforehand.
export const clearQuarantine = (db: DB, installId: string, rotationId: number): void => {
  db.query(CLEAR_QUARANTINE_SQL).run(installId, rotationId);
};

// All archived rows for a (install_id, rotation_id) pair, seq ASC.
// Mirrors `listApprovalsLogByInstall` for the archive table — lets
// a future replay/forensic flow walk an archived segment byte-for-byte.
export const listArchivedByRotation = (
  db: DB,
  installId: string,
  rotationId: number,
): ApprovalLogArchivedRow[] => {
  return db.query(LIST_ARCHIVED_SQL).all(installId, rotationId) as ApprovalLogArchivedRow[];
};
