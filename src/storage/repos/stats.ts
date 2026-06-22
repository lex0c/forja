// Session usage aggregator. Single source of truth for "how much did
// this REPL spend / process", derived from the DB rather than from an
// in-memory running total. Used by `/stats` (and, in a later slice, the
// footer) so both surfaces report the SAME numbers — consistent during
// a session and across `--resume`.
//
// Why DB-derived and not REPL-accumulated:
//   - Resume-correct for free: a resumed REPL reopens the same session
//     row, whose `total_cost_usd` already carries the lifetime spend
//     and whose messages carry the lifetime tokens. No seeding.
//   - Subagent-complete: the in-memory `cumulative` the REPL keeps sums
//     each turn's `HarnessResult.costUsd`, which is PARENT-SELF only —
//     it silently drops `task_*` subagent spend. Subagents live in
//     separate `sessions` rows linked by `parent_session_id`, so the
//     tree walk below picks them up where the running total can't.
//
// Scope: the caller passes the REPL's root session ids (the one
// growing session row + any playbook-dispatch sessions). For each, we
// walk DOWN the `parent_session_id` tree (mirroring `cumulativeCostUsd`)
// so every subagent descendant is included. A `seen` guard dedupes
// shared/repeat ids and defends against a corrupt self-referential row.

import type { DB } from '../db.ts';
import { sumCompactionContextReclaim, sumCompactionUsage } from './compaction-events.ts';
import {
  countAssistantMessagesBySession,
  effectiveSessionModels,
  sumMessageUsage,
} from './messages.ts';
import { getSession, listChildSessions } from './sessions.ts';

export interface UsageStats {
  // Tree-wide rolled-up cost. Sourced from `sessions.total_cost_usd`
  // (the canonical rollup the harness writes, which also captures
  // compaction-call cost that never lands as a message row), summed
  // across the session and all its subagent descendants.
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreation: number;
  // false when ANY session in scope has `usage_complete = 0` — i.e. a
  // turn billed tokens but the provider reported no usage. The cost and
  // token totals are then a LOWER BOUND; the renderer should mark them.
  usageComplete: boolean;
  // Sessions walked: the root(s) plus every subagent descendant.
  sessionCount: number;
  // Cache-write (cache_creation) split by SOURCE — three DISJOINT buckets
  // that sum to `cacheCreation`. Cache write is the expensive axis, so
  // knowing which source drives it (vs the provider's single opaque
  // cache_creation number) is the lever for cutting it. The provider does
  // NOT attribute a write to a content block, so we can't sub-split the
  // parent bucket by prompt section — but these three come from distinct
  // persisted records and are exact:
  //   - parent: main-conversation sessions (is_subagent = 0) message writes
  //   - subagent: subagent sessions (is_subagent = 1) message writes
  //   - compaction: the compaction calls (compaction_events), any session
  cacheWriteParent: number;
  cacheWriteSubagent: number;
  cacheWriteCompaction: number;
  // Billed provider calls across the tree: count of `role='assistant'` message
  // rows. The denominator for /stats' per-turn economics (cost/turn, out/turn,
  // avg window/turn). Compaction calls are NOT counted here — they live in
  // `compactionCount` so the conversational-turn denominator stays clean.
  turns: number;
  // Compaction ROI rolled up across the tree. `compactionCount` is the number
  // of runs; `reclaimedTokens` the context tokens they freed (see
  // sumCompactionContextReclaim). Pairs with `cacheWriteCompaction` (the cost)
  // to read compaction as a trade rather than a pure expense.
  compactionCount: number;
  reclaimedTokens: number;
  // Distinct models across every session in scope (root(s) + subagent descendants).
  // The CLI resolves these against the catalog to tell whether the aggregate holds
  // UNMETERED usage (untracked $0) — which the currently selected provider alone can't
  // reveal, since the scope spans model switches, resumes, and mixed-metering subagents.
  models: string[];
}

