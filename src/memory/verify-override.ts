// LLM-judge override verifier — constants, types, and shared shapes
// for the S3 dispatcher / scheduler (MEMORY.md §11.x, spec §6.5.2).
//
// Code in this module is the SUBSTRATE consumed by:
//
//   - `src/memory/verify-override-dispatcher.ts` — orchestrates
//     scanForInjection → runSubagent → validate → record. Invoked by
//     the scheduler when a memory's override counter trips the
//     threshold (`countOverridesInWindow >= MEMORY_OVERRIDE_THRESHOLD_COUNT`).
//   - `src/memory/verify-override-scheduler.ts` — polls
//     `memory_override_events` per step boundary; applies the caps
//     and per-memory threshold; one dispatch per (scope, name) per
//     tick.
//   - `/memory governance status` slash — reads the live counters
//     for operator-facing display.
//
// The constants live HERE (not in the dispatcher / scheduler files)
// because tests + policy + slash all need to import them without
// pulling in the LLM-spawn machinery.

// ─── tunables ─────────────────────────────────────────────────────────

// Confidence floor for a `misguiding: true` verdict to land as a
// pending governance proposal. Below this threshold the verdict is
// recorded but NO proposal is emitted — the judge wasn't confident
// enough to warrant operator attention.
//
// 0.7 mirrors S11 (verify-semantic) + S13 (verify-conflict). Same
// rationale: false-positive that quarantines a real memory is more
// expensive than a false-negative that lets a wrong memory survive
// another step boundary. The threshold-gate (3 overrides in 24h)
// already ensures the judge only dispatches against memories with
// real-world evidence of operator friction — the confidence floor
// is the second-layer check on the LLM verdict itself.
export const SEMANTIC_OVERRIDE_MIN_CONFIDENCE = 0.7;

// Per-session dispatch cap. Mirrors S11/S13 cadence. The scheduler
// refuses to dispatch once this many fire in one session; logs the
// throttle as a stderr `memory: verify_override_budget_exhausted`
// line. Memory-override sessions tend to cluster (operator goes
// through a debugging run, hits 3-4 overrides for the same handful
// of memories) so 10 is generous headroom.
export const MEMORY_VERIFY_OVERRIDE_MAX_DISPATCHES_PER_SESSION = 10;

// Per-session cost cap in USD. Mirrors S11/S13. The threshold gate
// already bounds dispatch frequency (one per memory per cooldown
// window), so the cost cap is the runaway-spend ceiling not the
// primary rate-limit. 0.50 picked symmetric with verify-semantic
// + verify-conflict.
export const MEMORY_VERIFY_OVERRIDE_MAX_COST_USD = 0.5;

// Subagent budget — wallclock + step cap for the dispatched
// verify-override subagent. Slightly larger budget than verify-
// conflict because the judge reasons over multiple override events
// + the memory body + the affected tool calls; verify-conflict has
// a tighter focus (pair of bodies). Smaller than verify-semantic
// because there's no file-system grounding step — the judge
// reasons purely over operator behavior + memory text.
export const SEMANTIC_OVERRIDE_SUBAGENT_MAX_STEPS = 8;
export const SEMANTIC_OVERRIDE_SUBAGENT_MAX_COST_USD = 0.08;

// Cooldown between dispatches for the SAME memory. Prevents the
// scheduler from re-firing immediately on the next override above
// threshold (the threshold counter is sliding — 3 events in 24h
// keeps holding for hours after the dispatch). Without this, every
// new override above threshold would re-dispatch and burn budget.
//
// 24h matches the threshold window: the judge looks at the same
// pool of events for that long; re-dispatching with the same pool
// (and an unchanged memory body) is structurally redundant. When
// the operator edits the memory body (`content_hash` drifts) or
// when the 24h window rolls past the last attempt, dispatch
// resumes.
export const SEMANTIC_OVERRIDE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// ─── shapes ───────────────────────────────────────────────────────────

// Memory subset eligible for the override verifier. Same shape as
// S11 + S13: only `project` and `reference` (factual). `user` /
// `feedback` describe operator preferences — an operator overriding
// behavior derived from those is a feedback loop the LLM-judge
// can't usefully arbitrate ("operator overrode their own preference"
// resolves to "the preference is what they say it is").
export const SEMANTIC_OVERRIDE_ELIGIBLE_TYPES = ['project', 'reference'] as const;
export type SemanticOverrideEligibleType = (typeof SEMANTIC_OVERRIDE_ELIGIBLE_TYPES)[number];

// Structured output the verify-override subagent MUST emit.
// Validated by the dispatcher before recording / emitting a proposal.
// A missing required field → discard the verdict and log
// `verify_override_malformed` to stderr.
export interface SemanticOverrideOutput {
  // True ⇒ the memory's content plausibly drove the rejected /
  // denied actions. The judge looked at the override events + the
  // memory body and concluded the rule embedded in the memory is
  // not what the operator wants.
  misguiding: boolean;
  // [0, 1]. Below SEMANTIC_OVERRIDE_MIN_CONFIDENCE auto-archives
  // even for misguiding=true verdicts.
  confidence: number;
  // Short prose extraction of the rule / claim the judge inferred
  // from the memory body. Carried into the governance proposal's
  // evidence for forensic JOINs.
  rule_extracted: string;
  // Short prose of why the operator's overrides contradict the
  // rule. Empty string when the judge couldn't reach a verdict
  // (misguiding=false implies no contradiction observed).
  override_pattern_observed: string;
  // Suggested motivo for the resulting quarantine proposal. The
  // judge picks based on the override pattern: 'conflict' for
  // memories whose rules disagree with operator preference,
  // 'shift' for memories whose context drifted (operator moved on
  // from the project state the memory captured). Validation
  // restricts to a closed enum — the governance apply path passes
  // it through to `eviction_events.motivo`.
  suggested_motivo: 'conflict' | 'shift' | 'low_roi';
}

// Subagent name. Pinned constant so the dispatcher + the loader +
// the tests all reference the same string.
export const VERIFY_OVERRIDE_SUBAGENT_NAME = 'verify-override';

// proposed_by tag used when emitting a governance proposal driven
// by this detector. Matches the trigger derivation in
// `src/memory/governance.ts:triggerForProposal` so the audit chain
// renders the right trigger (`user_override_repeated`) on the
// eviction row.
export const VERIFY_OVERRIDE_PROPOSED_BY = 'subagent:verify-override';
