// Second-pass resolution after the scan inserts file/symbol/
// import rows. CODE_INDEX.md §3.1 step 4: with all the row data
// in place, link `imports.target_path` to a concrete project
// file (when local — `resolveImports`) AND
// `references_.target_symbol_id` to a symbol id (when the name
// resolves uniquely — `resolveReferences`). Both ship together
// after slice 4.3.3.b; the pipeline runs them in the same
// transaction at the end of every scan.
//
// Idempotent: every call filters on `target_path IS NULL`
// (resolveImports) or `target_symbol_id IS NULL`
// (resolveReferences) so re-running over an already-resolved DB
// is a no-op.
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
//   - References extracted are CALL SITES ONLY. Type
//     references (`function f(): User`), class heritage
//     (`class A extends Base`, `class A implements Iface`),
//     and decorator usage are NOT captured yet — slice
//     4.3.3.c will extend the query set. `find_references`
//     for a type-only or heritage-only symbol returns empty
//     in the meantime even though the symbol is reachable.

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
export interface ResolveReferencesResult {
  // References inspected this run (target_symbol_id was NULL).
  candidates: number;
  // Of those, how many resolved to a unique global symbol.
  resolved: number;
}

// Bind `references_.target_symbol_id` to the corresponding
// `symbols.id` whenever the reference's target_symbol_name
// resolves to EXACTLY ONE symbol globally. Names that match
// zero or multiple symbols stay NULL (caller treats them as
// external or ambiguous).
//
// Strategy: build a name → id map up front for names with a
// single occurrence. SQL bulk UPDATE matched on the map. We
// stage the map in a TEMPORARY table so the UPDATE is one
// statement instead of N round-trips. Idempotent — only rows
// with NULL target_symbol_id are inspected.
//
// Same-name overload groups (function foo with multiple
// declarations + impl) collapse to a single FQN; we group by
// FQN+name. If a name has multiple candidates with the same
// FQN, pick the one with the largest line span (the impl). If
// multiple FQNs exist for one name, leave it ambiguous —
// caller can disambiguate via find_references_by_name.
export const resolveReferences = (db: DB): ResolveReferencesResult => {
  const candidatesRow = db
    .query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM references_ WHERE target_symbol_id IS NULL',
    )
    .get();
  const candidates = candidatesRow?.n ?? 0;
  if (candidates === 0) return { candidates: 0, resolved: 0 };

  // Stage a name → id map of every name with exactly one
  // candidate symbol after collapsing overload groups. The
  // ROW_NUMBER + group-by-FQN dance keeps this single-pass
  // SQL: pick the max-span row per (name, fqn), then count
  // distinct FQNs per name; only names with exactly one FQN
  // qualify. Dropped via finally so a throw mid-pass doesn't
  // leak the temp table on this connection.
  db.exec('DROP TABLE IF EXISTS _resolvable_names');
  db.exec('CREATE TEMPORARY TABLE _resolvable_names (name TEXT PRIMARY KEY, id INTEGER NOT NULL)');
  try {
    // Two-step composition (SQLite doesn't support DISTINCT
    // inside window functions, ruling out a single CTE):
    //   1. Per-(name,fqn) impl pick via ROW_NUMBER —
    //      `rn_in_group=1` is the largest-span symbol for that
    //      overload group.
    //   2. Filter by names that have exactly one distinct FQN
    //      across the table — names whose FQN is shared across
    //      multiple parent classes (`A.start` vs `B.start`)
    //      stay ambiguous.
    db.exec(`
      INSERT INTO _resolvable_names (name, id)
      SELECT per_group.name, per_group.id
        FROM (
          SELECT name, fqn, id,
                 ROW_NUMBER() OVER (
                   PARTITION BY name, fqn
                   ORDER BY (end_line - start_line) DESC, id ASC
                 ) AS rn
            FROM symbols
            WHERE fqn IS NOT NULL
        ) per_group
       WHERE per_group.rn = 1
         AND per_group.name IN (
           SELECT name FROM symbols
            WHERE fqn IS NOT NULL
            GROUP BY name
            HAVING COUNT(DISTINCT fqn) = 1
         );
    `);

    const updateResult = db
      .query<{ changes?: number }, []>(`UPDATE references_
           SET target_symbol_id = (
             SELECT id FROM _resolvable_names WHERE name = references_.target_symbol_name
           )
           WHERE target_symbol_id IS NULL
             AND target_symbol_name IN (SELECT name FROM _resolvable_names)`)
      .run();

    // bun:sqlite's run() returns { changes, lastInsertRowid }.
    // Cast through unknown — TS bindings declare run() loosely.
    const resolved =
      typeof (updateResult as { changes?: unknown }).changes === 'number'
        ? (updateResult as { changes: number }).changes
        : 0;
    return { candidates, resolved };
  } finally {
    try {
      db.exec('DROP TABLE IF EXISTS _resolvable_names');
    } catch {
      // Best-effort.
    }
  }
};

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
