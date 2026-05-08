import type {
  CritiqueInput,
  CritiqueRunOptions,
  CritiqueStrategy,
} from '../../../src/critique/index.ts';

// Per-fixture shape consumed by `tests/critique/eval.test.ts`.
//
// The fixture pre-renders the critic's response (including the
// `[critique]` markers) so the engine sees deterministic input
// regardless of network / model availability. The runner builds a
// mock `Provider` whose `generate` yields this string verbatim,
// then asserts the resulting `CritiqueResult` matches `expected`.

export interface CritiqueFixture {
  // Stable identifier — must match the file basename so the
  // runner's per-fixture diagnostics carry the right name.
  name: string;
  description: string;
  // Engine input. The runner passes this verbatim to
  // `runCritique`.
  input: CritiqueInput;
  // The critic's raw text response, including markers. The mock
  // provider emits this as a single text_delta then stops.
  criticResponse: string;
  // Optional engine option overrides. The runner defaults
  // threshold=0.7, watchdog=0.
  options?: Partial<CritiqueRunOptions>;
  // Outcome assertions. The runner uses `toBe`/`toBeGreaterThanOrEqual`
  // on the named fields; missing fields are not asserted.
  expected: {
    strategy: CritiqueStrategy;
    rawCount?: number;
    filteredCount?: number;
    minOverallConfidence?: number;
    maxOverallConfidence?: number;
    // Substring the engine's `reason` must contain. Useful for
    // soft-failure fixtures that need to confirm the right reason
    // path fired (parse_failed vs markers_missing vs
    // overhead_exceeded).
    reasonContains?: string;
  };
}
