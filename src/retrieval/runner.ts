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

import { type MemoryRegistry, serializeMemoryFile } from '../memory/index.ts';
import type { DB } from '../storage/db.ts';
import { hashMemoryContent, recordProvenance } from '../storage/repos/memory-provenance.ts';
import { createCompressionResolver } from './compression.ts';
import { runRetrieval } from './pipeline.ts';
import type { ViewSearch } from './pipeline.ts';
import type {
  ContextSlotEntry,
  RetrievalView,
  RetrieveContextInput,
  RetrieveContextOutput,
  RetrieveFn,
  RetrieveFnOpts,
} from './types.ts';
import { createMemoryView } from './views/memory.ts';
import { createSessionView } from './views/session.ts';

// `memory:<scope>/<name>` — produced by views/memory.ts. Parsed
// here back into (scope, name) so the runner can peek the
// underlying memory file for hash + state capture without
// reaching into the view's encoding internals.
const MEMORY_NODE_PREFIX = 'memory:';
const parseMemoryNodeId = (
  nodeId: string,
): { scope: 'user' | 'project_shared' | 'project_local'; name: string } | null => {
  if (!nodeId.startsWith(MEMORY_NODE_PREFIX)) return null;
  const rest = nodeId.slice(MEMORY_NODE_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  const scope = rest.slice(0, slash);
  if (scope !== 'user' && scope !== 'project_shared' && scope !== 'project_local') return null;
  return { scope, name: rest.slice(slash + 1) };
};

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
  // Track whether the views were caller-supplied vs default-wired
  // — the `loadBodies` swap below MUST NOT replace a caller-supplied
  // memory view (custom limits, stubs, alternative scoring), which
  // would silently query a different corpus than the test/fixture
  // / custom-wireup asked for.
  const callerSuppliedViews = deps.views !== undefined;
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
    opts?: RetrieveFnOpts,
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
    //
    // GUARDED BY `!callerSuppliedViews`: only the default-wired
    // memory view gets replaced. A caller that injected its own
    // `views.memory` (tests, fixtures, alternative-scoring wireup
    // per BuildRetrievalRunnerDeps doc) keeps the view as
    // supplied — overriding silently would mean the runner
    // queried a different corpus / behavior than the caller
    // requested. Callers that DO want loadBodies-on can construct
    // their custom view with `loadBodies: true` themselves
    // (createMemoryView accepts the flag) before passing it in.
    if (input.loadBodies === true && viewsForCall.memory !== undefined && !callerSuppliedViews) {
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
        ...(signal !== undefined ? { signal } : {}),
      },
      {
        text: input.query,
        workflow: input.workflow ?? 'default',
        queryType: input.queryType ?? 'semantic',
        budgetTokens: input.budgetTokens ?? defaultBudget,
      },
    );

    // Late abort check. The pipeline now does per-stage abort
    // checks internally (and throws `retrieval aborted before
    // <stage>` if the signal flipped), so this catches only the
    // rare case where the signal flipped AFTER compress completed
    // but BEFORE we got back here — e.g., during persist. Surface
    // as throw so the tool's catch returns `retrieval.internal_error`
    // with a recognizable message.
    if (signal?.aborted) {
      throw new Error('retrieval aborted mid-flight');
    }

    // Provenance emit (MEMORY.md §11.2, S1/T1.5). Every memory-view
    // entry in `contextSlot.included` becomes one
    // memory_provenance row — surface='retrieve_context', linking
    // the retrieval batch (via retrieval_query_id) AND the
    // originating tool_call. Position pins the slot rank for
    // operator forensics ("memory was exposed but ranked 18th").
    //
    // Skipped when:
    //   - persist failed upstream (queryId === '') — FK to
    //     retrieval_trace can't resolve and the repo invariant
    //     requires a non-null retrieval_query_id;
    //   - no toolCallId supplied (test contexts that bypass the
    //     harness — degrades the same way memory_read does).
    //
    // Audit-drift posture: per-row try/catch; failures hit stderr
    // but never abort the retrieval. The body load + ranking
    // already happened; provenance is observability.
    if (result.queryId.length > 0 && opts?.toolCallId !== undefined) {
      emitRetrievalProvenance(deps, opts.toolCallId, result.queryId, result.contextSlot.included);
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
        traceMissing: result.traceMissing,
      },
    };
  };
};

// Walk `contextSlot.included`, filter memory-view entries, parse
// scope/name from the node id, peek the memory body for hash +
// state, and emit one provenance row per entry. `position` is the
// index inside the slot (0 = top hit) — pinned for the
// "exposed but ranked low" forensic query.
//
// Per-entry try/catch isolates failures: a malformed node id, a
// missing memory file (operator deleted between rank and emit), a
// DB FK violation — none should abort the loop or surface to the
// caller. Audit drift hits stderr; the retrieval itself already
// succeeded.
const emitRetrievalProvenance = (
  deps: BuildRetrievalRunnerDeps,
  toolCallId: string,
  queryId: string,
  included: ContextSlotEntry[],
): void => {
  for (let i = 0; i < included.length; i++) {
    const entry = included[i];
    if (entry === undefined || entry.view !== 'memory') continue;
    try {
      const parsed = parseMemoryNodeId(entry.nodeId);
      if (parsed === null) continue;
      const peek = deps.memoryRegistry.peek(parsed.name, { scope: parsed.scope });
      let contentHash: string | null = null;
      let stateAtExposure = 'active';
      if (peek.kind === 'present') {
        try {
          contentHash = hashMemoryContent(serializeMemoryFile(peek.file));
        } catch {
          contentHash = null; // best-effort, mirrors the schema's nullable column
        }
        stateAtExposure = peek.file.frontmatter.state ?? 'active';
      }
      recordProvenance(deps.db, {
        sessionId: deps.sessionId,
        toolCallId,
        memoryScope: parsed.scope,
        memoryName: parsed.name,
        surface: 'retrieve_context',
        retrievalQueryId: queryId,
        positionInCorpus: i,
        memoryContentHash: contentHash,
        memoryStateAtExposure: stateAtExposure,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `memory: AUDIT DRIFT: failed to record retrieve_context exposure for ${entry.nodeId}: ${msg}\n`,
      );
    }
  }
};
