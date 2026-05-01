// Second-pass resolution after the scan inserts file/symbol/
// import rows. CODE_INDEX.md §3.1 step 4: with all the row data
// in place, link `imports.target_path` to a concrete project
// file (when local) and `references_.target_symbol_id` to a
// symbol id (when the name resolves uniquely). Reference
// resolution lands in slice 4.3.3.b; this module ships
// `resolveImports` for slice 4.3.3.a.
//
// Idempotent: every call filters on `target_path IS NULL`
// (or `target_symbol_id IS NULL` later) so re-running over an
// already-resolved DB is a no-op. Pipeline calls this after
// every scan.
//
// Known limitations (deferred to a polish slice):
//   - tsconfig `paths` / module aliases (`@/lib/foo`) NOT
//     supported. The extractor classifies bare specifiers as
//     external; aliased imports never reach the resolver.
//     Real-world TS projects with path aliases will see gaps
//     in `dependents_of` results.
//   - Absolute `/foo` imports: extractor classifies as local
//     (is_external=false), but the resolver's join logic
//     strips the leading slash and treats them as relative —
//     net effect: `/foo` rarely matches an indexed row, so
//     target_path stays null. Pinned by the corresponding
//     test in resolver.test.ts. A future fix should either
//     mark `/`-prefix as external in extract.ts or anchor the
//     resolver at projectRoot for it.

import type { DB } from '../storage/db.ts';

// Ordered candidate extensions for module → file resolution.
// Order matters: `.ts` wins over `.js` when both exist for the
// same path. Mirrors the de-facto bundler / tsc resolution
// order. Keep aligned with `language.ts`'s detectLanguage —
// any extension we index here MUST be a recognized language
// upstream (no point resolving to a file that walker drops).
const RESOLUTION_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];

// In-memory file-path lookup. The resolver tries up to 16
// candidates per import (8 extensions × {direct, index}); on a
// 3k-file repo with ~5 imports/file, naive `WHERE path = ?`
// per candidate is ~240k SQLite round-trips and ~2 seconds of
// write-lock hold. Loading every file path into a Set once and
// checking in-memory is ~10× faster (memory cost ~50 B/path,
// trivial). Returns the candidate string itself when present —
// `files.path` is canonical and the candidate IS that path
// when it matches.
const tryResolveCandidate = (allPaths: Set<string>, candidate: string): string | null =>
  allPaths.has(candidate) ? candidate : null;

// POSIX-style path joining + ".." normalization for module
// resolution. The walker emits paths with forward slashes
// regardless of host OS; we keep that contract. Doesn't use
// node:path/posix.resolve directly because that requires an
// absolute base — our inputs are project-relative.
const joinAndNormalize = (sourceDir: string, target: string): string | null => {
  const parts = (sourceDir === '.' || sourceDir === '' ? [] : sourceDir.split('/')).concat(
    target.split('/'),
  );
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      // Escape from the project root → reject. The pipeline's
      // walker already filtered out-of-tree paths from `files`,
      // so a `..` escape can never resolve to an indexed row
      // anyway, but failing fast keeps the candidate list
      // small and avoids the negative-lookup round trip.
      if (normalized.length === 0) return null;
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return normalized.join('/');
};

// Try every supported extension + the index-style fallback
// `<module>/index.<ext>`. The index-style entry mirrors how
// Node, bundlers, and TypeScript resolve a directory import to
// `index.ts` / `index.js`. Returns the first hit found in
// `allPaths`, in the order `RESOLUTION_EXTENSIONS` declares.
const resolveModuleToPath = (
  allPaths: Set<string>,
  sourceFile: string,
  targetModule: string,
): string | null => {
  // Source file's directory. `'src/auth.ts'` → `'src'`;
  // `'index.ts'` (root) → `''`.
  const slashIdx = sourceFile.lastIndexOf('/');
  const sourceDir = slashIdx >= 0 ? sourceFile.slice(0, slashIdx) : '';

  const baseStr = joinAndNormalize(sourceDir, targetModule);
  if (baseStr === null) return null;

  // Direct hits: `<base><ext>`.
  for (const ext of RESOLUTION_EXTENSIONS) {
    const candidate = baseStr + ext;
    const hit = tryResolveCandidate(allPaths, candidate);
    if (hit !== null) return hit;
  }
  // Index-style: `<base>/index<ext>`. Skip when base is empty
  // (would resolve to `/index.ts` — never matches a relative
  // file_path).
  if (baseStr.length > 0) {
    for (const ext of RESOLUTION_EXTENSIONS) {
      const candidate = `${baseStr}/index${ext}`;
      const hit = tryResolveCandidate(allPaths, candidate);
      if (hit !== null) return hit;
    }
  }
  return null;
};

export interface ResolveImportsResult {
  // Imports inspected this run (target_path was NULL).
  candidates: number;
  // Of those, how many resolved to a concrete file_path.
  resolved: number;
}

// Walk every import row whose target_path is still NULL and
// has a relative target_module (./ or ../ prefixed; absolute
// paths and bare specifiers are external by definition and
// stay NULL). Try the resolution candidates and update
// `target_path` when one matches. The caller is expected to
// wrap in a transaction; this function does not open one
// itself so it can compose with the pipeline's existing
// transactional write batching.
export const resolveImports = (db: DB): ResolveImportsResult => {
  const rows = db
    .query<{ id: number; source_file: string; target_module: string }, []>(
      `SELECT id, source_file, target_module
         FROM imports
        WHERE target_path IS NULL
          AND is_external = 0
          AND target_module IS NOT NULL`,
    )
    .all();
  if (rows.length === 0) return { candidates: 0, resolved: 0 };

  // Snapshot of every indexed file path. Resolving 15k imports
  // × 16 candidates against the DB would cost ~240k SQLite
  // round-trips; the in-memory Set turns that into pure JS
  // hash lookups. The Set is local to this call — re-built
  // every resolver pass so it always reflects the current scan.
  const allPaths = new Set<string>(
    db
      .query<{ path: string }, []>('SELECT path FROM files')
      .all()
      .map((r) => r.path),
  );

  const update = db.query<unknown, [string, number]>(
    'UPDATE imports SET target_path = ? WHERE id = ?',
  );
  let resolved = 0;
  for (const row of rows) {
    if (
      !row.target_module.startsWith('./') &&
      !row.target_module.startsWith('../') &&
      !row.target_module.startsWith('/')
    ) {
      // Defensive: extractor flags these as external, but a
      // future encoding change could leak a bare specifier
      // into the local set. Skip.
      continue;
    }
    const path = resolveModuleToPath(allPaths, row.source_file, row.target_module);
    if (path !== null) {
      update.run(path, row.id);
      resolved++;
    }
  }
  return { candidates: rows.length, resolved };
};
