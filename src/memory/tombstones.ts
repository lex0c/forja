// Tombstone storage for evicted memory entries (MEMORY.md §6.5).
//
// Eviction moves the body file from its scope root into a
// `.tombstones/` subdirectory under the same scope, renamed
// `<name>.<unix_ms>.md`. Restore (1.3.d) reads the latest tombstone
// matching `<name>.*.md` and copies content back into the scope
// root. Retention GC sweep (deferred to a future slice) lists
// tombstones older than the per-scope window and unlinks them.
//
// This module owns the I/O — paths.ts owns the path computation,
// frontmatter.ts owns the file shape. Helpers here are sync because
// the rest of the memory subsystem is sync (writer.ts, lifecycle.ts);
// tombstone churn is low (one rename per eviction, one readdir per
// restore/GC) so making them async would add complexity without
// payoff.

import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type ScopeRoots,
  memoryFilePath,
  parseTombstoneFilename,
  tombstonePath,
  tombstonesDir,
} from './paths.ts';
import type { MemoryScope } from './types.ts';

export interface TombstoneEntry {
  // Memory name (frontmatter `name`, not the filename).
  name: string;
  // Unix ms timestamp embedded in the tombstone filename.
  ts: number;
  // Absolute path to the tombstone file.
  path: string;
}

export interface MoveToTombstoneOptions {
  // Override Date.now() for tests. Production calls omit.
  now?: () => number;
}

export interface MoveToTombstoneResult {
  // Where the body landed.
  tombstonePath: string;
  // Timestamp written into the filename. Callers persist this
  // alongside the eviction_events row so restore can find the
  // exact tombstone later.
  ts: number;
}

// Move a memory body file into `.tombstones/` atomically (rename
// is atomic on POSIX; on Windows rename across directories may
// fall back to copy+delete, but within the same scope root that
// degraded case is rare enough to accept).
//
// Caller is responsible for:
//   - clearing the index entry (loader/registry layer)
//   - emitting the memory_events `evicted` row + eviction_events
//     row (the transition contract from 1.2.a)
//   - validating that the source file actually exists (this
//     function throws ENOENT through if it doesn't, surfacing
//     the bug rather than silently no-op'ing)
//
// Filename collision handling: tombstones are
// `<name>.<unix_ms>.md`. Two evictions of the same name within
// the same ms (rare, but possible after a fast restore-then-
// evict cycle) would collide on the destination filename, and
// POSIX renameSync silently overwrites the destination — the
// older tombstone would be lost. To prevent silent overwrite,
// we bump `ts` by 1ms until we find a free filename. Bounded
// because the loop walks integer ms forward — in practice it
// terminates in 0-2 iterations.
//
// `now()` is injectable for deterministic test fixtures.
export const moveToTombstone = (
  roots: ScopeRoots,
  scope: MemoryScope,
  name: string,
  options: MoveToTombstoneOptions = {},
): MoveToTombstoneResult => {
  const now = options.now ?? Date.now;
  let ts = now();
  const source = memoryFilePath(roots, scope, name);
  let dest = tombstonePath(roots, scope, name, ts);
  while (existsSync(dest)) {
    ts += 1;
    dest = tombstonePath(roots, scope, name, ts);
  }
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(source, dest);
  return { tombstonePath: dest, ts };
};

// List every tombstone in a scope. Returns entries sorted by ts
// descending (most-recent first) — restore + UI both want
// newest-first by default. Missing `.tombstones/` directory
// returns []; junk filenames (not matching `<name>.<ts>.md`)
// are skipped silently — operator dropping a README in
// `.tombstones/` shouldn't trip the listing.
export const listTombstones = (roots: ScopeRoots, scope: MemoryScope): TombstoneEntry[] => {
  const dir = tombstonesDir(roots, scope);
  if (!existsSync(dir)) return [];
  const entries: TombstoneEntry[] = [];
  for (const filename of readdirSync(dir)) {
    const parsed = parseTombstoneFilename(filename);
    if (parsed === null) continue;
    entries.push({
      name: parsed.name,
      ts: parsed.ts,
      path: tombstonePath(roots, scope, parsed.name, parsed.ts),
    });
  }
  entries.sort((a, b) => b.ts - a.ts);
  return entries;
};

// Most-recent tombstone for a given name, or null when no
// tombstone exists. Restore (1.3.d) reads this to know what to
// copy back.
//
// Single readdir scan, filter inline — bounded by the
// `.tombstones/` directory size which in practice is dozens of
// entries even in a long-lived project (per-scope retention
// caps it at 30d worth of evictions). No index needed.
export const findLatestTombstone = (
  roots: ScopeRoots,
  scope: MemoryScope,
  name: string,
): TombstoneEntry | null => {
  const dir = tombstonesDir(roots, scope);
  if (!existsSync(dir)) return null;
  let best: TombstoneEntry | null = null;
  for (const filename of readdirSync(dir)) {
    const parsed = parseTombstoneFilename(filename);
    if (parsed === null) continue;
    if (parsed.name !== name) continue;
    if (best === null || parsed.ts > best.ts) {
      best = {
        name: parsed.name,
        ts: parsed.ts,
        path: tombstonePath(roots, scope, parsed.name, parsed.ts),
      };
    }
  }
  return best;
};

// Tombstones whose age (`now - ts`) exceeds `retentionMs`. Input
// to the future GC sweep that materializes the `evicted → purged`
// transition once the retention window expires (EVICTION §7.1).
// `now` is parameterized for test determinism; production caller
// passes `Date.now()`.
//
// The retentionMs threshold is per-scope per MEMORY §6.5.4. This
// function is scope-agnostic — caller picks the right ms value
// for the scope being swept and calls separately per scope.
export const listExpiredTombstones = (
  roots: ScopeRoots,
  scope: MemoryScope,
  nowMs: number,
  retentionMs: number,
): TombstoneEntry[] => listTombstones(roots, scope).filter((e) => nowMs - e.ts > retentionMs);

// Remove a tombstone file. Returns true on success, false when
// the file didn't exist (idempotent for the GC sweep which may
// re-run after a partial failure). Other I/O errors (ENOTDIR,
// permission denied) throw — they indicate a problem the caller
// must surface.
export const removeFromTombstones = (
  roots: ScopeRoots,
  scope: MemoryScope,
  name: string,
  ts: number,
): boolean => {
  const path = tombstonePath(roots, scope, name, ts);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
};
