// LLM-judge conflict detector — constants, types, and shared shapes
// for the S13 dispatcher / scheduler (MEMORY.md §11.x / S13).
//
// Mirrors src/memory/verify-semantic.ts. The constants live HERE
// (not inside the dispatcher / scheduler files) because tests +
// policy + slash all need to import them without pulling in the
// LLM-spawn machinery.

// ─── tunables ─────────────────────────────────────────────────────────

// Confidence floor for a `conflicting` verdict to land as a pending
// governance proposal. Below this threshold the verdict still
// records an attempt-row (audit + dedup) AND a proposal — but the
// proposal is immediately auto-rejected with
// `decided_by='system:low_confidence'`. The operator's forensic
// surface (`/memory governance list --status rejected`) still shows
// the verdict; the apply path doesn't pay attention to it.
//
// 0.7 mirrors SEMANTIC_VERIFY_MIN_CONFIDENCE: same calibration
// posture (operator's time outweighs detector recall in the
// uncalibrated initial period).
export const SEMANTIC_CONFLICT_MIN_CONFIDENCE = 0.7;

// Per-session dispatch + cost caps. Independent counters from S11
// — operators may legitimately have either detector firing more
// than the other in their workload. Same numeric defaults as S11.
export const MEMORY_VERIFY_CONFLICT_MAX_DISPATCHES_PER_SESSION = 10;
export const MEMORY_VERIFY_CONFLICT_MAX_COST_USD = 0.5;

// Subagent budget — wallclock + step cap for the dispatched
// verify-conflict subagent. SHORTER than verify-semantic because the
// pair-judge has no repo-reading footprint (memory_read only; bodies
// already in input). 6 steps + $0.06 is enough for "read, compare,
// emit JSON" with budget headroom for a refused-parse retry.
export const SEMANTIC_CONFLICT_SUBAGENT_MAX_STEPS = 6;
export const SEMANTIC_CONFLICT_SUBAGENT_MAX_COST_USD = 0.06;

// Re-export the dedup window from the substrate repo so callers
// have one import surface for all S13 constants.
export {
  MEMORY_CONFLICT_ATTEMPTS_RETENTION_MS,
  SEMANTIC_CONFLICT_DEDUP_WINDOW_MS,
} from '../storage/repos/memory-conflict-attempts.ts';

// ─── shapes ───────────────────────────────────────────────────────────

// Same eligibility shape as S11 — only project / reference memory
// types are factual enough to be worth pairing. user / feedback
// memories describe operator preferences and are out of scope.
export const SEMANTIC_CONFLICT_ELIGIBLE_TYPES = ['project', 'reference'] as const;
export type SemanticConflictEligibleType = (typeof SEMANTIC_CONFLICT_ELIGIBLE_TYPES)[number];

// Structured output the verify-conflict subagent MUST emit.
// Validated by `parseOutputAsObject` + a shallow schema gate in the
// dispatcher before the attempt + proposal land.
export interface SemanticConflictOutput {
  conflicting: boolean;
  // Free-form kebab-case label — examples in the .md system prompt.
  conflict_kind: string;
  // [0, 1]. Below SEMANTIC_CONFLICT_MIN_CONFIDENCE auto-archives
  // even for conflicting verdicts.
  confidence: number;
  evidence: {
    shared_concept: string;
    polarity_a: string;
    polarity_b: string;
  };
}

// Subagent name. Pinned constant so the dispatcher + loader + tests
// all reference the same string.
export const VERIFY_CONFLICT_SUBAGENT_NAME = 'verify-conflict';

// proposed_by tag used when emitting a governance proposal driven
// by this detector. Matches the trigger derivation in
// `src/memory/governance.ts:triggerForProposal` so the audit chain
// renders the right trigger (`conflict_detected`) on the eviction
// row.
export const VERIFY_CONFLICT_PROPOSED_BY = 'subagent:verify-conflict';

// BM25 prefilter cap (T13.2). For N siblings in the same scope as
// the just-written memory, the scheduler dispatches LLM-judge calls
// against at most K of them — those with highest BM25 score against
// the just-written memory's body. K=5 balances "cheap LLM cost" with
// "catch the actual conflicts" — siblings with zero token overlap are
// implausibly conflicting, and the top-5 by BM25 catch the
// near-duplicate / antonym cases the heuristic-only S4 missed.
export const CONFLICT_PREFILTER_K = 5;
