// Bayesian aggregator tests (FEEDBACK_ADAPTATION §5).

import { describe, expect, test } from 'bun:test';
import {
  passesPromotionGate,
  posteriorFromCounts,
  posteriorFromOutcomes,
  tallyOutcomes,
} from '../../src/feedback/bayesian.ts';
import { getPriorForSignature } from '../../src/feedback/priors.ts';

describe('tallyOutcomes', () => {
  test('counts success/failure, ignores partial+ambiguous', () => {
    const t = tallyOutcomes(['success', 'success', 'failure', 'partial', 'ambiguous', 'success']);
    expect(t.successes).toBe(3);
    expect(t.failures).toBe(1);
    expect(t.ignored).toBe(2);
    expect(t.n).toBe(4);
  });

  test('empty list yields all zeros', () => {
    expect(tallyOutcomes([])).toEqual({ successes: 0, failures: 0, ignored: 0, n: 0 });
  });
});

describe('posteriorFromCounts', () => {
  test('Beta(2,1) prior + 8 successes / 2 failures', () => {
    // Posterior Beta(10, 3); mean ≈ 0.769
    const stats = posteriorFromCounts({ alpha: 2, beta: 1 }, 8, 2);
    expect(stats).not.toBeNull();
    if (stats === null) return;
    expect(stats.n).toBe(10);
    expect(stats.mean).toBeCloseTo(10 / 13, 3);
    expect(stats.ciLow).toBeLessThan(stats.mean);
    expect(stats.ciHigh).toBeGreaterThan(stats.mean);
    expect(stats.ciLow).toBeGreaterThanOrEqual(0);
    expect(stats.ciHigh).toBeLessThanOrEqual(1);
  });

  test('Beta(1,1) prior + 9 successes / 1 failure: tighter CI than 1 success / 0 failures', () => {
    // §5.1: same mean, different uncertainty
    const tight = posteriorFromCounts({ alpha: 1, beta: 1 }, 9, 1);
    const loose = posteriorFromCounts({ alpha: 1, beta: 1 }, 1, 0);
    if (tight === null || loose === null) throw new Error('expected non-null');
    expect(tight.ciHigh - tight.ciLow).toBeLessThan(loose.ciHigh - loose.ciLow);
  });

  test('null on n=0', () => {
    expect(posteriorFromCounts({ alpha: 2, beta: 1 }, 0, 0)).toBeNull();
  });

  test('CI bounds clamped to [0, 1]', () => {
    // Extreme: 100 successes, 0 failures → mean near 1; raw normal
    // approximation could push ciHigh above 1.
    const stats = posteriorFromCounts({ alpha: 1, beta: 1 }, 100, 0);
    if (stats === null) throw new Error('expected non-null');
    expect(stats.ciHigh).toBeLessThanOrEqual(1);
    expect(stats.ciLow).toBeGreaterThanOrEqual(0);
  });
});

describe('posteriorFromOutcomes', () => {
  test('end-to-end from outcome list', () => {
    const stats = posteriorFromOutcomes({ alpha: 2, beta: 1 }, [
      'success',
      'success',
      'success',
      'failure',
      'partial', // ignored
    ]);
    if (stats === null) throw new Error('expected non-null');
    expect(stats.n).toBe(4); // 3 successes + 1 failure
    expect(stats.mean).toBeCloseTo(5 / 7, 3); // (2+3) / (2+1+3+1)
  });

  test('null when only partial/ambiguous outcomes', () => {
    expect(posteriorFromOutcomes({ alpha: 2, beta: 1 }, ['partial', 'ambiguous'])).toBeNull();
  });
});

describe('passesPromotionGate', () => {
  test('all conditions met → true', () => {
    expect(passesPromotionGate({ ciLow: 0.75, n: 12, distributionStable: true })).toBe(true);
  });

  test('ci_low <= 0.7 → false', () => {
    expect(passesPromotionGate({ ciLow: 0.7, n: 100, distributionStable: true })).toBe(false);
    expect(passesPromotionGate({ ciLow: 0.69, n: 100, distributionStable: true })).toBe(false);
  });

  test('n < 10 → false even with high CI', () => {
    expect(passesPromotionGate({ ciLow: 0.99, n: 9, distributionStable: true })).toBe(false);
  });

  test('distribution_stable=false → false', () => {
    expect(passesPromotionGate({ ciLow: 0.9, n: 100, distributionStable: false })).toBe(false);
  });

  test('contradiction with superior tier → false', () => {
    expect(
      passesPromotionGate({
        ciLow: 0.9,
        n: 100,
        distributionStable: true,
        noContradictionWithSuperior: false,
      }),
    ).toBe(false);
  });
});

describe('getPriorForSignature', () => {
  test('L1 alias → Beta(2, 1)', () => {
    expect(getPriorForSignature('alias:grep:ripgrep')).toEqual({ alpha: 2, beta: 1 });
  });

  test('L4 strategy → Beta(1, 2)', () => {
    expect(getPriorForSignature('strategy:refactor:js')).toEqual({ alpha: 1, beta: 2 });
  });

  test('foreign signature → uniform Beta(1, 1)', () => {
    expect(getPriorForSignature('unknown:foo:bar')).toEqual({ alpha: 1, beta: 1 });
  });
});
