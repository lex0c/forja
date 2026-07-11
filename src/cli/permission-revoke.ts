// `forja permission revoke <id> [--reason <text>] [--json]` — revoke
// a §8 persisted grant. Idempotent per spec line 621: calling twice
// on the same id is a no-op after the first call. Plain-text mode
// reports whether THIS call performed the revocation or the grant
// was already revoked; JSON mode emits a single line with the
// revocation envelope.
//
// The CLI does NOT scope by install_id — the underlying repo update
// matches by the (globally-unique) ULID. A multi-install machine
// running this CLI is authorized to revoke any grant on its DB
// (operators run on their own machine; isolation is at the DB-file
// level).

import { ensureInstallId } from '../permissions/index.ts';
import { isUlid } from '../permissions/ulid.ts';
import { MIGRATIONS, defaultDbPath, migrate, openDb } from '../storage/index.ts';
import { getGrantById, revokeGrant } from '../storage/repos/grants.ts';

export interface RunPermissionRevokeOptions {
  id: string;
  reason?: string;
  json?: boolean;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export const runPermissionRevoke = async (options: RunPermissionRevokeOptions): Promise<number> => {
  const out = options.out ?? ((s) => process.stdout.write(s));
  const err = options.err ?? ((s) => process.stderr.write(s));
  const json = options.json === true;
  const now = options.now ?? (() => Date.now());

  if (!isUlid(options.id)) {
    const reason = `not a valid ULID: '${options.id}' (expected 26 chars, Crockford base32, uppercase)`;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'id_shape', message: reason })}\n`);
    } else {
      err(`forja permission revoke: ${reason}\n`);
    }
    return 1;
  }

  // Establish install context (mostly for error reporting symmetry
  // with `verify` / `grants`); the actual revoke matches by id alone.
  try {
    ensureInstallId(options.env !== undefined ? { env: options.env } : {});
  } catch (e) {
    const reason = (e as Error).message;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'install_id', message: reason })}\n`);
    } else {
      err(`forja permission revoke: ${reason}\n`);
    }
    return 1;
  }

  const dbPath = options.dbPath ?? defaultDbPath();
  try {
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    // Fetch BEFORE revoking so we can render the previous state and
    // distinguish "already revoked" / "no such grant" / "now revoked".
    const before = getGrantById(db, options.id);
    if (before === null) {
      const msg = `no grant with id ${options.id}`;
      if (json) {
        out(
          `${JSON.stringify({
            ok: false,
            error: 'not_found',
            message: msg,
            id: options.id,
          })}\n`,
        );
      } else {
        err(`forja permission revoke: ${msg}\n`);
      }
      return 1;
    }
    const result = revokeGrant(db, options.id, now(), options.reason ?? null);
    const after = getGrantById(db, options.id);
    if (json) {
      // One-line envelope: revoked flag + the row's final state.
      // `revoked: false` means the grant was already revoked before
      // this call (idempotent no-op); `revoked: true` means this
      // call performed the revocation.
      out(
        `${JSON.stringify({
          ok: true,
          revoked: result.revoked,
          grant: after,
        })}\n`,
      );
      return 0;
    }
    if (result.revoked) {
      out(`revoked grant ${options.id}\n`);
      if (after !== null) {
        out(`  scope:      ${after.scope_kind}:${after.scope_value}\n`);
        out(`  capability: ${after.capability}\n`);
        if (after.revoked_reason !== null) out(`  reason:     ${after.revoked_reason}\n`);
        out(`  revoked_at: ${new Date(after.revoked_at as number).toISOString()}\n`);
      }
    } else {
      // Idempotent path: render the ORIGINAL revocation's metadata so
      // the operator can see WHO revoked first and WHY. Distinct from
      // a fresh revoke so the audit trail of the first call survives.
      out(`already revoked: ${options.id}\n`);
      if (before.revoked_at !== null) {
        out(`  revoked_at: ${new Date(before.revoked_at).toISOString()}\n`);
      }
      if (before.revoked_reason !== null) {
        out(`  reason:     ${before.revoked_reason}\n`);
      }
    }
    return 0;
  } catch (e) {
    const reason = (e as Error).message;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'db', message: reason })}\n`);
    } else {
      err(`forja permission revoke: ${reason}\n`);
    }
    return 1;
  }
};
