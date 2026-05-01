// Incremental scan path (CODE_INDEX.md §3.2). Updates the
// index in place for a specific set of files instead of
// walking the entire project. Used by the harness's
// PostToolUse hook (slice 4.3.6.b) so write_file / edit_file
// don't leave the index stale for the rest of the session,
// and by `agent --code-index scan --since` (future slice).
//
// For each input path:
//   1. Normalize to a project-relative POSIX path. Out-of-tree
//      paths are silently dropped (caller's responsibility to
//      filter; we don't crash).
//   2. lstat + the same extension/size/symlink filters the
//      full walker uses. A file that's been deleted, become a
//      symlink, exceeded the size cap, or moved out of a
//      supported language has its existing index row pruned
//      (CASCADE drops symbols/imports/references).
//   3. Read + hash. If `content_hash` matches the stored row,
//      touch `indexed_at` and skip the parse (CODE_INDEX.md
//      §3.2's hot-path optimization — the dominant case after
//      a no-op edit or a save with whitespace-only changes).
//   4. Otherwise: delete file row + re-extract + insert.
//   5. After all files: run the resolver passes so any
//      newly-orphaned references rebind and any new imports
//      get target_path resolved against the current files
//      table.
//
// Invariants preserved from the full-scan path:
//   - Idempotent: running with the same inputs against an
//     up-to-date index is a no-op (steps 3-5 each filter on
//     "needs work").
//   - Per-file try/catch isolates a malformed row from
//     tanking the rest of the batch.
//   - resolveImports / resolveReferences only update rows
//     with NULL targets, so re-running them across the whole
//     index after an incremental pass is cheap.

import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import type { DB } from '../../storage/db.ts';
import { withTransaction } from '../../storage/db.ts';
import { CODE_INDEX_DEFAULT_EXCLUDES, CODE_INDEX_MAX_FILE_SIZE_BYTES } from '../privacy.ts';
import {
  deleteFile as deleteFileRow,
  getFile,
  insertImports,
  insertReferences,
  insertSymbols,
  upsertFile,
} from '../repo.ts';
import { resolveImports, resolveReferences } from '../resolver.ts';
import type { FileMeta, FileParseStatus, Import, IndexSymbol, Reference } from '../types.ts';
import { withScanLock } from './_lock.ts';
import { CURRENT_SCHEMA_VERSION, countLines, sha256Hex } from './_util.ts';
import { extractFromSource } from './extract.ts';
import { type SupportedLanguage, detectLanguage } from './language.ts';
import { parseSource } from './parser.ts';

// Compiled once at module load — privacy excludes are fixed at
// build time and PostToolUse will fire scanFiles on every edit,
// so per-call recompilation would be measurable in busy
// sessions.
const EXCLUDE_GLOBS = CODE_INDEX_DEFAULT_EXCLUDES.map((p) => new Bun.Glob(p));

export interface ScanFilesOptions {
  // Absolute paths (canonical) — caller resolves projectRoot
  // upstream. Test harness can construct via `join(projectRoot,
  // relPath)`. Out-of-tree paths are dropped silently.
  projectRoot: string;
  paths: string[];
}

export interface ScanFilesResult {
  // File rows re-indexed this run — i.e., the row was upserted
  // because content changed (or because no row existed). A
  // parse failure ALSO counts here: the file row is upserted
  // with parse_status='failed' (and the same path appears in
  // `errors`). Mirrors `filesScanned` from the full-scan
  // ScanResult — "we processed it" rather than "it succeeded".
  // Pruned files are NOT in this counter; they're in `removed`.
  updated: number;
  // Files whose content_hash matched stored — only indexed_at
  // got bumped, parse skipped.
  unchanged: number;
  // Files that were in the index but no longer pass the
  // walker's filters (deleted, became symlink, oversized, …)
  // and got their row dropped.
  removed: number;
  // Per-file errors (read failure, parse exception). Same
  // shape as the full-scan ScanResult — best-effort: one bad
  // file doesn't abort the rest. Parse failures also bump
  // `updated` (see comment above) — a failed file appears in
  // both counters, matching pipeline.ts's filesScanned + errors
  // duality.
  errors: { path: string; error: string }[];
}

interface FileWork {
  relPath: string;
  absPath: string;
  // null = file gone / excluded / wrong type → drop the row
  meta: { sizeBytes: number; mtimeMs: number; language: SupportedLanguage } | null;
}

const normalize = (projectRoot: string, p: string): string | null => {
  const abs = isAbsolute(p) ? p : resolvePath(projectRoot, p);
  const rel = relative(projectRoot, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null; // out-of-tree
  return rel.replaceAll('\\', '/');
};

const probeFile = async (projectRoot: string, relPath: string): Promise<FileWork> => {
  const absPath = resolvePath(projectRoot, relPath);
  const work: FileWork = { relPath, absPath, meta: null };
  // Exclude check first — cheap, avoids a stat call for paths
  // we'd drop anyway.
  for (const g of EXCLUDE_GLOBS) {
    if (g.match(relPath)) return work;
  }
  const language = detectLanguage(relPath);
  if (language === null) return work;
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(absPath);
  } catch {
    return work; // file gone
  }
  if (stat.isSymbolicLink()) return work;
  if (!stat.isFile()) return work;
  if (stat.size > CODE_INDEX_MAX_FILE_SIZE_BYTES) return work;
  work.meta = {
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    language,
  };
  return work;
};

export const scanFiles = (db: DB, opts: ScanFilesOptions): Promise<ScanFilesResult> =>
  withScanLock(db, () => doScanFiles(db, opts));

