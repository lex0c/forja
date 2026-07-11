import { describe, expect, test } from 'bun:test';
import { CSV_COLUMNS, cacheReadRate, remapRow, unfinished } from '../../scripts/model-ranking.ts';
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

describe('cacheReadRate (ranking cache-hit metric)', () => {
  test('null when the provider never cached this battery (no read or write)', () => {
    // Ollama (cache: false) reads 0 / writes 0 but still has prompt tokens —
    // that is "n/a", not "0% hit", so the CSV cell stays blank.
    expect(cacheReadRate(0, 0, 5000)).toBeNull();
  });

  test('fraction of prompt tokens served from cache when caching is active', () => {
    // 900 read + 100 write of 1000 prompt tokens → 90% hit.
    expect(cacheReadRate(900, 100, 1000)).toBeCloseTo(0.9, 5);
  });

  test('null on an all-setup-failure battery (no usage at all — avoids 0/0)', () => {
    expect(cacheReadRate(0, 0, 0)).toBeNull();
  });
});

describe('remapRow (CSV schema migration)', () => {
  test('a row from an older header gets a blank cell for each new column, by name', () => {
    const oldHeader = 'model,cost_usd';
    const out = remapRow(oldHeader, 'ollama/x,0.000000');
    const cells = out.split(',');
    const at = (name: string): string | undefined => cells[CSV_COLUMNS.indexOf(name)];
    // Same width as the current schema; known columns preserved by NAME (not index),
    // every column the old header lacked filled blank.
    expect(cells.length).toBe(CSV_COLUMNS.length);
    expect(at('model')).toBe('ollama/x');
    expect(at('cost_usd')).toBe('0.000000');
    expect(at('cache_read_rate')).toBe('');
    expect(at('composite')).toBe('');
  });
});
