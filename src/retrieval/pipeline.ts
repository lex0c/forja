// Retrieval pipeline orchestrator (RETRIEVAL.md §2 + §9).
//
// Four stages, all observable, all timed, all persisted in
// `retrieval_trace` (§10.1). Each stage is a pluggable function the
// slice-4.x modules implement:
//
//   search   → per-view candidate generation (slices 4.2 memory,
//              4.3 session, 4.4 workspace)
//   expand   → bounded traversal over the implicit graph (slice 4.5)
//   rank     → multi-signal fusion with explicit breakdown (4.6)
//   compress → hierarchy + greedy budget allocation (4.7)
//
// Slice 4.1 (this file) ships the SKELETON: types are real, timings
// are real, persistence is real, but every stage callback returns
// empty by default. Tests pin the wiring without depending on view
// implementations. Subsequent slices replace each stub.
//
// The pipeline is sync-ish — all stages are synchronous today
// because the substrate (SQLite + filesystem) is. When workspace
// view picks up ripgrep (async via Bun.spawn), `search` per view
// becomes Promise<Candidate[]>. Slice 4.4 lifts the relevant stages
// to async; the public `runRetrieval` is already declared async to
// avoid a breaking signature change.

import type { DB } from '../storage/db.ts';
import { createRetrievalTrace } from '../storage/repos/retrieval-trace.ts';
import { type CompressionResolver, compressGreedy } from './compression.ts';
import { rankCandidates } from './ranking.ts';
import type {
  Candidate,
  ContextSlot,
  ExpandedCandidate,
  PipelineTimings,
  RankedCandidate,
  RetrievalQuery,
  RetrievalResult,
  RetrievalView,
} from './types.ts';

// Each view exports a `search` function the pipeline calls. The
// shape is identical across views; the differentiator is the
// substrate each view reads. v1 ships memory + session + workspace.
//
// Async because workspace will need filesystem IO (ripgrep). The
// pipeline awaits them in parallel (Promise.all) — view A blocking
// on file IO must not stall view B's DB query.
//
// `signal` is forwarded from the runner so views that can honor
// cancellation (subprocess-backed views like workspace ripgrep, or
// any future view with long-running IO) cancel in-flight work
// instead of leaving zombies behind. v1 views (memory, session) are
// synchronous over in-memory / SQLite state — they ignore `signal`
// today; the pipeline still does a coarse `aborted` check between
// stages so a flipped signal stops the chain at the next boundary.
export interface ViewSearch {
  search(query: RetrievalQuery, signal?: AbortSignal): Promise<Candidate[]>;
}

export interface PipelineDeps {
  db: DB;
  sessionId: string;
  // Per-view search callbacks. Missing entries are treated as
  // "view disabled this call" — degradation surface (§15.7).
  views: Partial<Record<RetrievalView, ViewSearch>>;
  // Expansion stage. Stub default returns each candidate untouched
  // with `runningScore = bootstrapScore` and a single-hop path.
  expand?: (candidates: Candidate[], query: RetrievalQuery) => ExpandedCandidate[];
  // Ranking stage. Stub default copies bootstrapScore into
  // finalScore and zero-fills the signal breakdown.
  rank?: (expanded: ExpandedCandidate[], query: RetrievalQuery) => RankedCandidate[];
  // Compression stage. When `compressionResolver` is provided
  // (slice 4.7), the pipeline runs the greedy budget allocator
  // over the four-level representation hierarchy
  // (full/outline/summary/ref). When neither `compress` nor
  // `compressionResolver` is provided, falls back to the
  // ref-only stub (slice 4.1) — useful for skeleton-shape tests
  // that don't need substrate resolution.
  compress?: (ranked: RankedCandidate[], query: RetrievalQuery) => ContextSlot;
  compressionResolver?: CompressionResolver;
  // Wall-clock source. Defaults to Date.now(). Tests pin a value
  // so `created_at` is deterministic.
  now?: () => number;
  // Monotonic timer for per-stage measurement. Defaults to
  // performance.now(). Separate from `now` because `now` answers
  // "when did this happen" (epoch) and `monoNow` answers "how
  // long did this stage take" (relative).
  monoNow?: () => number;
  // Optional abort signal. When set and aborted, the pipeline
  // throws between stages instead of running them — bounded
  // cancellation. View-level cancellation is best-effort per the
  // `ViewSearch.search` contract (only IO-backed views actually
  // honor it today). A persist failure after compression doesn't
  // re-check the signal — the work is already done, the row goes
  // in regardless so the trace stays consistent with what the
  // caller saw.
  signal?: AbortSignal;
}

const defaultExpand = (candidates: Candidate[]): ExpandedCandidate[] =>
  candidates.map((c) => ({
    nodeId: c.nodeId,
    view: c.view,
    bootstrapScore: c.bootstrapScore,
    reason: c.reason,
    path: [c.nodeId],
    runningScore: c.bootstrapScore,
    ...(c.createdAt !== undefined ? { createdAt: c.createdAt } : {}),
  }));

// Default rank delegates to the spec-implementing `rankCandidates`
// (slice 4.6). The pipeline can still receive a custom rank via
// `deps.rank` for tests or alternative ranking experiments.
const defaultRank = (
  expanded: ExpandedCandidate[],
  query: RetrievalQuery,
  now: () => number,
): RankedCandidate[] => rankCandidates({ candidates: expanded, query, now });

