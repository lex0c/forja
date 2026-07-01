// mcp_servers + mcp_manifest_history repo. Schema in migrations
// 081-mcp-servers.ts / 083-mcp-servers-scoped.ts; spec AUDIT.md §1.5.
//
// Both tables are keyed by `(scope, name)` / `(scope, server_name)`, NOT by name
// alone: `sessions.db` is user-global but project MCP config is per-repo, so the
// same `<name>` (`db`, `postgres`) in different repos must be distinct rows.
// `scope` = the project root for project servers, `''` (global) for `user`
// servers. Every read/write takes the scope so one repo can't clobber another's
// identity or cached trust.
//
// `mcp_servers` is MUTABLE state (one row per configured `(scope, name)`). The
// immutable columns (scope/name/transport/command/url/source) are set once by
// `insertServer`; a transport/command change is remove + insert (`deleteServer`
// then `insertServer`), never an in-place rewrite — per AUDIT §1.5. The mutable
// columns are patched by `patchServer` and the counters by `bumpServerCounters`.
//
// `mcp_manifest_history` is APPEND-ONLY, FOREVER retention (no prune primitive —
// the gc sweep must skip it). One row per trust decision; (scope, server_name,
// hash) is UNIQUE so a re-decision on the same hash is a caller-side concern (the
// manager looks up `getManifestDecision` before inserting). Enum columns
// (state/transport/decision) are typed `string` here — same convention as
// failure_events.classe: the DB CHECK + the src/mcp domain unions are the
// vocabulary authority, the row shape stays decoupled from the higher layer.

import type { SQLQueryBindings } from 'bun:sqlite';
import type { DB } from '../db.ts';

export interface McpServerRow {
  // Project isolation key: the repo root for project servers, '' for user
  // (global). Part of the primary key alongside `name`.
  scope: string;
  name: string;
  transport: string; // 'stdio' | 'sse' | 'http' (CHECK)
  command: string | null; // JSON array string (stdio); env values redacted
  url: string | null; // SSE/HTTP only
  source: string; // 'user' | 'project_shared' | 'project_local'
  state: string; // the 8 STATE_MACHINE §6.5 states (CHECK)
  current_manifest_hash: string | null;
  protocol_version: string | null;
  server_version: string | null;
  last_connected_at: number | null;
  last_error: string | null;
  // Epoch-ms of an operator `/mcp revoke` (migration 082); NULL when never
  // revoked. `init` skips the cached grant while this is set; `/mcp reconnect`
  // clears it on a fresh re-trust.
  revoked_at: number | null;
  total_calls: number;
  total_tokens_in: number;
  audit_schema_version: number;
}

// Immutable-at-insert columns plus the initial state. Counters default
// to 0 and audit_schema_version to 1 at the DB layer.
export interface InsertServerInput {
  scope: string;
  name: string;
  transport: string;
  command: string | null;
  url: string | null;
  source: string;
  state: string;
}

// Mutable columns only. A key PRESENT in the patch is written (including
// an explicit `null`, e.g. clearing last_error on recovery); a key
// ABSENT is left unchanged. The column set is a fixed whitelist, so the
// dynamic SET clause carries no caller-controlled identifiers.
export interface McpServerPatch {
  state?: string;
  current_manifest_hash?: string | null;
  protocol_version?: string | null;
  server_version?: string | null;
  last_connected_at?: number | null;
  last_error?: string | null;
  revoked_at?: number | null;
}

const SERVER_COLUMNS = [
  'scope',
  'name',
  'transport',
  'command',
  'url',
  'source',
  'state',
  'current_manifest_hash',
  'protocol_version',
  'server_version',
  'last_connected_at',
  'last_error',
  'revoked_at',
  'total_calls',
  'total_tokens_in',
  'audit_schema_version',
] as const;

const SERVER_SELECT = `SELECT ${SERVER_COLUMNS.join(', ')} FROM mcp_servers`;

