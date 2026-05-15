// Retrieval subsystem types (RETRIEVAL.md).
//
// Pure declarations — no DB, no FS, no module-level state. Slots
// every other module in `src/retrieval/` exchanges. Centralized so
// the pipeline contract (search → expand → rank → compress) is one
// reading.

// ─── views ────────────────────────────────────────────────────────────

// The three source views per spec §3.1. Each view exports its own
// `search` + edge resolver; the pipeline fuses results.
//
// `workspace` v1 sources from filesystem (ripgrep + filename match);
// CODE_INDEX is deliberately not implemented (auto-memory pin).
export const RETRIEVAL_VIEWS = ['workspace', 'session', 'memory'] as const;
export type RetrievalView = (typeof RETRIEVAL_VIEWS)[number];

// ─── workflows ────────────────────────────────────────────────────────

// Per spec §5.2 the workflow drives ranking weights + hop budget +
// per-view share of the token budget (§7.1). `default` is the
// middle-ground when the caller doesn't pin one.
export const RETRIEVAL_WORKFLOWS = [
  'review',
  'refactor',
  'explain',
  'debug',
  'precedent_lookup',
  'default',
] as const;
export type RetrievalWorkflow = (typeof RETRIEVAL_WORKFLOWS)[number];

// ─── query shapes ─────────────────────────────────────────────────────

// Per spec §2.1. The driver decides; retrieval respects. The shape
// influences which view is the primary seed source.
export const RETRIEVAL_QUERY_TYPES = [
  'symbol',
  'semantic',
  'causal',
  'precedent',
  'navigational',
] as const;
export type RetrievalQueryType = (typeof RETRIEVAL_QUERY_TYPES)[number];

// ─── node + edge schema (storage-agnostic per spec §8) ────────────────

// Node kinds. Open vocabulary per view — `symbol`/`file`/`outline`
// are workspace-shaped; `task`/`edit`/`failure`/`goal`/`tool_call`/
// `message` are session-shaped; `memory_entry` is memory-shaped.
// Spec §8.4 deliberately keeps payload opaque; only the view that
// produced the node knows how to interpret it.
export type NodeKind =
  // workspace
  | 'file'
  | 'symbol'
  | 'outline'
  // session
  | 'goal'
  | 'task'
  | 'edit'
  | 'failure'
  | 'tool_call'
  | 'message'
  // memory
  | 'memory_entry';

