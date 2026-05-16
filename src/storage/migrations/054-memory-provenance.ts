// memory_provenance — exposure trace for memories the model saw
// during a session (MEMORY.md §11.2, feat/memory-lifecycle-detectors
// Slice 1).
//
// ────────────────────────────────────────────────────────────────────
// WHAT THE SCHEMA CLAIMS, AND WHAT IT DOES NOT.
//
// Each row is an EXPOSURE record — "memory X was visible to the
// model at the moment of tool_call Y" or "memory X was eager-loaded
// at session start". It does NOT claim:
//
//   - Causation. The model can ignore an exposed memory entirely.
//     `verify_failed` / `user_override_repeated` / `conflict_detected`
//     detectors layer correlation analysis on top of exposure data
//     — that's epistemic correlation, NOT proof that the memory drove
//     the action.
//   - Use. There's no signal (today) that says "the model
//     attended to this memory". Provenance is the lower bound: the
//     bytes WERE in the model's window.
//   - Replay completeness. The system prompt's full bytes, the tool
//     registry version, the model_id + temperature + decoding seed —
//     none of those live here. Provenance is one dimension of
//     cognitive observability, not all of it.
//
// Reframing the language ("exposed", not "caused") is the
// load-bearing discipline; the schema follows it.
// ────────────────────────────────────────────────────────────────────
//
// Schema rationale per column:
//
// - `id` (TEXT PRIMARY KEY UUID). One row per exposure event. UUID
//   matches every other audit-shaped repo in the project.
//
// - `session_id` (TEXT NOT NULL FK CASCADE). Session-scoped by
//   design — privacy + analytics both want "what was visible to
//   this session" as the unit. Cross-session aggregate queries
//   need a separate, explicitly-named function (mirrors the lesson
//   from `listRetrievalTracesByWorkflow` regression fix in commit
//   55ba11a).
//
// - `tool_call_id` (TEXT NULL FK CASCADE). Nullable because
//   eager-load happens at session boot — BEFORE any tool call
//   exists. Eager rows have NULL tool_call_id and represent
//   "this memory was visible to every tool call in this session
//   from start". Per-call surfaces (`memory_read`, `retrieve_context`)
//   set the tool_call_id explicitly.
//
// - `memory_scope`, `memory_name`. The memory identity. Together
//   with `session_id` they're the most common query shape:
//   "how many times was user/auth exposed in this session?".
//
// - `surface` (TEXT NOT NULL CHECK). One of three exposure paths:
//
//     - `eager`           — system-prompt eager-load at session boot.
//                           One row per (session, memory) — N tool
//                           calls don't generate N rows for the
//                           same eager memory.
//     - `memory_read`     — model called the memory_read tool by
//                           name. Per-call: every read is a new row.
//     - `retrieve_context` — retrieve_context tool returned a slot
//                           that included this memory. Per-call: the
//                           row links back to the originating
//                           tool_call via `tool_call_id` AND to the
//                           retrieval batch via `retrieval_query_id`.
//
// - `retrieval_query_id` (TEXT NULL FK retrieval_trace). NULL for
//   eager / memory_read; set for retrieve_context exposures. Allows
//   grouping: "the retrieval at trace X exposed N memories" without
//   reconstructing the relationship from the timing fields.
//
//   INSERT-time invariant (enforced by `recordProvenance`):
//     surface='retrieve_context' ⇒ retrieval_query_id IS NOT NULL.
//   Post-cascade state: when a retrieval_trace row is deleted, FK
//   `ON DELETE SET NULL` may null this column on surviving
//   provenance rows. The exposure still happened — the row stays
//   in the table — but the grouping key is lost. Consumers handle
//   the post-cascade state gracefully:
//     - `listExposuresInRetrieval` filters by retrieval_query_id
//       so post-cascade rows simply aren't returned by that path.
//     - `listProvenanceForToolCall` / `listProvenanceByName` still
//       return them; the slash command's renderer skips the
//       retrieval grouping detail when the qid is null.
//   This split (strong INSERT invariant, graceful post-cascade
//   nullable) is deliberate so retrieval-trace GC can prune
//   without orphaning the exposure history.
//
// - `position_in_corpus` (INTEGER NULL). For retrieve_context:
//   index in `contextSlot.included` (0 = top hit). NULL elsewhere.
//   Operator forensics value: "the memory was exposed but ranked
//   18th in the slot — maybe operator/model didn't actually attend
//   to it". Cheaper than re-reading `retrieval_trace` for every
//   provenance query.
//
// - `memory_content_hash` (TEXT NULL). SHA-256 of frontmatter +
//   body bytes at exposure time. NULL when capture fails (best-
//   effort: hash should never block exposure recording).
//
//   WHY: memory content is MUTABLE state. Without the hash, an
//   audit row says "memory X was exposed" but can't prove WHAT
//   bytes. Operator editing the memory later breaks replay; hash
//   makes audit row + memory file pairing honest. Replay layer can
//   verify the hash and refuse to "replay" against drifted content.
//
// - `memory_state_at_exposure` (TEXT NULL). Frontmatter `state`
//   field snapshot ('active' / 'quarantined' / etc.). The memory
//   may transition state after exposure; future queries asking
//   "what was the state when the model saw this?" need the
//   snapshot, not the current value.
//
// - `created_at` (INTEGER NOT NULL). Epoch ms. Indexed for the
//   "exposures in window" forensic query (used by
//   `user_override_repeated` detector aggregation in Slice 3).
//
// Indices:
//
// - `idx_memory_provenance_session_created` — canonical
//   "what was exposed in this session" lookup; DESC on created_at +
//   tiebreaker on id matches the pattern in retrieval_trace +
//   failure_events.
// - `idx_memory_provenance_session_scope_name_created` — "history
//   of exposures for memory X in this session" forensic; leads with
//   session_id because EVERY caller filters by session (privacy +
//   analytics default — see repo header). DESC on created_at for
//   most-recent-first traversal.
// - `idx_memory_provenance_tool_call` — partial index WHERE
//   tool_call_id IS NOT NULL; covers "what was exposed during
//   tool_call Y" lookup. Partial because eager rows (NULL
//   tool_call_id) outnumber per-call rows and would otherwise
//   bloat the index.
// - `idx_memory_provenance_retrieval` — partial index WHERE
//   retrieval_query_id IS NOT NULL; covers "the retrieval at
//   query Z exposed which memories" grouping.

