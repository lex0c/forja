import { type Dirent, existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { FrontmatterError, parseMemoryFile } from './frontmatter.ts';
import { type ParsedIndex, parseIndex } from './index-file.ts';
import {
  indexFilePath,
  memoryFilePath,
  rootForScope,
  seedIndexFilePath,
  seedMemoryFilePath,
  seedsRoot,
} from './paths.ts';
import type { ScopeRoots } from './paths.ts';
import type { MemoryFile, MemoryScope } from './types.ts';

// Disk-side loader for the memory subsystem.
//
// Layered API:
//   - `loadScopeIndex(roots, scope)`         — read MEMORY.md
//   - `readMemoryByName(roots, scope, name)` — read one .md by name
//   - `listOrphanFiles(roots, scope)`        — find .md files on disk
//                                              that the index doesn't
//                                              reference (operator
//                                              hand-edited surface)
//
// Every fs read distinguishes three outcomes:
//   1. ENOENT on the scope root / index file — scope is empty or the
//      operator hasn't initialized memory yet. Return an empty result;
//      this is the "no memory yet" path and is NOT an error.
//   2. ENOENT on a specific memory file referenced by the index — the
//      index points at a missing body. Surface as `kind: 'missing'`
//      so the registry can keep the entry visible (operator may have
//      deleted the body but not the index entry; `/memory list`
//      surfaces both states).
//   3. Parse error in either MEMORY.md or a body — operator broke
//      their own file. Return `kind: 'malformed'` with the underlying
//      error message; the registry surfaces this in `/memory list`
//      WITHOUT swallowing it (silent skip would hide a real corruption).
//
// The loader does NOT cache. The registry layer (5.2.a) holds the
// in-memory snapshot. Keeping the loader stateless makes it trivial
// to test against tmpdirs and lets the registry decide its own
// invalidation policy.

export type ScopeIndexResult =
  | { kind: 'present'; index: ParsedIndex }
  | { kind: 'absent' }
  | { kind: 'malformed'; error: string };

const isEnoent = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';

// Refuse symlinks and non-regular files BEFORE readFileSync. Two
// reasons share this gate:
//
//   1. Trust attestation symmetry (S5 review). The shared-corpus
//      fingerprint (`listSharedCorpusFiles` in trust-corpus.ts)
//      already lstat-rejects symlinks: a symlinked `.md` is
//      excluded from the hash AND the trust modal inventory.
//      Without this loader-side mirror, the eager-load /
//      retrieval surfaces would `readFileSync(path)` and follow
//      the symlink — feeding target bytes to the model under a
//      trust hash that pretended the file didn't exist. A
//      malicious repo could ship `MEMORY.md` referencing
//      `evil.md` where `evil.md` is a symlink to `~/.ssh/id_rsa`
//      (or any out-of-scope file): the fingerprint stays
//      unchanged across boots ("no re-prompt needed") while the
//      target's bytes leak into the model's context. Closing the
//      symmetry at the loader makes the substrate's symlink
//      policy uniform — modal sees the same set the model sees.
//
//   2. Non-regular file rejection (defense-in-depth). A
//      directory named `foo.md/`, a fifo, a socket, a device
//      node — `readFileSync` either returns junk or blocks
//      indefinitely. Surface as malformed so operators can spot
//      it via `/memory list` rather than discovering it via a
//      hung boot.
//
// Outcomes from the pre-read regular-file check.
type RegularFileCheck =
  | { kind: 'ok' }
  | { kind: 'not_found' }
  | { kind: 'symlink' }
  | { kind: 'non_regular' };

const checkRegularFile = (path: string): RegularFileCheck => {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if (isEnoent(err)) return { kind: 'not_found' };
    throw err;
  }
  if (stat.isSymbolicLink()) return { kind: 'symlink' };
  if (!stat.isFile()) return { kind: 'non_regular' };
  return { kind: 'ok' };
};

const SYMLINK_REFUSE_MESSAGE =
  'memory file is a symlink — refused by security policy ' +
  '(shared-corpus trust attestation requires regular files; ' +
  'materialize a real file at this path)';

const NON_REGULAR_REFUSE_MESSAGE =
  'memory file is not a regular file (got directory, fifo, socket, or device node)';

