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
import { sumCompactionUsage } from './compaction-events.ts';
import { sumMessageUsage } from './messages.ts';
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
}

const emptyStats = (): UsageStats => ({
  costUsd: 0,
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  cacheCreation: 0,
  usageComplete: true,
  sessionCount: 0,
});

export const computeUsageStats = (db: DB, rootSessionIds: readonly string[]): UsageStats => {
  const stats = emptyStats();
  const seen = new Set<string>();

  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const session = getSession(db, id);
    if (session === null) return;
    stats.sessionCount += 1;
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
    for (const child of listChildSessions(db, id)) visit(child.id);
  };

  for (const root of rootSessionIds) visit(root);
  return stats;
};
