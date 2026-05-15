// Bayesian aggregator (FEEDBACK_ADAPTATION §5).
//
// Combines a Beta prior with observed (successes, failures) into a
// posterior Beta(α₀+S, β₀+F) and computes (mean, ci_low, ci_high, n)
// for the promotion gate (§5.3).
//
// CI method: normal approximation on the Beta posterior. For Beta(α,β)
// with α, β both reasonably sized (>10), Var = αβ / ((α+β)² (α+β+1));
// the 95% CI is mean ± 1.96 × sqrt(Var). This is well-behaved when
// the promotion gate's n >= 10 threshold filters out the tiny-sample
// regime where normal approximation breaks down.
//
// Alternatives considered:
//   - Wilson score interval: designed for binomial proportions;
//     would require treating prior as pseudo-counts. Slightly more
//     accurate at small n; complexity not worth the gain given our
//     n >= 10 floor.
//   - Exact Beta quantile via numerical incomplete beta inverse:
//     correct at all n but ~50× the code + slower. Future slice can
//     swap in if the gate moves below n=10 or accuracy near the
//     gate boundary becomes operationally meaningful.

import type { OutcomeResult } from '../storage/repos/outcomes.ts';
import type { BetaPrior } from './priors.ts';

// 1.96 is the z-score for a two-sided 95% normal CI. Centralized so
// future slices can parameterize confidence levels without scattering
// magic numbers.
const Z_95 = 1.96;

export interface PosteriorStats {
  // Posterior mean = α / (α + β).
  mean: number;
  // 95% credibility interval lower bound, clamped to [0, 1].
  ciLow: number;
  // 95% credibility interval upper bound, clamped to [0, 1].
  ciHigh: number;
  // Observed sample size (S + F). Excludes prior pseudo-counts —
  // gate's `n >= 10` reads this number, not α+β.
  n: number;
}

// Tally a list of outcome results into (successes, failures, n).
// 'success' counts toward success; 'failure' counts toward failure;
// 'partial' and 'ambiguous' are EXCLUDED from the binomial — spec
// §5 frames the posterior as P(success | this action_signature in
// this scope); ambiguous outcomes contaminate that signal and feed
// into a different surface (per-tier evidence schema, future slice).
export const tallyOutcomes = (
  results: OutcomeResult[],
): { successes: number; failures: number; ignored: number; n: number } => {
  let successes = 0;
  let failures = 0;
  let ignored = 0;
  for (const r of results) {
    if (r === 'success') successes++;
    else if (r === 'failure') failures++;
    else ignored++;
  }
  return { successes, failures, ignored, n: successes + failures };
};

// Compute posterior stats from a prior + observed counts. Returns
// `null` when n === 0 (no observations; posterior IS the prior; no
// data-driven gate decision can apply).
export const posteriorFromCounts = (
  prior: BetaPrior,
  successes: number,
  failures: number,
): PosteriorStats | null => {
  const n = successes + failures;
  if (n === 0) return null;
  const a = prior.alpha + successes;
  const b = prior.beta + failures;
  const mean = a / (a + b);
  const variance = (a * b) / ((a + b) ** 2 * (a + b + 1));
  const stdev = Math.sqrt(variance);
  const ciLow = Math.max(0, mean - Z_95 * stdev);
  const ciHigh = Math.min(1, mean + Z_95 * stdev);
  return { mean, ciLow, ciHigh, n };
};

// Convenience: tally + posterior in one call. Returns null when no
// success/failure observations exist (only partial/ambiguous).
export const posteriorFromOutcomes = (
  prior: BetaPrior,
  results: OutcomeResult[],
): PosteriorStats | null => {
  const { successes, failures } = tallyOutcomes(results);
  return posteriorFromCounts(prior, successes, failures);
};

// Promotion gate per §5.3. Returns true when:
//   - ci_low > 0.7 (margin lower bound, not mean)
//   - n >= 10 (minimum sample size)
//   - distribution_stable (caller passes — comes from §7.3 detector)
//
// `noContradictionWithSuperior` is the §5.3 "contradicts active policy
// in higher tier" check; caller passes the result of the comparison.
// Per spec this defaults to true (no contradiction known) — the
// strict check is the caller's responsibility because it needs the
// scope chain we don't carry here.
export interface PromotionGateInput {
  ciLow: number;
  n: number;
  distributionStable: boolean;
  noContradictionWithSuperior?: boolean;
}

export const passesPromotionGate = (input: PromotionGateInput): boolean => {
  if (input.ciLow <= 0.7) return false;
  if (input.n < 10) return false;
  if (!input.distributionStable) return false;
  if (input.noContradictionWithSuperior === false) return false;
  return true;
};

export { Z_95 };
