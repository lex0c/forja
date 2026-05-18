// LLM-judge semantic verifier — constants, types, and shared shapes
// for the S11 dispatcher / scheduler (MEMORY.md §11.x).
//
// Code in this module is the SUBSTRATE consumed by:
//
//   - `src/memory/verify-semantic/dispatcher.ts` (T11.7) — orchestrates
//     scanForInjection → dedup → runSubagent → validate → record.
//   - `src/memory/verify-semantic/scheduler.ts` (T11.8) — polls
//     provenance trail per step boundary; applies the caps + dedup.
//   - `/memory governance status` slash (T11.10) — reads the live
//     counters + caps for operator-facing status display.
//
// The constants live HERE (not in the dispatcher / scheduler files)
// because tests + policy + slash all need to import them without
// pulling in the LLM-spawn machinery.

// ─── tunables ─────────────────────────────────────────────────────────

// Confidence floor for a `contradicted` verdict to land as a pending
// governance proposal. Below this threshold the verdict is recorded
// in memory_verify_attempts but NO proposal is emitted — the judge
// wasn't confident enough to warrant operator attention.
//
// 0.7 is conservative: the LLM-judge's calibration on factual
// contradiction detection in this codebase isn't measured yet, and
// a false-positive that quarantines a real memory is more expensive
// than a false-negative that lets a wrong memory survive one more
// turn. Operators can tune via policy when the calibration data
// shows it's safe to lower.
export const SEMANTIC_VERIFY_MIN_CONFIDENCE = 0.7;

// Per-session dispatch cap. The scheduler refuses to dispatch a new
// verification once the session has fired this many already, even
// when other gates would admit it. Logs the throttle as a stderr
// `memory: verify_semantic_budget_exhausted` line so the operator
// sees it.
//
// 10 picked to cover a daily-driver session of memory-heavy turns
// (~5-10 distinct factual memories exposed per session per typical
// usage) without becoming a per-turn LLM tax for opt-in operators
// who haven't touched policy.
export const MEMORY_VERIFY_SEMANTIC_MAX_DISPATCHES_PER_SESSION = 10;

// Per-session cost cap in USD. Defends against runaway spend when
// a verify dispatches against a corpus that turns out to grow
// unboundedly or against a model whose cost-per-token jumped
// unexpectedly. The scheduler tracks dispatch cost as runSubagent
// resolves; once the cumulative session cost crosses this, refuses
// to dispatch (same stderr signal as the dispatch cap).
//
// 0.50 picked as ~10× the per-dispatch cost on the default Anthropic
// model (claude-haiku-4-5 at ~$0.04 per dispatch). Above the per-
// session dispatch cap × per-dispatch cost (10 × $0.04 = $0.40),
// leaving 25% headroom for cost variance.
export const MEMORY_VERIFY_SEMANTIC_MAX_COST_USD = 0.5;

// Subagent budget — wallclock + step cap for the dispatched
// verify-semantic subagent itself. Forwarded into the spawn factory
// when the dispatcher resolves the definition. Shorter than the
// default subagent budget because the verifier's task is bounded
// (read claim, read evidence files, decide).
export const SEMANTIC_VERIFY_SUBAGENT_MAX_STEPS = 15;
export const SEMANTIC_VERIFY_SUBAGENT_MAX_COST_USD = 0.1;

// Re-export the dedup window from the substrate repo so callers
// have one import surface for all S11 constants.
export { SEMANTIC_VERIFY_DEDUP_WINDOW_MS } from '../storage/repos/memory-verify-attempts.ts';

// ─── shapes ───────────────────────────────────────────────────────────

// Memory subset eligible for the semantic verifier. Spec MEMORY.md
// §1 enumerates four `type` values; only `project` and `reference`
// carry the kind of factual claim a code-aware judge can verify
// against the repo. `user` and `feedback` describe operator
// preferences / discipline (not facts about the codebase), so they
// are out of scope.
export const SEMANTIC_VERIFY_ELIGIBLE_TYPES = ['project', 'reference'] as const;
export type SemanticVerifyEligibleType = (typeof SEMANTIC_VERIFY_ELIGIBLE_TYPES)[number];

// Structured output the verify-semantic subagent MUST emit. Validated
// by `parseOutputAsObject` + a shallow schema gate before the
// dispatcher records the attempt or emits a proposal.
//
// Fields are MUST-be-present unless flagged optional inline. A
// missing required field → discard the verdict and log
// `verify_semantic_malformed` stderr (T11.5).
export interface SemanticVerifyOutput {
  verdict: 'passed' | 'contradicted' | 'inconclusive';
  // [0, 1]. Below SEMANTIC_VERIFY_MIN_CONFIDENCE auto-archives
  // even for contradicted verdicts.
  confidence: number;
  // Short prose extraction of the memory's factual claim, as the
  // judge understood it. Carried into evidence for forensic JOINs.
  claim_extracted: string;
  // Short prose of what the judge saw in the codebase that
  // contradicts (or supports) the claim. Empty string when the
  // judge couldn't reach a verdict (verdict='inconclusive').
  ground_truth_observed: string;
  // File paths the judge cites as evidence. Empty array for
  // `passed` / `inconclusive`. For `contradicted`, the judge MUST
  // populate at least one path (system prompt enforces this; the
  // validator rejects a contradicted verdict with empty evidence
  // paths as a hallucination).
  evidence_paths: string[];
}

// Subagent name. Pinned constant so the dispatcher + the loader +
// the tests all reference the same string.
export const VERIFY_SEMANTIC_SUBAGENT_NAME = 'verify-semantic';

// proposed_by tag used when emitting a governance proposal driven
// by this detector. Matches the trigger derivation in
// `src/memory/governance.ts:triggerForProposal` so the audit chain
// renders the right trigger (`verify_failed`) on the eviction row.
export const VERIFY_SEMANTIC_PROPOSED_BY = 'subagent:verify-semantic';
