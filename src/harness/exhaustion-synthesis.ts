// Pre-terminal synthesis turn (STATE_MACHINE.md §2.2 / ORCHESTRATION.md §8.2),
// extracted from runAgent so its decision + orchestration are unit-testable in
// isolation (the behaviour is unchanged; this is the same code as the old inline
// closure). A run that spent its whole step budget on tool calls would otherwise
// return an EMPTY output — the report was always going to be the last action,
// which never came. So before transitioning to `exhausted`, make ONE tool-less
// provider call ("budget's up, write your answer now") and persist it as the
// closing assistant turn.
//
// The mutable run totals (usage / cost / usageComplete) and the cost-cap /
// compaction closures live in runAgent; they cross this seam via `deps`, with
// `recordUsage` / `markUsageIncomplete` as the ONLY write seam back into the
// loop's accumulators (so cost stays single-sourced).

import { computeCost } from '../providers/cost.ts';
import type { GenerateRequest, ProviderMessage, UsageInfo } from '../providers/index.ts';
import { abortableIterable, stallWatchdog } from './abortable.ts';
import { buildAssistantContent } from './assistant-content.ts';
import { CollectStepError, collectStep } from './collect.ts';
import { resolveProviderEffort } from './effort.ts';
import { DEFAULT_RETRY, generateWithRetry } from './retry.ts';
import type { SessionContext } from './session-context.ts';
import {
  type HarnessConfig,
  type HarnessEvent,
  type RunBudget,
  resolveMaxOutputTokens,
} from './types.ts';

export const EXHAUSTION_DIRECTIVE =
  'Your step budget is exhausted — you may not call any more tools. Write your final answer or report NOW using only what you have already gathered, and state explicitly what you did not get to check.';

// Did the run end on a SETTLED text answer — the LAST message an assistant
// carrying non-empty text, with nothing pending after it? Then the synthesis is
// a no-op. Crucially this inspects the LAST message, NOT the last assistant: a
// `text + tool_use` turn whose tool_results were appended AFTER it is NOT
// settled — the model emitted a preamble ("I'll inspect…") and never
// incorporated the tool output, so the run must still synthesize. Walking back
// past trailing tool_results would mistake that preamble for the answer.
export const endsWithSettledAnswer = (messages: readonly ProviderMessage[]): boolean => {
  const last = messages[messages.length - 1];
  if (last?.role !== 'assistant') return false; // trailing tool_results ⇒ unconsumed
  const c = last.content;
  if (typeof c === 'string') return c.trim().length > 0;
  return c.some((b) => b.type === 'text' && b.text.trim().length > 0);
};

// Append the exhaustion directive (alternation-safe). Returns a NEW array — the
// caller's history is untouched (the directive is ephemeral; only the assistant
// synthesis is persisted). Merges into a trailing user message so we never emit
// two consecutive user turns; pushes a fresh user turn otherwise.
export const buildSynthesisMessages = (
  messages: readonly ProviderMessage[],
  directive: string,
): ProviderMessage[] => {
  const out: ProviderMessage[] = [...messages];
  const last = out[out.length - 1];
  if (last?.role === 'user') {
    out[out.length - 1] =
      typeof last.content === 'string'
        ? { role: 'user', content: `${last.content}\n\n${directive}` }
        : { role: 'user', content: [...last.content, { type: 'text', text: directive }] };
  } else {
    out.push({ role: 'user', content: directive });
  }
  return out;
};

// Build the tool-less synthesis request. NO tools is the load-bearing difference
// — the model can only synthesize, never consume more budget or recurse. Mirrors
// the normal turn's sampling/determinism axes so the synthesis isn't silently
// sampled differently (`seed_in_eval` keeps eval replay reproducible).
export const buildSynthesisRequest = (
  config: HarnessConfig,
  budget: RunBudget,
  messages: ProviderMessage[],
  reqEffort: ReturnType<typeof resolveProviderEffort>,
): GenerateRequest => ({
  model: config.provider.id,
  messages,
  max_tokens: resolveMaxOutputTokens(budget, config.provider.capabilities),
  ...(config.systemPrompt !== undefined ? { system: config.systemPrompt } : {}),
  ...(config.systemSegments !== undefined ? { systemSegments: config.systemSegments } : {}),
  ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
  ...(config.topP !== undefined ? { top_p: config.topP } : {}),
  ...(config.thinkingBudget !== undefined ? { thinking_budget: config.thinkingBudget } : {}),
  ...(reqEffort !== undefined ? { effort: reqEffort } : {}),
  ...(config.seedInEval !== undefined ? { seed_in_eval: config.seedInEval } : {}),
});

// The runAgent state this turn reaches through. The loop owns the mutable
// accumulators; `recordUsage` / `markUsageIncomplete` are the only write seam,
// and `costCapDetailIfExceeded` reads them back so a mid-turn re-check reflects
// the spend just applied.
export interface ExhaustionSynthesisDeps {
  ctx: SessionContext;
  config: HarnessConfig;
  budget: RunBudget;
  signal: AbortSignal;
  costCapDetailIfExceeded: () => string | null;
  // Forced compaction (force=true bypasses the steps>=maxSteps skip AND estimates
  // tool-less); folds its own summary cost into the run totals.
  maybeCompact: (force: boolean) => Promise<string | null>;
  recordUsage: (usage: UsageInfo, cost: number, usageSeen: boolean) => void;
  markUsageIncomplete: () => void;
  emit: (event: HarnessEvent) => void;
  emitCostUpdate: (delta: number) => void;
}

