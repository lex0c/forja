// Outcome-signals calibration extractor per PERMISSION_ENGINE.md
// §6.3.2 step 1: "Coletar telemetria por 30d em deployment piloto:
// `(score, decision_humano, outcome)` triples".
//
// This module materializes those triples by joining `approvals_log`
// against `outcome_signals` and projecting the shape calibration
// consumers (offline logistic regression, A/B sweeps) need without
// having to know the underlying schema. Callers ALWAYS scope by
// install_id — calibration on a shared DB without that filter would
// mix populations and bias the derived weights.
//
// Filter semantics:
//   - install_id: required. No default to force explicit scope.
//   - sinceMs / untilMs: half-open window `[since, until)` on
//     `approvals_log.ts`. Both optional; absence means "no bound on
//     that side". The 30-day spec window is a caller responsibility
//     — passing `now - 30*86400_000` is the canonical knob.
//   - decisions: which `approvals_log.decision` values to include.
//     Default `['confirm-allowed', 'confirm-denied']` per spec
//     §6.3.2.1 limitations — these are the only labels with a
//     clean operator decision; auto-allow/deny add selection bias.
//     Pass an empty array (or `['*']` semantics via `includeAll`)
//     to widen.
//   - limit: hard cap on rows returned. Calibration sweeps over
//     30d typically fit in memory (<100k rows on a busy install),
//     but the cap protects callers that forget to window.
//
// Output shape: one triple per approval row, with the aggregated
// outcome already computed. The signals array is included verbatim
// for callers that want per-kind subscores instead of just the
// composite (the aggregator's `OutcomeAggregate.signals` shape, but
// keyed back to the source approval). The schema is documented in
// the type, not just inline — calibration scripts written against
// it must keep the shape stable across slices.
//
// Performance: the read fans out N queries (one per approval row)
// for the signal join. Acceptable at 30d × low-thousands; if a
// future calibration window pushes this to seconds-scale latency,
// the SQL would migrate to a single LEFT JOIN with GROUP BY on
// approval_seq. We keep the per-row read here because (a) the
// composite policy (max-wins) is JS-side, not SQL-side, and (b)
// the aggregator-already-tested code path stays the source of
// truth for outcome derivation.

import type { DB } from '../storage/db.ts';
import { listApprovalsLogByInstall } from '../storage/repos/approvals-log.ts';
import { type OutcomeAggregate, computeOutcomeForApproval } from './aggregator.ts';

export interface CalibrationTriple {
  // Foreign key back to approvals_log + outcome_signals.
  approval_seq: number;
  // Wall-clock of the approval (ms). Calibration scripts use this
  // to bucket by time window in their own analysis.
  ts: number;
  // Tool name — calibration may want per-tool stratification (the
  // score components differ heavily between bash and write_file).
  tool_name: string;
  // The human-facing decision label. The narrow default filter
  // (confirm-allowed/confirm-denied) maps to clean human-in-the-loop
  // labels; wider filters introduce auto-decision rows that need
  // inverse-propensity-weighting at the analysis side.
  decision: string;
  // The deterministic + classifier-adjusted final score that the
  // §6.6 approval gate consulted. [0, 1].
  score: number;
  // Per-feature score contributions (the §6.3 weight table) as a
  // record. The regression input — features are keys, contributions
  // are values. Empty `{}` is the legitimate baseline row shape.
  score_components: Record<string, number>;
  // Outcome aggregate derived from `outcome_signals` rows via the
  // current aggregator. The `OutcomeLabel` (`harmful`/`harmless`)
  // is the regression target; `composite` is the underlying score
  // for threshold tuning; `signals` is the raw set for per-kind
  // analysis.
  outcome: OutcomeAggregate;
}

export interface ExtractCalibrationTriplesOptions {
  // Required. Calibration must always scope to a single install.
  installId: string;
  // Lower bound on `approvals_log.ts`, inclusive. Default `0`.
  sinceMs?: number;
  // Upper bound on `approvals_log.ts`, exclusive. Default
  // `Number.MAX_SAFE_INTEGER`.
  untilMs?: number;
  // Decision filter. Default `['confirm-allowed', 'confirm-denied']`
  // per spec §6.3.2.1 limitations. Pass `'*'` to bypass.
  decisions?: readonly string[] | '*';
  // Hard cap on returned rows. Default 100000.
  limit?: number;
}

