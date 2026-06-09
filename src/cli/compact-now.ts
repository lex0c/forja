// Shared "compact a live SessionContext now" routine. Extracted from the
// /compact slash command so the resume "from summary" path (repl.ts / run.ts
// at boot) can compact the hydrated context with the SAME machinery: relevance
// pre-pass, the billed LLM fold, cost accounting, the compaction_events audit
// row, and the bracketed "Compacting context…" chip. In-memory ONLY — the DB
// log stays the full history (a fresh --resume re-derives + re-compacts).
//
// Deps are passed explicitly (not a SlashContext) so both the slash command and
// the resume bootstrap can call it. `bus` / `cumulative` / `refreshStats` are
// optional: headless resume has no chip to bracket and no REPL cumulative.

import type { RelevanceElideResult } from '../harness/compaction-relevance.ts';
import {
  accountCompaction,
  compactionTriggerTokens,
  hashContext,
  recordCompactionEvent,
  relevanceVerbatimBudgetBytes,
} from '../harness/compaction.ts';
import type { SessionContext } from '../harness/session-context.ts';
import type { RunBudget } from '../harness/types.ts';
import type { Provider } from '../providers/index.ts';
import type { DB } from '../storage/index.ts';
import { formatPinnedBlock, getActivePinsBySession } from '../storage/repos/context-pins.ts';
import {
  getSession,
  markSessionUsageIncomplete,
  updateSessionCost,
} from '../storage/repos/sessions.ts';
import type { Bus } from '../tui/bus.ts';

export interface CompactContextDeps {
  // The live context to compact in place.
  ctx: SessionContext;
  provider: Provider;
  budget: RunBudget;
  db: DB;
  // Gates the relevance pre-pass: an elided body is recoverable only via
  // retrieve_context, which the harness wires only when a memory registry is
  // present. Without it, skip the pre-pass and let the LLM fold keep a summary.
  memoryRegistryPresent: boolean;
  now: () => number;
  // Composes with the internal step-stall timeout so the operator's interrupt
  // (or a hung provider) aborts the summary call; either abort degrades to the
  // deterministic fallback inside compactMessages.
  signal?: AbortSignal;
  // When present, brackets the "Compacting context…" chip (compacting:start/end).
  bus?: Bus;
  // When present, the billed summary cost folds into the REPL cumulative.
  cumulative?: { costUsd: number };
  refreshStats?: () => void;
}

export type CompactContextResult =
  | {
      kind: 'ok';
      strategy: string;
      before: number;
      after: number;
      foldedCount: number;
      relevanceElidedCount: number;
      relevanceFreedBytes: number;
      // The billed cost of THIS compaction (accountCompaction). Already folded
      // into the session row (updateSessionCost) and the optional `cumulative`;
      // returned so a caller WITHOUT a cumulative accumulator (headless resume)
      // can still surface it — the per-run runAgent result.costUsd doesn't
      // include a boot-time compaction that ran before the run.
      costUsd: number;
    }
  | { kind: 'noop' }
  | { kind: 'error'; message: string };

export const compactContextNow = async (
  deps: CompactContextDeps,
): Promise<CompactContextResult> => {
  const { ctx: live, provider, budget, db, now } = deps;
  const before = live.length;
  // Same pin block the auto-compaction injects, so the active constraints
  // survive identically (formatPinnedBlock is shared).
  const pinnedBlock = formatPinnedBlock(getActivePinsBySession(db, live.sessionId));
  // Defensive snapshot: compactMessages absorbs provider/stream errors into a
  // deterministic fallback and does NOT rethrow, so a restore only fires on an
  // unexpected throw — a cheap rewind vs a corrupted single source of truth.
  const snap = live.snapshot();
  // Bound the summary call; compose the caller's interrupt signal so Ctrl+C
  // aborts it too. Either abort turns into the deterministic fallback.
  const timeout = AbortSignal.timeout(budget.maxStepStallMs);
  const compactSignal =
    deps.signal !== undefined ? AbortSignal.any([deps.signal, timeout]) : timeout;
  let contextChanged = false;
  try {
    deps.bus?.emit({ type: 'compacting:start', ts: now() });
    const beforeHash = hashContext(live.getMessages());
    // Relevance pre-pass for parity with the auto path: pointer-elide
    // low-relevance tool_result bodies first so the forced fold summarizes a
    // lighter, gated history. Unlike the loop, this always proceeds to the
    // fold (the caller forced it; no token threshold to short-circuit on).
    let relevanceElided: RelevanceElideResult | null = null;
    if (budget.compactionRelevance === true && deps.memoryRegistryPresent) {
      const triggerAt = compactionTriggerTokens(
        budget.compactionThreshold,
        provider.capabilities.context_window,
      );
      relevanceElided = live.relevanceElide({
        verbatimBudgetBytes: relevanceVerbatimBudgetBytes(triggerAt),
        preserveTail: budget.compactionPreserveTail,
      });
    }
    const result = await live.compact(provider, {
      preserveTail: budget.compactionPreserveTail,
      signal: compactSignal,
      ...(pinnedBlock !== undefined ? { pinnedBlock } : {}),
    });
    // Shared accounting: fold cost into the session row + the REPL cumulative
    // (else the spend escapes /cost, audit, and the maxCostUsd cap), and
    // downgrade usage_complete when it billed without reporting usage.
    const acct = accountCompaction(result, provider.capabilities);
    if (acct.costUsd > 0) {
      if (deps.cumulative !== undefined) deps.cumulative.costUsd += acct.costUsd;
      const session = getSession(db, live.sessionId);
      if (session !== null) {
        updateSessionCost(db, live.sessionId, session.totalCostUsd + acct.costUsd);
      }
    }
    if (acct.usageIncomplete) {
      markSessionUsageIncomplete(db, live.sessionId);
    }
    // Audit row (compaction_events) for parity with the auto path.
    recordCompactionEvent(db, {
      sessionId: live.sessionId,
      beforeHash,
      messagesAfter: live.getMessages(),
      strategy: result.strategy,
      foldedCount: result.foldedCount,
      callUsage: {
        tokensIn: result.usage.input,
        tokensOut: result.usage.output,
        cacheRead: result.usage.cache_read,
        cacheCreation: result.usage.cache_creation,
      },
      ...(relevanceElided !== null && relevanceElided.elidedCount > 0
        ? { freedBytes: relevanceElided.freedBytes, elidedIds: relevanceElided.elidedIds }
        : {}),
      ...(result.summary !== undefined ? { summary: result.summary } : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      recordedAt: now(),
    });
    deps.refreshStats?.();
    const relevanceElidedCount = relevanceElided?.elidedCount ?? 0;
    const relevanceFreedBytes = relevanceElided?.freedBytes ?? 0;
    if (result.strategy === 'skipped' && relevanceElidedCount === 0) {
      return { kind: 'noop' };
    }
    // Past the no-op check ⇒ something changed (a fold and/or relevance elision).
    contextChanged = true;
    return {
      kind: 'ok',
      strategy: result.strategy,
      before,
      after: live.length,
      foldedCount: result.foldedCount,
      relevanceElidedCount,
      relevanceFreedBytes,
      costUsd: acct.costUsd,
    };
  } catch (e) {
    live.restore(snap);
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  } finally {
    deps.bus?.emit({ type: 'compacting:end', ts: now(), contextChanged });
  }
};
