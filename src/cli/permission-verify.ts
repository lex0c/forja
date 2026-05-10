// `agent permission verify` — walks the audit hash chain for the
// active install_id and reports integrity. DB-only path: no provider,
// no session start. Exit code 0 (intact) or 1 (broken or bootstrap
// error). The JSON form prints one NDJSON line so the command stays
// composable with hooks / CI pipelines.
//
// This is the minimal verification entry — the richer `replay`
// surface from PERMISSION_ENGINE.md §17 is a separate slice.

import { type VerifyResult, createSqliteSink, ensureInstallId } from '../permissions/index.ts';
import { MIGRATIONS, defaultDbPath, migrate, openDb } from '../storage/index.ts';

export interface RunPermissionVerifyOptions {
  json?: boolean;
  // Override the default DB path. Tests pin to an in-memory DB or a
  // temp file; production reads the operator's session DB.
  dbPath?: string;
  // Test seam for install_id discovery.
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export const runPermissionVerify = async (
  options: RunPermissionVerifyOptions = {},
): Promise<number> => {
  const out = options.out ?? ((s) => process.stdout.write(s));
  const err = options.err ?? ((s) => process.stderr.write(s));
  const json = options.json === true;

  let identity: { install_id: string; created_at_ms: number };
  try {
    identity = ensureInstallId(options.env !== undefined ? { env: options.env } : {});
  } catch (e) {
    const reason = (e as Error).message;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'install_id', message: reason })}\n`);
    } else {
      err(`forja permission verify: ${reason}\n`);
    }
    return 1;
  }

  const dbPath = options.dbPath ?? defaultDbPath();
  let result: VerifyResult;
  try {
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const sink = createSqliteSink({ db, identity });
    result = sink.verifyChain();
  } catch (e) {
    const reason = (e as Error).message;
    if (json) {
      out(
        `${JSON.stringify({
          ok: false,
          error: 'db',
          message: reason,
          install_id: identity.install_id,
        })}\n`,
      );
    } else {
      err(`forja permission verify: ${reason}\n`);
    }
    return 1;
  }

  if (json) {
    out(`${JSON.stringify({ install_id: identity.install_id, ...result })}\n`);
    return result.ok ? 0 : 1;
  }

  if (result.ok) {
    out(
      `audit chain: intact (${result.rows} row${result.rows === 1 ? '' : 's'}, install_id=${identity.install_id})\n`,
    );
    return 0;
  }
  // Broken — print all fields humans need to investigate.
  out(`audit chain: BROKEN at seq ${result.brokenAt} (${result.reason})\n`);
  out(`  install_id: ${identity.install_id}\n`);
  out(`  expected:   ${result.expected}\n`);
  out(`  actual:     ${result.actual}\n`);
  out('\n');
  out('Investigate before continuing. Forensic options:\n');
  out('  - Restore the SQLite DB from a backup before the break.\n');
  out('  - Audit the row at the broken seq and adjacent rows.\n');
  out('  - If the break is acknowledged and not recoverable, the engine supports\n');
  out('    --accept-broken-chain (with audit-log signed entry) — not implemented in this slice.\n');
  return 1;
};