// Shared index-loading helper: takes an absolute path to a
// MEMORY.md file and returns the typed result. Used by both the
// per-scope loader (`loadScopeIndex`) and the seeds-subdir loader
// (`loadSeedsIndex`); centralizing the symlink/regular-file gate
// + parse error wrapping here means the two surfaces can't drift
// in error reporting or in security posture.
const loadIndexAt = (path: string): ScopeIndexResult => {
  const fileCheck = checkRegularFile(path);
  if (fileCheck.kind === 'not_found') return { kind: 'absent' };
  if (fileCheck.kind === 'symlink') return { kind: 'malformed', error: SYMLINK_REFUSE_MESSAGE };
  if (fileCheck.kind === 'non_regular') {
    return { kind: 'malformed', error: NON_REGULAR_REFUSE_MESSAGE };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    // checkRegularFile already absorbed ENOENT; remaining throws
    // are real fs errors (EACCES, EIO) we surface unchanged.
    if (isEnoent(err)) return { kind: 'absent' };
    throw err;
  }
  // parseIndex itself doesn't throw — it surfaces malformed lines via
  // the result. But a future regression that throws would leave the
  // caller without a clean signal; wrap defensively so the registry
  // gets a typed outcome either way.
  try {
    const index = parseIndex(raw);
    return { kind: 'present', index };
  } catch (err) {
    return {
      kind: 'malformed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

// Read MEMORY.md for one scope. Returns 'absent' when either the
// scope root directory or the file itself does not exist — both
// states indicate "no memories declared via index here", which is
// indistinguishable from the operator's perspective. Other fs errors
// (EACCES, EIO) propagate; they're real problems, not scope state.
//
// SECURITY (S5 review): refuse symlinked MEMORY.md. The shared-
// corpus fingerprint excludes symlinks from its hash, so a symlinked
// index would let an attacker swap which bodies eager-load reads
// (point MEMORY.md at any out-of-scope file containing
// markdown-link syntax) while leaving the trust hash unchanged.
// Same loader-level mirror as `readMemoryByName` below; see that
// helper's header for the full threat-model.
export const loadScopeIndex = (roots: ScopeRoots, scope: MemoryScope): ScopeIndexResult =>
  loadIndexAt(indexFilePath(roots, scope));

// Read the seed catalog's index file (`<user>/seeds/MEMORY.md`,
// spec §5.7.4). Same contract as `loadScopeIndex` — the seeds
// subdir is a filesystem affordance under the user scope, not a
// separate MemoryScope, so the result type and security posture
// match exactly.
export const loadSeedsIndex = (roots: ScopeRoots): ScopeIndexResult =>
  loadIndexAt(seedIndexFilePath(roots));

export type MemoryFileResult =
  | { kind: 'present'; file: MemoryFile }
  | { kind: 'missing' }
  | { kind: 'malformed'; error: string };

// Shared body-loading helper: takes a sandboxed absolute path
// (already validated by `memoryFilePath` / `seedMemoryFilePath`)
// and returns the typed result. Centralizes the symlink/regular-
// file gate + parse error wrapping so the per-scope and seeds
// readers can't diverge in security posture.
const readMemoryAt = (path: string): MemoryFileResult => {
  const fileCheck = checkRegularFile(path);
  if (fileCheck.kind === 'not_found') return { kind: 'missing' };
  if (fileCheck.kind === 'symlink') return { kind: 'malformed', error: SYMLINK_REFUSE_MESSAGE };
  if (fileCheck.kind === 'non_regular') {
    return { kind: 'malformed', error: NON_REGULAR_REFUSE_MESSAGE };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return { kind: 'missing' };
    throw err;
  }
  try {
    const file = parseMemoryFile(raw);
    return { kind: 'present', file };
  } catch (err) {
    if (err instanceof FrontmatterError) {
      return { kind: 'malformed', error: err.message };
    }
    throw err;
  }
};

// Read one memory file by `name` in `scope`. The name is resolved
// through `memoryFilePath`, which validates and re-applies the
// sandbox check — callers can pass arbitrary user-supplied names
// without re-validating.
//
// SECURITY (S5 review): refuse symlinks and non-regular files
// BEFORE readFileSync. The shared-corpus trust attestation excludes
// symlinks from the fingerprint at `listSharedCorpusFiles` — but
// without this loader-side mirror, the eager-load and retrieval
// paths would still follow them via `readFileSync(path)` and feed
// target bytes to the model. A malicious repo could ship MEMORY.md
// referencing a symlinked body whose target is an out-of-scope
// file (e.g., `~/.ssh/id_rsa` or any host file readable by the
// agent's UID); the fingerprint would stay unchanged across boots
// because the symlinked body was excluded from it, so no trust
// re-prompt fires, while the model silently sees the target's
// content. Mirroring the rejection at the loader closes the
// asymmetry and makes the substrate's symlink policy uniform.
export const readMemoryByName = (
  roots: ScopeRoots,
  scope: MemoryScope,
  name: string,
): MemoryFileResult => readMemoryAt(memoryFilePath(roots, scope, name));

// Read one seed memory by `name` from `<user>/seeds/` (spec §5.7.4).
// Same security contract as `readMemoryByName`; the name is
// re-validated through `seedMemoryFilePath` before any fs touch.
export const readSeedByName = (roots: ScopeRoots, name: string): MemoryFileResult =>
  readMemoryAt(seedMemoryFilePath(roots, name));

// Shared orphan walker. Lists top-level `.md` files under `dir`
// that aren't already referenced by the supplied index entries.
// Used by both the per-scope walker (`listOrphanFiles`) and the
// seeds walker (`listSeedOrphanFiles`); pulling the loop here
// keeps the filter rules (`.md` suffix, exclude MEMORY.md, exclude
// dot-prefixed, exclude non-regular files) uniform.
//
// We read entries with `withFileTypes: true` so a directory whose
// name happens to end in `.md` (`<scope>/weird.md/` — operator typo
// or attacker plant) doesn't slip past the suffix filter into the
// orphan list as a phantom file path. Downstream `readMemoryAt`
// would still reject the directory at its non_regular gate, but
// having phantom paths in the orphan list confuses gc/audit
// callers that act on the list (rm/move/format) and produces
// misleading audit output. Symlinks are also filtered here for the
// same reason — the S5 gate in `readMemoryAt` is the authoritative
// refusal, but surfacing a symlinked entry as "orphan" would lie
// about its on-disk shape.
const listOrphansAt = (dir: string, indexResult: ScopeIndexResult): string[] => {
  if (!existsSync(dir)) return [];

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const indexed = new Set<string>();
  if (indexResult.kind === 'present') {
    for (const e of indexResult.index.entries) indexed.add(e.href);
  }

  const orphans: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.endsWith('.md')) continue;
    if (name === 'MEMORY.md') continue;
    if (name.startsWith('.')) continue;
    if (indexed.has(name)) continue;
    orphans.push(join(dir, name));
  }
  return orphans;
};

// Files-on-disk minus files-referenced-by-index. Used by the audit /
// gc surfaces (5.6) to spot orphans the operator left behind. The
// scope root may not exist (returns empty array, not an error).
//
// Notes:
//   - Only top-level `.md` files are considered. Sub-directories are
//     ignored — the spec layout is flat, and a memory file in a
//     subdir is either operator confusion or an attack. The one
//     exception is the user scope's `seeds/` subdir (spec §5.7.4);
//     `listSeedOrphanFiles` is the dedicated walker for that.
//   - `MEMORY.md` itself is excluded (it's the index, not a memory).
//   - Hidden files (`.dotfiles`) are excluded too — the spec name
//     validator forbids leading dots, so any `.foo.md` is not a
//     valid memory regardless.
export const listOrphanFiles = (roots: ScopeRoots, scope: MemoryScope): string[] =>
  listOrphansAt(rootForScope(roots, scope), loadScopeIndex(roots, scope));

// Same shape as `listOrphanFiles` but scoped to the seeds subdir
// under user scope (spec §5.7.4). The two walkers can't be unified
// behind a single MemoryScope value because seeds participate in
// the user-scope lifecycle (eager-load, audit, scope-of-path) —
// they're a sub-location, not a scope. Slice 3+ uses this walker
// to detect vendor-catalog files the operator deleted manually.
export const listSeedOrphanFiles = (roots: ScopeRoots): string[] =>
  listOrphansAt(seedsRoot(roots), loadSeedsIndex(roots));

// Convenience: derive the in-scope memory `name` from an absolute
// path produced by `memoryFilePath` (or `listOrphanFiles`). Exposed
// so the registry can build entries from orphan files without
// re-implementing the inverse mapping.
export const memoryNameFromPath = (path: string): string => {
  const file = basename(path);
  if (!file.endsWith('.md')) {
    throw new Error(`expected .md file, got ${path}`);
  }
  return file.slice(0, -'.md'.length);
};
