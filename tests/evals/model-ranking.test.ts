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
    // status is undefined (errored before producing a HarnessResult); failure
    // carries the reason — this is the case the old status-only predicate missed.
    expect(unfinished(result({ failure: 'missing OLLAMA_API_KEY' }))).toBe(true);
    // Defensive: a missing status with no failure is still "never finished".
    expect(unfinished(result({}))).toBe(true);
  });

  test('the loop non-clean exits count as unfinished', () => {
    expect(unfinished(result({ status: 'exhausted' }))).toBe(true);
    expect(unfinished(result({ status: 'interrupted' }))).toBe(true);
    expect(unfinished(result({ status: 'error' }))).toBe(true);
  });

  test('a clean finish does NOT count as unfinished (pass or expectation-fail)', () => {
    expect(unfinished(result({ status: 'done', passed: true }))).toBe(false);
    // Finished the run but failed an expectation — reached the expect phase, so
    // `failure` is unset; reliability is fine, the pass/fail axis carries it.
    expect(unfinished(result({ status: 'done', passed: false }))).toBe(false);
  });
});
