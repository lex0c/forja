// memory_verify_override_attempts — cross-session dedup for the
// S3 LLM-judge override detector (MEMORY.md §11.x, spec §6.5.2).
//
// ────────────────────────────────────────────────────────────────────
// WHAT THIS TABLE TRACKS
//
// Each row records ONE dispatch of the verify-override subagent for
// a given memory body. Mirrors memory_verify_attempts (S11) and
// memory_conflict_attempts (S13) in shape. The dispatcher consults
// this table BEFORE dispatching to avoid re-paying LLM cost for a
// memory whose body hasn't changed within the cooldown window.
//
// Dedup semantic (S3 cooldown gate):
//
//   - misguiding=false → cache hit for SEMANTIC_OVERRIDE_COOLDOWN_MS
//     (24h, matches the threshold window: the judge's pool of
//     evidence overlaps with the threshold pool for that long; re-
//     dispatching with substantially the same pool is structurally
//     redundant).
//   - misguiding=true  → cache hit for the SAME window. Unlike S11's
//     "contradicted always re-dispatches", S3 has the pending-proposal
//     gate upstream to prevent duplicate operator queue entries — the
//     dedup table doesn't have to do that work too. When the cooldown
//     expires AND the proposal is still pending, the scheduler skips
//     via the pending-proposal gate; when the proposal was rejected
//     and a new override pattern emerges, the cooldown lets dispatch
//     resume.
//
// Cache MISS conditions (dispatch proceeds):
//   - No row matches (memory_scope, memory_name, content_hash).
//   - The matching row's attempted_at is older than COOLDOWN_MS.
//   - The memory body changed (content_hash drifts) — operator
//     edited; new evidence may yield a different verdict.
//
// ────────────────────────────────────────────────────────────────────
// SCHEMA
//
// - `id` (TEXT PRIMARY KEY). UUID. Same shape as memory_verify_
//   attempts / memory_conflict_attempts.
//
// - `memory_scope` (TEXT NOT NULL CHECK). Closed enum mirroring
//   MemoryScope.
//
// - `memory_name` (TEXT NOT NULL). Memory name within its scope.
//
// - `content_hash` (TEXT NOT NULL). SHA-256 hex of the memory's
//   `serializeMemoryFile` output. Drift → dedup miss → re-dispatch.
//
// - `misguiding` (INTEGER NOT NULL CHECK 0..1). The verdict's
//   boolean serialized as 0/1 (SQLite booleans-as-ints, same shape
//   as memory_conflict_attempts.verdict 'conflicting'/'compatible').
//   The S3 subagent emits `{misguiding: bool}`; we store the raw
//   bit so dedup queries don't have to interpret an enum string.
//
// - `confidence` (REAL NOT NULL CHECK 0..1). Subagent's confidence.
//   Surfaced via /memory governance status to show historical
//   dispatch scores; the threshold gate (>= 0.7) lives in the
//   dispatcher / scheduler.
//
// - `suggested_motivo` (TEXT NOT NULL CHECK). The subagent's
//   suggested governance motivo: 'conflict' | 'shift' | 'low_roi'.
//   Stored so the proposal generator can pass it through to the
//   apply path's eviction_events.motivo without re-querying the
//   subagent's structured output.
//
// - `model_id` (TEXT NOT NULL). Provider model that handled the
//   dispatch. Free-text — provider registry grows independently.
//
// - `prompt_hash` (TEXT NOT NULL). SHA-256 hex of the canonical
//   system+user prompt. Reviewers can replay the exact prompt
//   against a different model later.
//
// - `subagent_run_session_id` (TEXT NULL REFERENCES
//   subagent_runs(session_id) ON DELETE SET NULL). Lineage back to
//   the audit row. SET NULL on session purge preserves the dedup
//   cache + forensic chain.
//
// - `attempted_at` (INTEGER NOT NULL CHECK > 0). Epoch ms when the
//   dispatch returned. Drives the cooldown cutoff + retention sweep.
//
// ────────────────────────────────────────────────────────────────────
// INDEXES
//
// - `(memory_scope, memory_name, content_hash, attempted_at DESC)`
//   — primary dedup query: "most recent attempt for this exact
//   memory body". Single seek answers `lookupRecentOverrideAttempt`.
//
// - `(attempted_at)` — retention sweep ("rows older than 90d").
//
// ────────────────────────────────────────────────────────────────────
// LIFECYCLE
//
// Append-only. Boot-time GC sweep deletes rows older than 90d
// (mirrors memory_verify_attempts + memory_conflict_attempts
// retention). No UPDATE surface; every dispatch is its own row.

export const migration065MemoryVerifyOverrideAttempts = {
  id: 65,
  name: '065-memory-verify-override-attempts',
  sql: `
    CREATE TABLE memory_verify_override_attempts (
      id              TEXT PRIMARY KEY,
      memory_scope    TEXT NOT NULL
                        CHECK (memory_scope IN ('user','project_shared','project_local')),
      memory_name     TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      misguiding      INTEGER NOT NULL CHECK (misguiding IN (0, 1)),
      confidence      REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      suggested_motivo TEXT NOT NULL
                        CHECK (suggested_motivo IN ('conflict','shift','low_roi')),
      model_id        TEXT NOT NULL,
      prompt_hash     TEXT NOT NULL,
      subagent_run_session_id TEXT REFERENCES subagent_runs(session_id) ON DELETE SET NULL,
      attempted_at    INTEGER NOT NULL CHECK (attempted_at > 0)
    );

    CREATE INDEX idx_mvoa_dedup
      ON memory_verify_override_attempts(memory_scope, memory_name, content_hash, attempted_at DESC);

    CREATE INDEX idx_mvoa_retention
      ON memory_verify_override_attempts(attempted_at);
  `,
} as const;
