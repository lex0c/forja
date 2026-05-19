// GC orchestrator. Spec: AGENTIC_CLI.md §2.1.3 (operator-facing
// surface), AUDIT.md §1.2 (retention semantics).
//
// Pure-data layer (no CLI rendering, no FS, no stdout): takes a
// DB + config + now + dry-run flag and produces a `GcReport`
// describing what would happen (dry-run) or what happened (force).
// The CLI handler in `src/cli/gc.ts` consumes this and renders.
//
// Phase 1 contract: iterate the four supported tables; for each,
// count before, optionally delete, count after. Per-table failures
// are captured in `errors[]` but do NOT abort the orchestrator —
// gc is best-effort hygiene, and a single broken table shouldn't
// keep the other three from getting swept. Operator sees the
// aggregate; the broken one surfaces with reason.

import type { DB } from '../storage/db.ts';
import { pruneBgProcesses } from '../storage/repos/bg-processes.ts';
import { pruneContextPins } from '../storage/repos/context-pins.ts';
// `purgeExpiredRecapCache` predates the gc subsystem (RECAP §8.3
// inline cleanup). We reuse it rather than ship a parallel
// `pruneExpiredRecapCache` — the semantic is identical (sweep
// expired rows) and divergence between the two would mean read-path
// eviction and gc-path eviction could disagree on the boundary.
import { purgeExpiredRecapCache } from '../storage/repos/recap-cache.ts';
import { pruneRetrievalTrace } from '../storage/repos/retrieval-trace.ts';
import type { RetentionConfig } from './config-loader.ts';

// Phase 1 table names. Adding a table here without wiring the
// switch in `sweepOne` below is a refactor footgun — the test
// suite covers parity, but the constant is the source of truth
// for "what `agent gc` knows about" today.
export const PHASE_1_TABLES = [
  'recap_cache',
  'retrieval_trace',
  'context_pins',
  'bg_processes',
] as const;

export type Phase1Table = (typeof PHASE_1_TABLES)[number];

export interface TableReport {
  table: Phase1Table;
  beforeCount: number;
  // For dry-run, this is "would delete"; for force, this is
  // "actually deleted". Naming is uniform (just `deletedCount`)
  // because the `mode` field on the parent GcReport disambiguates
  // — duplicating field names would mean callers branch on mode
  // twice (read mode + read field), violating "one source of
  // truth per number".
  deletedCount: number;
  // The cutoff timestamp used for this sweep. For `recap_cache`,
  // this is `nowMs` (the comparison point for `expires_at`); for
  // the other three, it's `nowMs - retentionDays * 86_400_000`.
  // Exposed for forensic / config debugging ("why did 384 rows
  // get evicted? — because cutoff was X, and 384 rows had ts <
  // X").
  cutoffMs: number;
}

export interface TableError {
  table: Phase1Table;
  reason: string;
}

export interface GcReport {
  mode: 'dry-run' | 'force';
  // nowMs the orchestrator used; echoed so dry-run output is
  // reproducible against the same DB state.
  nowMs: number;
  config: RetentionConfig;
  // One entry per table that the orchestrator attempted. Tables
  // filtered out by `tables?` option don't appear here.
  tables: TableReport[];
  // Per-table errors (no aborts). When `errors.length > 0`, the
  // CLI emits non-zero exit + stderr lines summarizing each.
  errors: TableError[];
}

