// Retrieval runner — harness-built RetrieveFn for the
// `retrieve_context` tool (RETRIEVAL.md §15.4).
//
// The tool itself stays thin: it calls `ctx.retrieveContext(input)`
// and shapes the result for the model. This module owns the
// pipeline construction — wiring views + compression resolver into
// the orchestrator and translating the tool's input shape into the
// canonical `RetrievalQuery`.
//
// The runner is built once per session at harness boot (the views
// + resolver are session-scoped; recreating them per call would
// throw away BM25 corpus rebuild work the views can't currently
// cache anyway, but the pattern leaves room for that optimization
// without changing the tool surface).
//
// View wiring matches the substrate available today: memory +
// session (workspace deferred with slice 4.4). The runner accepts
// an explicit `views` set so future tests / fixtures can stub
// individual views without rebuilding the whole runner.

import type { MemoryRegistry } from '../memory/index.ts';
import type { DB } from '../storage/db.ts';
import { createCompressionResolver } from './compression.ts';
import { runRetrieval } from './pipeline.ts';
import type { ViewSearch } from './pipeline.ts';
import type {
  RetrievalView,
  RetrieveContextInput,
  RetrieveContextOutput,
  RetrieveFn,
} from './types.ts';
import { createMemoryView } from './views/memory.ts';
import { createSessionView } from './views/session.ts';

// Default per-call token budget when the caller omits `budgetTokens`.
// 1000 is conservative — fits inside the system-prompt portion of
// every modern provider's context window without dominating it.
// Tune via the optional `defaultBudgetTokens` builder arg when the
// active provider exposes a larger budget surface.
const DEFAULT_BUDGET_TOKENS = 1000;

export interface BuildRetrievalRunnerDeps {
  db: DB;
  sessionId: string;
  memoryRegistry: MemoryRegistry;
  // Optional override for the default per-call token budget.
  // Slice 4.9's harness wireup picks the provider's recommended
  // surface when available.
  defaultBudgetTokens?: number;
  // Optional view override — when omitted, the runner builds the
  // canonical memory + session pair. Tests / fixtures pass
  // explicit views to stub one or both.
  views?: Partial<Record<RetrievalView, ViewSearch>>;
}

export const buildRetrievalRunner = (deps: BuildRetrievalRunnerDeps): RetrieveFn => {
  const defaultBudget = deps.defaultBudgetTokens ?? DEFAULT_BUDGET_TOKENS;
  // Session-scoped views built once per runner. memory + session
  // hold no internal state today (BM25 corpora are rebuilt per
  // search call), so reuse is safe and matches the ViewSearch
  // contract.
  const wiredViews: Partial<Record<RetrievalView, ViewSearch>> = deps.views ?? {
    memory: createMemoryView({ registry: deps.memoryRegistry }),
    session: createSessionView({ db: deps.db, sessionId: deps.sessionId }),
  };
  const resolver = createCompressionResolver({
    registry: deps.memoryRegistry,
    db: deps.db,
  });

  return async (
    input: RetrieveContextInput,
    signal?: AbortSignal,
  ): Promise<RetrieveContextOutput> => {
    // Early abort check. The pipeline doesn't have an internal
    // abort handler yet (slice 4.4 will plumb it through the
    // workspace view's ripgrep subprocess); honoring the signal
    // at the entry point at least prevents a queued retrieval
    // from running after the caller already gave up.
    if (signal?.aborted) {
      throw new Error('retrieval aborted before dispatch');
    }

    // Filter views per the input's optional `views` allow-list.
    // The pipeline already degrades on missing views, so an empty
    // intersection just produces an empty slot — no error.
    const allowList = input.views;
    const viewsForCall: Partial<Record<RetrievalView, ViewSearch>> = allowList
      ? Object.fromEntries(
          Object.entries(wiredViews).filter(([k]) => allowList.includes(k as RetrievalView)),
        )
      : { ...wiredViews };

    // When loadBodies is requested, swap the memory view for one
    // built with body loading on. Cheap — the view is a single
    // object with closure deps; we're not rebuilding the BM25
    // corpus here, just the view's search function.
    if (input.loadBodies === true && viewsForCall.memory !== undefined) {
      viewsForCall.memory = createMemoryView({
        registry: deps.memoryRegistry,
        loadBodies: true,
      });
    }

    const result = await runRetrieval(
      {
        db: deps.db,
        sessionId: deps.sessionId,
        views: viewsForCall,
        compressionResolver: resolver,
      },
      {
        text: input.query,
        workflow: input.workflow ?? 'default',
        queryType: input.queryType ?? 'semantic',
        budgetTokens: input.budgetTokens ?? defaultBudget,
      },
    );

    // Late abort check. v1 view searches are synchronous enough
    // that this fires only when the signal flipped DURING the
    // pipeline's await — operator pressing Ctrl+C mid-call. We
    // surface as throw so the tool's catch returns
    // `retrieval.internal_error` with a recognizable message.
    if (signal?.aborted) {
      throw new Error('retrieval aborted mid-flight');
    }

    const budgetUsed = result.contextSlot.included.reduce((sum, e) => sum + e.costTokens, 0);
    const budget = input.budgetTokens ?? defaultBudget;

    return {
      contextSlot: result.contextSlot,
      queryId: result.queryId,
      stats: {
        candidatesRaw: result.candidatesRaw.length,
        candidatesRanked: result.candidatesRanked.length,
        included: result.contextSlot.included.length,
        skipped: result.contextSlot.skipped.length,
        budgetUsedTokens: budgetUsed,
        budgetRemainingTokens: Math.max(0, budget - budgetUsed),
      },
    };
  };
};
