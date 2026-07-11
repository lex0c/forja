import type { SQLQueryBindings } from 'bun:sqlite';
import { generateUlid } from '../../permissions/ulid.ts';
import type { DB } from '../db.ts';
import type { MessageUsageTotals } from './messages.ts';

// compaction_events repo (migration 072). Append-only audit/replay trail for
// each compaction (CONTEXT_TUNING §12): the live array persists no messages,
// so this is where the DECISION lives — strategy, how much it freed, the
// before/after context hashes, and the non-reproducible LLM summary text.
// Cross-ref AUDIT.md.

export interface CompactionEventRow {
  id: string;
  session_id: string | null;
  strategy: string;
  folded_count: number;
  freed_bytes: number | null;
  tokens_before: number | null; // NULL for a forced /compact (no trigger count)
  tokens_after: number | null;
  before_hash: string;
  after_hash: string;
  elided_ids: string | null; // JSON array of tool_use_ids (relevance path)
  summary: string | null;
  reason: string | null;
  recorded_at: number;
  // Billed usage of the compaction provider call (migration 073). NULL on
  // rows written before 073 and on the relevance-only path (no provider
  // call). Distinct from tokens_before/after, which are CONTEXT estimates.
  call_tokens_in: number | null;
  call_tokens_out: number | null;
  call_cache_read: number | null;
  call_cache_creation: number | null;
  // The model that billed this compaction call (migration 078). Set on the `llm` /
  // `fallback` paths (a provider call happened); NULL on `relevance` (no call) and on rows
  // written before the migration.
  model: string | null;
}

export interface AppendCompactionEventInput {
  sessionId: string | null;
  // The CompactionStrategy value, typed as `string` here so storage stays
  // BELOW the harness layer (no storage→harness import / cycle). The DB CHECK
  // plus the typed call site (loop / `/compact`) constrain it to a real strategy.
  strategy: string;
  foldedCount: number;
  freedBytes?: number;
  // Absent for a forced `/compact` — it has no trigger token count.
  tokensBefore?: number;
  tokensAfter?: number;
  beforeHash: string;
  afterHash: string;
  elidedIds?: readonly string[];
  summary?: string;
  reason?: string;
  recordedAt: number;
  // Billed usage of the compaction provider call. Present on the `llm` /
  // `fallback` paths; absent on `relevance` (no provider call → zero usage,
  // stored as NULL). The caller maps the harness `UsageInfo` shape here.
  callUsage?: MessageUsageTotals;
  // The model that billed the compaction call (migration 078) — the compaction provider's id.
  // The caller sets it ONLY for billed strategies (`llm` / `fallback`); `relevance` / `skipped`
  // make no provider call, so it stays NULL and never marks the session metered.
  model?: string | null;
}

