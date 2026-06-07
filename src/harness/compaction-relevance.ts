import type { ProviderMessage } from '../providers/index.ts';
import { createBM25Index, tokenize } from '../retrieval/bm25.ts';

// Relevance-driven middle elision — the building block for a
// "relevance" compaction strategy that complements the LLM-summary
// path in `compaction.ts`.
//
// Why this exists: the default compaction folds the ENTIRE middle of
// the transcript into one LLM-written summary — lossy on everything,
// relevant or not, and it costs a provider call. For code agents the
// bulk of middle tokens is tool_result bodies (file reads, greps,
// test output), most of which stop bearing on the current goal a few
// turns later. This pass keeps the message sequence intact — every
// message, role, and tool_use/tool_result pair stays in place, so
// provider alternation + pairing never break — and only shrinks the
// CONTENT of LOW-goal-relevance tool_results to a pointer. The raw
// stays in the audit log and is reachable via `retrieve_context`
// (session view), so elision is reversible, not destructive.
//
// Three invariants borrowed from `OUTPUT_POLICY.md §0`:
//   - Error results (`is_error`) are NEVER elided — load-bearing
//     verbatim regardless of relevance (§0.4: "path de erro nunca é
//     summarizado").
//   - Pure + clock-free. Relevance is BM25(goal) over the result
//     body; recency is POSITION, not wall-clock. Same
//     (middle, goal, budget) → same partition, so the compaction
//     replay path stays deterministic WITHOUT recording the decision
//     (this is why we deliberately avoid `Date.now()` / the ranker's
//     temporal signal here — wall-clock would diverge on replay).
//   - Budget-bounded greedy. Walking results highest-score-first, each
//     is kept verbatim while it fits the remaining byte budget; the rest
//     become pointers. First-fit by score, not an optimal knapsack — a
//     high-score body that overflows the budget is skipped in favor of a
//     smaller lower-score one that fits (keeping SOMETHING relevant beats
//     keeping nothing), which is the right call for a token-saving pass.

export interface RelevanceElideOptions {
  // Goal text the middle is scored against (the BM25 query). An empty
  // goal makes the relevance signal uniformly 0, so recency alone
  // decides — a sane degradation, not an error.
  goalText: string;
  // Total bytes of tool_result content kept VERBATIM; the rest are
  // pointered. The recency/relevance blend and the min-elide floor are
  // fixed module constants — no production caller tunes them, so they
  // are not exposed here (add a param only when a caller actually needs
  // to vary one, rather than advertising knobs the wiring can't reach).
  verbatimBudgetBytes: number;
}

// The audit view of a relevance pass — everything except the rebuilt
// `middle`. Single source for the `compaction_finished.relevance` event
// field (`harness/types.ts`) and the loop's local, so the shape can't
// drift across files.
export type RelevanceAudit = Omit<RelevanceElideResult, 'middle'>;

export interface RelevanceElideResult {
  // The middle with low-relevance tool_result bodies replaced by
  // pointers. Same length + roles + block structure as the input;
  // only some tool_result `content` strings change. Objects are
  // reused by identity where untouched.
  middle: ProviderMessage[];
  elidedCount: number;
  keptCount: number;
  // Total bytes removed from the in-context middle (sum of elided
  // bodies, before the pointer text is added back).
  freedBytes: number;
  // tool_use_ids whose bodies were pointered — the audit surface for
  // "which results were dropped". Scores are recomputable from the raw
  // (the scorer is deterministic), so ids + counts suffice.
  elidedIds: string[];
}

const DEFAULT_RECENCY_WEIGHT = 0.25;
const DEFAULT_MIN_ELIDE_BYTES = 200;
// Score-equality tolerance for the deterministic tiebreak — mirrors
// `retrieval/ranking.ts` so two equal-score results order by id, not
// by float round-off.
const TIEBREAK_EPSILON = 1e-12;

interface Entry {
  id: string; // tool_use_id — unique + stable, doubles as the BM25 doc id
  content: string;
  bytes: number;
  relevance: number;
  recency: number;
  score: number;
}

