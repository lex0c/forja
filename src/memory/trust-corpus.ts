// Shared-corpus trust substrate — MEMORY.md §6.5.2 `trust_revoked`
// detector (S5/T5.1).
//
// ────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE DOES
//
// Two responsibilities, both deterministic:
//
//   1. `computeSharedFingerprint(sharedRoot)` — SHA-256 hex of the
//      canonical concatenation of the shared corpus' files. The
//      operator's "I trust this shared corpus" decision is anchored
//      to this hash; any byte-level change in any file flips the
//      hash and re-prompts.
//
//   2. `getSharedTrust(db, scopeRoot)` / `setSharedTrust(db, ...)` —
//      read/write the last-confirmed hash for a given scope-root
//      from `shared_corpus_trust` (migration 055).
//
// The boot-time modal flow (T5.2) and the bulk-quarantine on
// revoke (T5.3) live OUTSIDE this module — those are operator-
// facing concerns. This module is pure substrate.
//
// ────────────────────────────────────────────────────────────────────
// WHY HASH AND NOT MTIME / FILE LIST
//
// `mtime` is a touchpoint surface: `touch shared/foo.md` re-prompts
// the operator without changing content. File-list-only would miss
// content edits to existing files (the exact scenario S5 defends
// against: a `git pull` modifies an existing shared memory body).
// SHA-256 of the canonical byte stream is the only signal that
// answers "has the operator-influencing surface changed" without
// false positives (mtime) or false negatives (file list).
//
// ────────────────────────────────────────────────────────────────────
// CANONICALIZATION RULES
//
// The hash MUST be stable across:
//
//   - Filesystem reordering (`readdir` order is unspecified;
//     different OS / FS pairs return different orders for the
//     same directory). Sort filenames lexicographically before
//     concat.
//   - Missing-file states. An empty corpus (no MEMORY.md, no
//     bodies) must still produce a stable hash, distinct from
//     "MEMORY.md exists but is empty". We mark presence by
//     framing each file with `path\n<byte length>\n<bytes>\n`;
//     absent files contribute nothing, present-but-empty files
//     contribute `name\n0\n\n`.
//   - Trailing newlines / CRLF. We hash the raw bytes as they
//     live on disk — operator-relevant changes include the body
//     bytes verbatim. Editors that auto-normalize line endings
//     WILL re-prompt; that is the spec-correct behavior (the
//     surface that ships to other agents has changed).
//
// What is NOT in the corpus:
//   - `.tombstones/` and its descendants (evicted memories — not
//     loaded into operator context).
//   - Non-`.md` files in the shared root (operator junk, hidden
//     `.DS_Store`, etc.; not surfaced to the model).
//   - Subdirectories other than `.tombstones/` — per MEMORY.md §2,
//     shared/ is FLAT (no nesting). Anything in a subdir is
//     out-of-spec and ignored by the loader, so it's ignored
//     here too.
// ────────────────────────────────────────────────────────────────────

import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The canonical "no shared corpus exists at all" hash. Returned by
// `computeSharedFingerprint` when the scope root itself is absent
// — distinguishes "corpus does not exist" from "corpus is empty"
// (the latter has `MEMORY.md` present-but-empty, hashes
// differently). Operators newly cloning a project with NO shared
// memories see this hash; if a later `git pull` introduces
// shared/, the hash changes and a re-prompt fires.
const EMPTY_CORPUS_HASH = createHash('sha256').update('forja:no-shared-corpus').digest('hex');