export interface RunGcInput {
  db: DB;
  config: RetentionConfig;
  // Comparison point for "is this row past retention?". Production
  // passes Date.now(); tests inject a fixed value. Validated > 0
  // by each prune helper, but we re-check here so the orchestrator
  // can reject before any per-table call (cleaner error surface).
  nowMs: number;
  dryRun: boolean;
  // Restrict to a subset of Phase 1 tables. Undefined = all four.
  // Unknown table names are caller's bug — orchestrator silently
  // drops them (the CLI parser is the proper place to reject).
  tables?: ReadonlyArray<Phase1Table>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Compute the age cutoff (rows with `ts < cutoffMs` are deletable)
// for a given retention-in-days. For `recap_cache` we use `nowMs`
// directly against the per-row `expires_at` — separate code path
// because the comparison is "TTL elapsed", not "age-based".
const computeCutoffForTable = (
  table: Phase1Table,
  config: RetentionConfig,
  nowMs: number,
): number => {
  switch (table) {
    case 'recap_cache':
      return nowMs;
    case 'retrieval_trace':
      return nowMs - config.retrieval_trace_days * DAY_MS;
    case 'context_pins':
      return nowMs - config.context_pins_days * DAY_MS;
    case 'bg_processes':
      return nowMs - config.bg_processes_days * DAY_MS;
  }
};

// SELECT COUNT — used for both the pre-delete baseline AND the
// dry-run "would delete" projection. For `bg_processes`, the
// dry-run count must exclude `status = 'running'` to match the
// real delete predicate. For `recap_cache`, the boundary is `<=`
// to match the read-path eviction inside `purgeExpiredRecapCache`
// (RECAP §8.3) — a TTL of exactly `nowMs` is considered elapsed.
const countWouldDelete = (db: DB, table: Phase1Table, cutoffMs: number): number => {
  let sql: string;
  switch (table) {
    case 'recap_cache':
      sql = 'SELECT COUNT(*) AS n FROM recap_cache WHERE expires_at <= ?';
      break;
    case 'retrieval_trace':
      sql = 'SELECT COUNT(*) AS n FROM retrieval_trace WHERE created_at < ?';
      break;
    case 'context_pins':
      sql = 'SELECT COUNT(*) AS n FROM context_pins WHERE created_at < ?';
      break;
    case 'bg_processes':
      sql =
        "SELECT COUNT(*) AS n FROM background_processes WHERE spawned_at < ? AND status != 'running'";
      break;
  }
  const row = db.query(sql).get(cutoffMs) as { n: number } | null;
  return row?.n ?? 0;
};

const countTotal = (db: DB, table: Phase1Table): number => {
  const tableName = table === 'bg_processes' ? 'background_processes' : table;
  const row = db.query(`SELECT COUNT(*) AS n FROM ${tableName}`).get() as { n: number } | null;
  return row?.n ?? 0;
};

const sweepOne = (
  db: DB,
  table: Phase1Table,
  cutoffMs: number,
  dryRun: boolean,
): { beforeCount: number; deletedCount: number } => {
  const beforeCount = countTotal(db, table);
  if (dryRun) {
    return { beforeCount, deletedCount: countWouldDelete(db, table, cutoffMs) };
  }
  let deleted: number;
  switch (table) {
    case 'recap_cache':
      deleted = purgeExpiredRecapCache(db, cutoffMs);
      break;
    case 'retrieval_trace':
      deleted = pruneRetrievalTrace(db, cutoffMs);
      break;
    case 'context_pins':
      deleted = pruneContextPins(db, cutoffMs);
      break;
    case 'bg_processes':
      deleted = pruneBgProcesses(db, cutoffMs);
      break;
  }
  return { beforeCount, deletedCount: deleted };
};

export const runGc = (input: RunGcInput): GcReport => {
  if (!Number.isFinite(input.nowMs) || input.nowMs <= 0) {
    throw new Error(`runGc: nowMs must be a positive finite number (got ${input.nowMs})`);
  }
  const tables = input.tables ?? PHASE_1_TABLES;
  const reports: TableReport[] = [];
  const errors: TableError[] = [];

  for (const table of tables) {
    const cutoffMs = computeCutoffForTable(table, input.config, input.nowMs);
    try {
      const { beforeCount, deletedCount } = sweepOne(input.db, table, cutoffMs, input.dryRun);
      reports.push({ table, beforeCount, deletedCount, cutoffMs });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      errors.push({ table, reason });
    }
  }

  return {
    mode: input.dryRun ? 'dry-run' : 'force',
    nowMs: input.nowMs,
    config: input.config,
    tables: reports,
    errors,
  };
};
