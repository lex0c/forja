// `forja permission inspect <rotation_id> [--clear]` — PERMISSION_ENGINE.md
// §7.2 quarantine clearance flow.
//
// Slice 8 added the rotate-chain verb that archives the live audit
// chain under a new rotation_id and flips a `quarantined` flag on
// the new chain_meta row. Slice 12+ replay surface renders the flag
// in verify output but provides no operator path to CLEAR it — the
// only way today is direct SQL UPDATE.
//
// This verb closes the loop: an operator who has inspected the
// archived segment (via SQL, replay, or external forensics) runs
// `inspect <rotation_id> --clear` to flip `quarantined` to 0. Future
// `verify` runs no longer flag the rotation.
//
// Read-only path (no --clear): renders the chain_meta row + the
// archived-row count under that rotation. Operator sees what's in
// the segment before deciding to clear.

import { ensureInstallId } from '../permissions/index.ts';
import { defaultDbPath, MIGRATIONS, migrate, openDb } from '../storage/index.ts';
import {
  clearQuarantine,
  getLatestChainMeta,
  listChainMetaByInstall,
} from '../storage/repos/chain-rotation.ts';
import { forjaCommand } from './forja-command.ts';

export interface RunPermissionInspectOptions {
  rotationId: number;
  clear?: boolean;
  json?: boolean;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

interface InspectResult {
  rotationId: number;
  installId: string;
  rotatedAtMs: number;
  reason: string;
  preRotationTipHash: string;
  preRotationSeqMax: number;
  quarantinedBefore: boolean;
  quarantinedAfter: boolean;
  archivedRowCount: number;
  cleared: boolean;
}

const renderText = (result: InspectResult, out: (s: string) => void): void => {
  const r = result;
  out(`Inspect rotation_id=${r.rotationId} (install_id=${r.installId}):\n`);
  out(`  rotated_at:             ${r.rotatedAtMs}\n`);
  out(`  reason:                 ${r.reason}\n`);
  out(
    `  pre-rotation tip:       seq=${r.preRotationSeqMax} hash=${r.preRotationTipHash || '<empty chain>'}\n`,
  );
  out(`  archived rows:          ${r.archivedRowCount}\n`);
  out(`  quarantined (before):   ${r.quarantinedBefore ? 'yes' : 'no'}\n`);
  if (r.cleared) {
    out(`  quarantined (after):    ${r.quarantinedAfter ? 'yes' : 'no'}\n`);
    if (r.quarantinedBefore && !r.quarantinedAfter) {
      out('  status:                 ✓ quarantine cleared\n');
    } else if (!r.quarantinedBefore) {
      out('  status:                 (already clear — no change)\n');
    }
  } else if (r.quarantinedBefore) {
    out('\n');
    out('  Status: rotation segment is QUARANTINED — operator inspection required.\n');
    out(
      `  Inspect with: SELECT * FROM approvals_log_archived WHERE archive_rotation_id = ${r.rotationId};\n`,
    );
    out(
      `  Clear after inspection: ${forjaCommand(`permission inspect ${r.rotationId} --clear`)}\n`,
    );
  } else {
    out('  status:                 ✓ not quarantined\n');
  }
};

const renderJson = (result: InspectResult, out: (s: string) => void): void => {
  out(
    `${JSON.stringify({
      ok: true,
      rotation_id: result.rotationId,
      install_id: result.installId,
      rotated_at_ms: result.rotatedAtMs,
      reason: result.reason,
      pre_rotation_tip_hash: result.preRotationTipHash,
      pre_rotation_seq_max: result.preRotationSeqMax,
      archived_row_count: result.archivedRowCount,
      quarantined_before: result.quarantinedBefore,
      quarantined_after: result.quarantinedAfter,
      cleared: result.cleared,
    })}\n`,
  );
};

export const runPermissionInspect = async (
  options: RunPermissionInspectOptions,
): Promise<number> => {
  const out = options.out ?? ((s) => process.stdout.write(s));
  const err = options.err ?? ((s) => process.stderr.write(s));
  const json = options.json === true;
  const env = options.env ?? process.env;

  if (!Number.isInteger(options.rotationId) || options.rotationId <= 0) {
    const message = `forja permission inspect: <rotation_id> must be a positive integer (got ${options.rotationId})`;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'invalid_rotation_id', message })}\n`);
    } else {
      err(`${message}\n`);
    }
    return 1;
  }

  let identity: { install_id: string; created_at_ms: number };
  try {
    identity = ensureInstallId({ env });
  } catch (e) {
    const message = (e as Error).message;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'install_id', message })}\n`);
    } else {
      err(`forja permission inspect: ${message}\n`);
    }
    return 1;
  }

  const dbPath = options.dbPath ?? defaultDbPath();
  let db: ReturnType<typeof openDb>;
  try {
    db = openDb(dbPath);
    migrate(db, MIGRATIONS);
  } catch (e) {
    const message = (e as Error).message;
    if (json) {
      out(
        `${JSON.stringify({
          ok: false,
          error: 'db',
          message,
          install_id: identity.install_id,
        })}\n`,
      );
    } else {
      err(`forja permission inspect: ${message}\n`);
    }
    return 1;
  }

  // Look up the chain_meta row. We iterate listChainMetaByInstall +
  // filter rather than a dedicated repo `get` — keeps the read path
  // simple and avoids another repo surface for a one-off lookup.
  // Lists are bounded by rotation count (typically single digits).
  const allMeta = listChainMetaByInstall(db, identity.install_id);
  const meta = allMeta.find((m) => m.rotation_id === options.rotationId);
  if (meta === undefined) {
    const message = `no rotation found at rotation_id=${options.rotationId} for install_id=${identity.install_id}`;
    if (json) {
      out(
        `${JSON.stringify({
          ok: false,
          error: 'not_found',
          message,
          install_id: identity.install_id,
          rotation_id: options.rotationId,
        })}\n`,
      );
    } else {
      err(`forja permission inspect: ${message}\n`);
    }
    return 1;
  }

  // Count archived rows under this rotation. Uses a simple COUNT
  // query — listArchivedByRotation could load everything but we only
  // need the count for the operator readout.
  const countRow = db
    .query(
      'SELECT COUNT(*) as n FROM approvals_log_archived WHERE install_id = ? AND archive_rotation_id = ?',
    )
    .get(identity.install_id, options.rotationId) as { n: number };
  const archivedRowCount = countRow.n;

  const quarantinedBefore = meta.quarantined === 1;
  let cleared = false;
  let quarantinedAfter = quarantinedBefore;
  if (options.clear === true) {
    clearQuarantine(db, identity.install_id, options.rotationId);
    cleared = true;
    // Re-read to confirm the post-clear state.
    const refreshed = getLatestChainMeta(db, identity.install_id);
    // After clearQuarantine, the row should have quarantined=0 if it
    // matched this rotation. Re-fetch the specific row to be safe.
    const allMetaAfter = listChainMetaByInstall(db, identity.install_id);
    const metaAfter = allMetaAfter.find((m) => m.rotation_id === options.rotationId);
    quarantinedAfter = metaAfter?.quarantined === 1;
    // Silence unused variable for refreshed (kept for forensic
    // debugging signal of latest-rotation-id at clear time).
    void refreshed;
  }

  const result: InspectResult = {
    rotationId: options.rotationId,
    installId: identity.install_id,
    rotatedAtMs: meta.rotated_at_ms,
    reason: meta.reason,
    preRotationTipHash: meta.pre_rotation_tip_hash,
    preRotationSeqMax: meta.pre_rotation_seq_max,
    quarantinedBefore,
    quarantinedAfter,
    archivedRowCount,
    cleared,
  };
  if (json) renderJson(result, out);
  else renderText(result, out);
  return 0;
};
