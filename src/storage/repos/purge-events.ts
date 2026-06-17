// purge_events repo. Append-only from the OPERATOR'S perspective —
// the only mutation surface exposed here is the retention sweep
// (365d, per AUDIT.md §1.2), wired into the gc orchestrator
// (src/audit/gc.ts). No per-row UPDATE / DELETE-by-id ever lands;
// the contract is "append for writes; sweep by age only for the
// gc retention path".
//
// The append-only test pin in tests/storage/purge-events.test.ts
// whitelists `prunePurgeEvents` for exactly this reason: it is the
// single legitimate mutation surface. Any other DELETE/UPDATE
// addition (per-row delete, status update, etc.) should fail the
// whitelist test and force a discussion about why the append-only
// invariant should bend further.
//
// Schema in migration 066-purge-events.ts. Distinct from
// approvals_log (the permission-engine hash-chained ledger) in two
// ways:
//
//   1. No hash chain. Purge is an operational event, not a policy
//      decision with replay semantics. Tampering with rows here
//      doesn't break a verifiable chain — the trade-off is accepted
//      because `forja purge` happens rarely and the cost of a chain
//      (per-write read-modify-write, install-scoped genesis) is
//      disproportionate to the threat model.
//
//   2. No session_id. Purge fires outside any session — the project
//      bootstrap is the thing being removed, so there is no live
//      session to attribute to. `install_id` carries identity
//      instead, mirroring the approvals_log install scoping.

import type { SQLQueryBindings } from 'bun:sqlite';
import type { DB } from '../db.ts';

export interface PurgeEventRow {
  id: number;
  ts: number;
  install_id: string;
  cwd: string;
  artifacts_present_json: string;
  bytes_present: number;
  files_present: number;
  dirs_present: number;
  forja_version: string;
}

// Insert payload — all columns except `id` (DB-assigned via
// AUTOINCREMENT).
export type InsertPurgeEventInput = Omit<PurgeEventRow, 'id'>;

// Column order mirrors the migration's CREATE TABLE. A reorder here
// without touching the migration silently breaks index assumptions
// in downstream readers — caught at test boot time when the
// migration assertion runs.
const PERSISTED_COLUMNS = [
  'ts',
  'install_id',
  'cwd',
  'artifacts_present_json',
  'bytes_present',
  'files_present',
  'dirs_present',
  'forja_version',
] as const;

const PLACEHOLDERS = PERSISTED_COLUMNS.map(() => '?').join(', ');
const COLUMN_LIST = PERSISTED_COLUMNS.join(', ');
const INSERT_SQL = `INSERT INTO purge_events (${COLUMN_LIST}) VALUES (${PLACEHOLDERS})`;

// Explicit SELECT list — defensive against future ALTER broadening
// the row shape and silently widening TS. A new column lands as a
// compile-time signal here, not as `undefined` slipping into
// downstream consumers.
const SELECT_ALL = `SELECT id, ts, install_id, cwd, artifacts_present_json,
       bytes_present, files_present, dirs_present, forja_version
  FROM purge_events`;

const valuesForInsert = (input: InsertPurgeEventInput): SQLQueryBindings[] =>
  PERSISTED_COLUMNS.map((col) => {
    const v = (input as unknown as Record<string, unknown>)[col];
    return v as SQLQueryBindings;
  });

// Insert a new purge_events row. Returns the assigned `id` from
// `result.lastInsertRowid` — same pattern as approvals_log /
// chain_rotation, avoids a second SELECT round-trip. Callers
// (cli/purge.ts) surface the id in the force-mode JSON output so
// operators can correlate stdout with the DB row.
export const insertPurgeEvent = (db: DB, input: InsertPurgeEventInput): PurgeEventRow => {
  const result = db.query(INSERT_SQL).run(...valuesForInsert(input));
  return { id: Number(result.lastInsertRowid), ...input };
};

// List purge events for a given cwd, most recent first. Bounded by
// `limit` (default 50) so a hypothetical operator with thousands of
// purges doesn't OOM the inspector. Used by future
// `forja purge log` reader and by tests that pin the insert path.
export const listPurgeEventsByCwd = (db: DB, cwd: string, limit = 50): PurgeEventRow[] => {
  return db
    .query(`${SELECT_ALL} WHERE cwd = ? ORDER BY ts DESC LIMIT ?`)
    .all(cwd, limit) as PurgeEventRow[];
};

// Retention sweep — the ONLY mutation surface on this table. Deletes
// rows strictly OLDER than `cutoffMs` (`ts < cutoffMs`), preserving
// rows with `ts === cutoffMs`. The strict-less-than boundary matches
// every other age-based prune helper in the gc orchestrator
// (retrieval_trace, context_pins, memory_events, hook_runs,
// failure_events, eviction_events, outcomes) — operators observing
// multiple tables in the same gc run see consistent boundary
// semantics across the board.
//
// Returns the row count from `result.changes`, mirroring the same
// shape used by sister prune functions. The gc orchestrator
// (src/audit/gc.ts:sweepOne) consumes this for the force-mode
// `deletedCount` field.
//
// No `> 0` validation on cutoffMs: the orchestrator's runGc input
// validator rejects non-positive `nowMs` before any per-table call,
// and every cutoff is derived from `nowMs - days * DAY_MS` where
// `days >= 1` is enforced by parseDays. Defense-in-depth would mean
// re-validating here, but the validation lives where the input
// boundary is (orchestrator), not at every leaf.
export const prunePurgeEvents = (db: DB, cutoffMs: number): number => {
  const result = db.query('DELETE FROM purge_events WHERE ts < ?').run(cutoffMs);
  return Number(result.changes);
};