const doScanFiles = async (db: DB, opts: ScanFilesOptions): Promise<ScanFilesResult> => {
  const result: ScanFilesResult = { updated: 0, unchanged: 0, removed: 0, errors: [] };
  if (opts.paths.length === 0) return result;

  // De-duplicate + normalize. The PostToolUse hook can fire
  // back-to-back for write+edit on the same file; double-work
  // would be wasteful and the resolver only runs once anyway.
  const relPaths = new Set<string>();
  for (const p of opts.paths) {
    const rel = normalize(opts.projectRoot, p);
    if (rel !== null && rel.length > 0) relPaths.add(rel);
  }
  if (relPaths.size === 0) return result;

  const indexedAt = Date.now();

  // Probe + read in parallel — same pattern the full-scan
  // pipeline uses. Avoids holding the SQLite write lock
  // across tree-sitter parses.
  const works: FileWork[] = await Promise.all(
    [...relPaths].map((rel) => probeFile(opts.projectRoot, rel)),
  );

  // Read + hash + extract for files that pass filters.
  // Outcomes computed outside the transaction.
  type Outcome =
    | { kind: 'drop'; relPath: string }
    | { kind: 'unchanged'; relPath: string }
    | {
        kind: 'reindex';
        relPath: string;
        file: FileMeta;
        symbols: Omit<IndexSymbol, 'id'>[];
        imports: Omit<Import, 'id'>[];
        references: Omit<Reference, 'id' | 'targetSymbolId'>[];
      }
    | { kind: 'error'; relPath: string; error: string };

  const outcomes: Outcome[] = await Promise.all(
    works.map(async (w): Promise<Outcome> => {
      if (w.meta === null) {
        // No row to add. If a row exists in the index, the
        // transaction phase below drops it; otherwise no-op.
        return { kind: 'drop', relPath: w.relPath };
      }
      try {
        const source = await readFile(w.absPath, 'utf8');
        const contentHash = sha256Hex(source);
        const stored = getFile(db, w.relPath);
        if (stored !== null && stored.contentHash === contentHash) {
          return { kind: 'unchanged', relPath: w.relPath };
        }
        const meta = w.meta;
        let parseStatus: FileParseStatus = 'ok';
        let parseError: string | null = null;
        let symbols: Omit<IndexSymbol, 'id'>[] = [];
        let imports: Omit<Import, 'sourceFile' | 'targetPath' | 'id'>[] = [];
        let extractedRefs: Omit<Reference, 'id' | 'sourceFile' | 'targetSymbolId'>[] = [];
        let partial = false;
        try {
          const extracted = extractFromSource(source, meta.language, w.relPath, parseSource);
          symbols = extracted.symbols;
          imports = extracted.imports;
          extractedRefs = extracted.references;
          partial = extracted.partial;
          if (partial) parseStatus = 'partial';
        } catch (e) {
          parseStatus = 'failed';
          parseError = e instanceof Error ? e.message : String(e);
        }
        const completedImports: Omit<Import, 'id'>[] = imports.map((imp) => ({
          sourceFile: w.relPath,
          targetPath: null,
          targetModule: imp.targetModule,
          importedNames: imp.importedNames,
          isExternal: imp.isExternal,
        }));
        const completedReferences: Omit<Reference, 'id' | 'targetSymbolId'>[] = extractedRefs.map(
          (r) => ({
            sourceFile: w.relPath,
            sourceLine: r.sourceLine,
            sourceCol: r.sourceCol,
            targetSymbolName: r.targetSymbolName,
            refKind: r.refKind,
          }),
        );
        return {
          kind: 'reindex',
          relPath: w.relPath,
          file: {
            path: w.relPath,
            language: meta.language,
            contentHash,
            sizeBytes: meta.sizeBytes,
            loc: countLines(source),
            lastModifiedAt: meta.mtimeMs,
            indexedAt,
            parseStatus,
            parseError,
            indexSchemaVersion: CURRENT_SCHEMA_VERSION,
          },
          symbols,
          imports: completedImports,
          references: completedReferences,
        };
      } catch (e) {
        return {
          kind: 'error',
          relPath: w.relPath,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );

  withTransaction(db, () => {
    const touchIndexed = db.query<unknown, [number, string]>(
      'UPDATE files SET indexed_at = ? WHERE path = ?',
    );
    for (const o of outcomes) {
      if (o.kind === 'error') {
        result.errors.push({ path: o.relPath, error: o.error });
        continue;
      }
      if (o.kind === 'drop') {
        const had = getFile(db, o.relPath);
        if (had !== null) {
          deleteFileRow(db, o.relPath);
          result.removed++;
        }
        continue;
      }
      if (o.kind === 'unchanged') {
        touchIndexed.run(indexedAt, o.relPath);
        result.unchanged++;
        continue;
      }
      // reindex
      try {
        deleteFileRow(db, o.relPath);
        upsertFile(db, o.file);
        if (o.file.parseStatus !== 'failed') {
          insertSymbols(db, o.symbols);
          insertImports(db, o.imports);
          insertReferences(db, o.references);
        } else {
          result.errors.push({
            path: o.relPath,
            error: o.file.parseError ?? 'parse failed',
          });
        }
        result.updated++;
      } catch (e) {
        result.errors.push({
          path: o.relPath,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  });

  // Resolver pass — only runs over rows with NULL targets, so
  // it's cheap when nothing changed and bounded to the new/
  // re-indexed rows when something did. Skip when nothing was
  // touched (no inserts → no NULL targets to bind).
  if (result.updated > 0 || result.removed > 0) {
    withTransaction(db, () => {
      resolveImports(db);
      resolveReferences(db);
    });
  }

  return result;
};
