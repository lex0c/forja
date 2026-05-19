// memory_verify_attempts — cross-session dedup for the LLM-judge
// semantic verifier (MEMORY.md §11.x, Phase 2 / S11 / T11.10).
//
// ────────────────────────────────────────────────────────────────────
// WHAT THIS TABLE TRACKS
//
// Each row records ONE dispatch of the verify-semantic subagent for
// a given memory body. The scheduler consults the table BEFORE
// dispatching to avoid paying LLM cost for memories the judge just
// looked at; the apply path consults `memory_governance_proposals`
// for the same dedup (one pending proposal per memory) so the two
// gates compose:
//
//   - `memory_verify_attempts` answers "did we already dispatch the
//     judge against this exact body recently?". Cross-session,
//     content-addressed.
//   - `memory_governance_proposals` (status='pending') answers
//     "is there a proposal awaiting operator review for this
//     memory?". Session-scoped via session_id.
//
// Dispatch is allowed when BOTH gates return null. Passed and
// inconclusive verdicts dedup for a window (default 7d); contradicted
// verdicts ALWAYS re-dispatch because they're high-stakes — re-
// confirmation is cheap insurance against a flaky single shot.
//
// ────────────────────────────────────────────────────────────────────
// SCHEMA
//
// - `id` (TEXT PRIMARY KEY). UUID. Same shape as memory_provenance,
//   memory_governance_proposals.
//
// - `memory_scope` (TEXT NOT NULL CHECK). Closed enum mirroring
//   MemoryScope.
//
// - `memory_name` (TEXT NOT NULL). Memory name within its scope.
//
// - `content_hash` (TEXT NOT NULL). SHA-256 hex of
//   `serializeMemoryFile(file)` at dispatch time. Stable across
//   round-trips; if the operator edits the body, the hash changes
//   and dedup naturally re-dispatches.
//
// - `verdict` (TEXT NOT NULL CHECK). 'passed' | 'contradicted' |
//   'inconclusive'. Subagent's structured output verdict, surfaced
//   for dedup logic and detector-quality forensics. CHECK is the
//   last line of defense; the repo validates first.
//
// - `confidence` (REAL NOT NULL CHECK 0..1). Subagent's structured
//   output confidence. Stored so /memory governance status can
//   render historical dispatches with their scores.
//
// - `model_id` (TEXT NOT NULL). The provider model that handled the
//   dispatch — pinned for forensics ("was this verdict from gpt-5.4
//   or claude-opus-4-7?"). NOT enforced via CHECK because the
//   provider registry grows independently.
//
// - `prompt_hash` (TEXT NOT NULL). SHA-256 hex of the canonical
//   system+user prompt used in the dispatch. Lets reviewers replay
//   the exact prompt against a different model later.
//
// - `subagent_run_session_id` (TEXT NULL REFERENCES
//   subagent_runs(session_id) SET NULL). Links back to the
//   subagent_runs audit row. The referenced column is the child
//   session id — subagent_runs PKs on session_id (migration 012),
//   not on a separate id column. NULL when the subagent never
//   landed a row (spawn failure before insert, forensic reads on
//   the table after a session purge cascaded the parent).
//
// - `attempted_at` (INTEGER NOT NULL CHECK > 0). Epoch ms when the
//   dispatch returned (success or refusal). Drives the dedup
//   window cutoff + retention sweep.
//
// ────────────────────────────────────────────────────────────────────
// INDEXES
//
// - `(memory_scope, memory_name, content_hash, attempted_at DESC)`
//   — primary dedup query: "most recent attempt for this exact
//   memory body". Single seek answers `lookupRecentAttempt`.
//
// - `(attempted_at)` — retention sweep ("rows older than 90d").
//
// ────────────────────────────────────────────────────────────────────
// LIFECYCLE
//
// Append-only. Boot-time GC sweep (T11.10 future) deletes rows
// older than 90d (mirror of memory_provenance retention). No UPDATE
// surface; every dispatch is its own row.

export const migration057MemoryVerifyAttempts = {
  id: 57,
  name: '057-memory-verify-attempts',
  sql: `
    CREATE TABLE memory_verify_attempts (
      id              TEXT PRIMARY KEY,
      memory_scope    TEXT NOT NULL
                        CHECK (memory_scope IN ('user','project_shared','project_local')),
      memory_name     TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      verdict         TEXT NOT NULL
                        CHECK (verdict IN ('passed','contradicted','inconclusive')),
      confidence      REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      model_id        TEXT NOT NULL,
      prompt_hash     TEXT NOT NULL,
      subagent_run_session_id TEXT REFERENCES subagent_runs(session_id) ON DELETE SET NULL,
      attempted_at    INTEGER NOT NULL CHECK (attempted_at > 0)
    );

    CREATE INDEX idx_mva_dedup
      ON memory_verify_attempts(memory_scope, memory_name, content_hash, attempted_at DESC);

    CREATE INDEX idx_mva_retention
      ON memory_verify_attempts(attempted_at);
  `,
} as const;
