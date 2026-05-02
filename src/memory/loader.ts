import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { FrontmatterError, parseMemoryFile } from './frontmatter.ts';
import { type ParsedIndex, parseIndex } from './index-file.ts';
import { indexFilePath, memoryFilePath, rootForScope } from './paths.ts';
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

// Read MEMORY.md for one scope. Returns 'absent' when either the
// scope root directory or the file itself does not exist — both
// states indicate "no memories declared via index here", which is
// indistinguishable from the operator's perspective. Other fs errors
// (EACCES, EIO) propagate; they're real problems, not scope state.
export const loadScopeIndex = (roots: ScopeRoots, scope: MemoryScope): ScopeIndexResult => {
  const path = indexFilePath(roots, scope);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
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

export type MemoryFileResult =
  | { kind: 'present'; file: MemoryFile }
  | { kind: 'missing' }
  | { kind: 'malformed'; error: string };

// Read one memory file by `name` in `scope`. The name is resolved
// through `memoryFilePath`, which validates and re-applies the
// sandbox check — callers can pass arbitrary user-supplied names
// without re-validating.
export const readMemoryByName = (
  roots: ScopeRoots,
  scope: MemoryScope,
  name: string,
): MemoryFileResult => {
  // memoryFilePath throws for invalid names; callers that pass
  // model-supplied names should already validate, but if they don't
  // we propagate the FrontmatterError / ScopeError unchanged so the
  // tool surface (5.2.b) can map it to a clean tool error.
  const path = memoryFilePath(roots, scope, name);
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

// Files-on-disk minus files-referenced-by-index. Used by the audit /
// gc surfaces (5.6) to spot orphans the operator left behind. The
// scope root may not exist (returns empty array, not an error).
//
// Notes:
//   - Only top-level `.md` files are considered. Sub-directories are
//     ignored — the spec layout is flat, and a memory file in a
//     subdir is either operator confusion or an attack.
//   - `MEMORY.md` itself is excluded (it's the index, not a memory).
//   - Hidden files (`.dotfiles`) are excluded too — the spec name
//     validator forbids leading dots, so any `.foo.md` is not a
//     valid memory regardless.
export const listOrphanFiles = (roots: ScopeRoots, scope: MemoryScope): string[] => {
  const scopeRoot = rootForScope(roots, scope);
  if (!existsSync(scopeRoot)) return [];

  let entries: string[];
  try {
    entries = readdirSync(scopeRoot);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const indexed = new Set<string>();
  const indexResult = loadScopeIndex(roots, scope);
  if (indexResult.kind === 'present') {
    for (const e of indexResult.index.entries) indexed.add(e.href);
  }

  const orphans: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    if (name === 'MEMORY.md') continue;
    if (name.startsWith('.')) continue;
    if (indexed.has(name)) continue;
    orphans.push(join(scopeRoot, name));
  }
  return orphans;
};

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
