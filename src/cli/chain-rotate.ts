// `agent permission rotate-chain` — archives the active audit chain
// segment under a new rotation_id and starts a fresh chain
// (PERMISSION_ENGINE.md §7.2). Operator-driven only; the engine
// never auto-rotates.
//
// Symmetric to `permission-verify.ts`: DB-only, no provider, no
// session. Exits 0 on successful rotation, 1 on bootstrap error.
// The JSON form prints one NDJSON line so CI / hooks can consume.
//
// The rotation produces a `quarantined` flag on the new chain (set
// to 1 in chain_meta) that `permission verify` surfaces until the
// operator explicitly clears it via a future `permission inspect`
// verb. Quarantine is forensic-only; engine operation continues
// normally.

import { ensureInstallId } from '../permissions/index.ts';
import { MIGRATIONS, defaultDbPath, migrate, openDb } from '../storage/index.ts';
import { rotateChain } from '../storage/repos/chain-rotation.ts';

export interface RunChainRotateOptions {
  reason: string;
  json?: boolean;
  // Override the default DB path. Tests pin to an in-memory DB or a
  // temp file; production reads the operator's session DB.
  dbPath?: string;
  // Test seam for install_id discovery.
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
  // Test seam for the rotated_at_ms timestamp. Production uses
  // `Date.now()`; tests pin for deterministic chain_meta hashes.
  now?: () => number;
}

export const runChainRotate = async (options: RunChainRotateOptions): Promise<number> => {
  const out = options.out ?? ((s) => process.stdout.write(s));
  const err = options.err ?? ((s) => process.stderr.write(s));
  const json = options.json === true;
  const now = options.now ?? (() => Date.now());

  // `--reason` is enforced at parse time, but defense-in-depth:
  // empty/whitespace bypasses the argv check (e.g. via a programmatic
  // caller) would land in chain_meta as a blank forensic record.
  const reason = options.reason.trim();
  if (reason.length === 0) {
    const message = 'forja permission rotate-chain: --reason text cannot be empty';
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'reason', message })}\n`);
    } else {
      err(`${message}\n`);
    }
    return 1;
  }

  let identity: { install_id: string; created_at_ms: number };
  try {
    identity = ensureInstallId(options.env !== undefined ? { env: options.env } : {});
  } catch (e) {
    const message = (e as Error).message;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'install_id', message })}\n`);
    } else {
      err(`forja permission rotate-chain: ${message}\n`);
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
      err(`forja permission rotate-chain: ${message}\n`);
    }
    return 1;
  }

  let result: ReturnType<typeof rotateChain>;
  try {
    result = rotateChain(db, {
      install_id: identity.install_id,
      reason,
      rotated_at_ms: now(),
    });
  } catch (e) {
    const message = (e as Error).message;
    if (json) {
      out(
        `${JSON.stringify({
          ok: false,
          error: 'rotation',
          message,
          install_id: identity.install_id,
        })}\n`,
      );
    } else {
      err(`forja permission rotate-chain: ${message}\n`);
    }
    return 1;
  }

  if (json) {
    out(
      `${JSON.stringify({
        ok: true,
        install_id: identity.install_id,
        rotation_id: result.rotation_id,
        archived_rows: result.archived_rows,
        pre_rotation_tip_hash: result.pre_rotation_tip_hash,
        pre_rotation_seq_max: result.pre_rotation_seq_max,
        rotated_at_ms: result.rotated_at_ms,
        quarantined: true,
        reason,
      })}\n`,
    );
    return 0;
  }

  out(
    `audit chain: rotated (install_id=${identity.install_id}, rotation_id=${result.rotation_id})\n`,
  );
  out(
    `  archived ${result.archived_rows} row${result.archived_rows === 1 ? '' : 's'} under rotation_id=${result.rotation_id}\n`,
  );
  if (result.pre_rotation_seq_max > 0) {
    out(
      `  pre-rotation tip: seq=${result.pre_rotation_seq_max} hash=${result.pre_rotation_tip_hash}\n`,
    );
  } else {
    out('  pre-rotation chain was empty (preventive rotation)\n');
  }
  out(`  reason: ${reason}\n`);
  out('\n');
  out('The new chain begins at a rotated genesis (`GENESIS-ROTATED:<hash>`).\n');
  out('It is QUARANTINED until you inspect the archived segment and explicitly clear it.\n');
  out(
    `Inspect archived rows: SELECT * FROM approvals_log_archived WHERE archive_rotation_id = ${result.rotation_id};\n`,
  );
  return 0;
};
