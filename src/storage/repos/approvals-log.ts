// approvals_log repo. Append-only by contract — there is no UPDATE or
// DELETE method; the migration's UNIQUE constraint on `this_hash`
// gives extra defense against double-insert. Retention/vacuum (spec
// §7.4) is a separate concern that operates on a copy under
// `approvals_log_archived` and is not implemented in this slice.

import type { SQLQueryBindings } from 'bun:sqlite';
import type { DB } from '../db.ts';

export type ApprovalLogDecision =
  | 'allow'
  | 'deny'
  | 'confirm'
  | 'confirm-allowed'
  | 'confirm-denied';

export type ApprovalLogConfidence = 'high' | 'medium' | 'low';

export interface ApprovalLogRow {
  seq: number;
  ts: number;
  install_id: string;
  session_id: string;
  parent_approval_id: string | null;
  tool_name: string;
  tool_version: string;
  resolver_version: string;
  args_hash: string;
  capabilities_json: string;
  decision: ApprovalLogDecision;
  score: number;
  score_components_json: string;
  confidence: ApprovalLogConfidence;
  classifier_hash: string | null;
  classifier_adjust: number | null;
  policy_hash: string;
  sandbox_profile: string | null;
  ttl_expires_at: number | null;
  reason_chain_json: string;
  prev_hash: string;
  this_hash: string;
}

// Insert payload — all columns except `seq` (DB-assigned).
export type AppendApprovalsLogInput = Omit<ApprovalLogRow, 'seq'>;

// Field order matches the SQL column declaration. Centralized so the
// INSERT statement and any future shape-stable iteration (e.g.
// re-serialization for canonical hashing in audit.ts) stays in sync
// with the migration.
const PERSISTED_COLUMNS = [
  'ts',
  'install_id',
  'session_id',
  'parent_approval_id',
  'tool_name',
  'tool_version',
  'resolver_version',
  'args_hash',
  'capabilities_json',
  'decision',
  'score',
  'score_components_json',
  'confidence',
  'classifier_hash',
  'classifier_adjust',
  'policy_hash',
  'sandbox_profile',
  'ttl_expires_at',
  'reason_chain_json',
  'prev_hash',
  'this_hash',
] as const;

const PLACEHOLDERS = PERSISTED_COLUMNS.map(() => '?').join(', ');
const COLUMN_LIST = PERSISTED_COLUMNS.join(', ');
const INSERT_SQL = `INSERT INTO approvals_log (${COLUMN_LIST}) VALUES (${PLACEHOLDERS})`;

// SELECT * for the row shape. We list columns explicitly (rather
// than `*`) so a future ALTER TABLE that adds a column doesn't
// silently widen the row shape into TS without a compile-time
// signal.
const SELECT_ALL = `SELECT seq, ts, install_id, session_id, parent_approval_id, tool_name,
       tool_version, resolver_version, args_hash, capabilities_json, decision,
       score, score_components_json, confidence, classifier_hash, classifier_adjust,
       policy_hash, sandbox_profile, ttl_expires_at, reason_chain_json, prev_hash, this_hash
  FROM approvals_log`;

const valuesForInsert = (input: AppendApprovalsLogInput): SQLQueryBindings[] =>
  PERSISTED_COLUMNS.map((col) => {
    const v = (input as unknown as Record<string, unknown>)[col];
    return (v ?? null) as SQLQueryBindings;
  });

export const appendApprovalsLog = (db: DB, input: AppendApprovalsLogInput): ApprovalLogRow => {
  const stmt = db.query(INSERT_SQL);
  const result = stmt.run(...valuesForInsert(input));
  const seq = Number(result.lastInsertRowid);
  return { seq, ...input };
};

export const getApprovalsLogBySeq = (db: DB, seq: number): ApprovalLogRow | null => {
  const row = db.query(`${SELECT_ALL} WHERE seq = ?`).get(seq) as ApprovalLogRow | null;
  return row;
};

// Most-recent row for the given install_id, by seq DESC. `null` when
// no rows exist (fresh install → chain is at genesis). Audit sinks
// use this to look up the `prev_hash` for the next emit.
export const getLastApprovalsLogByInstall = (db: DB, installId: string): ApprovalLogRow | null => {
  const row = db
    .query(`${SELECT_ALL} WHERE install_id = ? ORDER BY seq DESC LIMIT 1`)
    .get(installId) as ApprovalLogRow | null;
  return row;
};

// Full chain in append order (seq ASC). Used by verifyChain in
// `audit.ts` to walk the hashes. Bounded by per-install retention
// (spec §7.4 default 90d / 100k rows); calling this on a fresh
// session DB is cheap.
export const listApprovalsLogByInstall = (db: DB, installId: string): ApprovalLogRow[] => {
  return db
    .query(`${SELECT_ALL} WHERE install_id = ? ORDER BY seq ASC`)
    .all(installId) as ApprovalLogRow[];
};

export const listApprovalsLogBySession = (
  db: DB,
  sessionId: string,
  limit?: number,
): ApprovalLogRow[] => {
  if (limit !== undefined) {
    return db
      .query(`${SELECT_ALL} WHERE session_id = ? ORDER BY seq ASC LIMIT ?`)
      .all(sessionId, limit) as ApprovalLogRow[];
  }
  return db
    .query(`${SELECT_ALL} WHERE session_id = ? ORDER BY seq ASC`)
    .all(sessionId) as ApprovalLogRow[];
};

// Slice 131 fixup #3: row-bounded post-timestamp lookup. The
// `checkpoint_reverted` wire (cli/checkpoints.ts) needs "approvals
// in this session whose `ts >= ckpt.createdAt`", capped to a
// sensible blast-radius. Pre-fixup the wire used
// `listApprovalsLogBySession(db, id, 200)` which returns the
// FIRST 200 by `seq ASC` — for any long session those are
// pre-checkpoint approvals and the wire silently signaled NONE
// of the actually-reverted rows. This dedicated query pushes
// the `ts` predicate into SQL and orders `seq DESC` so the cap
// truncates the OLDEST overflow, not the newest. Recent
// approvals (the ones most likely to be reverted) always land
// in the result.
export const listApprovalsLogBySessionSinceTs = (
  db: DB,
  sessionId: string,
  sinceTs: number,
  limit: number,
): ApprovalLogRow[] => {
  return db
    .query(`${SELECT_ALL} WHERE session_id = ? AND ts >= ? ORDER BY seq DESC LIMIT ?`)
    .all(sessionId, sinceTs, limit) as ApprovalLogRow[];
};

// Slice 131 fixup #5: row-bounded recent-N lookup. The
// `session_aborted` wire takes the last 5 approvals; pre-fixup
// it materialized the whole session via `listApprovalsLogBySession`
// and called `.slice(-5)` — a long session walks 10k+ rows on
// every abort. SQL `ORDER BY seq DESC LIMIT N` gives the same
// result for ~constant cost.
export const listApprovalsLogBySessionRecent = (
  db: DB,
  sessionId: string,
  limit: number,
): ApprovalLogRow[] => {
  return db
    .query(`${SELECT_ALL} WHERE session_id = ? ORDER BY seq DESC LIMIT ?`)
    .all(sessionId, limit) as ApprovalLogRow[];
};

export const countApprovalsLog = (db: DB): number => {
  const row = db.query('SELECT COUNT(*) as n FROM approvals_log').get() as { n: number };
  return row.n;
};

// Re-export the persisted column order so audit.ts can build the
// canonical hash input from a row and KNOW it matches what the DB
// stored. Without a single source of truth, a row written in one
// column order and hashed in another would chain-break on verify.
export { PERSISTED_COLUMNS };