export const migration054MemoryProvenance = {
  id: 54,
  name: '054-memory-provenance',
  sql: `
    CREATE TABLE memory_provenance (
      id                         TEXT PRIMARY KEY,
      session_id                 TEXT NOT NULL,
      tool_call_id               TEXT,
      memory_scope               TEXT NOT NULL CHECK (memory_scope IN (
                                    'user',
                                    'project_shared',
                                    'project_local'
                                  )),
      memory_name                TEXT NOT NULL,
      surface                    TEXT NOT NULL CHECK (surface IN (
                                    'eager',
                                    'memory_read',
                                    'retrieve_context'
                                  )),
      retrieval_query_id         TEXT,
      position_in_corpus         INTEGER,
      memory_content_hash        TEXT,
      memory_state_at_exposure   TEXT,
      created_at                 INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (tool_call_id) REFERENCES tool_calls(id) ON DELETE CASCADE,
      FOREIGN KEY (retrieval_query_id) REFERENCES retrieval_trace(id) ON DELETE SET NULL
    );

    CREATE INDEX idx_memory_provenance_session_created
      ON memory_provenance(session_id, created_at DESC, id DESC);

    CREATE INDEX idx_memory_provenance_session_scope_name_created
      ON memory_provenance(session_id, memory_scope, memory_name, created_at DESC, id DESC);

    CREATE INDEX idx_memory_provenance_tool_call
      ON memory_provenance(tool_call_id)
      WHERE tool_call_id IS NOT NULL;

    CREATE INDEX idx_memory_provenance_retrieval
      ON memory_provenance(retrieval_query_id)
      WHERE retrieval_query_id IS NOT NULL;
  `,
} as const;
