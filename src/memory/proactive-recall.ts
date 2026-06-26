// Proactive memory recall producer (MEMORY.md §4.4, Phase 3 Slice P1).
//
// Pure: given the turn's context (goal + prompt), it runs the
// caller-supplied memory `search` (a memory view the caller built with
// `trustedOnly` + `loadBodies` — §4.4 I3), keeps matches at or above a
// score floor, takes the top-K in the view's score order, and resolves
// each survivor's body via the caller-supplied `loadBody`. The
// injection point (P2) owns the view construction + the body loader;
// this module owns the query shape + the floor/top-K policy, so both
// are unit-testable without a registry or a runner.
//
// Order: the producer trusts the view's order (raw BM25 desc, id-asc
// tiebreak) and does NOT re-rank. `trustedOnly` makes the view
// active-only, so no quarantine penalty reshuffles the score — the
// view's order already is the final order. (If a future caller passes
// a view that can reshuffle, it must sort before handing results in.)
//
// Why a floor on the raw BM25 `bootstrapScore` (not a normalized
// [0,1] signal): the memory view returns the unnormalized lexical
// score, and a relative (per-batch) normalization would always
// promote *something* to 1.0 — exactly wrong for "inject nothing when
// nothing is relevant". An absolute floor lets a turn recall zero
// memories. The default is a conservative starting point; P5's eval
// calibrates it against real recall-vs-noise on the target models.

import type { Candidate, RetrievalQuery } from '../retrieval/types.ts';

// Floor on the memory view's raw BM25 `bootstrapScore`. A single
// common-term body hit scores well below this; a rare-term or
// title-weighted hit clears it. Exported + tunable; P5 calibrates.
export const PROACTIVE_RECALL_MIN_SCORE = 1.0;

// Cap on memories injected per eligible turn. Small by design (§4.4
// I4) — proactive injection is a nudge, not a context dump.
export const PROACTIVE_RECALL_TOP_K = 3;

// Per-call token budget handed to the view's query. The memory view
// doesn't compress, but `RetrievalQuery` requires a strict-positive
// budget; this is the value a trace (P4) would record.
const DEFAULT_QUERY_BUDGET_TOKENS = 1000;

export interface ProactiveRecallInput {
  // The session's current focus/goal text (working-state). The caller
  // resolves it; empty string when there's no goal yet.
  goalText: string;
  // The turn's user prompt.
  prompt: string;
}

export interface RecalledMemory {
  // `memory:<scope>/<name>` — the view's stable node id.
  nodeId: string;
  // The raw BM25 score that cleared the floor (carried for ordering +
  // a future trace; not re-normalized).
  score: number;
  // The memory body to inject (P2). Never empty — survivors whose
  // body can't load are dropped.
  body: string;
}

export interface ProactiveRecallDeps {
  // The memory view's `search`, built by the caller (P2) with
  // `trustedOnly: true` + `loadBodies: true` so I3 holds and body
  // tokens shape relevance. Kept abstract so the producer is pure.
  search: (query: RetrievalQuery) => Promise<readonly Candidate[]>;
  // Resolve a recalled node id to its body, or null when the body
  // can't be read. The caller owns nodeId parsing + the registry
  // peek; a null (or empty) body drops the candidate — no injection
  // without content.
  loadBody: (nodeId: string) => string | null;
  // Floor on the raw BM25 score (default `PROACTIVE_RECALL_MIN_SCORE`).
  minScore?: number;
  // Top-K cap (default `PROACTIVE_RECALL_TOP_K`).
  topK?: number;
  // Query budget (default `DEFAULT_QUERY_BUDGET_TOKENS`).
  budgetTokens?: number;
}

// Build the BM25 query from the turn's context: goal/focus first, then
// the prompt. Blank components are dropped; an all-blank input yields
// '' so the producer can short-circuit to "recall nothing".
const buildQuery = (input: ProactiveRecallInput): string =>
  [input.goalText, input.prompt]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('\n');

export const buildProactiveRecall = (
  deps: ProactiveRecallDeps,
): ((input: ProactiveRecallInput) => Promise<RecalledMemory[]>) => {
  const minScore = deps.minScore ?? PROACTIVE_RECALL_MIN_SCORE;
  const topK = deps.topK ?? PROACTIVE_RECALL_TOP_K;
  const budgetTokens = deps.budgetTokens ?? DEFAULT_QUERY_BUDGET_TOKENS;
  return async (input: ProactiveRecallInput): Promise<RecalledMemory[]> => {
    const text = buildQuery(input);
    if (text.length === 0) return [];
    const candidates = await deps.search({
      text,
      workflow: 'default',
      queryType: 'semantic',
      budgetTokens,
    });
    // Scan in the view's score order. Cap-first so `topK <= 0` recalls
    // nothing (the guard before any work). Floor with `break`, not
    // `continue`: a score-desc list means everything past the first
    // sub-floor hit is also below it (§4.4 I4 — a turn with only weak
    // matches recalls nothing, not its least-bad option). Body-drop
    // with `continue` — no injection without content.
    const recalled: RecalledMemory[] = [];
    for (const c of candidates) {
      if (recalled.length >= topK) break;
      if (c.bootstrapScore < minScore) break;
      const body = deps.loadBody(c.nodeId);
      if (body === null || body.length === 0) continue;
      recalled.push({ nodeId: c.nodeId, score: c.bootstrapScore, body });
    }
    return recalled;
  };
};
