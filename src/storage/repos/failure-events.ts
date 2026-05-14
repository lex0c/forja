// failure_events repo. Append-only — no UPDATE or DELETE method.
// Retention (spec §1.2: failure_events 365d) operates from a
// separate `agent gc` path landed in a later slice; this module
// only provides INSERT + read primitives.
//
// Schema in migration 041-failure-events.ts. Distinct from
// approvals_log (migration 034) in two key ways:
//
//   1. Primary key is TEXT id (ULID, src/permissions/ulid.ts),
//      not auto-increment INTEGER seq. Per FAILURE_MODES.md §19
//      ("id TEXT PRIMARY KEY"). ULID is sortable + globally
//      unique so seq collision across installs / DB copies is
//      structurally prevented.
//
//   2. Chain is per-session, not per-install. The writer
//      (src/failures/sink.ts) walks per-session prev_chain_hash
//      lookups via getLastFailureEventBySession below.
//
// install_id intentionally absent — the per-session chain makes
// cross-install pollution a misattributed-row problem only, not a
// chain-break vector. ALTER to add later if multi-install DB
// sharing becomes load-bearing.

import type { SQLQueryBindings } from 'bun:sqlite';
import type { DB } from '../db.ts';

export interface FailureEventRow {
  id: string;
  session_id: string;
  step_id: string | null;
  code: string;
  classe: string;
  recovery_action: string;
  user_visible: number; // 0 or 1
  payload_json: string | null;
  created_at: number;
  prev_chain_hash: string;
  this_chain_hash: string;
}

export type AppendFailureEventInput = FailureEventRow;

// Column order mirrors the migration's CREATE TABLE so the
// canonical hash payload computed in the sink stays byte-stable
// with what was actually persisted. A column reorder here without
// updating the sink would chain-break on verify.
const PERSISTED_COLUMNS = [
  'id',
  'session_id',
  'step_id',
  'code',
  'classe',
  'recovery_action',
  'user_visible',
  'payload_json',
  'created_at',
  'prev_chain_hash',
  'this_chain_hash',
] as const;

const PLACEHOLDERS = PERSISTED_COLUMNS.map(() => '?').join(', ');
const COLUMN_LIST = PERSISTED_COLUMNS.join(', ');
const INSERT_SQL = `INSERT INTO failure_events (${COLUMN_LIST}) VALUES (${PLACEHOLDERS})`;

// Explicit SELECT list — same defensive rationale as
// approvals-log.ts: a future ALTER widening the row shape must
// trip a compile-time signal, not silently broaden TS.
const SELECT_ALL = `SELECT id, session_id, step_id, code, classe, recovery_action,
       user_visible, payload_json, created_at, prev_chain_hash, this_chain_hash
  FROM failure_events`;

const valuesForInsert = (input: AppendFailureEventInput): SQLQueryBindings[] =>
  PERSISTED_COLUMNS.map((col) => {
    const v = (input as unknown as Record<string, unknown>)[col];
    return (v ?? null) as SQLQueryBindings;
  });

export const appendFailureEvent = (db: DB, input: AppendFailureEventInput): FailureEventRow => {
  db.query(INSERT_SQL).run(...valuesForInsert(input));
  return input;
};

// Most-recent row in a session's chain. The sink consults this to
// pick `prev_chain_hash` for the next emit. Ordering by created_at
// DESC works because the writer asserts monotonic timestamps; a
// fallback secondary sort on `id` (ULIDs are lexically sortable by
// time) handles same-millisecond collisions deterministically.
export const getLastFailureEventBySession = (
  db: DB,
  session_id: string,
): FailureEventRow | null => {
  const row = db
    .query(`${SELECT_ALL} WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(session_id) as FailureEventRow | null;
  return row;
};

// Full chain in append order (created_at ASC, id ASC tiebreak).
// Used by verifyChain to walk hashes for a session. Bounded by
// per-session retention; typical session has 0-3 failure events.
export const listFailureEventsBySession = (db: DB, session_id: string): FailureEventRow[] => {
  return db
    .query(`${SELECT_ALL} WHERE session_id = ? ORDER BY created_at ASC, id ASC`)
    .all(session_id) as FailureEventRow[];
};

// Cross-session list by code, newest first, capped. Powers the
// canonical AUDIT.md §6 query "show me all storage.lock_contention
// failures in the last 7 days". Caller supplies `since` and
// `limit`; no default to force operator awareness of scan bounds.
export const listFailureEventsByCode = (
  db: DB,
  code: string,
  since: number,
  limit: number,
): FailureEventRow[] => {
  return db
    .query(`${SELECT_ALL} WHERE code = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?`)
    .all(code, since, limit) as FailureEventRow[];
};

// Aggregation: per-code count since `since`. Surfaces trends
// without dragging every row across the boundary. Operator-facing
// AUDIT.md §6 query "what failed most this week".
export const countFailuresByCodeSince = (
  db: DB,
  since: number,
): Array<{ code: string; count: number }> => {
  return db
    .query(
      `SELECT code, COUNT(*) as count
         FROM failure_events
        WHERE created_at >= ?
        GROUP BY code
        ORDER BY count DESC`,
    )
    .all(since) as Array<{ code: string; count: number }>;
};

export const countFailureEvents = (db: DB): number => {
  const row = db.query('SELECT COUNT(*) as n FROM failure_events').get() as { n: number };
  return row.n;
};

// Re-export the persisted column order so the sink's canonical
// hash payload mirrors the DB's column declaration exactly. Same
// single-source-of-truth pattern approvals-log.ts uses.
export { PERSISTED_COLUMNS };
