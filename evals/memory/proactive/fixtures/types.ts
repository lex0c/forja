import type { MemoryScope, MemoryState } from '../../../../src/memory/types.ts';

// Per-fixture shape consumed by `tests/memory/proactive-eval-fixtures.test.ts`.
//
// Unlike the governance eval (which drives a real dispatcher with a mocked
// subagent verdict), the proactive-recall eval is fully deterministic with no
// model at all: the recall is BM25 + the §4.4 I3 trust/active filter, both pure
// functions of the seeded corpus + the turn inputs. Each fixture seeds a memory
// corpus, names the turn's recall inputs (the working-state focus + the user
// prompt), and asserts what the proactive recall does — which memories surface,
// which must NOT, the cap, and the injected block's size (the Δcache-cost proxy).
//
// What this suite catches:
//   - Useful recall regressions — a clearly-relevant memory drops below top-K.
//   - Noise leakage — an irrelevant memory clears the BM25 floor and gets
//     injected, paying cache cost for nothing.
//   - I3 robustness — an untrusted / quarantined memory keyword-stuffed to top
//     the BM25 ranking still NEVER surfaces (the trust/active gate runs first).
//   - Top-K cap — the injected set stays bounded no matter the corpus size.
//   - Δcache cost — the injected block stays under a char ceiling (a
//     deterministic proxy for the uncached-tail tokens §4.1-4.2 worried about).
//
// What it does NOT catch:
//   - Whether the floor=1.0 / topK=3 *values* are well-tuned for a given target
//     model. That's calibration against a real model — the separate default-ON
//     follow-up, not a deterministic pin.

// One memory the fixture seeds onto disk + into the registry before the recall
// runs. `type`/`source` are fixed by the seeder (feedback/inferred) — the
// proactive recall doesn't read them, so the fixture stays focused on the
// signals that matter: text, trust, state, triggers.
export interface ProactiveFixtureMemory {
  scope: MemoryScope;
  name: string;
  // Folded into the corpus at the description weight (×2). Also the MEMORY.md
  // index hook.
  description: string;
  // Default 'active'. Set 'quarantined' / 'archived' for I3 active-only tests.
  state?: MemoryState;
  // Default trusted. Set 'untrusted' for the I3 trust-gate tests.
  trust?: 'trusted' | 'untrusted';
  // §4.4 P3 runtime tags — folded into the proactive corpus.
  triggers?: readonly string[];
  body: string;
}

export interface ProactiveRecallExpected {
  // Node ids (`memory:scope/name`) that MUST surface in the recalled set.
  recalls?: readonly string[];
  // Node ids that MUST NOT surface (noise below the floor, or I3-excluded).
  excludes?: readonly string[];
  // Exact size of the recalled set (pins floor / top-K behavior).
  count?: number;
  // Upper bound on the injected block length in chars (the Δcache-cost proxy);
  // asserted against `formatProactiveRecallBlock(recalled)`.
  maxBlockChars?: number;
}

export interface ProactiveRecallFixture {
  // Stable id — must match the file basename so per-fixture diagnostics name it.
  name: string;
  description: string;
  // The seeded corpus (each memory written to disk + listed in MEMORY.md).
  memories: readonly ProactiveFixtureMemory[];
  // The turn's recall inputs: the working-state focus (the query head) + the
  // user prompt. Mirrors the loop call site (`resolveCachedRecall`).
  goalText: string;
  prompt: string;
  expected: ProactiveRecallExpected;
}