// The outcome the caller acts on. `costOverage` (non-null) → finish maxCostUsd (a
// hard cap breach, already over or crossed by the compaction / synthesis).
// `truncation` → the synthesis call ITSELF stopped at max_tokens / the context
// window, so the final report is incomplete; surface maxOutputTokens /
// maxContextTokens like a normal turn instead of masking it as plain step
// exhaustion. Both null → the caller finishes maxSteps.
export interface ExhaustionSynthesisResult {
  costOverage: string | null;
  truncation: { reason: 'maxOutputTokens' | 'maxContextTokens'; detail: string } | null;
}

const NO_OP: ExhaustionSynthesisResult = { costOverage: null, truncation: null };
const overage = (costOverage: string | null): ExhaustionSynthesisResult => ({
  costOverage,
  truncation: null,
});

// Best-effort closing turn. No-op on a settled answer; a failed synthesis still
// proceeds (cost recovered). See ExhaustionSynthesisResult for what the caller does.
export const synthesizeOnExhaustion = async (
  deps: ExhaustionSynthesisDeps,
): Promise<ExhaustionSynthesisResult> => {
  const { ctx, config, budget, signal } = deps;
  if (endsWithSettledAnswer(ctx.getMessages())) return NO_OP;
  const preOverage = deps.costCapDetailIfExceeded();
  if (preOverage !== null) return overage(preOverage);
  // Compact/elide first: a read-heavy run's last tool_results can push the
  // history past the window, and the top-of-loop maybeCompact() is bypassed here
  // (it skips at steps >= maxSteps), so an un-compacted synthesis request would
  // 400. Force it for this transition, then re-check the cost cap — the summary
  // call can itself cross it.
  await deps.maybeCompact(true);
  const compactOverage = deps.costCapDetailIfExceeded();
  if (compactOverage !== null) return overage(compactOverage);
  const reqEffort = resolveProviderEffort(config);
  const req = buildSynthesisRequest(
    config,
    budget,
    buildSynthesisMessages(ctx.getMessages(), EXHAUSTION_DIRECTIVE),
    reqEffort,
  );
  let collected: Awaited<ReturnType<typeof collectStep>>;
  try {
    collected = await collectStep(
      abortableIterable(
        stallWatchdog(
          generateWithRetry(config.provider, req, DEFAULT_RETRY),
          budget.maxStepStallMs,
        ),
        signal,
      ),
      (ev) => deps.emit({ type: 'provider_event', event: ev }),
    );
  } catch (e) {
    // A failed synthesis turn must never mask the exhaustion result. Still
    // recover whatever the provider already billed — it charges input tokens the
    // moment the request is accepted — mirroring the normal turn's recovery.
    deps.markUsageIncomplete();
    if (e instanceof CollectStepError && e.partial.usageSeen) {
      const partialCost = computeCost(config.provider.capabilities, e.partial.usage);
      deps.recordUsage(e.partial.usage, partialCost, true);
      deps.emitCostUpdate(partialCost);
    }
    // The recovered partial cost above may have crossed the cap. A failed call
    // produced no usable report, so there's no truncation to surface.
    return overage(deps.costCapDetailIfExceeded());
  }
  const assistantContent = buildAssistantContent(collected);
  const turnCostUsd = computeCost(config.provider.capabilities, collected.usage);
  deps.recordUsage(collected.usage, turnCostUsd, collected.usageSeen);
  ctx.appendAssistant(
    assistantContent,
    {
      usageSeen: collected.usageSeen,
      tokensIn: collected.usage.input,
      tokensOut: collected.usage.output,
      cacheRead: collected.usage.cache_read,
      cacheCreation: collected.usage.cache_creation,
      costUsd: turnCostUsd,
    },
    config.systemPromptHash ?? null,
    reqEffort ?? null,
    // The model that billed this synthesis turn (migration 077).
    config.provider.id,
  );
  deps.emitCostUpdate(turnCostUsd);
  // usage_persisted is the display cue (fires for EVERY settled response);
  // emitCostUpdate skips zero deltas, so a $0 local model would otherwise leave
  // the REPL/subagent footer stale for the synthesized turn until a later boundary.
  deps.emit({ type: 'usage_persisted' });
  // The synthesis call itself can truncate (max_tokens) or overflow the context
  // window — the report just persisted is incomplete, so signal that (like a normal
  // turn) instead of letting the caller report a clean maxSteps.
  let truncation: ExhaustionSynthesisResult['truncation'] = null;
  if (collected.stop_reason === 'max_tokens') {
    truncation = {
      reason: 'maxOutputTokens',
      detail: `synthesis truncated at max_tokens (cap=${req.max_tokens})`,
    };
  } else if (collected.stop_reason === 'model_context_window_exceeded') {
    truncation = {
      reason: 'maxContextTokens',
      detail:
        'synthesis stopped at the context window limit (model_context_window_exceeded); reduce input or rely on compaction',
    };
  }
  // The synthesis cost may also have crossed the cap — caller finishes maxCostUsd.
  return { costOverage: deps.costCapDetailIfExceeded(), truncation };
};
