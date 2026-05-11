// `agent permission policy-list [--json]` — §12.4 policy archive
// enumeration. Read-only operator surface for the `policy_archive`
// table (slice 13 schema, §17 prerequisite + §12.4 rollback read
// side). DB-only path — no provider, no session start.
//
// The archive stores one row per UNIQUE policy hash the engine
// ever booted with. Bootstrap upserts on every start; identical
// reboots only update `last_seen_ms`. The list shows operators
// the install's policy history, which a future `policy-rollback`
// verb consumes for the write side (§12.4 line 753 "reverte pra
// última policy válida").
//
// Output rows: hash, first_seen, last_seen, canonical_json byte
// size, and a `current` flag marking the most-recently-booted
// policy. The current row is determined by `MAX(last_seen_ms)` —
// not necessarily the SAME as the bootstrap's just-now policy
// (the engine path doesn't pass back the active hash to the CLI),
// but in practice it's a reliable indicator since the just-booted
// policy gets its last_seen_ms bumped on every run.

import { MIGRATIONS, defaultDbPath, migrate, openDb } from '../storage/index.ts';
import { listPolicyArchive } from '../storage/repos/policy-archive.ts';

export interface RunPermissionPolicyListOptions {
  json?: boolean;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

interface RowOut {
  policy_hash: string;
  first_seen_ms: number;
  last_seen_ms: number;
  bytes: number;
  current: boolean;
}

const buildRows = (
  archive: ReadonlyArray<{
    policy_hash: string;
    canonical_json: string;
    first_seen_ms: number;
    last_seen_ms: number;
  }>,
): RowOut[] => {
  if (archive.length === 0) return [];
  let maxLastSeen = -1;
  for (const r of archive) {
    if (r.last_seen_ms > maxLastSeen) maxLastSeen = r.last_seen_ms;
  }
  return archive.map((r) => ({
    policy_hash: r.policy_hash,
    first_seen_ms: r.first_seen_ms,
    last_seen_ms: r.last_seen_ms,
    bytes: r.canonical_json.length,
    current: r.last_seen_ms === maxLastSeen,
  }));
};

// Plain-text rendering. Compact one-line-per-row table with the
// hash truncated to 16 chars (operators copy the full hash from
// JSON mode if they need it). ISO-rendered timestamps keep the
// output human-comparable across timezones.
const renderPlain = (rows: ReadonlyArray<RowOut>): string => {
  if (rows.length === 0) {
    return 'policy archive: (empty — no engine bootstraps recorded yet)\n';
  }
  const lines: string[] = [`policy archive (${rows.length} row${rows.length === 1 ? '' : 's'}):`];
  // Header. Hash | first_seen | last_seen | bytes | current.
  lines.push('');
  for (const r of rows) {
    const flag = r.current ? '*' : ' ';
    const firstIso = new Date(r.first_seen_ms).toISOString();
    const lastIso = new Date(r.last_seen_ms).toISOString();
    lines.push(
      `  ${flag} ${r.policy_hash.slice(0, 24)}…  first=${firstIso}  last=${lastIso}  bytes=${r.bytes}`,
    );
  }
  lines.push('');
  lines.push('(* = most-recently-booted policy)');
  return `${lines.join('\n')}\n`;
};

export const runPermissionPolicyList = async (
  options: RunPermissionPolicyListOptions = {},
): Promise<number> => {
  const out = options.out ?? ((s) => process.stdout.write(s));
  const err = options.err ?? ((s) => process.stderr.write(s));
  const json = options.json === true;
  const dbPath = options.dbPath ?? defaultDbPath();

  let rows: RowOut[];
  try {
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const archive = listPolicyArchive(db);
    rows = buildRows(archive);
  } catch (e) {
    const reason = (e as Error).message;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'db', message: reason })}\n`);
    } else {
      err(`forja permission policy-list: ${reason}\n`);
    }
    return 1;
  }

  if (json) {
    for (const r of rows) out(`${JSON.stringify(r)}\n`);
    return 0;
  }
  out(renderPlain(rows));
  return 0;
};
