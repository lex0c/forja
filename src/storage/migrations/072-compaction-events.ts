// compaction_events — one row per compaction (CONTEXT_TUNING §12 / AUDIT).
// Compaction rewrites the live array but persists NO messages (SESSION.md);
// this table is the audit/replay trail for the DECISION: which strategy ran,
// how much it freed, and — load-bearing — the LLM summary text, which is
// non-deterministic and otherwise LOST on replay (resume re-derives from the
// log and re-compacts → a different summary). The before/after context hashes
// let a replay verify it reproduced the same context.
//
// Mirrors the *_events convention (memory_events 016, failure_events 041,
// eviction_events 046): TEXT PRIMARY KEY UUID; `session_id REFERENCES
// sessions(id) ON DELETE SET NULL` so the forensic trail outlives a session
// purge (a purge must not cascade-delete the audit history).
//
// Per-column:
//   - strategy: closed enum (= `CompactionStrategy` / `COMPACTION_STRATEGIES`).
//     CHECK is defense-in-depth; the writer derives the value from the tuple.
//     A 5th strategy = ALTER TABLE (explicit PR) — same discipline
//     failure_events uses on `classe` and eviction on `motivo`.
//   - freed_bytes / elided_ids: relevance pre-pass only; NULL on
//     llm/fallback/skipped. `elided_ids` is a JSON array of tool_use_ids
//     (the audit surface for "which results dropped out").
//   - tokens_before: the prompt-token estimate that crossed the threshold
//     (NULL for a forced `/compact` — it has no trigger count).
//   - tokens_after: re-estimate after compaction (NULL when not estimated —
//     e.g. `/compact`, which doesn't estimate).
//   - One row spans the WHOLE compaction event: on an llm-after-relevance fold
//     the relevance pre-pass + the LLM summary are ONE row, so before_hash /
//     tokens_before are the pre-RELEVANCE state and after_* the post-LLM state.
//     A before/after delta is the compaction's total reduction, not the billed
//     LLM call's alone.
//   - summary: the LLM `[compacted_history]` text on the `llm` path; NULL
//     otherwise. The non-reproducible bit. Sensitivity medium (may carry
//     code / paths) per AUDIT.md.
//   - before_hash / after_hash: sha256 of the serialized message array
//     (hashPromptContent), pre- and post-compaction.

export const migration072CompactionEvents = {
  id: 72,
  name: '072-compaction-events',
  sql: `
    CREATE TABLE compaction_events (
      id            TEXT PRIMARY KEY,
      session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      strategy      TEXT NOT NULL
                      CHECK (strategy IN ('llm','fallback','skipped','relevance')),
      folded_count  INTEGER NOT NULL,
      freed_bytes   INTEGER,
      tokens_before INTEGER,
      tokens_after  INTEGER,
      before_hash   TEXT NOT NULL,
      after_hash    TEXT NOT NULL,
      elided_ids    TEXT,
      summary       TEXT,
      reason        TEXT,
      recorded_at   INTEGER NOT NULL
    );

    CREATE INDEX idx_compaction_events_session
      ON compaction_events(session_id, recorded_at);
  `,
} as const;
