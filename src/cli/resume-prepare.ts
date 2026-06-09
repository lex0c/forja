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
import type { DB } from '../storage/index.ts';
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
}

export const prepareResumeContext = async (
  deps: PrepareResumeDeps,
): Promise<PrepareResumeResult> => {
  const hydrated = SessionContext.hydrateFromDb(deps.db, deps.sessionId, { uncapped: true });
  if (deps.mode !== 'summary') {
    return { ctx: hydrated.ctx, info: hydrated.info };
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
