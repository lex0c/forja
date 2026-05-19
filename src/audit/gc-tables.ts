// Standalone constants + types for the gc-covered tables. Lives
// separately from audit/gc.ts (the orchestrator) so that consumers
// who only need the table-name set — notably src/cli/args.ts for
// --table=X parser validation — can import the data without
// pulling the gc runtime graph (storage repos, memory deps via
// eviction-events, etc.).
//
// Why this matters: cli/args.ts is loaded by EVERY agent
// invocation, including `agent --help` and `agent --version`. If
// the parser pulled audit/gc.ts at module load time, those
// lightweight commands would fail whenever any deep storage
// dependency was unavailable (broken native binding, partial
// install, missing peer dep). The lazy-import posture for heavy
// runtime modules is documented in src/cli/index.ts — runtime
// handlers are dynamic-imported from inside main() so help/
// version stay immune to provider/storage wiring failures. This
// module preserves that invariant for the gc data the parser
// needs.
//
// ZERO IMPORTS. Adding any import here (even a type-only one to
// a module with side effects) re-introduces the coupling. The
// drift-guard test in tests/cli/args-gc.test.ts pins that
// cli/args.ts imports from THIS file, not from audit/gc.ts.

// Phase 1 — low-sensitivity tables (no chain integrity).
export const PHASE_1_TABLES = [
  'recap_cache',
  'retrieval_trace',
  'context_pins',
  'bg_processes',
] as const;

// Phase 2 — audit-cascade tables (FK SET NULL or CASCADE with
// sessions). Each has per-table semantic edge case documented in
// the corresponding prune helper.
export const PHASE_2_TABLES = [
  'memory_events',
  'hook_runs',
  'failure_events',
  'eviction_events',
  'outcomes',
  'outcome_signals',
] as const;

// Phase 3 — standalone audit ledgers. Append-only, no FK chain,
// install-scoped (not session-scoped), no hash chain. Distinct from
// Phase 2 because pruning these doesn't have to reason about
// FK cascade semantics with sessions, and distinct from the
// hash-chained ledgers (approvals_log) which still need a dedicated
// rotation-aware sweep before they can be added here.
//
// `purge_events` is the first inhabitant: AUDIT.md §1.2 specifies
// 365d retention, the migration comment (066-purge-events.ts:87)
// pre-declares "no DELETE outside the retention sweep", but the
// sweep itself was missing until this phase wired it in.
export const PHASE_3_TABLES = ['purge_events'] as const;

// Union: every table the orchestrator knows how to sweep.
// `args.ts` derives `KNOWN_GC_TABLES` from this so a new entry
// here automatically widens the parser's --table=X accept-set.
export const GC_TABLES = [...PHASE_1_TABLES, ...PHASE_2_TABLES, ...PHASE_3_TABLES] as const;

export type Phase1Table = (typeof PHASE_1_TABLES)[number];
export type Phase2Table = (typeof PHASE_2_TABLES)[number];
export type Phase3Table = (typeof PHASE_3_TABLES)[number];
export type GcTable = (typeof GC_TABLES)[number];
