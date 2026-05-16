// Retrieval ranking (RETRIEVAL.md §5).
//
// Weighted fusion of six signals per spec §5.1, with workflow-
// specific weights per §5.2. Score breakdown is mandatory per §5.3
// — every ranked candidate carries the per-signal contributions so
// operators can audit "why did this rank here?" without a black
// box.
//
//   final_score(c) = Σ w_i · signal_i(c)
//
// All weights sum to 1.0 (validated by test). v2/v3 tuning is
// expected to happen offline against the eval framework (§10.3);
// v1 ships the canonical spec-table values.

import type {
  ExpandedCandidate,
  RankedCandidate,
  RetrievalQuery,
  RetrievalView,
  RetrievalWorkflow,
  ScoreBreakdown,
} from './types.ts';

// Per-workflow signal weights. Lifted directly from spec §5.2
// table. `default` is added so callers without an explicit
// workflow get a balanced posture (lexical-leaning since v1 has
// no usable structural/semantic substrate for arbitrary queries).
export const WORKFLOW_WEIGHTS: Record<RetrievalWorkflow, ScoreBreakdown> = {
  review: {
    structural: 0.4,
    lexical: 0.3,
    semantic: 0.0,
    temporal: 0.0,
    usage: 0.1,
    goalAlignment: 0.2,
  },
  refactor: {
    structural: 0.5,
    lexical: 0.2,
    semantic: 0.0,
    temporal: 0.0,
    usage: 0.1,
    goalAlignment: 0.2,
  },
  debug: {
    structural: 0.3,
    lexical: 0.2,
    semantic: 0.0,
    temporal: 0.4,
    usage: 0.0,
    goalAlignment: 0.1,
  },
  explain: {
    structural: 0.3,
    lexical: 0.3,
    semantic: 0.1,
    temporal: 0.0,
    usage: 0.1,
    goalAlignment: 0.2,
  },
  precedent_lookup: {
    structural: 0.1,
    lexical: 0.3,
    semantic: 0.2,
    temporal: 0.1,
    usage: 0.1,
    goalAlignment: 0.2,
  },
  default: {
    structural: 0.3,
    lexical: 0.4,
    semantic: 0.0,
    temporal: 0.1,
    usage: 0.1,
    goalAlignment: 0.1,
  },
};

// Per-view temporal half-life (§4.3). Session decays fast (1h —
// recovery focuses on recent state); memory decays slowly (30d —
// precedent ages but doesn't die); workspace doesn't decay (FS is
// state, not event).
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const HALF_LIFE_MS_BY_VIEW: Record<RetrievalView, number> = {
  session: HOUR_MS,
  memory: 30 * DAY_MS,
  workspace: Number.POSITIVE_INFINITY,
};

// Validate that a weight set sums to 1.0 (within ε). §5.2 says
// "Pesos somam 1.0; normalização explícita evita drift." We
// validate at module-load time so a misspelled weight in the
// table doesn't drift the scores silently.
const WEIGHTS_EPSILON = 1e-9;

const sumWeights = (w: ScoreBreakdown): number =>
  w.structural + w.lexical + w.semantic + w.temporal + w.usage + w.goalAlignment;

for (const [workflow, weights] of Object.entries(WORKFLOW_WEIGHTS)) {
  const sum = sumWeights(weights);
  if (Math.abs(sum - 1.0) > WEIGHTS_EPSILON) {
    // Throws at import time so a build with a mistyped weight
    // never produces ranked output the operator can trust.
    throw new Error(
      `retrieval/ranking: WORKFLOW_WEIGHTS['${workflow}'] sums to ${sum}, expected 1.0`,
    );
  }
}

export interface RankCandidatesInput {
  candidates: readonly ExpandedCandidate[];
  query: RetrievalQuery;
  // Wall-clock anchor for the temporal signal's decay math.
  // Defaults to Date.now(). Tests pin a value for determinism.
  now?: () => number;
}

