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

// Compute a deterministic SHA-256 fingerprint of the shared corpus
// rooted at `sharedRoot` (typically the path returned by
// `projectScopeRoots(repoRoot).shared`). Returns `null` only if a
// genuinely fatal I/O error makes the corpus unreadable — the
// caller MUST treat null as "could not verify trust" (fail-closed
// — re-prompt) rather than "no change".
//
// Always reads every body. A prior (size, mtime) stat-compare
// fast-path was removed because it could pass a same-size content
// swap with restored mtime (utimes(2), or filesystems whose 1-2s
// mtime granularity makes a same-second rewrite invisible). The
// probe's confirm step calls this twice — once before the modal
// (presented hash) and once after a 'yes' (TOCTOU re-verify) —
// and stamps trust on what we re-verify, so it MUST hash bytes.
//
// Performance note: shared corpora are bounded by spec (§5.4 caps
// each body at SHARED_BODY_LINE_CAP=200 lines, ~10KB; operator-
// curated lists rarely exceed a few dozen entries). Synchronous
// readSync is appropriate at this scale — boot-time blocking <1ms
// in practice, dwarfed by SQLite migration cost.
export const computeSharedFingerprint = (sharedRoot: string): string | null => {
  const listing = listSharedCorpusFiles(sharedRoot);
  if (listing.kind === 'unreadable') return null;
  if (listing.kind === 'absent') return EMPTY_CORPUS_HASH;

  const hash = createHash('sha256');
  // Domain separator. Without this, a future caller that hashes
  // unrelated data with the same framing convention could collide
  // with corpus hashes. Cheap insurance.
  hash.update('forja:shared-corpus:v1\n');

  for (const { name } of listing.files) {
    let body: Buffer;
    try {
      body = readFileSync(join(sharedRoot, name));
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
