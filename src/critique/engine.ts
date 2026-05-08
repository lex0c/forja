// Self-critique engine (AGENTIC_CLI.md §5.4, ORCHESTRATION.md §6).
//
// Slice A scope. Pure function: takes a provider + input + options,
// returns a CritiqueResult. Does NOT touch the harness loop, does
// NOT persist anything, does NOT emit events. Loop wiring lands in
// Slice B.
//
// Three guarantees the engine commits to:
//   1. Bounded latency: `maxOverheadMs` is a hard ceiling. Past it,
//      the engine returns strategy='skipped' (run continues, audit
//      sees `overhead_exceeded`). The critic NEVER blocks the loop
//      indefinitely.
//   2. Bounded blast radius: stream errors / parse failures collapse
//      to strategy='failed'. The run is not aborted — the critic is
//      a soft check, not a hard gate.
//   3. Cost honesty: any usage the provider reported (even on a
//      failed/aborted call) flows through `usage` + `costUsd`. The
//      caller folds this into session totals; ignoring partial bills
//      would underreport spend.

import { abortableIterable } from '../harness/abortable.ts';
import { CollectStepError, collectStep } from '../harness/collect.ts';
import { computeCost, emptyUsage } from '../providers/cost.ts';
import type { GenerateRequest, Provider, StreamEvent, UsageInfo } from '../providers/index.ts';
import { stripAnsi } from '../sanitize/index.ts';
import {
  CRITIQUE_MARKER_CLOSE,
  CRITIQUE_MARKER_OPEN,
  CRITIQUE_SYSTEM_PROMPT_V1,
  DEFAULT_CRITIQUE_PROMPT_VERSION,
  renderCritiqueUserMessage,
} from './prompt.ts';
import type {
  CritiqueInput,
  CritiqueIssue,
  CritiqueOutput,
  CritiqueResult,
  CritiqueRunOptions,
  CritiqueSeverity,
} from './types.ts';

const DEFAULT_MAX_TOKENS = 1024;

// Clamp into [lo, hi]. Used for both threshold and confidence so a
// misconfigured threshold (e.g. negative) and a misbehaving model
// (confidence=2.0) both end up in the legal range.
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

// Severity values the spec accepts (§5.4). Anything else is coerced
// to `warn` — preserves the issue for audit while preventing a
// downstream consumer from receiving an invalid enum.
const VALID_SEVERITIES: ReadonlySet<string> = new Set(['info', 'warn', 'error']);

const coerceSeverity = (raw: unknown): CritiqueSeverity => {
  if (typeof raw === 'string' && VALID_SEVERITIES.has(raw)) {
    return raw as CritiqueSeverity;
  }
  return 'warn';
};

// Walk the model output and return the substring between the first
// open marker and the matching close marker. Returns null when
// either marker is missing — caller treats as parse failure.
//
// Markers + JSON (rather than raw JSON) survives chatter prefaces,
// markdown fences, and refusal text outside the markers. Inside,
// only the first `{` after the open marker through the last `}`
// before the close marker is parsed; this is enough to handle the
// common case where the model emits ` ```json {...} ``` ` between
// markers — the fences land outside the `{...}` slice.
const extractMarkerPayload = (text: string): string | null => {
  const openIdx = text.indexOf(CRITIQUE_MARKER_OPEN);
  if (openIdx < 0) return null;
  const afterOpen = openIdx + CRITIQUE_MARKER_OPEN.length;
  const closeIdx = text.indexOf(CRITIQUE_MARKER_CLOSE, afterOpen);
  if (closeIdx < 0) return null;
  const between = text.slice(afterOpen, closeIdx);
  const firstBrace = between.indexOf('{');
  const lastBrace = between.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < firstBrace) return null;
  return between.slice(firstBrace, lastBrace + 1);
};

interface ParsedCritique {
  output: CritiqueOutput;
}