// Rank expanded candidates by weighted signal fusion. Returns
// candidates sorted by finalScore DESC, with deterministic
// tiebreaker (nodeId ASC) for trace stability across reruns.
//
// The function is pure for a fixed `now` — same input produces
// the same output. Stage 4.6 of the pipeline replaces the
// skeleton stub from slice 4.1 with this real ranker.
export const rankCandidates = (input: RankCandidatesInput): RankedCandidate[] => {
  const weights = WORKFLOW_WEIGHTS[input.query.workflow];
  const now = input.now?.() ?? Date.now();

  // Lexical normalization: divide each bootstrapScore by the max
  // in the batch so the signal is bounded to [0, 1] regardless of
  // BM25's unbounded scale. Per-batch normalization keeps the
  // signal honest about relative ordering even when absolute BM25
  // numbers vary across queries / corpora.
  //
  // When the batch is empty or every score is 0, normalization is
  // a no-op — there's nothing to rank.
  const maxBootstrap = input.candidates.reduce(
    (m, c) => (c.bootstrapScore > m ? c.bootstrapScore : m),
    0,
  );

  const ranked: RankedCandidate[] = input.candidates.map((c) => {
    // Structural: 1 / pathLength. A direct hit (path = [seed])
    // gets 1.0; each hop diminishes. Expansion (slice 4.5) is
    // the substrate this signal eventually rides on; in v1 paths
    // are single-element so structural lands at 1.0 across the
    // board. Once expansion ships, the signal differentiates.
    const pathLength = Math.max(1, c.path.length);
    const structural = 1.0 / pathLength;

    // Lexical: normalized BM25.
    const lexical = maxBootstrap > 0 ? c.bootstrapScore / maxBootstrap : 0;

    // Semantic: 0 in v1. Spec §0 principle 2 keeps embedding
    // opt-in until eval shows lexical is insufficient.
    const semantic = 0;

    // Temporal: exponential decay against the view's half-life.
    // Without a `createdAt`, the candidate is treated as
    // timeless (signal = 1.0) — workspace falls here by design;
    // memory listings fall here today because mtime isn't on the
    // listing shape. Session-view candidates carry it.
    //
    // Clamped to [0, 1]: a `createdAt` in the future (clock skew,
    // test fixture with a forward-dated row, replay against an
    // older `now`) would otherwise produce signal > 1.0 from a
    // negative decay exponent, breaking the [0, 1] contract the
    // rest of the trace renders against.
    const halfLife = HALF_LIFE_MS_BY_VIEW[c.view];
    const temporalRaw =
      c.createdAt === undefined || !Number.isFinite(halfLife)
        ? 1.0
        : 0.5 ** ((now - c.createdAt) / halfLife);
    const temporal = Math.min(1.0, Math.max(0.0, temporalRaw));

    // Usage: 0 in v1. The session-citation history table doesn't
    // exist yet; spec marks `usage` as a future v2 signal.
    const usage = 0;

    // Goal alignment: 0 in v1. CONTEXT_TUNING §1.6 (the goal-
    // canonical form against which candidates are matched) isn't
    // implemented. When it lands, this becomes a lexical match
    // against the canonical goal string.
    const goalAlignment = 0;

    const signals: ScoreBreakdown = {
      structural,
      lexical,
      semantic,
      temporal,
      usage,
      goalAlignment,
    };
    const finalScore =
      weights.structural * structural +
      weights.lexical * lexical +
      weights.semantic * semantic +
      weights.temporal * temporal +
      weights.usage * usage +
      weights.goalAlignment * goalAlignment;

    return {
      nodeId: c.nodeId,
      view: c.view,
      reason: c.reason,
      path: c.path,
      finalScore,
      signals,
    };
  });

  // Score DESC, nodeId ASC tiebreak. The trace at §10.1 must be
  // stable across replays — without a tiebreaker, two equal-score
  // candidates would swap positions between runs and diff replays
  // would show false changes.
  //
  // We compare with a tolerance because finalScore is a sum of
  // products of floats; two semantically-equal scores can land at
  // 0.7000000000000001 vs 0.7 and strict `===` would skip the
  // tiebreak, producing unstable order across replays.
  ranked.sort((a, b) => {
    const diff = b.finalScore - a.finalScore;
    if (Math.abs(diff) < TIEBREAK_EPSILON) return a.nodeId.localeCompare(b.nodeId);
    return diff;
  });
  return ranked;
};

// Tolerance for `finalScore === finalScore` comparisons in the
// sort tiebreaker. 1e-12 is below the smallest representable
// difference that would matter in practice (well past BM25
// fluctuation) but well above the typical float-add round-off
// (~1e-15). The trace replays diff-clean.
const TIEBREAK_EPSILON = 1e-12;
