// GC orchestrator. Spec: AGENTIC_CLI.md §2.1.3 (operator-facing
// surface), AUDIT.md §1.2 (retention semantics).
//
// Pure-data layer (no CLI rendering, no FS, no stdout): takes a
// DB + config + now + dry-run flag and produces a `GcReport`
// describing what would happen (dry-run) or what happened (force).
// The CLI handler in `src/cli/gc.ts` consumes this and renders.
//
// Contract: iterate every covered table; for each, count before,
// optionally delete, count after. Per-table failures are captured
// in `errors[]` but do NOT abort the orchestrator — gc is
// best-effort hygiene, and a single broken table shouldn't keep
// the others from getting swept. Operator sees the aggregate; the
// broken one surfaces with reason.

import type { DB } from '../storage/db.ts';
import { pruneBgProcesses } from '../storage/repos/bg-processes.ts';
import { pruneContextPins } from '../storage/repos/context-pins.ts';
import { pruneEvictionEvents } from '../storage/repos/eviction-events.ts';
import { pruneFailureEvents } from '../storage/repos/failure-events.ts';
import { pruneHookRuns } from '../storage/repos/hook-runs.ts';
import { pruneMemoryEvents } from '../storage/repos/memory-events.ts';
import { pruneExpiredOutcomeSignals } from '../storage/repos/outcome-signals.ts';
import { pruneOutcomes } from '../storage/repos/outcomes.ts';
import { prunePurgeEvents } from '../storage/repos/purge-events.ts';
// `purgeExpiredRecapCache` predates the gc subsystem (RECAP §8.3
// inline cleanup). We reuse it rather than ship a parallel
// `pruneExpiredRecapCache` — the semantic is identical (sweep
// expired rows) and divergence between the two would mean read-path
// eviction and gc-path eviction could disagree on the boundary.
import { purgeExpiredRecapCache } from '../storage/repos/recap-cache.ts';
import { pruneRetrievalTrace } from '../storage/repos/retrieval-trace.ts';
import type { RetentionConfig } from './config-loader.ts';

// The table-name constants + types live in a separate zero-imports
// module (`gc-tables.ts`) so that `cli/args.ts` can import them
// without pulling the gc runtime graph (storage repos + memory
// chain via eviction-events). args.ts is loaded by EVERY agent
// invocation including --help and --version; depending on the
// runtime graph there breaks lightweight commands when any deep
// storage dep is unavailable. We re-export them here so existing
// consumers of audit/gc.ts (orchestrator + CLI handler) don't
// need to change their import paths.
//
// Adding a table without wiring the switches in `sweepOne` /
// `computeCutoffForTable` / `countWouldDelete` below is a refactor
// footgun — keep them in lockstep with the table list in
// gc-tables.ts.
export {
  GC_TABLES,
  type GcTable,
  PHASE_1_TABLES,
  PHASE_2_TABLES,
  PHASE_3_TABLES,
  type Phase1Table,
  type Phase2Table,
  type Phase3Table,
} from './gc-tables.ts';

import { GC_TABLES, type GcTable } from './gc-tables.ts';

export interface TableReport {
  table: GcTable;
  beforeCount: number;
  // For dry-run, this is "would delete"; for force, this is
  // "actually deleted". Naming is uniform (just `deletedCount`)
  // because the `mode` field on the parent GcReport disambiguates
  // — duplicating field names would mean callers branch on mode
  // twice (read mode + read field), violating "one source of
  // truth per number".
  deletedCount: number;
  // The cutoff timestamp used for this sweep. For TTL-based tables
  // (`recap_cache`, `outcome_signals`), this is `nowMs` itself
  // (the comparison point for `expires_at` / `ttl_expires_at`); for
  // the age-based tables, it's `nowMs - retentionDays * 86_400_000`.
  // Exposed for forensic / config debugging ("why did 384 rows get
  // evicted? — because cutoff was X, and 384 rows had ts < X").
  cutoffMs: number;
}

export interface TableError {
  table: GcTable;
  reason: string;
}

