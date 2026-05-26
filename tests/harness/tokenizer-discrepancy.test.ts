// Pins for the per-turn tokenizer-discrepancy detector
// (`src/harness/tokenizer-discrepancy.ts`). Spec: TOKEN_TUNING.md §8.3.

import { describe, expect, test } from 'bun:test';
import type { EmitFailureEventInput, FailureEventSink } from '../../src/failures/index.ts';
import {
  DISCREPANCY_THRESHOLD,
  checkTokenizerDiscrepancy,
} from '../../src/harness/tokenizer-discrepancy.ts';
import type { UsageInfo } from '../../src/providers/index.ts';

// Test sink that records every emit. Captures the raw input so
// pins can assert payload shape — the real sink scrubs + hashes
// + persists, but for the discrepancy detector's contract the
// only invariant is "the right emit() call was made".
const captureSink = (): {
  emits: EmitFailureEventInput[];
  sink: FailureEventSink;
} => {
  const emits: EmitFailureEventInput[] = [];
  return {
    emits,
    sink: {
      emit: (input) => {
        emits.push(input);
        return { id: '', this_chain_hash: '' };
      },
      verifyChain: () => ({ ok: true, rows: 0 }),
    },
  };
};

const usage = (overrides: Partial<UsageInfo> = {}): UsageInfo => ({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_creation: 0,
  ...overrides,
});