const emptyStats = (): UsageStats => ({
  costUsd: 0,
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  cacheCreation: 0,
  usageComplete: true,
  sessionCount: 0,
  models: [],
  cacheWriteParent: 0,
  cacheWriteSubagent: 0,
  cacheWriteCompaction: 0,
  turns: 0,
  compactionCount: 0,
  reclaimedTokens: 0,
});

// Cache-write amplification: cache writes over total cache traffic
// (writes + reads). Low is good — a mature session reuses (reads) far more
// than it writes. A climbing ratio between sessions means more of the
// prefix is being re-written each turn (an invalidator, or 5-min expiry).
// 0 when there is no cache traffic yet.
export const cacheWriteAmplification = (stats: UsageStats): number => {
  const cacheTotal = stats.cacheRead + stats.cacheCreation;
  return cacheTotal === 0 ? 0 : stats.cacheCreation / cacheTotal;
};

// Fraction of the INPUT side served from prompt cache: cache reads over all
// input tokens (non-cached input + cache reads + cache writes). Output is
// excluded — it isn't cached. Denominator includes cache_creation so the
// first turn (which writes the cache but reads nothing) reads as 0% and the
// ratio climbs as later turns reuse the prefix. Returns 0 when there is no
// input yet (avoids 0/0). Derived from UsageStats, not stored — a pure view.
export const cacheHitRatio = (stats: UsageStats): number => {
  const inputTotal = stats.tokensIn + stats.cacheRead + stats.cacheCreation;
  return inputTotal === 0 ? 0 : stats.cacheRead / inputTotal;
};

export const computeUsageStats = (db: DB, rootSessionIds: readonly string[]): UsageStats => {
  const stats = emptyStats();
  const seen = new Set<string>();
  const models = new Set<string>();

  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const session = getSession(db, id);
    if (session === null) return;
    stats.sessionCount += 1;
    // Per-turn models (migration 077) so the scope's metering reflects the models
    // ACTUALLY used, not each session's initial `model` (a /model switch leaves it
    // stale). `effectiveSessionModels` folds the pre-migration / no-billed-turn
    // fallback to `sessions.model` in one place (shared with `isSessionUnmetered`).
    for (const m of effectiveSessionModels(db, id, session.model)) models.add(m);
    stats.costUsd += session.totalCostUsd;
    if (!session.usageComplete) stats.usageComplete = false;
    // Tokens come from TWO sources: the per-turn `messages` rows, plus the
    // compaction provider calls. Compaction writes no `messages` row but
    // bills tokens (folded into total_cost_usd), so summing only messages
    // would report cost that includes compaction and tokens that omit it —
    // inconsistent. Cost is NOT re-added from compaction_events: it already
    // lives in total_cost_usd (double-counting it would inflate the cost).
    const usage = sumMessageUsage(db, id);
    const compactionUsage = sumCompactionUsage(db, id);
    stats.tokensIn += usage.tokensIn + compactionUsage.tokensIn;
    stats.tokensOut += usage.tokensOut + compactionUsage.tokensOut;
    stats.cacheRead += usage.cacheRead + compactionUsage.cacheRead;
    stats.cacheCreation += usage.cacheCreation + compactionUsage.cacheCreation;
    // Same numbers, bucketed by source for the cache-write attribution.
    // Message writes go to parent vs subagent by the session's identity
    // flag; compaction writes are their own bucket regardless of session.
    if (session.isSubagent) {
      stats.cacheWriteSubagent += usage.cacheCreation;
    } else {
      stats.cacheWriteParent += usage.cacheCreation;
    }
    stats.cacheWriteCompaction += compactionUsage.cacheCreation;
    // Per-turn denominator + compaction ROI, same tree-walk so they stay
    // resume-correct and subagent-inclusive like the token/cost totals.
    stats.turns += countAssistantMessagesBySession(db, id);
    const reclaim = sumCompactionContextReclaim(db, id);
    stats.compactionCount += reclaim.count;
    stats.reclaimedTokens += reclaim.reclaimedTokens;
    for (const child of listChildSessions(db, id)) visit(child.id);
  };

  for (const root of rootSessionIds) visit(root);
  stats.models = [...models];
  return stats;
};