const defaultCompress = (ranked: RankedCandidate[], query: RetrievalQuery): ContextSlot => {
  const included: ContextSlot['included'] = [];
  const skipped: ContextSlot['skipped'] = [];
  let remaining = query.budgetTokens;
  for (const r of ranked) {
    const cost = 1; // ref-level placeholder; slice 4.7 replaces.
    if (cost > remaining) {
      skipped.push({
        nodeId: r.nodeId,
        view: r.view,
        wouldCostTokens: cost,
        reason: 'budget exhausted (compression stub)',
      });
      continue;
    }
    included.push({
      nodeId: r.nodeId,
      view: r.view,
      level: 'ref',
      content: `${r.view}:${r.nodeId}`,
      costTokens: cost,
    });
    remaining -= cost;
  }
  return { included, skipped };
};

const defaultMonoNow = (): number => performance.now();

// Throw early when the caller already gave up. Each stage boundary
// is a yield point — if the signal flipped during the previous
// stage we stop the chain here rather than running another stage
// whose result will be discarded. The error message names the next
// stage so the operator/test can tell at which boundary we bailed.
const checkAborted = (signal: AbortSignal | undefined, nextStage: string): void => {
  if (signal?.aborted) {
    throw new Error(`retrieval aborted before ${nextStage}`);
  }
};

// Run the retrieval pipeline against the configured views and
// persist the trace. Returns the context slot the caller hands to
// CONTEXT_TUNING + the intermediate stages so callers can render
// breakdown without re-querying the trace table.
//
// Failure model: a view's `search` throws → that view contributes
// zero candidates and a stderr line surfaces (best-effort, mirrors
// outcome-emitter / dispatch-rewrite patterns). The pipeline does
// NOT fail when one view fails; degradation per spec §15.7. An
// unhandled throw in expand/rank/compress propagates — those are
// pure functions, an exception there is a code bug.
export const runRetrieval = async (
  deps: PipelineDeps,
  query: RetrievalQuery,
): Promise<RetrievalResult> => {
  const now = deps.now ?? (() => Date.now());
  const monoNow = deps.monoNow ?? defaultMonoNow;
  const expand = deps.expand ?? defaultExpand;
  const rank = deps.rank ?? ((expanded, query) => defaultRank(expanded, query, now));
  // Compression: explicit `compress` override wins; else if a
  // resolver is configured, run greedy allocation against it; else
  // fall back to the ref-only skeleton stub.
  const compress =
    deps.compress ??
    (deps.compressionResolver !== undefined
      ? (ranked: RankedCandidate[], query: RetrievalQuery) =>
          compressGreedy({
            ranked,
            query,
            resolver: deps.compressionResolver as CompressionResolver,
          })
      : defaultCompress);

  checkAborted(deps.signal, 'search');

  // Stage 1: search per view in parallel. A view's `search`
  // throwing collapses that view's contribution to [] — degradation
  // is preferred over a hard fail since other views may still
  // produce a useful slot. `signal` is forwarded so IO-backed views
  // (workspace ripgrep when 4.4 lands) can abort their subprocesses
  // mid-flight; sync views ignore it.
  const searchStart = monoNow();
  const viewEntries = Object.entries(deps.views) as [RetrievalView, ViewSearch][];
  const candidatesByView = await Promise.all(
    viewEntries.map(async ([view, impl]) => {
      try {
        return await impl.search(query, deps.signal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `forja retrieval: view '${view}' search failed (${msg}); contributing []\n`,
        );
        return [] as Candidate[];
      }
    }),
  );
  const candidatesRaw: Candidate[] = candidatesByView.flat();
  const searchMs = Math.max(0, monoNow() - searchStart);

  checkAborted(deps.signal, 'expand');

  // Stage 2: expansion.
  const expandStart = monoNow();
  const candidatesExpanded = expand(candidatesRaw, query);
  const expandMs = Math.max(0, monoNow() - expandStart);

  checkAborted(deps.signal, 'rank');

  // Stage 3: ranking.
  const rankStart = monoNow();
  const candidatesRanked = rank(candidatesExpanded, query);
  const rankMs = Math.max(0, monoNow() - rankStart);

  checkAborted(deps.signal, 'compress');

  // Stage 4: compression.
  const compressStart = monoNow();
  const contextSlot = compress(candidatesRanked, query);
  const compressMs = Math.max(0, monoNow() - compressStart);

  const timings: PipelineTimings = { searchMs, expandMs, rankMs, compressMs };

  // Persist. One row, end-of-pipeline — partial traces aren't
  // useful for forensic queries and would confuse eval replays.
  // Best-effort: a persist failure stderr-logs but doesn't crash
  // the caller (matches the pattern outcome-emitter uses).
  let queryId: string;
  try {
    const row = createRetrievalTrace(deps.db, {
      sessionId: deps.sessionId,
      queryText: query.text,
      workflow: query.workflow,
      queryType: query.queryType,
      budgetTokens: query.budgetTokens,
      candidatesRaw,
      candidatesExpanded,
      candidatesRanked,
      contextSlot,
      timings,
      createdAt: now(),
    });
    queryId = row.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`forja retrieval: trace persist failed (${msg})\n`);
    queryId = '';
  }

  return {
    queryId,
    contextSlot,
    candidatesRaw,
    candidatesExpanded,
    candidatesRanked,
    timings,
  };
};