export interface GcReport {
  mode: 'dry-run' | 'force';
  // nowMs the orchestrator used; echoed so dry-run output is
  // reproducible against the same DB state.
  nowMs: number;
  config: RetentionConfig;
  // One entry per table that the orchestrator attempted. Tables
  // filtered out by `tables?` option don't appear here. Tables
  // SKIPPED due to config (e.g., outcome_signals with
  // outcomeSignalsEnabled=false) also don't appear.
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
  // Restrict to a subset of GC_TABLES. Undefined = all 10.
  // Unknown table names are caller's bug — orchestrator silently
  // drops them (the CLI parser is the proper place to reject).
  tables?: ReadonlyArray<GcTable>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Compute the age cutoff (rows with `ts < cutoffMs` are deletable)
// for a given retention-in-days. For TTL-based tables we use
// `nowMs` directly against the per-row TTL column — separate code
// path because the comparison is "TTL elapsed", not "age-based".
const computeCutoffForTable = (table: GcTable, config: RetentionConfig, nowMs: number): number => {
  switch (table) {
    // TTL-based (compare nowMs against per-row column):
    case 'recap_cache':
    case 'outcome_signals':
      return nowMs;
    // Age-based (compare cutoff against per-row created/recorded/spawned):
    case 'retrieval_trace':
      return nowMs - config.retrieval_trace_days * DAY_MS;
    case 'context_pins':
      return nowMs - config.context_pins_days * DAY_MS;
    case 'bg_processes':
      return nowMs - config.bg_processes_days * DAY_MS;
    case 'memory_events':
      return nowMs - config.memory_events_days * DAY_MS;
    case 'hook_runs':
      return nowMs - config.hook_runs_days * DAY_MS;
    case 'failure_events':
      return nowMs - config.failure_events_days * DAY_MS;
    case 'eviction_events':
      return nowMs - config.eviction_events_days * DAY_MS;
    case 'outcomes':
      return nowMs - config.outcomes_days * DAY_MS;
    // Phase 3 — standalone audit ledger (no FK, no chain):
    case 'purge_events':
      return nowMs - config.purge_events_days * DAY_MS;
  }
};

// SELECT COUNT — used for both the pre-delete baseline AND the
// dry-run "would delete" projection. Per-table predicate matches
// the real DELETE predicate exactly:
//   - bg_processes: excludes status='running' (live processes
//     never deleted regardless of age).
//   - recap_cache + outcome_signals: TTL-based with `<=` boundary
//     (INCLUSIVE on equality — TTL exactly = nowMs is elapsed).
//     Sister tables share the boundary so operators observing both
//     in the same gc run see consistent semantics.
//   - others: age-based with `<` cutoff (EXCLUSIVE — natural for
//     "strictly older than retention window").
const countWouldDelete = (db: DB, table: GcTable, cutoffMs: number): number => {
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
    case 'memory_events':
      sql = 'SELECT COUNT(*) AS n FROM memory_events WHERE created_at < ?';
      break;
    case 'hook_runs':
      sql = 'SELECT COUNT(*) AS n FROM hook_runs WHERE created_at < ?';
      break;
    case 'failure_events':
      sql = 'SELECT COUNT(*) AS n FROM failure_events WHERE created_at < ?';
      break;
    case 'eviction_events':
      sql = 'SELECT COUNT(*) AS n FROM eviction_events WHERE recorded_at < ?';
      break;
    case 'outcomes':
      sql = 'SELECT COUNT(*) AS n FROM outcomes WHERE recorded_at < ?';
      break;
    case 'outcome_signals':
      sql = 'SELECT COUNT(*) AS n FROM outcome_signals WHERE ttl_expires_at <= ?';
      break;
    case 'purge_events':
      // Age-based on `ts` (epoch ms at confirmation time, CHECK > 0
      // in migration 066). Strict `<` boundary mirrors other
      // age-based tables; equal-cutoff rows survive.
      sql = 'SELECT COUNT(*) AS n FROM purge_events WHERE ts < ?';
      break;
  }
  const row = db.query(sql).get(cutoffMs) as { n: number } | null;
  return row?.n ?? 0;
};

const countTotal = (db: DB, table: GcTable): number => {
  const tableName = table === 'bg_processes' ? 'background_processes' : table;
  const row = db.query(`SELECT COUNT(*) AS n FROM ${tableName}`).get() as { n: number } | null;
  return row?.n ?? 0;
};

const sweepOne = (
  db: DB,
  table: GcTable,
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
    case 'memory_events':
      deleted = pruneMemoryEvents(db, cutoffMs);
      break;
    case 'hook_runs':
      deleted = pruneHookRuns(db, cutoffMs);
      break;
    case 'failure_events':
      deleted = pruneFailureEvents(db, cutoffMs);
      break;
    case 'eviction_events':
      deleted = pruneEvictionEvents(db, cutoffMs);
      break;
    case 'outcomes':
      deleted = pruneOutcomes(db, cutoffMs);
      break;
    case 'outcome_signals':
      deleted = pruneExpiredOutcomeSignals(db, cutoffMs);
      break;
    case 'purge_events':
      deleted = prunePurgeEvents(db, cutoffMs);
      break;
  }
  return { beforeCount, deletedCount: deleted };
};

// Honor config-driven skip: when outcome_signals sweep is disabled,
// we drop the table from the iteration entirely — the report
// omits it (not "0 deletes") so the operator sees "this was
// genuinely not processed".
const isTableEnabled = (table: GcTable, config: RetentionConfig): boolean => {
  if (table === 'outcome_signals') return config.outcomeSignalsEnabled;
  return true;
};

export const runGc = (input: RunGcInput): GcReport => {
  if (!Number.isFinite(input.nowMs) || input.nowMs <= 0) {
    throw new Error(`runGc: nowMs must be a positive finite number (got ${input.nowMs})`);
  }
  const tables = input.tables ?? GC_TABLES;
  const reports: TableReport[] = [];
  const errors: TableError[] = [];

  for (const table of tables) {
    if (!isTableEnabled(table, input.config)) continue;
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
