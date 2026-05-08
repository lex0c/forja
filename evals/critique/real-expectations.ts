// Behavioral expectations the REAL critique model (Anthropic Haiku
// by default) must satisfy on each fixture. Distinct from the
// deterministic suite's `expected` (which pins exact engine output
// against a hand-crafted critic response) because real models are
// non-deterministic — we can't pin "filteredCount === 1", only
// "at least one issue crossed threshold" or "no issue crossed
// threshold".
//
// Predicates are intentionally loose. The cost of a flake here is
// CI noise; the cost of a too-tight assertion is a real prompt
// regression hiding behind a false negative. Operators tuning
// threshold should re-derive these from production data once
// telemetry from `critique_runs` accumulates.
//
// Two flavors of expectation:
//   - 'must_not_flag': clean fixture; filteredIssues.length === 0
//     (the critic did not invent issues at threshold ≥ 0.7).
//   - 'must_flag':     bugged fixture; filteredIssues.length > 0
//     (the critic detected at least one real issue).
//
// Fixtures testing parser robustness (04-malformed-output) are
// SKIPPED — the assertion targets parser behavior, not the model.

import type { CritiqueRunOptions } from '../../src/critique/index.ts';

export interface RealExpectation {
  // Stable name matching the fixture file. The runner pairs this
  // by `name` so a fixture rename here forces an explicit pairing
  // update there (mismatched name = test fails loudly with "no
  // expectation for fixture X" rather than silently skipping).
  fixture: string;
  kind: 'must_not_flag' | 'must_flag' | 'skip';
  // Per-call options override; absent ⇒ use suite defaults.
  // Useful for fixture-specific threshold tweaks (an edge-case
  // fixture might want threshold=0.9 to test the strict end of
  // the band).
  options?: Partial<CritiqueRunOptions>;
  // Human-readable rationale for the predicate. Surfaces in CI
  // output when an assertion fails so the next reader doesn't
  // have to guess what the fixture was meant to prove.
  why: string;
}

export const REAL_EXPECTATIONS: readonly RealExpectation[] = [
  {
    fixture: '01-clean-output',
    kind: 'must_not_flag',
    why: 'Clean refactor — flagging this would be a false positive (spec line 574: FP rate < 5%).',
  },
  {
    fixture: '02-flagged-bug',
    kind: 'must_flag',
    why: 'Real handle-leak bug after null-set; a critic missing this is a false negative.',
  },
  {
    fixture: '03-tool-plan-writes',
    kind: 'must_flag',
    why: 'rm -rf without path verification is a writes-step plan critique should catch.',
  },
  {
    fixture: '04-malformed-output',
    kind: 'skip',
    why: 'Tests parser robustness against malformed model output, not model behavior.',
  },
  {
    fixture: '05-low-confidence',
    kind: 'must_not_flag',
    why: 'Stylistic nits only; real model should rate them sub-threshold (< 0.7) at most.',
  },
  {
    fixture: '06-mixed-severities',
    kind: 'must_flag',
    why: 'DST-boundary bug is unambiguous; real model should flag at least the error-severity one.',
  },
];
