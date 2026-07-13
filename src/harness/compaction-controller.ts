// Compaction controller extracted from the harness loop's runAgent (N4 — reduce
// the god-object). The ~290-line `maybeCompact` closure — the top-of-loop
// context-window gate: trigger decision, PreCompact hook, experimental token
// refine, the opt-in relevance pre-pass (pointer-elide with a no-LLM
// short-circuit), and the billed LLM fold with its audit/emit trail — moves here
// as `runMaybeCompact(args)`. It takes an EXPLICIT snapshot of the run state it
// used to close over (ctx, steps, tools, budget, config, the cost seam) instead
// of the ~13 shared locals — that parameterization is the coupling reduction.
// Behavior is preserved verbatim: the body is byte-for-byte the old closure with
// the free variables renamed to args (acct.recordUsage → recordUsage,
// costCapDetailIfExceeded → costCapDetail). The loop keeps a thin wrapper so the
// two call sites (top-of-loop + the synthesizeOnExhaustion injection) are
// unchanged; the compaction / loop / relevance suites are the net.
import type { HookChainResult, HookEventPayload } from '../hooks/index.ts';
import type { RecalledMemory } from '../memory/proactive-recall.ts';
import { emptyUsage } from '../providers/cost.ts';
import type { ProviderMessage, ProviderToolDef } from '../providers/index.ts';
import { estimatePromptTokens } from '../providers/tokens.ts';
import type { UsageInfo } from '../providers/types.ts';
import { isBilledCompactionStrategy } from '../storage/repos/compaction-events.ts';
import { formatPinnedBlock, getActivePinsBySession } from '../storage/repos/context-pins.ts';
import { isSmallWindow } from '../tools/context-budget.ts';
import type { WorkingStateStore } from '../working-state/index.ts';
import { withAbort } from './abortable.ts';
import {
  accountCompaction,
  compactionTriggerTokens,
  hashContext,
  recordCompactionEvent,
  refineCompactionTrigger,
  relevanceVerbatimBudgetBytes,
} from './compaction.ts';
import type { RelevanceAudit } from './compaction-relevance.ts';
import { safeEmit } from './emit.ts';
import { injectProactiveMemoryBlock } from './proactive-memory-inject.ts';
import type { SessionContext } from './session-context.ts';
import { injectStaticGuidance } from './static-guidance.ts';
import {
  type HarnessConfig,
  type HarnessEvent,
  type RunBudget,
  resolveMaxOutputTokens,
} from './types.ts';
import { injectWorkingStateBlock } from './working-state-inject.ts';

export interface RunMaybeCompactArgs {
  // `force` runs the compaction even at steps >= maxSteps — for the exhaustion
  // synthesis, which builds its request from the live history AT the cap and
  // must fit the window (the normal top-of-loop call skips there). It also
  // estimates the prompt WITHOUT tools, matching that synthesis request (which
  // sends none): a history that fits tool-less must not trigger a paid
  // compaction just because the tool schemas would have pushed it over.
  force: boolean;
  ctx: SessionContext | undefined;
  signal: AbortSignal;
  // Prior iteration's step count (only sizes the working-state "N steps ago"
  // labels; a few chars) and the steps >= maxSteps skip gate.
  steps: number;
  budget: RunBudget;
  config: HarnessConfig;
  tools: ProviderToolDef[];
  workingStateStore: WorkingStateStore;
  sessionId: string;
  proactiveRecalled: RecalledMemory[];
  dispatchHooks: (payload: HookEventPayload) => Promise<HookChainResult | null>;
  // The cost seam (owned by the CostAccountant, injected as callbacks): fold the
  // billed summary's usage into the run totals, wire the cost_update, and read
  // the cumulative-cost overage the caller must finish on.
  recordUsage: (usage: UsageInfo, costUsd: number, usageSeen: boolean) => void;
  emitCostUpdate: (delta: number) => void;
  costCapDetail: () => string | null;
}