// Whitelist of patchable columns — used to build the SET clause from the
// patch's own keys. NOT caller-controlled (the values come from this
// const), so there is no injection surface even though the SQL is built
// dynamically.
const PATCHABLE_COLUMNS = [
  'state',
  'current_manifest_hash',
  'protocol_version',
  'server_version',
  'last_connected_at',
  'last_error',
  'revoked_at',
] as const;

export const getServer = (db: DB, scope: string, name: string): McpServerRow | null => {
  return (
    (db
      .query(`${SERVER_SELECT} WHERE scope = ? AND name = ?`)
      .get(scope, name) as McpServerRow | null) ?? null
  );
};

// First row matching a name across ANY scope, for the degraded path where the
// caller can't determine the scope (no live manager, or a server not in the
// current config). Prefer the scoped `getServer` when the scope is known. The row
// carries its own `scope`, so a follow-up scoped read (e.g. history) is exact.
export const getServerAnyScope = (db: DB, name: string): McpServerRow | null => {
  return (
    (db.query(`${SERVER_SELECT} WHERE name = ? LIMIT 1`).get(name) as McpServerRow | null) ?? null
  );
};

// List persisted rows. With `scopes` given, restricts to those scopes (the
// current invocation's — the repo scope + the global ''); without it, returns
// every row (audit / diagnostics that span projects).
export const listServers = (db: DB, scopes?: readonly string[]): McpServerRow[] => {
  if (scopes === undefined) {
    return db.query(`${SERVER_SELECT} ORDER BY name ASC`).all() as McpServerRow[];
  }
  if (scopes.length === 0) return [];
  const placeholders = scopes.map(() => '?').join(', ');
  return db
    .query(`${SERVER_SELECT} WHERE scope IN (${placeholders}) ORDER BY name ASC`)
    .all(...scopes) as McpServerRow[];
};

