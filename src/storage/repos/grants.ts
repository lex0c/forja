// grants repo — §8 TTL grants per PERMISSION_ENGINE.md.
//
// Pattern + capability scope grants persist across sessions (the
// in-memory session-allow map covers `session` scope; `once` doesn't
// persist at all). This repo is the SQL surface for the table:
// insert + read + list-active + revoke.
//
// Revoke is idempotent — calling it twice on the same id is a no-op
// after the first call. Returns `boolean` so callers can render
// "already revoked" without a second query if they care.
//
// `listActiveGrants` filters expired + revoked rows at the SQL
// layer (uses the `idx_grants_active` covering index). Newest grants
// first so `/perms list-grants` puts recent operator decisions at
// the top.

import type { DB } from '../db.ts';

export type GrantScopeKind = 'pattern' | 'capability';
export type GrantGrantedBy = 'user' | 'enterprise' | 'project';

export interface GrantRow {
  id: string;
  install_id: string;
  scope_kind: GrantScopeKind;
  scope_value: string;
  capability: string;
  granted_at: number;
  expires_at: number;
  granted_by: GrantGrantedBy;
  granted_reason: string | null;
  revoked_at: number | null;
  revoked_reason: string | null;
}

export type InsertGrantInput = Omit<GrantRow, 'revoked_at' | 'revoked_reason'>;

const INSERT_SQL = `INSERT INTO grants (
  id, install_id, scope_kind, scope_value, capability,
  granted_at, expires_at, granted_by, granted_reason
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export const insertGrant = (db: DB, input: InsertGrantInput): void => {
  db.run(INSERT_SQL, [
    input.id,
    input.install_id,
    input.scope_kind,
    input.scope_value,
    input.capability,
    input.granted_at,
    input.expires_at,
    input.granted_by,
    input.granted_reason,
  ]);
};

const SELECT_COLS = `id, install_id, scope_kind, scope_value, capability,
  granted_at, expires_at, granted_by, granted_reason, revoked_at, revoked_reason`;

export const getGrantById = (db: DB, id: string): GrantRow | null => {
  const row = db.query(`SELECT ${SELECT_COLS} FROM grants WHERE id = ?`).get(id) as
    | GrantRow
    | undefined;
  return row ?? null;
};

// Live grants for an install at the supplied snapshot timestamp.
// Spec §8 query shape: `WHERE expires_at > snapshot_ts AND revoked_at IS NULL`.
// `snapshot_ts` is a parameter (not `Date.now()` baked in) so callers
// can replay against historical timestamps for audit reconstruction
// and tests can pin against fixed clock values.
export const listActiveGrants = (db: DB, installId: string, snapshotTs: number): GrantRow[] =>
  db
    .query(
      `SELECT ${SELECT_COLS}
         FROM grants
        WHERE install_id = ?
          AND revoked_at IS NULL
          AND expires_at > ?
        ORDER BY granted_at DESC`,
    )
    .all(installId, snapshotTs) as GrantRow[];

// Every grant for an install, regardless of expiry / revocation
// state. Used by `/perms list-grants --all` and historical replay.
export const listAllGrants = (db: DB, installId: string): GrantRow[] =>
  db
    .query(
      `SELECT ${SELECT_COLS}
         FROM grants
        WHERE install_id = ?
        ORDER BY granted_at DESC`,
    )
    .all(installId) as GrantRow[];

// Mark a grant as revoked. Idempotent: a second call on an already-
// revoked grant is a no-op (the WHERE clause filters out the
// already-revoked row, so the UPDATE matches zero rows the second
// time). Returns `true` when this call actually performed the
// revocation, `false` when the grant was already revoked or
// doesn't exist.
//
// Caller is responsible for passing a sensible `revokedAt` (typically
// `Date.now()`) — the repo doesn't read the clock so tests stay
// deterministic.
export interface RevokeGrantResult {
  revoked: boolean;
}

export const revokeGrant = (
  db: DB,
  id: string,
  revokedAt: number,
  reason: string | null,
): RevokeGrantResult => {
  const result = db.run(
    `UPDATE grants
        SET revoked_at = ?, revoked_reason = ?
      WHERE id = ?
        AND revoked_at IS NULL`,
    [revokedAt, reason, id],
  );
  return { revoked: result.changes > 0 };
};