const INSERT_SQL = `INSERT INTO compaction_events
  (id, session_id, strategy, folded_count, freed_bytes, tokens_before,
   tokens_after, before_hash, after_hash, elided_ids, summary, reason, recorded_at,
   call_tokens_in, call_tokens_out, call_cache_read, call_cache_creation, model)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_ALL = `SELECT id, session_id, strategy, folded_count, freed_bytes,
       tokens_before, tokens_after, before_hash, after_hash, elided_ids,
       summary, reason, recorded_at,
       call_tokens_in, call_tokens_out, call_cache_read, call_cache_creation, model
  FROM compaction_events`;

// Append one row; returns the generated id. ULID = sortable + globally unique
// (same id discipline as failure_events / eviction_events).
export const appendCompactionEvent = (db: DB, input: AppendCompactionEventInput): string => {
  const id = generateUlid();
  const bindings: SQLQueryBindings[] = [
    id,
    input.sessionId,
    input.strategy,
    input.foldedCount,
    input.freedBytes ?? null,
    input.tokensBefore ?? null,
    input.tokensAfter ?? null,
    input.beforeHash,
    input.afterHash,
    input.elidedIds !== undefined ? JSON.stringify([...input.elidedIds]) : null,
    input.summary ?? null,
    input.reason ?? null,
    input.recordedAt,
    input.callUsage?.tokensIn ?? null,
    input.callUsage?.tokensOut ?? null,
    input.callUsage?.cacheRead ?? null,
    input.callUsage?.cacheCreation ?? null,
    input.model ?? null,
  ];
  db.query(INSERT_SQL).run(...bindings);
  return id;
};

// Billed compaction-call usage summed across a session's compaction_events
// rows. The aggregator (computeUsageStats) adds this to the messages-based
// token totals so they account for compaction calls — which the harness
// bills into cost but persists no `messages` row for. COALESCE folds the
// pre-073 / relevance-path NULLs to 0; mirrors `sumMessageUsage`.
export const sumCompactionUsage = (db: DB, sessionId: string): MessageUsageTotals => {
  const row = db
    .query<{ ti: number; tout: number; cr: number; cc: number }, [string]>(
      `SELECT COALESCE(SUM(call_tokens_in), 0)       AS ti,
              COALESCE(SUM(call_tokens_out), 0)      AS tout,
              COALESCE(SUM(call_cache_read), 0)      AS cr,
              COALESCE(SUM(call_cache_creation), 0)  AS cc
       FROM compaction_events WHERE session_id = ?`,
    )
    .get(sessionId);
  return {
    tokensIn: row?.ti ?? 0,
    tokensOut: row?.tout ?? 0,
    cacheRead: row?.cr ?? 0,
    cacheCreation: row?.cc ?? 0,
  };
};

// Compaction ROI for a session: how many times compaction ran, and how many
// CONTEXT tokens it freed in total. Reclaim is `tokens_before - tokens_after`
// summed over rows where BOTH estimates are present and before > after — so a
// forced `/compact` (NULL tokens_before, AGENTIC_CLI §12) and any degenerate
// row that didn't shrink contribute 0 reclaim while still counting as a run.
// These are context estimates (CONTEXT_TUNING §12), distinct from the billed
// `call_*` usage that `sumCompactionUsage` returns. The aggregator surfaces
// this so /stats can frame compaction as ROI (freed context) rather than only
// as the cost it already shows under `writes: … compaction`.
export interface CompactionReclaim {
  count: number;
  reclaimedTokens: number;
}

export const sumCompactionContextReclaim = (db: DB, sessionId: string): CompactionReclaim => {
  const row = db
    .query<{ n: number; reclaimed: number }, [string]>(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(
                CASE WHEN tokens_before IS NOT NULL
                      AND tokens_after  IS NOT NULL
                      AND tokens_before > tokens_after
                     THEN tokens_before - tokens_after
                     ELSE 0 END
              ), 0) AS reclaimed
       FROM compaction_events WHERE session_id = ?`,
    )
    .get(sessionId);
  return { count: row?.n ?? 0, reclaimedTokens: row?.reclaimed ?? 0 };
};

// Forensic list in append order. Bounded by per-session retention.
export const listCompactionEventsBySession = (db: DB, sessionId: string): CompactionEventRow[] =>
  db
    .query(`${SELECT_ALL} WHERE session_id = ? ORDER BY recorded_at ASC, id ASC`)
    .all(sessionId) as CompactionEventRow[];

// Whether a compaction strategy makes a BILLED provider call (`llm`, or `fallback` after an
// llm attempt) — vs `relevance` / `skipped`, which make no call. The SINGLE source for the
// gate: the write paths (loop / `/compact`) record the model only for these strategies, and
// `compactionMetering` flags a NULL-model row as untracked only for these. Lives in the storage
// layer (not `harness/compaction.ts`, which can't be imported from here per the storage→harness
// no-import rule). A new billed strategy added to the harness MUST be added here too, or its
// metered spend reads as unmetered.
export const isBilledCompactionStrategy = (strategy: string): boolean =>
  strategy === 'llm' || strategy === 'fallback';

// The models that BILLED compaction for a session (migration 078), plus whether any billed
// compaction predates the migration. A compaction call (`llm` / `fallback`) bills — its cost
// is in `sessions.total_cost_usd` and `/stats` counts its tokens — but writes no `messages`
// row, so the metering resolver (`effectiveSessionModels`) folds these in to avoid mislabeling
// a session unmetered when it compacted on a metered model. `hasUntracked` flags a NULL-model
// row on a billed strategy (a pre-078 billed compaction whose model we can't recover →
// attributed to `sessions.model`); a NULL model on `relevance` / `skipped` is NOT spend and is
// ignored.
export const compactionMetering = (
  db: DB,
  sessionId: string,
): { models: string[]; hasUntracked: boolean } => {
  const rows = db
    .query('SELECT DISTINCT model, strategy FROM compaction_events WHERE session_id = ?')
    .all(sessionId) as { model: string | null; strategy: string }[];
  const models = [...new Set(rows.map((r) => r.model).filter((m): m is string => m !== null))];
  const hasUntracked = rows.some((r) => r.model === null && isBilledCompactionStrategy(r.strategy));
  return { models, hasUntracked };
};
