// Shared resume "full"/"summary" preparation. Both the interactive REPL boot
// and the headless run path need the SAME core: hydrate the whole log uncapped
// and, for summary mode, compact it before the first turn. Centralizing it here
// keeps the two callers from drifting (one path getting a fix the other misses).
//
// Caller-specific concerns stay OUT of here on purpose: the threshold warning,
// the scrollback replay, and how a compaction error is surfaced (bus info line
// vs stderr) differ between interactive and headless, so each caller does its
// own using the returned `info` / `compaction`.

import type { HydrateInfo } from '../harness/session-context.ts';
import { SessionContext } from '../harness/session-context.ts';
import type { RunBudget } from '../harness/types.ts';
import type { Provider } from '../providers/index.ts';
import { type DB, getSession } from '../storage/index.ts';
import type { Bus } from '../tui/bus.ts';
import { type CompactContextResult, compactContextNow } from './compact-now.ts';

export interface PrepareResumeDeps {
  db: DB;
  sessionId: string;
  mode: 'full' | 'summary';
  provider: Provider;
  budget: RunBudget;
  memoryRegistryPresent: boolean;
  now: () => number;
  signal?: AbortSignal;
  // Present in the interactive path (chip + cost rollup); absent headless.
  bus?: Bus;
  cumulative?: { costUsd: number };
  refreshStats?: () => void;
}

export interface PrepareResumeResult {
  ctx: SessionContext;
  info: HydrateInfo;
  // Only set for summary mode. The caller inspects `.kind === 'error'` to warn.
  compaction?: CompactContextResult;
  // Summary mode requested, but the session's persisted cost is already at/over
  // maxCostUsd — the boot compaction was SKIPPED rather than make a billed call
  // the run will immediately abort for anyway (see below). The caller surfaces
  // this and the context is left full/uncompacted; runAgent's pre-loop cost
  // gate then ends the run as `exhausted`.
  costCapped?: boolean;
}

export const prepareResumeContext = async (
  deps: PrepareResumeDeps,
): Promise<PrepareResumeResult> => {
  const hydrated = SessionContext.hydrateFromDb(deps.db, deps.sessionId, { uncapped: true });
  if (deps.mode !== 'summary') {
    return { ctx: hydrated.ctx, info: hydrated.info };
  }
  // Honor the hard cost cap BEFORE the billed summary call. runAgent's pre-loop
  // gate aborts a resumed run when the session's persisted cost is already
  // at/over maxCostUsd (it loads session.totalCostUsd into priorCostUsd) — but
  // that gate runs AFTER this boot compaction. Without this check the summary
  // request would bill the provider + bump the session cost just before the run
  // aborts for the cap, so the hard cap wouldn't actually hold for this path.
  // Skip the compaction (leave the context full) and let the harness end the
  // run as `exhausted`. `>=`: at exactly the cap the harness aborts too (its
  // per-call token reservation pushes the cumulative strictly over).
  const priorCost = getSession(deps.db, deps.sessionId)?.totalCostUsd ?? 0;
  if (deps.budget.maxCostUsd !== undefined && priorCost >= deps.budget.maxCostUsd) {
    return { ctx: hydrated.ctx, info: hydrated.info, costCapped: true };
  }
  const compaction = await compactContextNow({
    ctx: hydrated.ctx,
    provider: deps.provider,
    budget: deps.budget,
    db: deps.db,
    memoryRegistryPresent: deps.memoryRegistryPresent,
    now: deps.now,
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    ...(deps.bus !== undefined ? { bus: deps.bus } : {}),
    ...(deps.cumulative !== undefined ? { cumulative: deps.cumulative } : {}),
    ...(deps.refreshStats !== undefined ? { refreshStats: deps.refreshStats } : {}),
  });
  return { ctx: hydrated.ctx, info: hydrated.info, compaction };
};
