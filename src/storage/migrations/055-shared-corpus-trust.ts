// shared_corpus_trust — last-confirmed fingerprint of the
// `.forja/memory/shared/` corpus per scope-root path (MEMORY.md
// §14.3 hardening, S5/T5.1).
//
// ────────────────────────────────────────────────────────────────────
// WHAT THIS TABLE TRACKS
//
// The `frontmatter.trust` field (per-memory) covers ONE concern:
// "is this individual body safe to eager-load?". This table covers
// a DIFFERENT one: "has the shared/ corpus as a whole changed
// since the operator last confirmed trust?".
//
// Use case (spec MEMORY.md §6.5.2, `trust_revoked` detector): an
// operator clones a project, runs `forja`, confirms cwd trust on
// first visit. Subsequent visits skip the prompt. But if a
// `git pull` pulls in commits that ADD shared memories (e.g., a
// malicious party with commit access could plant operator-
// influencing instructions in `.forja/memory/shared/`), the
// operator should be re-prompted. Hash-based detection makes
// "shared corpus changed since last confirm" a deterministic
// boolean.
//
// SCHEMA:
//
// - `scope_root` (TEXT PRIMARY KEY). Absolute path to the
//   `.forja/memory/shared/` directory. One trust row per
//   scope-root — operators with multiple projects each get their
//   own row.
//
// - `last_confirmed_hash` (TEXT NOT NULL). SHA-256 hex of the
//   canonical concat of `MEMORY.md` + every `.md` body file in
//   the scope root (sorted by filename). NULL is NOT permitted:
//   absence of the row IS the "never confirmed" state — distinct
//   from "confirmed once, hash unknown".
//
// - `last_confirmed_at` (INTEGER NOT NULL). Epoch ms when the
//   operator confirmed trust. Surfaces in `/memory trust status`
//   (S5/T5.4) so the operator sees "trust last confirmed at
//   YYYY-MM-DD" — a recency check for compliance / forensic
//   reviews.
//
// Lifecycle: row created on first operator-confirmed trust;
// updated to the current hash + timestamp on each subsequent
// re-confirm. DELETE only via explicit `/memory trust forget`
// (deferred) or session purge (no FK to sessions — trust is
// cwd-scoped, survives sessions intentionally).
// ────────────────────────────────────────────────────────────────────

export const migration055SharedCorpusTrust = {
  id: 55,
  name: '055-shared-corpus-trust',
  sql: `
    CREATE TABLE shared_corpus_trust (
      scope_root          TEXT PRIMARY KEY,
      last_confirmed_hash TEXT NOT NULL,
      last_confirmed_at   INTEGER NOT NULL CHECK (last_confirmed_at > 0)
    );
  `,
} as const;
