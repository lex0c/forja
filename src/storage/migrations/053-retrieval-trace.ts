// retrieval_trace — observability surface for the retrieval pipeline
// (RETRIEVAL.md §10.1).
//
// Every retrieve_context call lands ONE row capturing the full
// pipeline state: raw candidates per view, post-expansion candidates,
// ranked output with score breakdown, the final context slot, what
// was skipped (with reason + hypothetical cost), and per-stage
// timings. Operators tracing "why did this candidate make it / get
// cut?" follow the trail; future eval frameworks (RETRIEVAL §10.3)
// replay rows against ground truth.
//
// Schema rationale:
//
// - `id` (TEXT PRIMARY KEY UUID). One row per query. Same shape every
//   other audit-shaped repo in the project uses.
//
// - `session_id` (TEXT NOT NULL FK CASCADE). Retrieval is session-
//   scoped — a session purge takes its traces with it.
//
// - `query_text` (TEXT NOT NULL). The operator/model-provided text.
//   Subject to the standard scrub layer at insert time (paths,
//   secrets) — we don't want a stale retrieval row to be the path by
//   which a credential survives.
//
// - `workflow` (TEXT NOT NULL, CHECK). Six legal values mirror
//   RETRIEVAL §5.2 + the default. CHECK at the DB layer is defense-
//   in-depth; the caller TypeScript enum is the primary gate.
//
// - `query_type` (TEXT NOT NULL, CHECK). Five legal values per
//   §2.1: symbol | semantic | causal | precedent | navigational.
//   Driver-provided. Distinct from workflow — workflow says "what
//   kind of work am I doing" (review/refactor/...); query_type says
//   "what shape is THIS query".
//
// - `budget_tokens` (INTEGER NOT NULL CHECK > 0). The token ceiling
//   compression respected. Zero / negative is a caller bug and would
//   produce a context slot that's structurally meaningless.
//
// - `candidates_raw_json`, `candidates_expanded_json`,
//   `candidates_ranked_json`, `context_slot_json` (TEXT, nullable).
//   The intermediate states. Stored as JSON strings because the
//   schema is per-view-shaped and we don't gain anything from a
//   normalized table for what is read once per operator forensic
//   query. Nullable so a pipeline that crashed mid-stage still
//   produces a partial row that explains how far it got.
//
//   AUDIT IMMUTABILITY: `context_slot_json.included[N].content`
//   carries the raw memory / session body inline. When the
//   underlying memory is later evicted / purged / scope-shrunk,
//   the inlined body STAYS in this column — the trace is a
//   frozen snapshot of what the model saw at decision time, not
//   a live mirror. Eval replay against historical traces needs
//   the real content; scrubbing on eviction would silently
//   mutate the historical record. See MEMORY.md §13.3 +
//   RETRIEVAL.md §10 for the policy rationale. Cleanup at the
//   trace level happens ONLY via session purge (FK CASCADE on
//   `session_id`).
//
//   `context_slot_json` carries the FULL slot — both `included`
//   and `skipped`. An earlier draft split skipped into a separate
//   column to make per-skip rendering cheaper; the savings were
//   illusory (one JSON parse either way) and the split made the
//   slot's source-of-truth ambiguous when read paths needed to
//   reconcile two columns. One column, one shape.
//
// - `timings_json` (TEXT, nullable). `{ search_ms, expand_ms,
//   rank_ms, compress_ms }`. Per spec §10.1 — also feeds the
//   latency metrics in §10.2.
//
// - `created_at` (INTEGER NOT NULL). Epoch ms. Indexed for the
//   common "latest N traces in this session" forensic query.
//
// Indices:
//
// - `idx_retrieval_trace_session_created` covers the canonical
//   "show me what just happened in this session" lookup.
// - `idx_retrieval_trace_workflow` lets per-workflow eval / metric
//   queries skip a table scan.

export const migration053RetrievalTrace = {
  id: 53,
  name: '053-retrieval-trace',
  sql: `
    CREATE TABLE retrieval_trace (
      id                       TEXT PRIMARY KEY,
      session_id               TEXT NOT NULL,
      query_text               TEXT NOT NULL,
      workflow                 TEXT NOT NULL CHECK (workflow IN (
                                  'review',
                                  'refactor',
                                  'explain',
                                  'debug',
                                  'precedent_lookup',
                                  'default'
                                )),
      query_type               TEXT NOT NULL CHECK (query_type IN (
                                  'symbol',
                                  'semantic',
                                  'causal',
                                  'precedent',
                                  'navigational'
                                )),
      budget_tokens            INTEGER NOT NULL CHECK (budget_tokens > 0),
      candidates_raw_json      TEXT,
      candidates_expanded_json TEXT,
      candidates_ranked_json   TEXT,
      context_slot_json        TEXT,
      timings_json             TEXT,
      created_at               INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_retrieval_trace_session_created
      ON retrieval_trace(session_id, created_at DESC);

    CREATE INDEX idx_retrieval_trace_workflow
      ON retrieval_trace(workflow);
  `,
} as const;