// Partition the middle's tool_results into keep-verbatim vs
// pointer-elide by goal relevance, then rebuild the middle with the
// low-relevance bodies pointered. Pure: no clock, no I/O, no random.
export const relevanceElideMiddle = (
  middle: ProviderMessage[],
  opts: RelevanceElideOptions,
): RelevanceElideResult => {
  const recencyWeight = DEFAULT_RECENCY_WEIGHT;
  const minElide = DEFAULT_MIN_ELIDE_BYTES;

  // Collect elision-eligible tool_results in document order: non-error
  // (errors are load-bearing verbatim) and above the min size (small
  // bodies aren't worth pointering).
  const eligible: Entry[] = [];
  for (const m of middle) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type !== 'tool_result' || b.is_error === true) continue;
      const bytes = Buffer.byteLength(b.content, 'utf8');
      if (bytes <= minElide) continue;
      eligible.push({
        id: b.tool_use_id,
        content: b.content,
        bytes,
        relevance: 0,
        recency: 0,
        score: 0,
      });
    }
  }
  if (eligible.length === 0) {
    return { middle, elidedCount: 0, keptCount: 0, freedBytes: 0, elidedIds: [] };
  }

  // BM25 relevance of each body against the goal, normalized to [0, 1]
  // by the batch max so it's comparable to recency regardless of
  // BM25's unbounded scale (mirrors `retrieval/ranking.ts`).
  const index = createBM25Index(eligible.map((e) => ({ id: e.id, tokens: tokenize(e.content) })));
  const queryTokens = tokenize(opts.goalText);
  let maxRel = 0;
  for (const e of eligible) {
    e.relevance = index.scoreTokens(queryTokens, e.id);
    if (e.relevance > maxRel) maxRel = e.relevance;
  }

  // Recency by POSITION among eligible results (clock-free → replay-
  // safe): index 0 is earliest, last is most recent. A single
  // eligible result has no spread, so recency = 1.
  const lastIdx = eligible.length - 1;
  eligible.forEach((e, i) => {
    const relNorm = maxRel > 0 ? e.relevance / maxRel : 0;
    e.recency = lastIdx > 0 ? i / lastIdx : 1;
    e.score = (1 - recencyWeight) * relNorm + recencyWeight * e.recency;
  });

  // Greedy keep within the byte budget, highest score first; id ASC
  // tiebreak for a deterministic partition across replays.
  const ordered = [...eligible].sort((a, b) => {
    const d = b.score - a.score;
    return Math.abs(d) < TIEBREAK_EPSILON ? a.id.localeCompare(b.id) : d;
  });
  const keep = new Set<string>();
  let keptBytes = 0;
  for (const e of ordered) {
    if (keptBytes + e.bytes <= opts.verbatimBudgetBytes) {
      keep.add(e.id);
      keptBytes += e.bytes;
    }
  }

  const elideIds = new Set(eligible.filter((e) => !keep.has(e.id)).map((e) => e.id));
  if (elideIds.size === 0) {
    return { middle, elidedCount: 0, keptCount: keep.size, freedBytes: 0, elidedIds: [] };
  }

  let elidedCount = 0;
  let freedBytes = 0;
  const newMiddle = middle.map((m) => {
    if (typeof m.content === 'string') return m;
    let touched = false;
    const content = m.content.map((b) => {
      // Re-apply the eligibility guards (not just `elideIds.has`): a
      // duplicated/shared tool_use_id must never let an error body or a
      // sub-floor body be pointered — the id-keyed set alone would match
      // those on a collision (errors are load-bearing, OUTPUT_POLICY §0.4).
      if (b.type !== 'tool_result' || b.is_error === true || !elideIds.has(b.tool_use_id)) return b;
      const bytes = Buffer.byteLength(b.content, 'utf8');
      if (bytes <= minElide) return b;
      elidedCount++;
      freedBytes += bytes;
      touched = true;
      return {
        ...b,
        content: `[tool_result elided: ${bytes} bytes — low goal-relevance, original in audit log]`,
      };
    });
    return touched ? { ...m, content } : m;
  });

  return {
    middle: newMiddle,
    elidedCount,
    keptCount: keep.size,
    freedBytes,
    elidedIds: [...elideIds],
  };
};
