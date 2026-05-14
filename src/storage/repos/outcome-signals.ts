// outcome_signals repo. Append-only — no UPDATE or DELETE method.
// Retention is per-row (`ttl_expires_at`) so the future `agent gc`
// path filters via WHERE clauses rather than per-table policy.
//
// Schema in migration 042-outcome-signals.ts. Linked to
// approvals_log via FK on `approval_seq`; the FK CASCADE keeps
// the join tight if an approval row is ever removed (shouldn't,
// append-only, but defensive). Read paths are bounded by
// approval_seq (aggregator) or signal_kind window (trend queries),
// both backed by the migration's indices.

import type { SQLQueryBindings } from 'bun:sqlite';
import type { DB } from '../db.ts';

export interface OutcomeSignalRow {
  id: string;
  approval_seq: number;
  install_id: string;
  signal_kind: string;
  signal_weight: number;
  payload_json: string | null;
  observed_at: number;
  detected_at: number;
  ttl_expires_at: number;
}

export type AppendOutcomeSignalInput = OutcomeSignalRow;

const PERSISTED_COLUMNS = [
  'id',
  'approval_seq',
  'install_id',
  'signal_kind',
  'signal_weight',
  'payload_json',
  'observed_at',
  'detected_at',
  'ttl_expires_at',
] as const;

const PLACEHOLDERS = PERSISTED_COLUMNS.map(() => '?').join(', ');
const COLUMN_LIST = PERSISTED_COLUMNS.join(', ');
const INSERT_SQL = `INSERT INTO outcome_signals (${COLUMN_LIST}) VALUES (${PLACEHOLDERS})`;

// Explicit SELECT list — a future ALTER widening the row shape
// must trip a compile-time signal, not silently broaden TS.
const SELECT_ALL = `SELECT id, approval_seq, install_id, signal_kind, signal_weight, payload_json,
       observed_at, detected_at, ttl_expires_at
  FROM outcome_signals`;

const valuesForInsert = (input: AppendOutcomeSignalInput): SQLQueryBindings[] =>
  PERSISTED_COLUMNS.map((col) => {
    const v = (input as unknown as Record<string, unknown>)[col];
    return (v ?? null) as SQLQueryBindings;
  });

export const appendOutcomeSignal = (db: DB, input: AppendOutcomeSignalInput): OutcomeSignalRow => {
  db.query(INSERT_SQL).run(...valuesForInsert(input));
  return input;
};

// Primary aggregator query: every signal observed for a given
// approval. Ordering by detected_at ASC keeps forensic
// reconstruction in time order; the aggregator itself doesn't
// depend on ordering (max-wins composite) but operators reading
// raw rows benefit from the natural sequence.
export const listOutcomeSignalsByApproval = (db: DB, approval_seq: number): OutcomeSignalRow[] => {
  return db
    .query(`${SELECT_ALL} WHERE approval_seq = ? ORDER BY detected_at ASC, id ASC`)
    .all(approval_seq) as OutcomeSignalRow[];
};

// Slice 131 fixup #1: post-rotation aggregation. With the FK
// gone, signals outlive their approval row. Calibration scripts
// joining across `approvals_log` + `approvals_log_archived` can
// pivot on `install_id` to scope the join cleanly.
export const listOutcomeSignalsByInstall = (
  db: DB,
  install_id: string,
  since: number,
  limit: number,
): OutcomeSignalRow[] => {
  return db
    .query(
      `${SELECT_ALL} WHERE install_id = ? AND detected_at >= ? ORDER BY detected_at DESC LIMIT ?`,
    )
    .all(install_id, since, limit) as OutcomeSignalRow[];
};

// Trend query: count signals of a given kind since `since`.
// Powers "calibration coverage: how many checkpoint_reverted
// events in the last 30 days?" without dragging every row across
// the boundary. Caller supplies the time bound — no default to
// force explicit awareness of scan scope.
export const countSignalsByKindSince = (db: DB, signal_kind: string, since: number): number => {
  const row = db
    .query(
      `SELECT COUNT(*) as n FROM outcome_signals
        WHERE signal_kind = ? AND detected_at >= ?`,
    )
    .get(signal_kind, since) as { n: number };
  return row.n;
};

// Cross-kind aggregation for monitoring dashboards. Returns rows
// grouped by kind in count DESC; complements
// countSignalsByKindSince when the caller wants the full
// distribution rather than one kind.
export const countSignalsByKindGrouped = (
  db: DB,
  since: number,
): Array<{ signal_kind: string; count: number }> => {
  return db
    .query(
      `SELECT signal_kind, COUNT(*) as count
         FROM outcome_signals
        WHERE detected_at >= ?
        GROUP BY signal_kind
        ORDER BY count DESC`,
    )
    .all(since) as Array<{ signal_kind: string; count: number }>;
};

export const countOutcomeSignals = (db: DB): number => {
  const row = db.query('SELECT COUNT(*) as n FROM outcome_signals').get() as { n: number };
  return row.n;
};

export { PERSISTED_COLUMNS };
