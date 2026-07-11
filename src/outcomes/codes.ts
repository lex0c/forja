// Outcome signal vocabulary per PERMISSION_ENGINE.md §6.3.2's
// calibration plan. Slice 131 ships four kinds — one per concrete
// proxy the system already observes. Per-kind defaults are the
// "informed guess" baseline analogous to the score's
// RISK_SCORE_WEIGHTS; future calibration sweeps will validate or
// adjust them via the same logistic regression that derives v2.1
// score weights.
//
// Source of truth for both the sink (default weight + ttl) and
// the migration's CHECK enum. A new kind requires (a) an entry
// here, (b) an ALTER on the CHECK list, AND (c) wiring at the
// observable signal site. The format-strict approach mirrors the
// failure_events codes vocabulary (slice 130) — silent drift
// between sites would fragment calibration data.

export type OutcomeSignalKind =
  | 'tool_error'
  | 'failure_event'
  | 'checkpoint_reverted'
  | 'session_aborted';

export const OUTCOME_SIGNAL_KINDS: ReadonlySet<OutcomeSignalKind> = new Set<OutcomeSignalKind>([
  'tool_error',
  'failure_event',
  'checkpoint_reverted',
  'session_aborted',
]);

export const isOutcomeSignalKind = (v: unknown): v is OutcomeSignalKind =>
  typeof v === 'string' && OUTCOME_SIGNAL_KINDS.has(v as OutcomeSignalKind);

// Per-kind default weight. Values from slice 131 plan §"Pesos
// default por kind":
//
//   tool_error          0.30  Weak. Tool errors are often benign
//                              (transient, missing file, retry).
//                              A single error rarely implies the
//                              decision was wrong; aggregating
//                              across many errors does.
//   failure_event       0.50  Medium. A downstream failure_event
//                              (sandbox loss, storage contention)
//                              indicates system trouble correlated
//                              with the decision but not provably
//                              causal. Calibration sweeps will
//                              tighten or loosen.
//   checkpoint_reverted 0.90  Strong. Operator ran `--undo`. The
//                              explicit human judgment that the
//                              authorized change should not have
//                              happened — the closest proxy to
//                              "harmful" the system can observe
//                              without out-of-band review.
//   session_aborted     0.20  Weak. Sessions abort for many
//                              reasons (Ctrl+C, timeout, crash,
//                              cost cap). Most are not "decision
//                              was wrong". Included for completeness
//                              of the proxy set; calibration may
//                              show it's noise and zero it out.
export const DEFAULT_SIGNAL_WEIGHTS: Readonly<Record<OutcomeSignalKind, number>> = {
  tool_error: 0.3,
  failure_event: 0.5,
  checkpoint_reverted: 0.9,
  session_aborted: 0.2,
};

// Per-kind default TTL in days. AUDIT.md §1.2 says 365 days as
// the default for medium-sensitivity audit tables;
// `checkpoint_reverted` carries the strongest calibration signal
// and is retained longer so long-window regressions (annual
// audits, comparing baseline-v2.0 vs v2.1) can still find it.
export const DEFAULT_SIGNAL_TTL_DAYS: Readonly<Record<OutcomeSignalKind, number>> = {
  tool_error: 365,
  failure_event: 365,
  checkpoint_reverted: 730,
  session_aborted: 365,
};

// Threshold composite >= COMPOSITE_HARMFUL_THRESHOLD maps to
// `harmful` for spec §6.3.2's binary label. Defensible (matches
// the score's confirm threshold heuristic) but not optimal —
// the calibration script will tune this alongside per-kind
// weights. Documented as `outcome-baseline-v2.0`.
export const COMPOSITE_HARMFUL_THRESHOLD = 0.5;
