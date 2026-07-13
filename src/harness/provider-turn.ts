// Provider-turn driver extracted from the harness loop's runAgent (N3 — reduce
// the god-object). "Drive one provider call" was two things inline in the
// ~4200-line closure: assembling the per-step GenerateRequest, and composing the
// four stream primitives (retry / stall-watchdog / abort / collect) in a
// load-bearing order. Both move here so the request shape and — more importantly
// — the fragile wrap ordering live in one named, unit-testable place. Behavior
// is preserved verbatim; the request assembly and the collect composition are
// byte-for-byte the same as the inline versions.
import type {
  GenerateRequest,
  Provider,
  ProviderMessage,
  ProviderToolDef,
  StreamEvent,
} from '../providers/index.ts';
import { abortableIterable, stallWatchdog } from './abortable.ts';
import { type CollectedStep, collectStep } from './collect.ts';
import { DEFAULT_RETRY, generateWithRetry } from './retry.ts';
import type { HarnessConfig } from './types.ts';

export interface BuildGenerateRequestArgs {
  config: HarnessConfig;
  // The already-context-assembled message list (working-state panel, proactive
  // recall, static guidance already injected by the caller).
  messages: ProviderMessage[];
  // Resolved output-token budget for this step.
  maxTokens: number;
  // Resolved tool defs; omitted from the request when empty.
  tools: ProviderToolDef[];
  // Resolved provider reasoning-effort for this request; omitted when undefined.
  effort: GenerateRequest['effort'];
}

// Assemble the per-step GenerateRequest. Kept as one place so the
// exactOptionalPropertyTypes conditional spreads (a field is present ONLY when
// set, never as an explicit `undefined`) can't drift between callers.
export const buildGenerateRequest = (args: BuildGenerateRequestArgs): GenerateRequest => {
  const { config, messages, maxTokens, tools, effort } = args;
  return {
    model: config.provider.id,
    messages,
    max_tokens: maxTokens,
    ...(config.systemPrompt !== undefined ? { system: config.systemPrompt } : {}),
    ...(config.systemSegments !== undefined ? { systemSegments: config.systemSegments } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.topP !== undefined ? { top_p: config.topP } : {}),
    ...(config.thinkingBudget !== undefined ? { thinking_budget: config.thinkingBudget } : {}),
    // Provider reasoning-effort axis. Each adapter maps it to its native
    // surface; the operational caps ride `budget` separately.
    ...(effort !== undefined ? { effort } : {}),
    ...(config.seedInEval !== undefined ? { seed_in_eval: config.seedInEval } : {}),
  };
};

export interface CollectProviderStepArgs {
  provider: Provider;
  req: GenerateRequest;
  // Silent-stall budget for the watchdog (budget.maxStepStallMs).
  maxStepStallMs: number;
  // Combined abort signal (user Ctrl+C + wall-clock).
  signal: AbortSignal;
  // Live observer: each raw provider event is forwarded here (UI renderer /
  // the caller's verify-gate output buffering).
  onEvent: (event: StreamEvent) => void;
}

// Make ONE provider call and drain its stream into a CollectedStep. The
// four-primitive composition order is LOAD-BEARING:
//   1. generateWithRetry produces the raw stream (transient-error retries).
//   2. stallWatchdog wraps inside-out so a silent provider stall throws
//      StepStallError — the timer resets on every yield.
//   3. abortableIterable wraps OUTSIDE so external aborts (Ctrl+C, wall-clock)
//      take precedence over stall detection.
//   4. collectStep drains, forwarding each raw event to `onEvent`.
// Inverting (1) and (2) would count the consumer's own processing time (heavy
// renderer work between deltas) against the stall budget and falsely trip on
// slow consumers rather than real provider hangs. The Provider interface does
// not propagate signals to the SDK, so without the abort wrap a hung HTTP
// request blocks indefinitely and neither Ctrl+C nor maxWallClockMs can
// interrupt it. Throws (CollectStepError wrapping the partial step) on stream
// failure — the caller owns error routing.
export const collectProviderStep = (args: CollectProviderStepArgs): Promise<CollectedStep> => {
  const { provider, req, maxStepStallMs, signal, onEvent } = args;
  return collectStep(
    abortableIterable(
      stallWatchdog(generateWithRetry(provider, req, DEFAULT_RETRY), maxStepStallMs),
      signal,
    ),
    onEvent,
  );
};
