import { describe, expect, test } from 'bun:test';
import { unfinished } from '../../scripts/model-ranking.ts';
import type { EvalCaseResult } from '../../src/evals/types.ts';

// Regression for the ranking's `unfinished_rate`. A setup failure (missing API
// key, bootstrap throw, early timeout) leaves EvalCaseResult.status UNDEFINED +
// failure set. The old predicate took only the status STRING, so those errored
// cases read as 0% unfinished — a whole batch that failed setup looked perfectly
// reliable. `unfinished` now takes the whole result and counts those.

const result = (over: Partial<EvalCaseResult>): EvalCaseResult => ({
  name: 'c',
  sourcePath: 'c.yaml',
  passed: false,
  durationMs: 0,
  costUsd: 0,
  steps: 0,
  usageComplete: true,
  expectations: [],
  ...over,
});

describe('unfinished (ranking unfinished_rate)', () => {
  test('a setup failure (no harness result) counts as unfinished', () => {
    // The signal is the MISSING status (the run errored before producing a
    // HarnessResult), NOT the failure string — a setup failure leaves status
    // undefined. This is the case the original status-only predicate missed.
    expect(unfinished(result({ failure: 'missing OLLAMA_API_KEY' }))).toBe(true);
    expect(unfinished(result({}))).toBe(true); // missing status, no failure → still unfinished
  });

  test('the loop non-clean exits count as unfinished', () => {
    expect(unfinished(result({ status: 'exhausted' }))).toBe(true);
    expect(unfinished(result({ status: 'interrupted' }))).toBe(true);
    expect(unfinished(result({ status: 'error' }))).toBe(true);
  });

  test('a clean finish does NOT count as unfinished — even when over its cost budget', () => {
    expect(unfinished(result({ status: 'done', passed: true }))).toBe(false);
    // Finished the run but failed an expectation — reached the expect phase, so
    // reliability is fine; the pass/fail axis carries it.
    expect(unfinished(result({ status: 'done', passed: false }))).toBe(false);
    // Completed but overspent the case's declared maxCostUsd: a real status PLUS
    // a "cost exceeded" failure (executor.ts sets both). It reached the expect
    // phase → pass/cost, NOT reliability. Regression: keying on `failure` (or any
    // non-undefined status with failure) wrongly counted this as unfinished.
    expect(
      unfinished(result({ status: 'done', failure: 'cost 0.5000 exceeded budget 0.4000' })),
    ).toBe(false);
  });
});
