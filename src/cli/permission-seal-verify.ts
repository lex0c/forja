// `forja permission seal-verify` — runs `verifySealAgainstChain`
// for the active install_id's seal file, reports integrity.
// Complement to `forja permission verify` (audit chain integrity):
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
  ensureInstallId,
  factoryForSealMode,
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
    const factory = options.sealStoreFactory ?? factoryForSealMode(sealConfig.mode);
    if (factory === null) {
      if (json) {
        out(`${JSON.stringify({ ok: false, error: 'unsupported_mode', mode: sealConfig.mode })}\n`);
      } else {
        err(`forja permission seal-verify: mode '${sealConfig.mode}' has no factory wired yet\n`);
      }
      return 1;
    }
    store = factory(sealConfig);
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

  // Slice 128 (R4 P0-Audit-1): pass identity.install_id so seal
  // entries are bound to THIS install's chain. Cross-install
  // forgery (attacker plants row for install_B that matches the
  // seal entry while install_A's actual chain is tampered) now
  // fails loud.
  const result: VerifySealResult = verifySealAgainstChain(store, db, identity.install_id);

  if (json) {
    // Scope hint, machine-readable mirror of the intact-path note
    // below: a clean seal-verify proves seal-vs-stored-hash ONLY, not
    // that each stored hash matches its row payload (the recompute
    // lives in `permission verify`). Without this an automated gate
    // keying on `ok` would read a tampered row whose stored hash was
    // left stale as fully intact. `ok` is deliberately left untouched —
    // the two checks are orthogonal forensic signals; this advertises
    // the gap rather than folding the other check's verdict in. Emitted
    // only when there are entries to caveat (mirrors the human guard).
    const payload: Record<string, unknown> = { install_id: identity.install_id, ...result };
    if (result.ok && result.entriesChecked > 0) {
      payload.scope = 'seal-vs-stored-hash';
      payload.fullIntegrityRequires = 'permission verify';
    }
    out(`${JSON.stringify(payload)}\n`);
    return result.ok ? 0 : 1;
  }

  if (result.ok) {
    out(
      `seal file: intact (${result.entriesChecked} entr${
        result.entriesChecked === 1 ? 'y' : 'ies'
      } cross-checked, install_id=${identity.install_id})\n`,
    );
    if (sealConfig.path !== undefined) {
      const label = sealConfig.mode === 'git-anchored' ? 'repo' : 'file';
      out(`  ${label}: ${sealConfig.path}\n`);
    }
    // seal-verify proves the seal file matches the STORED row hashes
    // (seal unedited ∧ stored hashes unchanged). It does NOT recompute
    // each row's hash from its payload — a row edited with a stale
    // this_hash that still matches the seal passes here. The recompute
    // (this_hash_mismatch + prev_hash linkage) lives in `permission
    // verify`. A complete §7.3 integrity proof requires BOTH; surface
    // that on the intact path so a clean seal-verify isn't mistaken for
    // full chain integrity.
    if (result.entriesChecked > 0) {
      out('  note: this confirms the seal matches the stored chain hashes only.\n');
      out('  for full integrity, also run `forja permission verify` (recomputes\n');
      out('  each row hash from its payload — catches a tampered row whose\n');
      out('  stored hash was left stale).\n');
    }
    if (result.entriesChecked === 0) {
      out('  note: no seal entries yet — the file is empty\n');
      out('  the engine seals automatically per interval_decisions / interval_seconds,\n');
      out('  or run `forja permission seal-now` to force one\n');
    }
    return 0;
  }

  out(`seal file: BROKEN — ${result.reason}\n`);
  out(`  install_id: ${identity.install_id}\n`);
  if (result.firstMismatchAt !== undefined) {
    out(`  first mismatch at seq: ${result.firstMismatchAt}\n`);
  }
  if (sealConfig.path !== undefined) {
    const label = sealConfig.mode === 'git-anchored' ? 'repo' : 'file';
    out(`  ${label}: ${sealConfig.path}\n`);
  }
  out('\n');
  out('Investigate before continuing. Forensic options:\n');
  out('  - The local hash chain in the DB and the external seal file disagree.\n');
  out('  - Either the DB was tampered with (chain hash changed) or the seal file\n');
  out('    was edited (`chattr -a` first, then write). lsattr the seal file to\n');
  out('    confirm the +a bit is still set.\n');
  out('  - Run `forja permission verify` to check the chain integrity in isolation.\n');
  return 1;
};