// Compute a deterministic SHA-256 fingerprint of the shared corpus
// rooted at `sharedRoot` (typically the path returned by
// `projectScopeRoots(repoRoot).shared`). Returns `null` only if a
// genuinely fatal I/O error makes the corpus unreadable — the
// caller MUST treat null as "could not verify trust" (fail-closed
// — re-prompt) rather than "no change".
//
// Performance note: shared corpora are bounded by spec (§5.4 caps
// each body at SHARED_BODY_LINE_CAP=200 lines, ~10KB; operator-
// curated lists rarely exceed a few dozen entries). Synchronous
// readSync is appropriate at this scale — boot-time blocking <1ms
// in practice, dwarfed by SQLite migration cost.
export const computeSharedFingerprint = (sharedRoot: string): string | null => {
  let entries: string[];
  try {
    entries = readdirSync(sharedRoot);
  } catch (err) {
    // ENOENT is the normal "no shared corpus" case (operator never
    // wrote a shared memory). Any other error (EACCES, EIO) is a
    // genuine read failure — return null to signal "verify failed".
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return EMPTY_CORPUS_HASH;
    return null;
  }

  // Filter to corpus members: `.md` files at the root, excluding
  // `.tombstones/` and any other subdirs. The MEMORY.md index is
  // a regular `.md` file and gets the same framing as bodies —
  // operator-relevant changes include index reordering.
  const corpusFiles: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    // Defensive: skip if the .md path is actually a directory
    // (operator could have `mkdir foo.md/` for whatever reason).
    let isFile = false;
    try {
      isFile = statSync(join(sharedRoot, name)).isFile();
    } catch {
      // Stat failure on a single entry: skip but don't fail the
      // whole hash — readdirSync said it was there, so a transient
      // disappearance between readdir and stat is benign.
      continue;
    }
    if (isFile) corpusFiles.push(name);
  }

  // Stable order. `sort()` with no comparator uses lexicographic
  // UTF-16 ordering — deterministic across platforms.
  corpusFiles.sort();

  const hash = createHash('sha256');
  // Domain separator. Without this, a future caller that hashes
  // unrelated data with the same framing convention could collide
  // with corpus hashes. Cheap insurance.
  hash.update('forja:shared-corpus:v1\n');

  for (const filename of corpusFiles) {
    let body: Buffer;
    try {
      body = readFileSync(join(sharedRoot, filename));
    } catch {
      // Same rationale as the stat fallback: skip transient
      // disappearances. A persistent read failure on a member
      // file (e.g., EACCES on a single body) WILL be reported as
      // a hash change next boot, which is the safe outcome.
      continue;
    }
    // Frame: `filename\n<byte length>\n<raw bytes>\n`. The length
    // prefix prevents adjacency confusion — without it, files
    // `a.md = "hello"` `b.md = "world"` would hash identically to
    // `a.md = "helloworld"` `b.md = ""`. The trailing `\n` after
    // the body separates frames so a body that ends mid-line
    // doesn't bleed into the next filename.
    hash.update(filename);
    hash.update('\n');
    hash.update(`${body.length}`);
    hash.update('\n');
    hash.update(body);
    hash.update('\n');
  }

  return hash.digest('hex');
};

// Repository row shape. Mirrors the columns of
// `shared_corpus_trust` from migration 055. We keep this as a
// flat object rather than an opaque token so callers can render
// `last_confirmed_at` in `/memory trust status` (T5.4).
export interface SharedTrustRow {
  scopeRoot: string;
  lastConfirmedHash: string;
  lastConfirmedAtMs: number;
}

// Fetch the last-confirmed trust row for a scope root. Returns
// null if no row exists — distinct from a row whose hash mismatches
// the current corpus. The boot flow uses the null case to mean
// "first visit, prompt for initial trust"; a row-present case
// means "confirmed before, compare hashes".
export const getSharedTrust = (db: Database, scopeRoot: string): SharedTrustRow | null => {
  const row = db
    .prepare(
      `SELECT scope_root          AS scopeRoot,
              last_confirmed_hash AS lastConfirmedHash,
              last_confirmed_at   AS lastConfirmedAtMs
         FROM shared_corpus_trust
        WHERE scope_root = ?`,
    )
    .get(scopeRoot) as SharedTrustRow | null;
  return row ?? null;
};

// Upsert the trust row. Called by the operator-facing flow once
// the modal returns "accept" — never invoked from automated paths
// (the whole point of S5 is that ONLY explicit operator action can
// re-establish trust). `atMs` defaults to `Date.now()`; tests
// override it for determinism.
export const setSharedTrust = (
  db: Database,
  scopeRoot: string,
  hash: string,
  atMs: number = Date.now(),
): void => {
  db.prepare(
    `INSERT INTO shared_corpus_trust (scope_root, last_confirmed_hash, last_confirmed_at)
       VALUES (?, ?, ?)
     ON CONFLICT(scope_root) DO UPDATE SET
       last_confirmed_hash = excluded.last_confirmed_hash,
       last_confirmed_at   = excluded.last_confirmed_at`,
  ).run(scopeRoot, hash, atMs);
};

// Remove the trust row. Used by the revoke path (T5.3) — once the
// operator denies the re-prompt, the row is cleared so the NEXT
// boot also re-prompts (a denied revoke isn't "I trust the new
// hash"; it's "I don't trust this corpus at all"). Distinct from
// `setSharedTrust` because we don't want to upsert a sentinel hash
// — the absence of a row IS the spec-correct representation of
// "never confirmed".
export const clearSharedTrust = (db: Database, scopeRoot: string): void => {
  db.prepare('DELETE FROM shared_corpus_trust WHERE scope_root = ?').run(scopeRoot);
};