export interface RetrievalNode {
  // Stable identifier unique per (source, kind, key). Synthesized
  // by the originating view — workspace uses `file:<path>`,
  // session uses `tool_call:<uuid>` etc.
  id: string;
  source: RetrievalView;
  kind: NodeKind;
  // Kind-specific payload. v1 implementations pass enough to
  // resolve the body on demand (file path, memory name, db id);
  // we don't duplicate content here.
  payload: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

// Edge kinds per spec §4.2. The numeric weights live in
// `src/retrieval/edge-weights.ts` (slice 4.5); the type just
// catalogs the vocabulary so callers can refer by name.
export type EdgeKind =
  // workspace-internal
  | 'calls'
  | 'imports'
  | 'references'
  | 'defined_in'
  // cross-view
  | 'mentioned_in'
  | 'similar_to'
  // memory-internal
  | 'fixed_by'
  | 'precedent_for'
  // session-internal
  | 'caused_by'
  | 'goal_of';

// `derived` = inferred by tooling (tree-sitter import edge,
// goal→task projection). `declared` = a human/agent wrote it
// (memory frontmatter `fixed_by: session/abc#step42`). Reindex
// invalidates `derived` from a view; `declared` survives.
export type EdgeDerivation = 'derived' | 'declared';

export interface RetrievalEdge {
  src: string; // node id
  dst: string; // node id
  kind: EdgeKind;
  weight: number; // 0.0..1.0
  derivation: EdgeDerivation;
  createdAt: number;
}

// ─── candidates at each pipeline stage ────────────────────────────────

// Output of per-view `search`. The view annotates the raw match
// with `bootstrapScore` (BM25 / recency / etc.) and a human
// `reason` string so the trace at §10.1 is operator-readable.
export interface Candidate {
  nodeId: string;
  view: RetrievalView;
  bootstrapScore: number;
  reason: string;
}

// Output of expansion. The traversal walked from a seed candidate
// through `path` (a sequence of node ids hop-by-hop) accumulating
// `runningScore` (product of edge weights * decay). Candidates
// below the prune threshold (§4.4) never appear here.
export interface ExpandedCandidate {
  nodeId: string;
  view: RetrievalView;
  bootstrapScore: number;
  reason: string;
  path: string[]; // [seed, hop1, hop2, ...]
  runningScore: number;
}

// Score breakdown per spec §5.3 — sum of weighted signals + the
// individual signal values so an operator can read why this
// candidate landed where it did.
export interface ScoreBreakdown {
  structural: number;
  lexical: number;
  semantic: number; // 0 in v1 (no embedding)
  temporal: number;
  usage: number; // 0 in v1 (no usage history)
  goalAlignment: number;
}

export interface RankedCandidate {
  nodeId: string;
  view: RetrievalView;
  reason: string;
  path: string[];
  finalScore: number;
  signals: ScoreBreakdown;
}

// ─── compression hierarchy (§6.1) ─────────────────────────────────────

// Cheaper → fuller. The compression loop tries `full` first and
// degrades down the list as the remaining token budget shrinks.
export const COMPRESSION_LEVELS = ['full', 'outline', 'summary', 'ref'] as const;
export type CompressionLevel = (typeof COMPRESSION_LEVELS)[number];

export interface ContextSlotEntry {
  nodeId: string;
  view: RetrievalView;
  level: CompressionLevel;
  // The actual content the consumer (CONTEXT_TUNING) renders into
  // the prompt. Stringified for trace persistence; shape varies
  // by level (`full` is the raw body; `ref` is `path:lineno` or
  // `memory#name`).
  content: string;
  // Tokens the slot occupied. Caller's token model decides the
  // count; spec stays agnostic per §7.
  costTokens: number;
}

export interface SkippedCandidate {
  nodeId: string;
  view: RetrievalView;
  // The cheapest level that didn't fit — operator hint for "would
  // X token bump have included this?". `null` when even `ref`
  // didn't fit (rare; the slot was already saturated).
  wouldCostTokens: number | null;
  reason: string;
}

export interface ContextSlot {
  included: ContextSlotEntry[];
  skipped: SkippedCandidate[];
}

// ─── pipeline I/O ─────────────────────────────────────────────────────

export interface RetrievalQuery {
  // Free-text the driver passes in. Goes through scrubFreeformText
  // before persisting in retrieval_trace (no path leaks).
  text: string;
  workflow: RetrievalWorkflow;
  queryType: RetrievalQueryType;
  // Token budget the compression layer respects. Per-call so
  // CONTEXT_TUNING can size differently per slot. Strict positive
  // (DB CHECK enforces).
  budgetTokens: number;
  // Optional per-view budget override (RETRIEVAL §7.1). When
  // omitted, the workflow's default split applies.
  perViewBudget?: Partial<Record<RetrievalView, number>>;
  // Optional hop budget override per spec §4.1. Hard cap of 5 is
  // enforced regardless.
  hopBudget?: number;
}

export interface PipelineTimings {
  searchMs: number;
  expandMs: number;
  rankMs: number;
  compressMs: number;
}

export interface RetrievalResult {
  queryId: string;
  contextSlot: ContextSlot;
  // Read-back of the persisted trace stages so callers can render
  // breakdown without an extra DB hit. Mirrors retrieval_trace
  // columns 1:1.
  candidatesRaw: Candidate[];
  candidatesExpanded: ExpandedCandidate[];
  candidatesRanked: RankedCandidate[];
  timings: PipelineTimings;
}

// ─── trace persistence (§10.1) ────────────────────────────────────────

export interface RetrievalTraceRow {
  id: string;
  sessionId: string;
  queryText: string;
  workflow: RetrievalWorkflow;
  queryType: RetrievalQueryType;
  budgetTokens: number;
  candidatesRaw: Candidate[];
  candidatesExpanded: ExpandedCandidate[];
  candidatesRanked: RankedCandidate[];
  contextSlot: ContextSlot;
  timings: PipelineTimings;
  createdAt: number;
}
