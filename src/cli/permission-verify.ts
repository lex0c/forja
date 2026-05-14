// `agent permission verify` — walks the audit hash chain for the
// active install_id and reports integrity. DB-only path: no provider,
// no session start. Exit code 0 (intact) or 1 (broken or bootstrap
// error). The JSON form prints one NDJSON line so the command stays
// composable with hooks / CI pipelines.
//
// This is the minimal verification entry — the richer `replay`
// surface from PERMISSION_ENGINE.md §17 is a separate slice.

import {
  type ChainBreakAcceptedRow,
  type VerifyResult,
  createSqliteSink,
  ensureInstallId,
  listChainBreakAcceptedRows,
} from '../permissions/index.ts';
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
  let acceptedBreaks: ChainBreakAcceptedRow[] = [];
  try {
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const sink = createSqliteSink({ db, identity });
    result = sink.verifyChain();
    // §7.2: surface accepted breaks even on intact chains. An
    // operator who ran with `--accept-broken-chain` once should see
    // that history every time they verify — accepted breaks are
    // forensically meaningful (the chain CONTAINS a known break;
    // the operator signed off on it).
    acceptedBreaks = listChainBreakAcceptedRows(db, identity.install_id);
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
    out(
      `${JSON.stringify({
        install_id: identity.install_id,
        ...result,
        accepted_breaks: acceptedBreaks,
      })}\n`,
    );
    return result.ok ? 0 : 1;
  }

  if (result.ok) {
    out(
      `audit chain: intact (${result.rows} row${result.rows === 1 ? '' : 's'}, install_id=${identity.install_id})\n`,
    );
    if (result.current_rotation_id > 0) {
      out(`  current rotation: rotation_id=${result.current_rotation_id}\n`);
    }
    if (result.quarantined) {
      out('  status: QUARANTINED — chain was rotated and the archived\n');
      out('          segment has not yet been inspected. Run\n');
      out(
        `          'SELECT * FROM approvals_log_archived WHERE archive_rotation_id = ${result.current_rotation_id};'\n`,
      );
      out('          to audit the pre-rotation rows.\n');
    }
    if (acceptedBreaks.length > 0) {
      // §7.2: an intact chain that CONTAINS an accepted break is
      // forensically meaningful — operator opted to continue under
      // a known break. Surface the seqs so the operator can audit
      // them by row.
      const seqList = acceptedBreaks.map((r) => r.seq).join(', ');
      out(
        `  ⚠ ${acceptedBreaks.length} chain-break-accepted row(s) on this chain (seq${
          acceptedBreaks.length === 1 ? '' : 's'
        }: ${seqList})\n`,
      );
      out('     The chain is intact AFTER each acceptance point, but operators\n');
      out('     explicitly continued under a known break at these seqs. Inspect with:\n');
      out(
        `       'SELECT * FROM approvals_log WHERE install_id = ''${identity.install_id}'' AND seq IN (${seqList});'\n`,
      );
    }
    return 0;
  }
  // Broken — print all fields humans need to investigate.
  out(`audit chain: BROKEN at seq ${result.brokenAt} (${result.reason})\n`);
  out(`  install_id: ${identity.install_id}\n`);
  out(`  expected:   ${result.expected}\n`);
  out(`  actual:     ${result.actual}\n`);
  if (result.current_rotation_id > 0) {
    out(`  current rotation: rotation_id=${result.current_rotation_id}\n`);
  }
  if (result.quarantined) {
    out('  quarantine: this chain segment is post-rotation and still flagged.\n');
  }
  out('\n');
  out('Investigate before continuing. Forensic options:\n');
  out('  - Restore the SQLite DB from a backup before the break.\n');
  out('  - Audit the row at the broken seq and adjacent rows.\n');
  out('  - Re-run with `agent permission rotate-chain --reason "<text>"` to archive\n');
  out('    the broken segment and start a fresh chain (chain remains QUARANTINED\n');
  out('    until you inspect the archived rows).\n');
  out('  - Re-run `agent --accept-broken-chain ...` to continue under the known break.\n');
  out('    A `chain-break-accepted` audit row lands BEFORE new decisions; the\n');
  out('    acceptance is permanently visible in the chain and `verify` flags it.\n');
  return 1;
};
