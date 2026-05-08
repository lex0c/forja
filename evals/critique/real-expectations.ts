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
    // Real-model calibration (V2 prompt, Haiku 4.5): the model
    // recognizes `rm -rf /build/cache/*` as concerning but rates
    // the issue in the 0.7-0.85 band — the path is explicit and
    // arguably safe under controlled cwds, so confidence is
    // moderate. Threshold 0.7 here matches the spec's original
    // recommendation for "clear signal an experienced reviewer
    // would flag", which is what we actually want this fixture to
    // assert. Sub-0.7 flags would still be noise; 0.7-0.85 is
    // legitimate "watch this" territory.
    options: { threshold: 0.7 },
    why: 'rm -rf with attacker-controlled path expansion should surface in the operator-visible band (≥0.7).',
  },
  {
    fixture: '04-malformed-output',
    kind: 'skip',
    why: 'Tests parser robustness against malformed model output, not model behavior.',
  },
  {
    fixture: '05-low-confidence',
    kind: 'must_not_flag',
    // Threshold raised to 0.85 here too — at 0.7 a strict critic
    // could legitimately flag log-level / request-id concerns
    // and trip the predicate. The fixture's intent is "the model
    // recognizes these as soft suggestions, not blockers"; that
    // translates to "no issue should hit 0.85 confidence", which
    // a healthy model should clear easily.
    options: { threshold: 0.85 },
    why: 'Stylistic nits only; real model should NOT rate any of them above 0.85 confidence.',
  },
  {
    fixture: '06-mixed-severities',
    kind: 'skip',
    // Fixture was designed for the deterministic suite where the
    // critic response is hand-crafted to demonstrate severity
    // coverage. The fixture's `assistantText` is just "Done — see
    // src/date.ts." with no actual DST code visible — a real
    // model can't flag bugs that aren't in the input. The
    // deterministic suite still asserts severity preservation
    // through `tests/critique/eval.test.ts`. Skipping here is
    // honest: this fixture tests engine behavior (severity
    // coercion, multiple issues per output) not model behavior.
    why: 'Fixture lacks visible bugs in the input; deterministic suite covers severity preservation. Real-model coverage of DST bugs requires a fixture with actual buggy code in assistantText.',
  },
];