// Parse the marker payload into a typed CritiqueOutput. Returns null
// on any structural failure: invalid JSON, missing arrays, wrong
// types. Per-issue type errors are softened (clamped confidence,
// coerced severity, empty strings for missing description /
// suggestion) — those preserve the issue for audit. The spec calls
// this out: false positives can be tuned via threshold, but a
// completely unparseable response means the critic added zero signal
// for the cost.
const parseCritique = (raw: string): ParsedCritique | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const issuesRaw = obj.issues;
  if (!Array.isArray(issuesRaw)) return null;
  const issues: CritiqueIssue[] = [];
  for (const entry of issuesRaw) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const description = typeof e.description === 'string' ? e.description.trim() : '';
    const suggestion = typeof e.suggestion === 'string' ? e.suggestion.trim() : '';
    const confidenceRaw = typeof e.confidence === 'number' ? e.confidence : Number(e.confidence);
    const confidence = Number.isFinite(confidenceRaw) ? clamp(confidenceRaw, 0, 1) : 0;
    // Drop issues that carry no description AND no suggestion: those
    // are pure noise the model padded the array with.
    if (description.length === 0 && suggestion.length === 0) continue;
    issues.push({
      severity: coerceSeverity(e.severity),
      description,
      confidence,
      suggestion,
    });
  }
  const overallRaw =
    typeof obj.overall_confidence === 'number'
      ? obj.overall_confidence
      : Number(obj.overall_confidence);
  const overallConfidence = Number.isFinite(overallRaw) ? clamp(overallRaw, 0, 1) : 0;
  return { output: { issues, overallConfidence } };
};

// Wrap the provider stream so two concurrent abort sources agree
// on cancellation: (a) the caller's external signal (Ctrl+C, wall-
// clock, parent cancellation) and (b) our internal overhead
// watchdog. AbortSignal.any from Node 20+ would do this in one
// line; we do it manually for runtime portability.
//
// Returns the wrapped iterable plus a `cleanup()` that the caller
// MUST run regardless of outcome — clears the watchdog timer and
// detaches the listener so a successful early return doesn't leak.
const buildAbortableStream = (
  source: AsyncIterable<StreamEvent>,
  callerSignal: AbortSignal | undefined,
  watchdogMs: number,
): {
  stream: AsyncIterable<StreamEvent>;
  cleanup: () => void;
  watchdogFired: () => boolean;
} => {
  const ctrl = new AbortController();
  let watchdogFiredFlag = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (watchdogMs > 0) {
    timer = setTimeout(() => {
      watchdogFiredFlag = true;
      ctrl.abort();
    }, watchdogMs);
  }
  let onCallerAbort: (() => void) | null = null;
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) {
      ctrl.abort();
    } else {
      onCallerAbort = () => ctrl.abort();
      callerSignal.addEventListener('abort', onCallerAbort);
    }
  }
  const cleanup = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (callerSignal !== undefined && onCallerAbort !== null) {
      callerSignal.removeEventListener('abort', onCallerAbort);
      onCallerAbort = null;
    }
  };
  return {
    stream: abortableIterable(source, ctrl.signal),
    cleanup,
    watchdogFired: () => watchdogFiredFlag,
  };
};

