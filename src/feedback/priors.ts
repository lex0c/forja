// Bayesian priors per action_signature level (FEEDBACK_ADAPTATION §5.2).
//
// Prior is Beta(α₀, β₀) — the loop frio aggregator combines it with
// observed (successes, failures) to compute the posterior Beta(α₀+S,
// β₀+F). Different levels carry different priors per spec:
//
//   L1 alias    Beta(2, 1)   optimistic — simple aliases usually work
//   L2 flag     Beta(1, 1)   uniform    — moderate risk
//   L3 recipe   Beta(1, 1)   uniform    — no strong prior
//   L4 strategy Beta(1, 2)   pessimistic — strategies fail more than they look
//
// Pessimistic L4 is deliberate (§5.2): protects against premature
// enthusiasm — a strategy that gets 7/10 in a small sample shouldn't
// promote without strong evidence, because strategy classifiers are
// noisy.
//
// Future slice: load priors from a TOML config (operator override)
// per spec §5.2's YAML example. Today defaults are hardcoded; the
// `getPriorForSignature` helper is the single point where config-
// loaded values will plug in.

import { type ActionSignatureLevel, levelOf } from '../storage/repos/action-signature.ts';

export interface BetaPrior {
  // Pseudo-count of successes. Higher = more optimistic.
  alpha: number;
  // Pseudo-count of failures. Higher = more pessimistic.
  beta: number;
}

const PRIORS_BY_LEVEL: Record<ActionSignatureLevel, BetaPrior> = {
  L1: { alpha: 2, beta: 1 },
  L2: { alpha: 1, beta: 1 },
  L3: { alpha: 1, beta: 1 },
  L4: { alpha: 1, beta: 2 },
};

// Default for signatures with no parseable level (foreign vocabulary
// or storage layer that accepts opaque strings). Uniform — safest
// when nothing's known.
const DEFAULT_PRIOR: BetaPrior = { alpha: 1, beta: 1 };

// Resolve the Beta prior for an action_signature. Walks `levelOf`
// (prefix-only check) so the lookup is cheap; level-unknown
// signatures fall through to the uniform default.
export const getPriorForSignature = (actionSignature: string): BetaPrior => {
  const level = levelOf(actionSignature);
  return level === null ? DEFAULT_PRIOR : PRIORS_BY_LEVEL[level];
};

export { PRIORS_BY_LEVEL, DEFAULT_PRIOR };
