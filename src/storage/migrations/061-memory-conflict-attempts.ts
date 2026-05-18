// memory_conflict_attempts — cross-session dedup for the LLM-judge
// conflict detector (MEMORY.md §11.x / S13 / T13.4).
//
// ────────────────────────────────────────────────────────────────────
// WHAT THIS TABLE TRACKS
//
// Each row records ONE dispatch of the verify-conflict subagent for
// a PAIR of memory bodies. Mirrors memory_verify_attempts (S11)
// shape-by-shape; the key difference is the pair-keyed schema —
// dedup is keyed on the (scope_a, name_a, scope_b, name_b,
// content_hash_a, content_hash_b) tuple instead of a single-memo
// (scope, name, content_hash).
//
// Pair-ordering invariant: callers MUST canonicalize the pair
// before INSERT so the same conflict-pair always lands the same row
// regardless of argument order. Canonical form: the lexicographically
// smaller `(scope, name)` becomes side A; the larger becomes side B.
// The CHECK constraint `scope_a || '/' || name_a < scope_b || '/' ||
// name_b` enforces this — a caller that forgets the canonicalization
// gets a loud constraint violation at INSERT time instead of a
// silently-duplicated row.
//
// ────────────────────────────────────────────────────────────────────
// SCHEMA
//
// - `id` (TEXT PRIMARY KEY). UUID. Same shape as the rest of the
//   memory_* audit family.
//
// - `scope_a` / `name_a` / `content_hash_a` — side A of the
//   canonical pair (lexicographically smaller).
// - `scope_b` / `name_b` / `content_hash_b` — side B.
//
// - `verdict` (TEXT NOT NULL CHECK). Boolean-shaped via 'conflicting'
//   / 'compatible' so the column can be filtered without booleans-
//   as-ints surprises. 'conflicting' matches the subagent's
//   `conflicting: true`; 'compatible' covers everything else
//   (including paraphrased-agreement, disjoint-topics, etc.).
//
// - `conflict_kind` (TEXT). Subagent's structured-output value;
//   'incompatible-implementation', 'paraphrased-agreement', etc.
//   Free-text — the subagent may coin new kebab-case kinds — so the
//   column is plain TEXT with no CHECK.
//
// - `confidence` (REAL NOT NULL CHECK 0..1). Same range as
//   memory_verify_attempts.confidence.
//
// - `model_id` (TEXT NOT NULL). Provider model that handled the
//   dispatch.
//
// - `prompt_hash` (TEXT NOT NULL). SHA-256 hex of the canonical
//   system+user prompt used in the dispatch.
//
// - `subagent_run_session_id` (TEXT NULL REFERENCES
//   subagent_runs(session_id) ON DELETE SET NULL). Lineage back to
//   the audit row. Same SET-NULL semantics as
//   memory_verify_attempts.
//
// - `attempted_at` (INTEGER NOT NULL CHECK > 0). Epoch ms.
//
// ────────────────────────────────────────────────────────────────────
// INDEXES
//
// - `(scope_a, name_a, content_hash_a, scope_b, name_b,
//    content_hash_b, attempted_at DESC)` — primary dedup query:
//   "most recent attempt for this exact canonical pair". Single
//   seek answers `lookupRecentConflictAttempt`.
//
// - `(attempted_at)` — retention sweep.
//
// ────────────────────────────────────────────────────────────────────
// LIFECYCLE
//
// Append-only. Boot-time GC sweep deletes rows older than 90d
// (mirror of memory_verify_attempts retention). No UPDATE surface;
// every dispatch is its own row.

export const migration061MemoryConflictAttempts = {
  id: 61,
  name: '061-memory-conflict-attempts',
  sql: `
    CREATE TABLE memory_conflict_attempts (
      id              TEXT PRIMARY KEY,
      scope_a         TEXT NOT NULL
                        CHECK (scope_a IN ('user','project_shared','project_local')),
      name_a          TEXT NOT NULL,
      content_hash_a  TEXT NOT NULL,
      scope_b         TEXT NOT NULL
                        CHECK (scope_b IN ('user','project_shared','project_local')),
      name_b          TEXT NOT NULL,
      content_hash_b  TEXT NOT NULL,
      verdict         TEXT NOT NULL
                        CHECK (verdict IN ('conflicting','compatible')),
      conflict_kind   TEXT,
      confidence      REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      model_id        TEXT NOT NULL,
      prompt_hash     TEXT NOT NULL,
      subagent_run_session_id TEXT REFERENCES subagent_runs(session_id) ON DELETE SET NULL,
      attempted_at    INTEGER NOT NULL CHECK (attempted_at > 0),
      CHECK (scope_a || '/' || name_a < scope_b || '/' || name_b)
    );

    CREATE INDEX idx_mca_dedup
      ON memory_conflict_attempts(scope_a, name_a, content_hash_a,
                                  scope_b, name_b, content_hash_b,
                                  attempted_at DESC);

    CREATE INDEX idx_mca_retention
      ON memory_conflict_attempts(attempted_at);
  `,
} as const;