const DEFAULT_DECISIONS: readonly string[] = ['confirm-allowed', 'confirm-denied'];
const DEFAULT_LIMIT = 100_000;

// Safely parse `score_components_json`. The column is stored as a
// JSON string; malformed JSON (storage rot, hostile edit) becomes
// an empty record so the regression can still consume the row's
// score field. Logged via console.warn so audit consumers see the
// failure without the calibration sweep aborting.
const parseScoreComponents = (raw: string, approval_seq: number): Record<string, number> => {
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    console.warn(
      `calibration: malformed score_components_json on approval_seq=${approval_seq}; treating as empty`,
    );
    return {};
  }
};

export const extractCalibrationTriples = (
  db: DB,
  options: ExtractCalibrationTriplesOptions,
): CalibrationTriple[] => {
  const sinceMs = options.sinceMs ?? 0;
  const untilMs = options.untilMs ?? Number.MAX_SAFE_INTEGER;
  if (sinceMs > untilMs) {
    throw new Error(
      `extractCalibrationTriples: sinceMs (${sinceMs}) must be <= untilMs (${untilMs})`,
    );
  }
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (limit < 1) {
    throw new Error(`extractCalibrationTriples: limit must be >= 1, got ${limit}`);
  }
  const decisionFilter =
    options.decisions === '*' ? null : (options.decisions ?? DEFAULT_DECISIONS);

  // Fetch the candidate approval rows. listApprovalsLogByInstall
  // already orders by seq ASC and filters by install_id; we
  // post-filter on the time + decision predicates in JS rather
  // than building a parametric SQL because the decision list is
  // open-ended and a parametric IN-clause would require its own
  // sanitization. The result set is bounded by `limit` AFTER the
  // filter, so a tight window doesn't bring back 100k unfiltered
  // rows just to drop most.
  const rows = listApprovalsLogByInstall(db, options.installId);
  const triples: CalibrationTriple[] = [];
  for (const row of rows) {
    if (triples.length >= limit) break;
    if (row.ts < sinceMs || row.ts >= untilMs) continue;
    if (decisionFilter !== null && !decisionFilter.includes(row.decision)) continue;
    const outcome = computeOutcomeForApproval(db, row.seq);
    triples.push({
      approval_seq: row.seq,
      ts: row.ts,
      tool_name: row.tool_name,
      decision: row.decision,
      score: row.score,
      score_components: parseScoreComponents(row.score_components_json, row.seq),
      outcome,
    });
  }
  return triples;
};

// Coverage summary alongside the extraction — answers the
// operator's "do I have enough data to calibrate?" question
// without pulling the full triple set across the boundary. Spec
// §6.3.2 step 1 implies a 30-day window with sufficient triples;
// this surface lets a CLI report low-coverage states (e.g.,
// "<100 confirm-allowed rows in the window" suggests delaying
// the sweep).
//
// Counts are computed off the same input filter as
// `extractCalibrationTriples` so reports stay consistent.
export interface CalibrationCoverage {
  // Total candidate rows in the window (post decision filter).
  total: number;
  // Counts by outcome label.
  harmful: number;
  harmless: number;
  // Counts by decision value. Useful for spotting class imbalance
  // before running regression — a window with 1 confirm-denied and
  // 9999 confirm-allowed will fit the model poorly.
  byDecision: Record<string, number>;
  // Count of rows that had at least one outcome_signal (any kind).
  // Rows without signals collapse to `outcome=harmless,composite=0`
  // by aggregator contract; flagging "uncovered" rows separately
  // lets the calibration consumer downweight them if desired.
  withAnySignal: number;
}

export const summarizeCalibrationCoverage = (
  db: DB,
  options: ExtractCalibrationTriplesOptions,
): CalibrationCoverage => {
  const triples = extractCalibrationTriples(db, options);
  const coverage: CalibrationCoverage = {
    total: triples.length,
    harmful: 0,
    harmless: 0,
    byDecision: {},
    withAnySignal: 0,
  };
  for (const t of triples) {
    if (t.outcome.outcome === 'harmful') coverage.harmful += 1;
    else coverage.harmless += 1;
    coverage.byDecision[t.decision] = (coverage.byDecision[t.decision] ?? 0) + 1;
    if (t.outcome.signals.length > 0) coverage.withAnySignal += 1;
  }
  return coverage;
};
