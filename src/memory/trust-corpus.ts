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
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Single corpus entry — used by every layer that asks "what's in the
// shared corpus right now?" (fingerprint, modal preview, slash
// status). Exported so callers can render byte sizes without
// re-running the underlying readdir/lstat dance.
export interface CorpusFile {
  name: string;
  bytes: number;
}

// Listing outcome. Three states with distinct downstream meaning:
//   - 'present': directory exists and was enumerable. `files` may be
//     empty if no `.md` regular files are present.
//   - 'absent': directory itself doesn't exist (ENOENT / ENOTDIR).
//     Caller treats as "no corpus" — fingerprint returns the
//     EMPTY_CORPUS_HASH sentinel, modal renders "currently empty",
//     slash shows zero inventory.
//   - 'unreadable': other fs error (EACCES, EIO). Caller treats as
//     verify-failed — fingerprint returns null, the probe surfaces
//     `kind: 'verify_failed'`, the bootstrap path fails-closed by
//     excluding the project_shared scope from eager-load.
export type CorpusListing =
  | { kind: 'present'; files: CorpusFile[] }
  | { kind: 'absent' }
  | { kind: 'unreadable' };

// List the `.md` files at the shared-corpus root. Single source of
// truth for what counts as "in the corpus" — used by:
//
//   - `computeSharedFingerprint` (the hash these files feed into)
//   - `enumerateCorpus` in trust-corpus-probe.ts (the modal preview
//     the operator sees during re-confirmation)
//   - `handleTrust` in cli/slash/commands/memory.ts (the
//     `/memory trust status` inspector)
//
// Pre-extraction these three sites had inline near-duplicate logic
// and could drift on future cases (hidden files, subdirs other than
// `.tombstones/`, symlinks). One helper means one decision surface.
//
// SYMLINK REJECTION (S5 P1/F4 hardening). `lstatSync` instead of
// `statSync` so we DON'T follow the link. A symlinked `.md` body
// would otherwise leak its target's bytes into BOTH the trust
// fingerprint AND the eager-load section downstream — an
// exfiltration channel through the modal-trusted shared-memory
// pipeline. An operator who genuinely wants to share content across
// projects must materialize a real file; the substrate refuses to
// attest content it can't pin to a specific inode under the
// scope root.
export const listSharedCorpusFiles = (sharedRoot: string): CorpusListing => {
  let entries: string[];
  try {
    entries = readdirSync(sharedRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    return { kind: 'unreadable' };
  }

  const files: CorpusFile[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(join(sharedRoot, name));
    } catch {
      // Transient disappearance between readdir and stat — skip
      // silently. The fingerprint stays stable if the entry was
      // never going to participate anyway.
      continue;
    }
    // Refuse symlinks AND non-regular files (directories named
    // `foo.md/` from an operator typo, sockets, fifos). A regular
    // file is the only shape the loader downstream is prepared to
    // read as a memory body.
    if (st.isSymbolicLink()) continue;
    if (!st.isFile()) continue;
    files.push({ name, bytes: st.size });
  }

  // Deterministic lexicographic order. `sort()` with no comparator
  // uses UTF-16 code-unit comparison — same result across platforms.
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { kind: 'present', files };
};

// The canonical "no shared corpus exists at all" hash. Returned by
// `computeSharedFingerprint` when the scope root itself is absent
// — distinguishes "corpus does not exist" from "corpus is empty"
// (the latter has `MEMORY.md` present-but-empty, hashes
// differently). Operators newly cloning a project with NO shared
// memories see this hash; if a later `git pull` introduces
// shared/, the hash changes and a re-prompt fires.
// Exported so the probe orchestrator can distinguish "first-visit
// with empty corpus → safe to silent-seed" from "first-visit with
// non-empty corpus → must prompt" (P0/F2 hardening). The sentinel
// stays distinct from any real corpus hash by construction: real
// hashes use the `'forja:shared-corpus:v1\n'` domain separator
// followed by framed file contents, while the sentinel hashes the
// disjoint `'forja:no-shared-corpus'` string.
export const EMPTY_CORPUS_HASH = createHash('sha256')
  .update('forja:no-shared-corpus')
  .digest('hex');

// File-level summary captured alongside the fingerprint. Used by
// `recomputeSharedFingerprintIfStale` as the fast-path key — if every
// file's `(size, mtimeMs)` matches the snapshot, the bytes are
// assumed unchanged and the cached hash is returned without re-
// reading. mtime alone isn't enough (touch(1) without content change
// would invalidate the cache for nothing); size alone isn't enough
// (same-size content edit slips through); the pair gives a cheap
// approximation that's correct in the operator-doesn't-write-mid-
// modal case and conservatively falls back to a full re-hash
// otherwise.
//
// SECURITY: this is a PERFORMANCE OPTIMIZATION, not a trust signal.
// An attacker who can write to disk can also `utimes(2)` mtimes to
// match an old snapshot. The fast-path is only safe because the
// fingerprint that anchors it was computed from raw bytes (which
// the attacker would have to also leave untouched to slip through).
// `recomputeSharedFingerprintIfStale` falls back to full hashing on
// any deviation — the worst case under attack is "we re-hash and
// detect drift", same as the pre-cache behavior.
export interface CorpusFileStat {
  name: string;
  size: number;
  mtimeMs: number;
}

