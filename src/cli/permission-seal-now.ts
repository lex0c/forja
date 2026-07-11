// `forja permission seal-now` — manually flushes a §7.3 seal entry
// for the latest audit chain row. Operators run this before
// SIGTERM in scripts, in scheduled cron, or when the inotify-driven
// scheduler isn't suitable (e.g. one-shot batch jobs that don't
// hold the engine resident long enough to hit `interval_seconds`).
//
// DB-only path — does NOT bootstrap the engine. The verb knows
// about the seal store, the chain head, and what to append; the
// scheduler abstraction is only needed for the engine's automatic
// firing.
//
// Resolves the active policy from cwd/HOME (no session needed),
// reads `seal.mode`, builds the matching SealStore (worm-file in
// slice 58; future modes plug in as additional branches), queries
// the latest `approvals_log` row, and appends one entry. Exits 0
// on success (sealed OR noop) or 1 on error (no seal config,
// chattr failure, append failure).

import {
  ensureInstallId,
  factoryForSealMode,
  resolvePolicy,
  type SealEntry,
  type SealPolicy,
  type SealStore,
} from '../permissions/index.ts';
import { type DB, defaultDbPath, MIGRATIONS, migrate, openDb } from '../storage/index.ts';
import { getLastApprovalsLogByInstall } from '../storage/repos/approvals-log.ts';

export interface RunPermissionSealNowOptions {
  json?: boolean;
  // Override the default DB path. Tests pin to an in-memory DB or
  // a temp file; production reads the operator's session DB.
  dbPath?: string;
  // Override cwd / env for policy resolution. Tests pin specific
  // policy YAML paths via env=`{}`+enterprisePath/userPath seams;
  // production calls inherit from process.
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  // Test seam: override the SealStore factory so unit tests can
  // inject a mem-store and skip the chattr binary call. Production
  // leaves this undefined → `defaultWormFileFactory` is used.
  sealStoreFactory?: (config: SealPolicy) => SealStore;
  // Test seams for `resolvePolicy` paths — match the bootstrap's
  // shape so the same yaml fixtures work in both surfaces.
  enterprisePath?: string | null;
  userPath?: string | null;
  // Timestamp seam for the SealEntry's `ts` field. Production
  // calls Date.now(); tests pin a fixed number for assertions.
  now?: () => number;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export const runPermissionSealNow = async (
  options: RunPermissionSealNowOptions = {},
): Promise<number> => {
  const out = options.out ?? ((s) => process.stdout.write(s));
  const err = options.err ?? ((s) => process.stderr.write(s));
  const json = options.json === true;
  const now = options.now ?? Date.now;

  let identity: { install_id: string; created_at_ms: number };
  try {
    identity = ensureInstallId(options.env !== undefined ? { env: options.env } : {});
  } catch (e) {
    const reason = (e as Error).message;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'install_id', message: reason })}\n`);
    } else {
      err(`forja permission seal-now: ${reason}\n`);
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
      err(`forja permission seal-now: policy load failed: ${reason}\n`);
    }
    return 1;
  }

  if (sealConfig === undefined || sealConfig.mode === 'none') {
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'seal_disabled' })}\n`);
    } else {
      err('forja permission seal-now: sealing is not configured in the active policy\n');
      err("  add a 'seal:' section with mode: worm-file to permissions.yaml\n");
    }
    return 1;
  }

  // Backend dispatch via the shared `factoryForSealMode` helper —
  // worm-file (slice 58) and git-anchored (slice 63) supported.
  // Future modes (s3-object-lock, rfc3161-tsa) light up by adding
  // a branch in `factoryForSealMode` + a `defaultXFactory` export.
  let store: SealStore;
  try {
    const factory = options.sealStoreFactory ?? factoryForSealMode(sealConfig.mode);
    if (factory === null) {
      // Defensive — parsePolicy rejects reserved modes; this only
      // fires if a future schema accepts a new mode before the
      // dispatch is updated.
      if (json) {
        out(`${JSON.stringify({ ok: false, error: 'unsupported_mode', mode: sealConfig.mode })}\n`);
      } else {
        err(`forja permission seal-now: mode '${sealConfig.mode}' has no factory wired yet\n`);
      }
      return 1;
    }
    store = factory(sealConfig);
  } catch (e) {
    const reason = (e as Error).message;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'factory', message: reason })}\n`);
    } else {
      err(`forja permission seal-now: ${reason}\n`);
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
      err(`forja permission seal-now: ${reason}\n`);
    }
    return 1;
  }

  const lastRow = getLastApprovalsLogByInstall(db, identity.install_id);
  if (lastRow === null) {
    if (json) {
      out(`${JSON.stringify({ ok: true, sealed: null, reason: 'chain_empty' })}\n`);
    } else {
      out('forja permission seal-now: chain is empty, nothing to seal\n');
    }
    return 0;
  }

  // Already-sealed check — read the last entry from the seal file
  // and skip if it matches the current chain head. Avoids
  // duplicate lines when an operator runs seal-now twice in a row
  // without any decisions between.
  let lastSealedSeq = 0;
  try {
    const existing = store.list();
    if (existing.length > 0) {
      lastSealedSeq = existing[existing.length - 1]?.seq ?? 0;
    }
  } catch (e) {
    // Malformed seal file — surface loudly. Operator should
    // investigate before appending, since tampering is a real
    // signal.
    const reason = (e as Error).message;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'seal_file', message: reason })}\n`);
    } else {
      err(`forja permission seal-now: seal file corrupted: ${reason}\n`);
      err('  inspect the file before retrying\n');
    }
    return 1;
  }

  if (lastRow.seq === lastSealedSeq) {
    if (json) {
      out(
        `${JSON.stringify({
          ok: true,
          sealed: null,
          reason: 'already_sealed',
          seq: lastSealedSeq,
        })}\n`,
      );
    } else {
      out(`forja permission seal-now: chain already sealed at seq ${lastSealedSeq}\n`);
    }
    return 0;
  }

  const entry: SealEntry = {
    seq: lastRow.seq,
    ts: now(),
    hash: lastRow.this_hash,
  };
  const result = store.append(entry);
  if (!result.ok) {
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'append', message: result.reason })}\n`);
    } else {
      err(`forja permission seal-now: append failed: ${result.reason}\n`);
    }
    return 1;
  }

  if (json) {
    out(`${JSON.stringify({ ok: true, sealed: entry })}\n`);
  } else {
    out(`forja permission seal-now: sealed seq ${entry.seq} (hash ${entry.hash})\n`);
  }
  return 0;
};