export const insertServer = (db: DB, input: InsertServerInput): void => {
  db.query(
    `INSERT INTO mcp_servers (scope, name, transport, command, url, source, state)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.scope,
    input.name,
    input.transport,
    input.command,
    input.url,
    input.source,
    input.state,
  );
};

export const deleteServer = (db: DB, scope: string, name: string): void => {
  db.query('DELETE FROM mcp_servers WHERE scope = ? AND name = ?').run(scope, name);
};

// Patch the mutable columns. No-op when the patch carries none of them.
export const patchServer = (db: DB, scope: string, name: string, patch: McpServerPatch): void => {
  const cols = PATCHABLE_COLUMNS.filter((c) => c in patch);
  if (cols.length === 0) return;
  const setClause = cols.map((c) => `${c} = ?`).join(', ');
  const values = cols.map(
    (c) => ((patch as Record<string, unknown>)[c] ?? null) as SQLQueryBindings,
  );
  db.query(`UPDATE mcp_servers SET ${setClause} WHERE scope = ? AND name = ?`).run(
    ...values,
    scope,
    name,
  );
};

// Atomic per-server counter increment (MCP.md §5 budget accounting).
export const bumpServerCounters = (
  db: DB,
  scope: string,
  name: string,
  delta: { calls?: number; tokensIn?: number },
): void => {
  db.query(
    `UPDATE mcp_servers
        SET total_calls = total_calls + ?,
            total_tokens_in = total_tokens_in + ?
      WHERE scope = ? AND name = ?`,
  ).run(delta.calls ?? 0, delta.tokensIn ?? 0, scope, name);
};

// ─── mcp_manifest_history (append-only, forever) ───────────────────────

export interface McpManifestHistoryRow {
  id: number;
  scope: string;
  server_name: string;
  hash: string;
  previous_hash: string | null;
  manifest_json: string;
  protocol_version: string;
  server_version: string | null;
  decision: string; // 'granted' | 'denied' | 'revoked' | 'superseded' (CHECK)
  decided_by: string; // 'user' | 'auto_approve' | 'ci'
  decided_at: number;
  approval_id: number | null;
  audit_schema_version: number;
}

export interface RecordManifestDecisionInput {
  scope: string;
  server_name: string;
  hash: string;
  previous_hash: string | null;
  manifest_json: string;
  protocol_version: string;
  server_version: string | null;
  decision: string;
  decided_by: string;
  decided_at: number;
  approval_id: number | null;
}

const MANIFEST_COLUMNS = [
  'id',
  'scope',
  'server_name',
  'hash',
  'previous_hash',
  'manifest_json',
  'protocol_version',
  'server_version',
  'decision',
  'decided_by',
  'decided_at',
  'approval_id',
  'audit_schema_version',
] as const;

const MANIFEST_SELECT = `SELECT ${MANIFEST_COLUMNS.join(', ')} FROM mcp_manifest_history`;

// Append a trust decision. Returns the assigned row id (INTEGER PK
// autoincrements). The caller is responsible for not re-recording an
// identical (scope, server_name, hash) — that triple is UNIQUE, so a duplicate
// throws; consult `getManifestDecision` first.
export const recordManifestDecision = (db: DB, input: RecordManifestDecisionInput): number => {
  const result = db
    .query(
      `INSERT INTO mcp_manifest_history
         (scope, server_name, hash, previous_hash, manifest_json, protocol_version,
          server_version, decision, decided_by, decided_at, approval_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.scope,
      input.server_name,
      input.hash,
      input.previous_hash,
      input.manifest_json,
      input.protocol_version,
      input.server_version,
      input.decision,
      input.decided_by,
      input.decided_at,
      input.approval_id,
    );
  return Number(result.lastInsertRowid);
};

// Re-decide an existing (scope, server, hash) manifest row in place. The triple
// is UNIQUE, so a decision that CHANGES after a prior one — e.g. a manifest the
// operator DECLINED and later approves via `/mcp reconnect` or
// `--auto-approve-mcp` — cannot be appended as a second row; the caller updates
// the existing row so `latestTrustedManifest` sees the new grant on the next boot
// instead of the approval being silently lost. Returns true when a row matched.
export const updateManifestDecision = (
  db: DB,
  scope: string,
  serverName: string,
  hash: string,
  update: { decision: string; decided_by: string; decided_at: number },
): boolean => {
  const result = db
    .query(
      `UPDATE mcp_manifest_history
          SET decision = ?, decided_by = ?, decided_at = ?
        WHERE scope = ? AND server_name = ? AND hash = ?`,
    )
    .run(update.decision, update.decided_by, update.decided_at, scope, serverName, hash);
  return result.changes > 0;
};

// The decision recorded for an exact (scope, server, hash) triple, if any. Drives
// the "trusted-cached → skip prompt" path: a `granted` row here means the
// operator already approved this exact manifest in this scope.
export const getManifestDecision = (
  db: DB,
  scope: string,
  serverName: string,
  hash: string,
): McpManifestHistoryRow | null => {
  return (
    (db
      .query(`${MANIFEST_SELECT} WHERE scope = ? AND server_name = ? AND hash = ?`)
      .get(scope, serverName, hash) as McpManifestHistoryRow | null) ?? null
  );
};

// Most recent `granted` manifest for a (scope, server) (newest decided_at). Used
// to recognise the steady-state trusted hash across sessions.
export const latestTrustedManifest = (
  db: DB,
  scope: string,
  serverName: string,
): McpManifestHistoryRow | null => {
  return (
    (db
      .query(
        `${MANIFEST_SELECT}
          WHERE scope = ? AND server_name = ? AND decision = 'granted'
          ORDER BY decided_at DESC, id DESC
          LIMIT 1`,
      )
      .get(scope, serverName) as McpManifestHistoryRow | null) ?? null
  );
};

// Full decision history for a (scope, server), newest first. Powers `/mcp show`
// and the doctor MCP section.
export const listManifestHistory = (
  db: DB,
  scope: string,
  serverName: string,
): McpManifestHistoryRow[] => {
  return db
    .query(
      `${MANIFEST_SELECT} WHERE scope = ? AND server_name = ? ORDER BY decided_at DESC, id DESC`,
    )
    .all(scope, serverName) as McpManifestHistoryRow[];
};