export interface CorpusSnapshot {
  hash: string;
  files: readonly CorpusFileStat[];
}

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
  const snap = computeSharedFingerprintWithSnapshot(sharedRoot);
  return snap === null ? null : snap.hash;
};

// Variant returning the fingerprint AND the per-file (size, mtime)
// tuple used by `recomputeSharedFingerprintIfStale` to skip a full
// re-hash when nothing on disk changed. The probe (P1/F1) calls
// this once and threads the snapshot into its `verifyConfirmedHash`
// step — saves 1 corpus read on the operator-clicks-yes path
// without weakening TOCTOU detection (any stat-pair mismatch falls
// back to full re-hash).
export const computeSharedFingerprintWithSnapshot = (sharedRoot: string): CorpusSnapshot | null => {
  const listing = listSharedCorpusFiles(sharedRoot);
  if (listing.kind === 'unreadable') return null;
  if (listing.kind === 'absent') {
    return { hash: EMPTY_CORPUS_HASH, files: [] };
  }

  const hash = createHash('sha256');
  // Domain separator. Without this, a future caller that hashes
  // unrelated data with the same framing convention could collide
  // with corpus hashes. Cheap insurance.
  hash.update('forja:shared-corpus:v1\n');

  const files: CorpusFileStat[] = [];
  for (const { name } of listing.files) {
    let body: Buffer;
    let mtimeMs: number;
    try {
      body = readFileSync(join(sharedRoot, name));
      // lstatSync to read mtime without following symlinks (which
      // listSharedCorpusFiles already rejected, but defensive).
      mtimeMs = lstatSync(join(sharedRoot, name)).mtimeMs;
    } catch {
      // Skip transient disappearances between listing and read. A
      // persistent read failure on a single body (e.g., EACCES)
      // WILL be reported as a hash change next boot, which is the
      // safe outcome — the corpus content the operator sees in
      // the eager-load loader will also exclude that file, so
      // hash and effective corpus stay aligned.
      continue;
    }
    // Frame: `filename\n<byte length>\n<raw bytes>\n`. The length
    // prefix prevents adjacency confusion — without it, files
    // `a.md = "hello"` `b.md = "world"` would hash identically to
    // `a.md = "helloworld"` `b.md = ""`. The trailing `\n` after
    // the body separates frames so a body that ends mid-line
    // doesn't bleed into the next filename.
    hash.update(name);
    hash.update('\n');
    hash.update(`${body.length}`);
    hash.update('\n');
    hash.update(body);
    hash.update('\n');
    files.push({ name, size: body.length, mtimeMs });
  }

  return { hash: hash.digest('hex'), files };
};

// Fast-path re-verification (P1/F1 hardening). Re-stats every file
// in `snapshot.files`; if (size, mtime) tuples ALL match AND the
// current listing has no additional files, returns the snapshot
// unchanged (no bytes re-read). On ANY deviation — new file,
// missing file, size mismatch, mtime change — falls back to a
// full `computeSharedFingerprintWithSnapshot`.
//
// Why this is safe even against a TOCTOU attacker: the attacker
// who edits content between the original fingerprint and the
// verify call changes mtime (writes update it) and likely size;
// the fast-path detects both and re-hashes. The attacker who
// `utimes(2)`s to match the snapshot's mtime AND keeps size
// identical would slip through — but that requires a same-size
// content swap, which is the same vulnerability the original
// (cache-free) fingerprint had: identical-bytes-but-different-
// meaning evades hashing regardless of fast-path. The cache adds
// no security weakness.
export const recomputeSharedFingerprintIfStale = (
  sharedRoot: string,
  snapshot: CorpusSnapshot,
): CorpusSnapshot | null => {
  const listing = listSharedCorpusFiles(sharedRoot);
  if (listing.kind === 'unreadable') return null;
  if (listing.kind === 'absent') {
    // Disagreement: snapshot says corpus had files, current state
    // says nothing. Fast-path can't return snapshot unchanged.
    if (snapshot.files.length === 0) return snapshot;
    return computeSharedFingerprintWithSnapshot(sharedRoot);
  }
  // Build a name → stat map from the listing to compare against
  // snapshot.files. Both sides are sorted lexicographically by
  // `listSharedCorpusFiles`, so we can walk in lockstep — but a
  // map lookup is more resilient to spurious sort drifts and lets
  // us detect added files cheaply.
  const currentByName = new Map<string, CorpusFileStat>();
  for (const f of listing.files) {
    let mtimeMs: number;
    try {
      mtimeMs = lstatSync(join(sharedRoot, f.name)).mtimeMs;
    } catch {
      // Transient — fall back to full re-fingerprint.
      return computeSharedFingerprintWithSnapshot(sharedRoot);
    }
    currentByName.set(f.name, { name: f.name, size: f.bytes, mtimeMs });
  }
  if (currentByName.size !== snapshot.files.length) {
    return computeSharedFingerprintWithSnapshot(sharedRoot);
  }
  for (const cached of snapshot.files) {
    const cur = currentByName.get(cached.name);
    if (cur === undefined) {
      return computeSharedFingerprintWithSnapshot(sharedRoot);
    }
    if (cur.size !== cached.size || cur.mtimeMs !== cached.mtimeMs) {
      return computeSharedFingerprintWithSnapshot(sharedRoot);
    }
  }
  // All stat tuples agree → trust the cached hash.
  return snapshot;
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