// Engine entry point. The harness loop (Slice B) calls this with
// the per-step input + the operator's CritiqueConfig folded into
// CritiqueRunOptions. Always returns a CritiqueResult — never
// throws for "soft" failures (parse, stream error, watchdog). Only
// throws when the CALLER's signal aborted, so the loop can route
// to its existing aborted/maxWallClockMs handling.
export const runCritique = async (
  provider: Provider,
  input: CritiqueInput,
  options: CritiqueRunOptions,
): Promise<CritiqueResult> => {
  const start = Date.now();
  const threshold = clamp(options.threshold, 0, 1);
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const promptVersion = options.promptVersion ?? DEFAULT_CRITIQUE_PROMPT_VERSION;

  const userMessage = renderCritiqueUserMessage(input);

  const req: GenerateRequest = {
    model: provider.id,
    system: CRITIQUE_SYSTEM_PROMPT_V1,
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: maxTokens,
    // Determinism: the critic should produce the same opinion for
    // the same input across runs (replay, eval). 0 also helps the
    // structured-marker output stay in shape.
    temperature: 0,
    metadata: { critique_prompt_version: promptVersion },
  };

  const watchdog = buildAbortableStream(
    provider.generate(req),
    options.signal,
    options.maxOverheadMs,
  );

  let attemptUsage: UsageInfo = emptyUsage();
  let attemptUsageSeen = false;
  let collectedText = '';
  let streamErrorReason: string | null = null;

  try {
    const collected = await collectStep(watchdog.stream);
    attemptUsage = collected.usage;
    attemptUsageSeen = collected.usageSeen;
    collectedText = collected.text;
    if (collected.errors.length > 0) {
      streamErrorReason = collected.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
    }
  } catch (err) {
    if (err instanceof CollectStepError) {
      attemptUsage = err.partial.usage;
      attemptUsageSeen = err.partial.usageSeen;
      collectedText = err.partial.text;
    }
    // Caller-driven abort: rethrow so the harness loop's aborted
    // path takes over (Ctrl+C, wall-clock). Internal watchdog
    // shows up here as the same AbortError shape, so we
    // disambiguate via the watchdog flag.
    const callerAborted = options.signal?.aborted === true;
    if (callerAborted && !watchdog.watchdogFired()) {
      watchdog.cleanup();
      throw err;
    }
    if (watchdog.watchdogFired()) {
      watchdog.cleanup();
      const usage = attemptUsage;
      return {
        strategy: 'skipped',
        filteredIssues: [],
        rawIssues: [],
        overallConfidence: 0,
        durationMs: Date.now() - start,
        costUsd: attemptUsageSeen ? computeCost(provider.capabilities, usage) : 0,
        usage,
        usageSeen: attemptUsageSeen,
        reason: `overhead_exceeded (>${options.maxOverheadMs}ms)`,
      };
    }
    // Generic stream failure (network blip, malformed events that
    // CollectStepError didn't classify). Soft-fail per
    // ORCHESTRATION §6: critic must not derail the run.
    const cause = err instanceof Error ? err.message || err.name || String(err) : String(err);
    streamErrorReason = streamErrorReason ?? cause;
  } finally {
    watchdog.cleanup();
  }

  const costUsd = attemptUsageSeen ? computeCost(provider.capabilities, attemptUsage) : 0;

  if (streamErrorReason !== null) {
    return {
      strategy: 'failed',
      filteredIssues: [],
      rawIssues: [],
      overallConfidence: 0,
      durationMs: Date.now() - start,
      costUsd,
      usage: attemptUsage,
      usageSeen: attemptUsageSeen,
      reason: `stream_error: ${streamErrorReason}`,
    };
  }

  if (collectedText.trim().length === 0) {
    return {
      strategy: 'failed',
      filteredIssues: [],
      rawIssues: [],
      overallConfidence: 0,
      durationMs: Date.now() - start,
      costUsd,
      usage: attemptUsage,
      usageSeen: attemptUsageSeen,
      reason: 'empty_response',
    };
  }

  // Strip ANSI before parsing — same defense the compaction module
  // applies (a buggy/hijacked proxy could inject control bytes).
  const sanitized = stripAnsi(collectedText);
  const payload = extractMarkerPayload(sanitized);
  if (payload === null) {
    return {
      strategy: 'failed',
      filteredIssues: [],
      rawIssues: [],
      overallConfidence: 0,
      durationMs: Date.now() - start,
      costUsd,
      usage: attemptUsage,
      usageSeen: attemptUsageSeen,
      reason: 'markers_missing',
    };
  }
  const parsed = parseCritique(payload);
  if (parsed === null) {
    return {
      strategy: 'failed',
      filteredIssues: [],
      rawIssues: [],
      overallConfidence: 0,
      durationMs: Date.now() - start,
      costUsd,
      usage: attemptUsage,
      usageSeen: attemptUsageSeen,
      reason: 'parse_failed',
    };
  }

  const rawIssues = parsed.output.issues;
  const filteredIssues = rawIssues.filter((i) => i.confidence >= threshold);

  return {
    strategy: 'llm',
    filteredIssues,
    rawIssues,
    overallConfidence: parsed.output.overallConfidence,
    durationMs: Date.now() - start,
    costUsd,
    usage: attemptUsage,
    usageSeen: attemptUsageSeen,
  };
};
