// `agent permission grants [--all] [--json]` — list §8 persisted
// grants for the active install. Default surface lists only active
// (non-expired, non-revoked) grants; `--all` includes every row
// for forensic audit. DB-only path — no provider, no session start.
//
// JSON mode emits one NDJSON line per grant. Plain-text mode renders
// a compact column layout (id, scope_value, capability, expires_at,
// status). Both modes scope by install_id; cross-install grants
// (rare, multi-install machines) stay invisible.

import { ensureInstallId } from '../permissions/index.ts';
import { MIGRATIONS, defaultDbPath, migrate, openDb } from '../storage/index.ts';
import { type GrantRow, listActiveGrants, listAllGrants } from '../storage/repos/grants.ts';

export interface RunPermissionGrantsOptions {
  all?: boolean;
  json?: boolean;
  // Override the default DB path. Tests pin to an in-memory DB or a
  // temp file; production reads the operator's session DB.
  dbPath?: string;
  // Test seam for install_id discovery and `now()` snapshot.
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

// Render a single grant row in plain-text mode. Columns kept narrow
// so a typical terminal width (>= 80 cols) fits id + scope + cap +
// expiry + status without wrapping. ID is a ULID (26 chars, fixed).
const renderGrantRow = (g: GrantRow, nowMs: number): string => {
  const status = g.revoked_at !== null ? 'revoked' : g.expires_at <= nowMs ? 'expired' : 'active';
  const expiresIso = new Date(g.expires_at).toISOString();
  return `  ${g.id}  ${status.padEnd(7)}  ${g.scope_kind}:${g.scope_value}  ${g.capability}  expires=${expiresIso}`;
};

export const runPermissionGrants = async (
  options: RunPermissionGrantsOptions = {},
): Promise<number> => {
  const out = options.out ?? ((s) => process.stdout.write(s));
  const err = options.err ?? ((s) => process.stderr.write(s));
  const json = options.json === true;
  const all = options.all === true;
  const now = options.now ?? (() => Date.now());

  let identity: { install_id: string; created_at_ms: number };
  try {
    identity = ensureInstallId(options.env !== undefined ? { env: options.env } : {});
  } catch (e) {
    const reason = (e as Error).message;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'install_id', message: reason })}\n`);
    } else {
      err(`forja permission grants: ${reason}\n`);
    }
    return 1;
  }

  const dbPath = options.dbPath ?? defaultDbPath();
  let grants: GrantRow[];
  const snapshotTs = now();
  try {
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    grants = all
      ? listAllGrants(db, identity.install_id)
      : listActiveGrants(db, identity.install_id, snapshotTs);
  } catch (e) {
    const reason = (e as Error).message;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'db', message: reason })}\n`);
    } else {
      err(`forja permission grants: ${reason}\n`);
    }
    return 1;
  }

  if (json) {
    // NDJSON: one grant per line. Empty result emits zero lines —
    // consumers can detect "no grants" via empty stdout. Stderr
    // stays silent on the happy path.
    for (const g of grants) out(`${JSON.stringify(g)}\n`);
    return 0;
  }

  // Plain text: header + rows + footer hint.
  const label = all ? 'all grants' : 'active grants';
  if (grants.length === 0) {
    out(`${label}: (none)\n`);
    if (!all) {
      out("(use 'agent permission grants --all' to include expired and revoked rows)\n");
    }
    return 0;
  }
  out(`${label} (${grants.length}):\n`);
  for (const g of grants) out(`${renderGrantRow(g, snapshotTs)}\n`);
  return 0;
};