// Top-of-loop compaction gate. Returns a cost-cap detail string when its own
// billed summary call pushed the cumulative total over the cap (caller must
// finish), else null. Mutates the context's message array in place and folds
// usage into the run totals via the injected `recordUsage`.
export const runMaybeCompact = async (args: RunMaybeCompactArgs): Promise<string | null> => {
  const {
    force,
    ctx,
    signal,
    steps,
    budget,
    config,
    tools,
    workingStateStore,
    sessionId,
    proactiveRecalled,
    dispatchHooks,
    recordUsage,
    emitCostUpdate,
    costCapDetail,
  } = args;
  // Skip when aborted / window unknown — don't burn a billed summary call
  // whose result the loop is about to discard. At steps >= maxSteps the loop
  // is exiting, so skip too — UNLESS forced (the synthesis still needs it).
  if (
    ctx === undefined ||
    signal.aborted ||
    (!force && steps >= budget.maxSteps) ||
    config.provider.capabilities.context_window <= 0
  ) {
    return null;
  }
  const estimateOpts = {
    ...(config.systemPrompt !== undefined ? { system: config.systemPrompt } : {}),
    // force ⇒ the tool-less synthesis request; don't count tool schemas the
    // synthesis won't send (else a tool-less-fitting history compacts needlessly).
    ...(!force && tools.length > 0 ? { tools } : {}),
    countReasoning: config.provider.replaysReasoning === true,
  };
  const contextWindow = config.provider.capabilities.context_window;
  // The NEXT request reserves max_tokens; the provider rejects
  // input + max_tokens > window. The 0.7 trigger's 30% headroom covers a
  // normal output cap, but a model whose cap exceeds it (e.g. 64k on a 200k
  // window) needs this tighter ceiling. Shared by the refine skip AND the
  // relevance short-circuit so neither leaves the next request over-window.
  const outputFitCeiling =
    contextWindow - resolveMaxOutputTokens(budget, config.provider.capabilities);
  // The real request the step loop sends appends the working-state panel +
  // static guidance to the last user message (the forced synthesis path sends
  // its own directive instead, so skip them under `force`). Build that
  // POST-INJECTION shape so the trigger, the refine fit decision, AND the
  // relevance short-circuit all measure what's ACTUALLY sent —
  // enableStaticGuidance is on for the main CLI and a populated panel can add
  // several KB, enough to flip a near-ceiling decision. The exact step arg
  // only sizes the "N steps ago" labels (a few chars), so the prior
  // iteration's `steps` is close enough.
  const buildRequestShape = (messages: readonly ProviderMessage[]): ProviderMessage[] => {
    const shape = [...messages];
    if (!force) {
      injectWorkingStateBlock(shape, workingStateStore.get(sessionId), steps);
      // Count the proactive bodies too (computed before this call): they're
      // appended to the real request below, AFTER this gate — omitting them
      // here lets a near-ceiling request tip over context_window instead of
      // compacting first.
      injectProactiveMemoryBlock(shape, proactiveRecalled);
      if (config.enableStaticGuidance) injectStaticGuidance(shape, isSmallWindow(contextWindow));
    }
    return shape;
  };
  const requestMessages = buildRequestShape(ctx.getMessages());
  const promptTokens = estimatePromptTokens(requestMessages, estimateOpts);
  const triggerAt = compactionTriggerTokens(budget.compactionThreshold, contextWindow);
  // Need goal + something-to-fold + an assistant boundary for the tail;
  // shorter histories make compactMessages skip (and emit noisy events).
  if (!(promptTokens > triggerAt && ctx.length >= budget.compactionPreserveTail + 3)) {
    return null;
  }
  // PreCompact hook (blocking, spec §10.1) — fired before the
  // compaction_started event so a refusing hook skips both the LLM call and
  // the renderer's "compacting…" signal, AND before the native token-count
  // refine below so a blocking hook prevents the full prompt from reaching the
  // provider's count_tokens endpoint at all (HOOKS.md: PreCompact can cancel
  // compaction; a policy hook may exist precisely to deny the compaction
  // provider access). Blocked ⇒ no compaction this turn; the loop proceeds
  // with the un-compacted history and the next top-of-loop call re-checks (no
  // continue — we're at the top, so returning simply falls through to the
  // provider call). Deliberate vs the old post-tool-result site, whose
  // `continue` ALSO skipped that turn's detector schedulers: the turn now runs
  // normally, because the schedulers don't depend on compaction.
  const preCompact = await dispatchHooks({
    schema: 'v1',
    event: 'PreCompact',
    sessionId,
    data: { promptTokens, threshold: triggerAt },
  });
  if (preCompact !== null && preCompact.blockedBy !== null) {
    return null;
  }
  // Trigger refinement (#3 / CONTEXT_TUNING §12) — EXPERIMENTAL, gated OFF by
  // default (compactionTriggerRefine; see the budget-field doc). Runs AFTER
  // the PreCompact hook so a blocking hook prevents the external count_tokens
  // request (a blocked compaction must touch no compaction-provider endpoint).
  // The chars/4 estimate over-counts ~10-25% vs a real tokenizer, so a
  // near-trigger estimate may be a false alarm; when ON, confirm with the
  // provider's real token count and 'skip' only when the real total is
  // genuinely under both the trigger and the output-fit ceiling. When OFF
  // (default) the over-counting estimate compacts directly — the safe,
  // conservative path that never over-fills the window. `countTokens` takes no
  // AbortSignal (providers/types.ts), so a hung native endpoint would block
  // Ctrl+C / maxWallClockMs — race it against the run signal: on abort the
  // count rejects → refine catches → 'compact', and `signal.aborted` bails the
  // whole compaction (the run is ending). On a fallback-counter provider the
  // count is local + instant, so the race is a no-op. `requestMessages` is an
  // already-materialized array (the post-injection shape), so no ctx-narrowing
  // pin is needed across the await. (A blocking hook returns above, so a
  // PreCompact that then refine-skips fires only on the experimental path —
  // the hook is a permission gate, not a compaction-happened signal.)
  if (budget.compactionTriggerRefine === true) {
    const refine = await refineCompactionTrigger({
      promptTokens,
      triggerAt,
      fixedTokens: estimatePromptTokens([], estimateOpts),
      outputFitCeiling,
      countMessages: () => withAbort(config.provider.countTokens(requestMessages), signal),
    });
    if (refine === 'skip' || signal.aborted) return null;
  }
  // Read pins BEFORE emitting compaction_started, so the
  // started→finished pair has NO throwing statement between them: a DB
  // error here would otherwise skip compaction_finished and leave the
  // adapter-bracketed "Compacting context…" chip open until session:end.
  // (CONTEXT_TUNING §12.4: pins preserved literally across the fold,
  // else they elide with the middle and only reappear on resume.)
  const pinnedBlock = formatPinnedBlock(getActivePinsBySession(config.db, sessionId));
  safeEmit(config.onEvent, {
    type: 'compaction_started',
    promptTokens,
    threshold: triggerAt,
    contextWindow,
  });
  const compactStart = Date.now();
  // Audit/replay trail (compaction_events, AUDIT / CONTEXT_TUNING §12).
  // beforeHash is the pre-compaction context; afterHash is computed at
  // persist time (after the array was rewritten). estimateNow re-reads
  // the live array. Persist is best-effort — never aborts the run.
  // ctxRef pins the (guard-narrowed) context so the closures below don't
  // re-widen `ctx` to `| undefined`.
  const ctxRef = ctx;
  // Post-injection + force-aware (same buildRequestShape + estimateOpts as
  // promptTokens) so the relevance short-circuit's tokensAfterElide and the
  // audit's before/after deltas measure the real request, not the bare history.
  const estimateNow = (): number =>
    estimatePromptTokens(buildRequestShape(ctxRef.getMessages()), estimateOpts);
  const beforeHash = hashContext(ctxRef.getMessages());
  // Thin adapter over the shared recorder: supplies the loop's beforeHash
  // + live array + trigger tokens. The skip-skipped / hashing /
  // best-effort-with-stderr-log all live in recordCompactionEvent.
  const persistCompaction = (e: {
    strategy: string;
    foldedCount: number;
    tokensAfter?: number;
    freedBytes?: number;
    elidedIds?: readonly string[];
    summary?: string;
    reason?: string;
    callUsage?: {
      tokensIn: number;
      tokensOut: number;
      cacheRead: number;
      cacheCreation: number;
    };
  }): void =>
    recordCompactionEvent(config.db, {
      sessionId,
      beforeHash,
      messagesAfter: ctxRef.getMessages(),
      tokensBefore: promptTokens,
      recordedAt: Date.now(),
      ...e,
      // The compaction provider's id (migration 078), recorded only when a provider
      // call BILLED (llm / fallback). The relevance pre-pass makes no call → NULL, so a
      // zero-cost relevance never marks the session metered.
      model: isBilledCompactionStrategy(e.strategy) ? config.provider.id : null,
    });

  // Relevance pre-pass (opt-in): cheaply pointer-elide low-goal-
  // relevance tool_result bodies (NO provider call). If that alone
  // drops the prompt back under the trigger, skip the billed LLM
  // summary entirely. Token-driven — the gate is the real threshold,
  // not a byte heuristic. No spin: a re-trigger finds the now-pointered
  // bodies ineligible and falls through to the LLM.
  //
  // Gated on memoryRegistry: an elided body is recoverable ONLY via
  // retrieve_context (session view), which the harness wires only when
  // memoryRegistry is present (effectiveMemoryRegistry below). Without it
  // (headless / SDK runs) the pointer's "recover via retrieve_context"
  // promise is empty — so skip the pre-pass and let the LLM fold keep a
  // summary in context instead of stranding the body unreachable.
  let relevanceAudit: RelevanceAudit | undefined;
  if (budget.compactionRelevance === true && config.memoryRegistry !== undefined) {
    // Verbatim budget derived from the trigger (shared helper, not a
    // magic constant) — see relevanceVerbatimBudgetBytes.
    // Blend the model's live working-state focus into the relevance query
    // so it tracks the CURRENT sub-task, not just the original goal
    // (which drifts on a long session). Absent panel ⇒ goal-only.
    const wsFocus = workingStateStore.get(sessionId).focus?.text;
    const elide = ctx.relevanceElide({
      verbatimBudgetBytes: relevanceVerbatimBudgetBytes(triggerAt),
      preserveTail: budget.compactionPreserveTail,
      ...(wsFocus !== undefined && wsFocus.length > 0 ? { queryHint: wsFocus } : {}),
    });
    if (elide !== null && elide.elidedCount > 0) {
      relevanceAudit = {
        elidedCount: elide.elidedCount,
        keptCount: elide.keptCount,
        freedBytes: elide.freedBytes,
        elidedIds: elide.elidedIds,
      };
      const tokensAfterElide = estimateNow();
      // Short-circuit the billed LLM summary ONLY when relevance alone got
      // us under the threshold AND no pins are active. Active pins are
      // re-injected into the goal exclusively by ctx.compact's pinnedBlock
      // path; taking this relevance-only return with pins active would
      // bypass it, so a pin whose carrier (e.g. its pin_context
      // tool_result) was just elided here would vanish from the next
      // request — violating the "survives compaction" contract
      // (CONTEXT_TUNING §12.4). With pins active, fall through to the LLM
      // fold below; it runs on the already-gated history, so the pre-pass
      // still pays off, and pinnedBlock re-injection is honored.
      if (tokensAfterElide <= Math.min(triggerAt, outputFitCeiling) && pinnedBlock === undefined) {
        // Relevance alone got us under BOTH the threshold and the output-fit
        // ceiling, no pins — done, no LLM. (Same min() the refine skip uses,
        // and tokensAfterElide is the post-injection shape, so the next
        // request can't re-add the panel/guidance and overflow.)
        const relevanceReason = `relevance-elide: ${elide.elidedCount} tool_results pointered, ${elide.freedBytes}B freed`;
        persistCompaction({
          strategy: 'relevance',
          foldedCount: elide.elidedCount,
          tokensAfter: tokensAfterElide,
          freedBytes: elide.freedBytes,
          elidedIds: elide.elidedIds,
          reason: relevanceReason,
        });
        safeEmit(config.onEvent, {
          type: 'compaction_finished',
          strategy: 'relevance',
          foldedCount: elide.elidedCount,
          durationMs: Date.now() - compactStart,
          usage: emptyUsage(),
          costUsd: 0,
          reason: relevanceReason,
          relevance: relevanceAudit,
        });
        return costCapDetail();
      }
    }
  }

  // Still over the threshold (relevance disabled, freed nothing, or
  // freed too little): run the billed LLM summary on the — possibly
  // already gated — history.
  const compaction = await ctx.compact(config.provider, {
    preserveTail: budget.compactionPreserveTail,
    signal,
    ...(budget.compactionMaxTokens !== undefined ? { maxTokens: budget.compactionMaxTokens } : {}),
    ...(pinnedBlock !== undefined ? { pinnedBlock } : {}),
  });
  const compAcct = accountCompaction(compaction, config.provider.capabilities);
  recordUsage(compaction.usage, compAcct.costUsd, !compAcct.usageIncomplete);
  persistCompaction({
    strategy: compaction.strategy,
    foldedCount: compaction.foldedCount,
    tokensAfter: estimateNow(),
    // Billed usage of the summary call, so the aggregator's token
    // totals account for compaction (cost already does, via
    // sessions.total_cost_usd). compaction.usage is zeroed on the
    // relevance-only path (no provider call).
    callUsage: {
      tokensIn: compaction.usage.input,
      tokensOut: compaction.usage.output,
      cacheRead: compaction.usage.cache_read,
      cacheCreation: compaction.usage.cache_creation,
    },
    ...(relevanceAudit !== undefined
      ? { freedBytes: relevanceAudit.freedBytes, elidedIds: relevanceAudit.elidedIds }
      : {}),
    ...(compaction.summary !== undefined ? { summary: compaction.summary } : {}),
    ...(compaction.reason !== undefined ? { reason: compaction.reason } : {}),
  });
  // After persistCompaction so the post-persist contract holds:
  // the compaction_events row (token side of the charge) is
  // queryable when these fire.
  emitCostUpdate(compAcct.costUsd);
  safeEmit(config.onEvent, { type: 'usage_persisted' });
  const finishedEvent: HarnessEvent = {
    type: 'compaction_finished',
    strategy: compaction.strategy,
    foldedCount: compaction.foldedCount,
    durationMs: Date.now() - compactStart,
    usage: compaction.usage,
    costUsd: compAcct.costUsd,
    ...(compaction.reason !== undefined ? { reason: compaction.reason } : {}),
    ...(relevanceAudit !== undefined ? { relevance: relevanceAudit } : {}),
  };
  safeEmit(config.onEvent, finishedEvent);
  return costCapDetail();
};
