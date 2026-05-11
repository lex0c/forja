// `agent permission seal-verify` — runs `verifySealAgainstChain`
// for the active install_id's seal file, reports integrity.
// Complement to `agent permission verify` (audit chain integrity):
// chain-verify checks the SQLite chain itself; seal-verify checks
// that the EXTERNAL seal file matches the chain at every recorded
// point. A divergence indicates either chain tampering OR seal-
// file tampering — the §7.3 backstop against a root adversary
// who rewrote both rows and recomputed hashes.
//
// DB-only path — does NOT bootstrap the engine. Reads the active
// policy from cwd/HOME for the seal config, opens the DB, builds
// the matching SealStore in read-only mode (no chattr call needed
// since we never write), runs the verifier, renders the result.
// Exit code 0 (intact) or 1 (broken or bootstrap error).

import {
  type SealPolicy,
  type SealStore,
  type VerifySealResult,
  defaultWormFileFactory,
  ensureInstallId,
  verifySealAgainstChain,
} from '../permissions/index.ts';
import { resolvePolicy } from '../permissions/index.ts';
import { type DB, MIGRATIONS, defaultDbPath, migrate, openDb } from '../storage/index.ts';

export interface RunPermissionSealVerifyOptions {
  json?: boolean;
  dbPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  // Test seam: override SealStore factory to inject a mem-store
  // pre-populated with entries that match (or don't match) the
  // chain. Production leaves undefined.
  sealStoreFactory?: (config: SealPolicy) => SealStore;
  enterprisePath?: string | null;
  userPath?: string | null;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export const runPermissionSealVerify = async (
  options: RunPermissionSealVerifyOptions = {},
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
      err(`forja permission seal-verify: ${reason}\n`);
    }
    return 1;
  }

  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  let sealConfig: SealPolicy | undefined;
  try {
    const resolved = resolvePolicy({
      cwd,
      home: env.HOME ?? cwd,
      env,
      ...(options.enterprisePath !== undefined ? { enterprisePath: options.enterprisePath } : {}),
      ...(options.userPath !== undefined ? { userPath: options.userPath } : {}),
    });
    sealConfig = resolved.policy.seal;
  } catch (e) {
    const reason = (e as Error).message;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'policy', message: reason })}\n`);
    } else {
      err(`forja permission seal-verify: policy load failed: ${reason}\n`);
    }
    return 1;
  }

  if (sealConfig === undefined || sealConfig.mode === 'none') {
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'seal_disabled' })}\n`);
    } else {
      err('forja permission seal-verify: sealing is not configured in the active policy\n');
    }
    return 1;
  }

  let store: SealStore;
  try {
    if (sealConfig.mode === 'worm-file') {
      const factory = options.sealStoreFactory ?? defaultWormFileFactory;
      store = factory(sealConfig);
    } else {
      if (json) {
        out(`${JSON.stringify({ ok: false, error: 'unsupported_mode', mode: sealConfig.mode })}\n`);
      } else {
        err(`forja permission seal-verify: mode '${sealConfig.mode}' has no factory wired yet\n`);
      }
      return 1;
    }
  } catch (e) {
    const reason = (e as Error).message;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'factory', message: reason })}\n`);
    } else {
      err(`forja permission seal-verify: ${reason}\n`);
    }
    return 1;
  }

  const dbPath = options.dbPath ?? defaultDbPath();
  let db: DB;
  try {
    db = openDb(dbPath);
    migrate(db, MIGRATIONS);
  } catch (e) {
    const reason = (e as Error).message;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'db', message: reason })}\n`);
    } else {
      err(`forja permission seal-verify: ${reason}\n`);
    }
    return 1;
  }

  const result: VerifySealResult = verifySealAgainstChain(store, db);

  if (json) {
    out(`${JSON.stringify({ install_id: identity.install_id, ...result })}\n`);
    return result.ok ? 0 : 1;
  }

  if (result.ok) {
    out(
      `seal file: intact (${result.entriesChecked} entr${
        result.entriesChecked === 1 ? 'y' : 'ies'
      } cross-checked, install_id=${identity.install_id})\n`,
    );
    if (sealConfig.mode === 'worm-file' && sealConfig.path !== undefined) {
      out(`  file: ${sealConfig.path}\n`);
    }
    if (result.entriesChecked === 0) {
      out('  note: no seal entries yet — the file is empty\n');
      out('  the engine seals automatically per interval_decisions / interval_seconds,\n');
      out('  or run `agent permission seal-now` to force one\n');
    }
    return 0;
  }

  out(`seal file: BROKEN — ${result.reason}\n`);
  out(`  install_id: ${identity.install_id}\n`);
  if (result.firstMismatchAt !== undefined) {
    out(`  first mismatch at seq: ${result.firstMismatchAt}\n`);
  }
  if (sealConfig.mode === 'worm-file' && sealConfig.path !== undefined) {
    out(`  file: ${sealConfig.path}\n`);
  }
  out('\n');
  out('Investigate before continuing. Forensic options:\n');
  out('  - The local hash chain in the DB and the external seal file disagree.\n');
  out('  - Either the DB was tampered with (chain hash changed) or the seal file\n');
  out('    was edited (`chattr -a` first, then write). lsattr the seal file to\n');
  out('    confirm the +a bit is still set.\n');
  out('  - Run `agent permission verify` to check the chain integrity in isolation.\n');
  return 1;
};