describe('checkTokenizerDiscrepancy', () => {
  test('no emit when both ratios are within ±10%', () => {
    // Pin the steady-state. The compaction trigger lives or dies on
    // the heuristic being roughly right; emitting forensic rows for
    // every minor sub-10% drift would flood the table and train
    // operators to ignore it.
    // Estimate 1050 vs official 1000 → 5% drift. Text length 400
    // → output estimate 100; official 100 → 0%.
    const { emits, sink } = captureSink();
    const result = checkTokenizerDiscrepancy({
      sessionId: 's1',
      stepN: 1,
      providerId: 'claude-sonnet-4-5',
      providerFamily: 'anthropic',
      inputEstimated: 1050,
      collectedText: 'a'.repeat(400),
      usage: usage({ input: 1000, output: 100 }),
      failureSink: sink,
    });
    expect(emits).toHaveLength(0);
    expect(result.emittedInput).toBe(false);
    expect(result.emittedOutput).toBe(false);
    expect(result.inputRatio).toBeCloseTo(0.05, 2);
    expect(result.outputRatio).toBe(0);
  });

  test('input ratio compares against FULL billed payload (input + cache_read + cache_creation), not fresh input alone', () => {
    // Anthropic's `usage.input` is the FRESH-ONLY portion; cached
    // prefix lives in `cache_read`/`cache_creation`. Our pre-flight
    // estimator walks the full payload, so a naive `estimated vs
    // usage.input` comparison would fire a false-positive on every
    // cached-prefix turn (estimate=10200 vs usage.input=200 → ratio
    // 49 → emit). The fix sums all three on the official side so
    // the comparison is like-to-like.
    const { emits, sink } = captureSink();
    const result = checkTokenizerDiscrepancy({
      sessionId: 's-cache',
      stepN: 1,
      providerId: 'claude-sonnet-4-5',
      providerFamily: 'anthropic',
      // Full payload estimate ~ 10200 tokens.
      inputEstimated: 10_200,
      collectedText: '',
      // Provider bills: 200 fresh + 10000 cache hit + 0 creation = 10200 total.
      usage: usage({ input: 200, output: 0, cache_read: 10_000, cache_creation: 0 }),
      failureSink: sink,
    });
    // Estimate matches the total payload → ratio ≈ 0 → no emit.
    expect(result.inputRatio).toBeCloseTo(0, 4);
    expect(result.emittedInput).toBe(false);
    expect(emits).toHaveLength(0);
  });

  test('input ratio still fires when the estimator drifts vs the full payload', () => {
    // Sanity: the fix didn't accidentally suppress all input emits.
    // Same cached-prefix shape but the estimator returns 2× the
    // billed total → 100% drift → emit.
    const { emits, sink } = captureSink();
    const result = checkTokenizerDiscrepancy({
      sessionId: 's-drift',
      stepN: 1,
      providerId: 'claude-sonnet-4-5',
      providerFamily: 'anthropic',
      inputEstimated: 20_400, // 2x the billed total
      collectedText: '',
      usage: usage({ input: 200, output: 0, cache_read: 10_000, cache_creation: 0 }),
      failureSink: sink,
    });
    expect(result.emittedInput).toBe(true);
    expect(emits).toHaveLength(1);
    // `official` payload pin: matches the FULL billed sum, not
    // `usage.input` alone — keeps the persisted payload's
    // numerator/denominator pair self-consistent.
    expect((emits[0]?.payload as { official: number } | undefined)?.official).toBe(10_200);
  });

  test('emit input discrepancy when ratio crosses threshold', () => {
    // 2000 estimated vs 1000 official → 100% drift, well over the
    // 10% threshold. Forensic emit must carry both numbers, the
    // computed ratio, and the threshold so dashboards can group
    // by drift magnitude.
    const { emits, sink } = captureSink();
    const result = checkTokenizerDiscrepancy({
      sessionId: 's1',
      stepN: 7,
      providerId: 'claude-sonnet-4-5',
      providerFamily: 'anthropic',
      inputEstimated: 2000,
      collectedText: 'small',
      usage: usage({ input: 1000, output: 2 }),
      failureSink: sink,
    });
    expect(result.emittedInput).toBe(true);
    expect(emits).toHaveLength(1);
    const e = emits[0];
    expect(e?.code).toBe('tokenizer.discrepancy.input');
    expect(e?.classe).toBe('tokenizer');
    expect(e?.recovery_action).toBe('degraded');
    expect(e?.user_visible).toBe(false);
    expect(e?.session_id).toBe('s1');
    expect(e?.step_id).toBe('s1/7');
    expect(e?.payload).toMatchObject({
      provider: 'claude-sonnet-4-5',
      threshold: DISCREPANCY_THRESHOLD,
      kind: 'input',
      estimated: 2000,
      official: 1000,
    });
    // Ratio computed and persisted; >1 since estimate is 2× official.
    expect((e?.payload as { ratio: number } | undefined)?.ratio).toBeCloseTo(1.0, 2);
  });

  test('emit output discrepancy when chars/4 of streamed text diverges >10% from official', () => {
    // Text of 4000 chars → ceil(4000/4) = 1000 estimated on the
    // chars/4 path (non-OpenAI families). Official says 500 →
    // 100% drift on the output side. Family pinned to 'anthropic'
    // so the heuristic is used; OpenAI's tiktoken o200k_base would
    // compress repeat-character runs into a different count and
    // the discrepancy SHRINKS — which IS the whole point of
    // slice 6, but is covered by its own pin further down.
    const { emits, sink } = captureSink();
    const result = checkTokenizerDiscrepancy({
      sessionId: 's2',
      stepN: 3,
      providerId: 'claude-sonnet-4-5',
      providerFamily: 'anthropic',
      inputEstimated: 100,
      collectedText: 'x'.repeat(4000),
      usage: usage({ input: 100, output: 500 }),
      failureSink: sink,
    });
    expect(result.emittedOutput).toBe(true);
    expect(emits).toHaveLength(1);
    expect(emits[0]?.code).toBe('tokenizer.discrepancy.output');
    expect(emits[0]?.payload).toMatchObject({
      kind: 'output',
      estimated: 1000,
      official: 500,
      provider: 'claude-sonnet-4-5',
    });
  });

  test('OpenAI family uses tiktoken o200k_base instead of chars/4 (slice 6)', () => {
    // Slice 6 of the 3-layer token plan: OpenAI's o200k_base BPE
    // replaces chars/4 on both sides. The pin compares the two
    // estimate paths AGAINST EACH OTHER for the same text — same
    // input, different family — so the assertion holds regardless
    // of o200k_base's exact internal merges (the project's spec
    // doesn't pin those, and pinning them would couple this test
    // to the upstream `gpt-tokenizer` version).
    //
    // Run BOTH paths via the helper, collecting the output ratios
    // (which embed the respective `outputEstimated` divided by the
    // same official count). The ratios MUST differ — that's the
    // structural evidence that the family dispatch happened.
    const text = 'The quick brown fox jumps over the lazy dog repeatedly.';
    const officialOutput = 11; // o200k_base's approximate count for this sentence
    const heuristicResult = checkTokenizerDiscrepancy({
      sessionId: 's2b',
      stepN: 1,
      providerId: 'p',
      providerFamily: 'anthropic',
      inputEstimated: 50,
      collectedText: text,
      usage: usage({ input: 50, output: officialOutput }),
    });
    const tiktokenResult = checkTokenizerDiscrepancy({
      sessionId: 's2b',
      stepN: 1,
      providerId: 'gpt-4o',
      providerFamily: 'openai',
      inputEstimated: 50,
      collectedText: text,
      usage: usage({ input: 50, output: officialOutput }),
    });
    // Both ratios should be defined; the OpenAI ratio should be
    // SMALLER (tiktoken is closer to the official count than chars/4
    // for English prose — slice 6's value proposition).
    expect(heuristicResult.outputRatio).not.toBeNull();
    expect(tiktokenResult.outputRatio).not.toBeNull();
    expect(tiktokenResult.outputRatio).toBeLessThan(heuristicResult.outputRatio as number);
  });

  test('both input AND output discrepancy emits TWO events', () => {
    // Independent thresholds: an input-side drift doesn't gate the
    // output check. Pin so a refactor that short-circuits after the
    // first emit (or merges into one row) is caught immediately.
    const { emits, sink } = captureSink();
    checkTokenizerDiscrepancy({
      sessionId: 's3',
      stepN: 1,
      providerId: 'p',
      providerFamily: 'anthropic',
      inputEstimated: 5000,
      collectedText: 'a'.repeat(800),
      usage: usage({ input: 1000, output: 100 }),
      failureSink: sink,
    });
    expect(emits.map((e) => e.code)).toEqual([
      'tokenizer.discrepancy.input',
      'tokenizer.discrepancy.output',
    ]);
  });

  test('official === 0 returns null ratio (no signal) — no emit', () => {
    // A provider that bills zero is degenerate; the ratio would
    // divide by zero. We treat 0 as "no signal" rather than
    // emitting on every tool-only turn where the provider truthfully
    // returned 0 output tokens. The harness already records the
    // unmeasured status via `usageSeen` / aggregate flags.
    const { emits, sink } = captureSink();
    const result = checkTokenizerDiscrepancy({
      sessionId: 's4',
      stepN: 1,
      providerId: 'p',
      providerFamily: 'anthropic',
      inputEstimated: 1000,
      collectedText: 'whatever',
      usage: usage({ input: 0, output: 0 }),
      failureSink: sink,
    });
    expect(result.inputRatio).toBeNull();
    expect(result.outputRatio).toBeNull();
    expect(emits).toHaveLength(0);
  });

  test('exactly at the threshold (10%) does NOT emit — strict greater-than', () => {
    // 1100 estimated vs 1000 official → exactly 10%. The spec wording
    // is "Threshold > 10%"; we read that strictly so a borderline
    // ratio doesn't oscillate the forensic table. Above-threshold
    // crosses are unambiguous; exactly-at boundary is a no-op.
    const { emits, sink } = captureSink();
    const result = checkTokenizerDiscrepancy({
      sessionId: 's5',
      stepN: 1,
      providerId: 'p',
      providerFamily: 'anthropic',
      inputEstimated: 1100,
      collectedText: '',
      usage: usage({ input: 1000, output: 0 }),
      failureSink: sink,
    });
    expect(result.inputRatio).toBeCloseTo(0.1, 5);
    expect(result.emittedInput).toBe(false);
    expect(emits).toHaveLength(0);
  });

  test('absent sink returns ratios but performs no side effects', () => {
    // Diagnostic shape: callers without a wired sink (one-shot SDK
    // mode, headless replay) still get the computed numbers for
    // logging / telemetry, just no DB write. Mirrors the harness
    // pattern where failureSink is optional throughout the loop.
    const result = checkTokenizerDiscrepancy({
      sessionId: 's6',
      stepN: 1,
      providerId: 'p',
      providerFamily: 'anthropic',
      inputEstimated: 5000,
      collectedText: 'a'.repeat(4000),
      usage: usage({ input: 1000, output: 100 }),
    });
    expect(result.inputRatio).toBeCloseTo(4.0, 2);
    expect(result.outputRatio).toBeCloseTo(9.0, 2);
    expect(result.emittedInput).toBe(false);
    expect(result.emittedOutput).toBe(false);
  });

  test('sink that throws does not propagate — best-effort emit', () => {
    // The discrepancy check is forensic, not load-bearing. A sink
    // throwing (DB locked, disk full) must NOT crash the agent loop.
    // Mirrors `loop.ts`'s existing `failureSink.emit` try/catch
    // pattern around storage.resume_truncated.
    const throwingSink: FailureEventSink = {
      emit: () => {
        throw new Error('disk full');
      },
      verifyChain: () => ({ ok: true, rows: 0 }),
    };
    expect(() =>
      checkTokenizerDiscrepancy({
        sessionId: 's7',
        stepN: 1,
        providerId: 'p',
        providerFamily: 'anthropic',
        inputEstimated: 5000,
        collectedText: '',
        usage: usage({ input: 1000, output: 0 }),
        failureSink: throwingSink,
      }),
    ).not.toThrow();
  });
});
