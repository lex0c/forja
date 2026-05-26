// Per-turn tokenizer-discrepancy detector. Spec: TOKEN_TUNING.md §8.3
// ("Discrepância handling — log discrepância em
// `failure_events.code: 'tokenizer.discrepancy'`; threshold > 10%").
//
// Called by `loop.ts` after each step where `collected.usageSeen` is
// true. Compares two pairs:
//   1. INPUT  — pre-flight `promptTokensEstimate` (chars/4 over
//               messages + system + tool schemas, computed by the
//               harness right before the provider call) vs the
//               provider-billed `usage.input` from the stream.
//   2. OUTPUT — local chars/4 over `collected.text` vs
//               `usage.output`. The harness already has the full
//               text by the time this runs; recomputing chars/4
//               here (instead of threading the estimate from
//               somewhere) keeps the comparison local and
//               purely a function of the collected step + the
//               estimate the harness itself generated.
//
// Threshold of ±10% is the spec value. Below that we trust the
// heuristic; above that we emit a forensic row so dashboards
// (`agent stats --tokens`) can spot drift trends.
//
// Best-effort emission: a sink that throws does NOT block the loop;
// the harness's existing `failureSink.emit` call sites already eat
// errors with a stderr diagnostic, and we follow that pattern. A
// missing sink (caller didn't wire one) is silently noop'd — same
// behavior as `storage.resume_truncated` and other diagnostic codes.

import type { FailureEventSink } from '../failures/index.ts';
import type { ProviderFamily, UsageInfo } from '../providers/index.ts';
import { estimateTextTokensFor } from '../providers/tokens.ts';

// Spec §8.3: "Threshold > 10%".
export const DISCREPANCY_THRESHOLD = 0.1;

// Compute |estimated - official| / official. official === 0 is
// treated as "no signal" (returns null) — dividing by zero gives
// no useful ratio, and a provider that bills zero input is degenerate
// enough that the discrepancy is not the headline concern.
const ratio = (estimated: number, official: number): number | null => {
  if (official <= 0) return null;
  return Math.abs(estimated - official) / official;
};

export interface TokenizerDiscrepancyCheckInput {
  sessionId: string;
  stepN: number;
  // Identifier the harness uses for billing / cost lookup —
  // doubles as the model id in this codebase (Provider.id is the
  // model name, e.g. `claude-sonnet-4-5`). Persisted in the
  // forensic payload so `agent stats --tokens` can group drift
  // ratios by provider/model over time.
  providerId: string;
  // Provider family. Drives the output-side estimator choice
  // (tiktoken o200k_base for OpenAI vs chars/4 for everyone else).
  // The input estimate was already computed family-aware by the
  // harness, so we don't recompute it here — we receive the number.
  providerFamily: ProviderFamily;
  // Pre-flight estimate of the outbound prompt size. Forwarded by
  // the harness (same number it stamped on `step_start`).
  inputEstimated: number;
  // The full streamed assistant text. Tokenized via
  // `estimateTextTokensFor(providerFamily, ...)` so the output-side
  // estimate dispatches to the right tokenizer per provider — OpenAI
  // uses o200k_base, others fall back to chars/4.
  collectedText: string;
  // Provider-billed usage (only consult when the caller knows
  // `usageSeen === true` — otherwise the comparison is meaningless).
  usage: UsageInfo;
  // Optional sink. When undefined the function is a structural noop
  // (still useful for diagnostics: returns the computed ratios so
  // tests / future telemetry can observe them without a real sink).
  failureSink?: FailureEventSink | undefined;
  // Optional injection for tests. Production callers omit; the
  // sink itself stamps timestamps deterministically when needed.
  now?: () => number;
}

export interface TokenizerDiscrepancyCheckResult {
  // Both can be null when the provider's count was 0 (no signal)
  // or the estimate path was unavailable.
  inputRatio: number | null;
  outputRatio: number | null;
  // True iff the respective ratio exceeded
  // `DISCREPANCY_THRESHOLD` AND a sink emit was attempted.
  emittedInput: boolean;
  emittedOutput: boolean;
}

// Inspect a step's tokenizer numbers and emit a failure event when
// the local estimate diverges from the billed count by more than
// `DISCREPANCY_THRESHOLD`. Idempotent w.r.t. the input — only the
// sink call (if wired) has side effects.
export const checkTokenizerDiscrepancy = (
  input: TokenizerDiscrepancyCheckInput,
): TokenizerDiscrepancyCheckResult => {
  const outputEstimated = estimateTextTokensFor(input.providerFamily, input.collectedText);
  const inputRatio = ratio(input.inputEstimated, input.usage.input);
  const outputRatio = ratio(outputEstimated, input.usage.output);

  let emittedInput = false;
  let emittedOutput = false;

  const sink = input.failureSink;
  if (sink === undefined) {
    return { inputRatio, outputRatio, emittedInput, emittedOutput };
  }

  const stepId = `${input.sessionId}/${input.stepN}`;
  const basePayload = {
    provider: input.providerId,
    threshold: DISCREPANCY_THRESHOLD,
  };

  if (inputRatio !== null && inputRatio > DISCREPANCY_THRESHOLD) {
    try {
      sink.emit({
        code: 'tokenizer.discrepancy.input',
        classe: 'tokenizer',
        recovery_action: 'degraded',
        // Not user-visible: this is a forensic signal aimed at
        // operators reviewing `agent stats --tokens`, not an
        // operator-facing warning. Spamming the live region every
        // time the chars/4 heuristic drifts 11% on a code-heavy
        // turn would train operators to ignore it.
        user_visible: false,
        session_id: input.sessionId,
        step_id: stepId,
        payload: {
          ...basePayload,
          kind: 'input',
          estimated: input.inputEstimated,
          official: input.usage.input,
          ratio: inputRatio,
        },
      });
      emittedInput = true;
    } catch (e) {
      // Best-effort, mirroring the pattern in loop.ts's existing
      // failureSink.emit call sites.
      process.stderr.write(
        `forja: failed to persist tokenizer.discrepancy.input event: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
    }
  }

  if (outputRatio !== null && outputRatio > DISCREPANCY_THRESHOLD) {
    try {
      sink.emit({
        code: 'tokenizer.discrepancy.output',
        classe: 'tokenizer',
        recovery_action: 'degraded',
        user_visible: false,
        session_id: input.sessionId,
        step_id: stepId,
        payload: {
          ...basePayload,
          kind: 'output',
          estimated: outputEstimated,
          official: input.usage.output,
          ratio: outputRatio,
        },
      });
      emittedOutput = true;
    } catch (e) {
      process.stderr.write(
        `forja: failed to persist tokenizer.discrepancy.output event: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
    }
  }

  return { inputRatio, outputRatio, emittedInput, emittedOutput };
};
