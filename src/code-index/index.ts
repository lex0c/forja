// Public surface of the code-index subsystem
// (CODE_INDEX.md §4.1). The Query API is exposed as a class so
// the harness can construct it once per session and pass it
// through to tools that need symbolic lookups (read_symbol,
// find_references — slice 4.3.2+).
//
// This slice (4.3.0) ships ONLY the foundation: schema, types,
// repos, and the Query API surface. Every method delegates to
// SQL through the repo helpers; with no parser yet, the queries
// return empty results — but the API is real and the contract
// stable. The scanner slice (4.3.1) drops parser output into
// the same tables and the same queries start returning data.
//
// Failure-mode contract (CODE_INDEX.md §4.3): when the index DB
// can't be opened or migrations fail, the class surfaces an
// `init()` error. Callers MUST treat that as `index_unavailable`
// and either skip the optimization (repo_map fallback) or
// refuse to operate (tools that strictly require the index).
//
// `CodeIndex` is closeable; harness owns the lifetime. We don't
// auto-close on process exit because long-lived sessions
// (resume, daemon mode) may reopen via the same file.

import { CODE_INDEX_MIGRATIONS } from '../storage/code-index-migrations/index.ts';
import { type DB, openDb } from '../storage/db.ts';
import { migrate } from '../storage/migrate.ts';
import { defaultCodeIndexPath } from './paths.ts';
import {
  countFiles,
  findReferencesByName,
  findReferencesBySymbolId,
  getFile,
  getMeta,
  getSymbolById,
  getSymbolsByFqn,
  getSymbolsByName,
  listDependentsOf,
  listFiles as listFilesRepo,
  listImportsBySource,
  listSourcesForTest,
  listSymbolsInFile,
  listTestsForSource,
} from './repo.ts';
import { type ScanFilesResult, scanFiles } from './scanner/incremental.ts';
import { type ScanOptions, type ScanResult, scanProject } from './scanner/pipeline.ts';
import type {
  FileMeta,
  GetSymbolOptions,
  Import,
  IndexStatus,
  IndexSymbol,
  ListFilesOptions,
  Reference,
  TestMapping,
} from './types.ts';

export interface CodeIndexOptions {
  // Project root used for the DB path hash. MUST be canonical
  // (caller resolves via `git rev-parse --show-toplevel` or
  // equivalent). Tests pass an explicit value; production wraps
  // the resolution upstream.
  projectRoot: string;
  // Override for the on-disk DB path. Tests use this with
  // tmpdirs; production omits and the resolver computes a
  // deterministic path from `projectRoot`.
  dbPath?: string;
  // Test seam: an already-open DB. Bypasses the file-based path
  // resolver entirely. Useful for in-memory unit tests.
  dbOverride?: DB;
  // Override env vars (XDG_DATA_HOME, HOME) for path resolution.
  env?: NodeJS.ProcessEnv;
}

export class CodeIndex {
  private readonly db: DB;
  private readonly ownsDb: boolean;
  readonly projectRoot: string;
  readonly dbPath: string | null;

  private constructor(opts: CodeIndexOptions, db: DB, ownsDb: boolean, dbPath: string | null) {
    this.projectRoot = opts.projectRoot;
    this.db = db;
    this.ownsDb = ownsDb;
    this.dbPath = dbPath;
  }

  // Construct + initialize. Opens (or accepts) the DB, runs
  // migrations idempotently, returns a ready instance. Throws
  // when the DB can't be opened or migrations fail; caller
  // should treat any throw as `index_unavailable` per
  // CODE_INDEX.md §4.3.
  static async init(opts: CodeIndexOptions): Promise<CodeIndex> {
    let db: DB;
    let ownsDb: boolean;
    let dbPath: string | null;
    if (opts.dbOverride !== undefined) {
      db = opts.dbOverride;
      ownsDb = false;
      dbPath = null;
    } else {
      dbPath = opts.dbPath ?? defaultCodeIndexPath(opts.projectRoot, opts.env);
      db = openDb(dbPath);
      ownsDb = true;
    }
    // Migrate inside try/finally so a failure (schema mismatch
    // hash regression, disk full mid-DDL, etc.) doesn't leak the
    // file descriptor we just opened. Bun's Database doesn't
    // close on GC reliably; without explicit close, repeated
    // failed inits in tests / daemon mode pile up FDs and
    // eventually trip ulimit. We only close the DB when WE own
    // it — caller-supplied dbOverride is the caller's
    // responsibility regardless of init outcome.
    try {
      migrate(db, CODE_INDEX_MIGRATIONS);
    } catch (e) {
      if (ownsDb) {
        try {
          db.close();
        } catch {
          // ignore — close-after-migrate-throw is best-effort
        }
      }
      throw e;
    }
    return new CodeIndex(opts, db, ownsDb, dbPath);
  }

  // Resource cleanup. Idempotent: closing an already-closed DB
  // is harmless. Skips when the caller passed `dbOverride` —
  // they own the lifetime.
  close(): void {
    if (!this.ownsDb) return;
    try {
      this.db.close();
    } catch {
      // ignore — DB may already be closed (resume races, etc.)
    }
  }

  // ---------- IndexSymbol queries ----------

  // Look up symbols by name. When `opts.file` is omitted and the
  // name resolves to multiple files, the caller (tool wrapper) is
  // expected to surface `index.symbol.ambiguous` per
  // CODE_INDEX.md §5.1. The Query API itself just returns the
  // unfiltered list; disambiguation belongs to the tool layer.
  getSymbol(name: string, opts: GetSymbolOptions = {}): IndexSymbol[] {
    return getSymbolsByName(this.db, name, opts);
  }

  getSymbolById(id: number): IndexSymbol | null {
    return getSymbolById(this.db, id);
  }

  // Look up by fully-qualified name (the `<file>:Class.method`
  // shape produced by the extractor). Returns multiple rows for
  // overload groups (same FQN, different signatures); the tool
  // surface dedupes those to the implementation.
  getSymbolByFqn(fqn: string): IndexSymbol[] {
    return getSymbolsByFqn(this.db, fqn);
  }

  listSymbolsInFile(path: string): IndexSymbol[] {
    return listSymbolsInFile(this.db, path);
  }

  // ---------- Reference queries ----------

  // Strict resolution: returns references whose `target_symbol_id`
  // is bound to the given symbol. Misses unresolved references
  // (ambiguous/external). Pair with `findReferencesByName` when
  // you need the lossy lookup too.
  findReferences(symbolId: number): Reference[] {
    return findReferencesBySymbolId(this.db, symbolId);
  }

  // Name-based fallback. Surfaces all references whose
  // `target_symbol_name` matches, regardless of resolution
  // status. Used by tools that present "all callers, including
  // unresolved" to the model.
  findReferencesByName(name: string): Reference[] {
    return findReferencesByName(this.db, name);
  }

  // ---------- Import graph ----------

  importsOf(path: string): Import[] {
    return listImportsBySource(this.db, path);
  }

  // Returns the file paths (project-relative) of files that
  // import `path`. Useful for refactor-impact analysis.
  // CODE_INDEX.md §5.4: dependents_of canonical use case is
  // "before mudar API de auth.ts, quem precisa ser revisado".
  dependentsOf(path: string): string[] {
    const rows = listDependentsOf(this.db, path);
    // Deduplicate: a file may import the same target twice
    // (named + namespace). Caller doesn't care which form;
    // they care about the set of importing files.
    return Array.from(new Set(rows.map((r) => r.sourceFile)));
  }

  // Detailed variant retaining the full Import row(s) per
  // dependent — names, isExternal, etc. The dependents_of tool
  // uses this so the model sees WHAT each dependent imports,
  // not just THAT it imports. Returns one row per import edge
  // (a file importing the target twice yields two rows).
  dependentsOfDetailed(path: string): Import[] {
    return listDependentsOf(this.db, path);
  }

  // ---------- Test mapping ----------

  testsFor(sourcePath: string): TestMapping[] {
    return listTestsForSource(this.db, sourcePath);
  }

  sourceFor(testPath: string): TestMapping[] {
    return listSourcesForTest(this.db, testPath);
  }

  // ---------- File metadata ----------

  fileMeta(path: string): FileMeta | null {
    return getFile(this.db, path);
  }

  listFiles(opts: ListFilesOptions = {}): FileMeta[] {
    const filter: { language?: string; modifiedSince?: number } = {};
    if (opts.language !== undefined) filter.language = opts.language;
    if (opts.modifiedSince !== undefined) filter.modifiedSince = opts.modifiedSince;
    return listFilesRepo(this.db, filter);
  }

  // ---------- Scan ----------

  // Run a full project scan: walk the FS, parse + extract every
  // supported file, write rows. Idempotent — re-running converges
  // on current FS state. Reference resolution and the FS watcher
  // are separate slices (4.3.3, 4.3.6); the CLI surface that
  // exposes this to operators lands in 4.3.1.c.
  //
  // The `projectRoot` for the scan defaults to the one passed at
  // init time. Callers that want to scan a different root pass
  // it explicitly via opts.projectRoot.
  async scan(
    opts: Omit<ScanOptions, 'projectRoot'> & { projectRoot?: string } = {},
  ): Promise<ScanResult> {
    return scanProject(this.db, {
      ...opts,
      projectRoot: opts.projectRoot ?? this.projectRoot,
    });
  }

  // Incremental update path (CODE_INDEX.md §3.2). Re-indexes
  // a specific set of files in place — no walker, no prune.
  // Drops rows for paths that no longer pass the walker's
  // filters (deleted / symlink / oversized / wrong extension).
  // Skips parse when content_hash matches stored. Used by the
  // harness's PostToolUse hook so write_file / edit_file don't
  // leave the index stale mid-session. Resolver runs at the
  // end, scoped to NULL targets only, so cost is dominated by
  // the per-file parse.
  async scanFiles(opts: {
    paths: string[];
    projectRoot?: string;
  }): Promise<ScanFilesResult> {
    return scanFiles(this.db, {
      paths: opts.paths,
      projectRoot: opts.projectRoot ?? this.projectRoot,
    });
  }

  // ---------- Diagnostics ----------

  status(): IndexStatus {
    const lastFullScanAtRaw = getMeta(this.db, 'last_full_scan_at');
    const lastFullScanAt =
      lastFullScanAtRaw !== null && /^\d+$/.test(lastFullScanAtRaw)
        ? Number.parseInt(lastFullScanAtRaw, 10)
        : null;
    const filesIndexed = countFiles(this.db);
    const filesFailed = countFiles(this.db, 'failed');
    const dbSizeBytes = (() => {
      // SQLite exposes db size via PRAGMA page_count * page_size.
      // PRAGMA's column name is the pragma keyword itself, so we
      // alias to a stable shape. Errors swallowed (pragma fails
      // on closed db) and return 0 — diagnostics are best-effort,
      // not critical path.
      try {
        const pageCount = this.db
          .query<{ n: number }, []>('SELECT page_count AS n FROM pragma_page_count')
          .get();
        const pageSize = this.db
          .query<{ n: number }, []>('SELECT page_size AS n FROM pragma_page_size')
          .get();
        if (pageCount === null || pageSize === null) return 0;
        return pageCount.n * pageSize.n;
      } catch {
        return 0;
      }
    })();
    // Schema version is whatever migration ran last. Read from
    // the migrations meta table the runner maintains.
    const schemaVersionRow = (() => {
      try {
        return this.db.query<{ id: number }, []>('SELECT MAX(id) AS id FROM _migrations').get();
      } catch {
        return null;
      }
    })();
    const schemaVersion = schemaVersionRow?.id ?? 0;
    return {
      lastFullScanAt,
      filesIndexed,
      filesFailed,
      dbSizeBytes,
      schemaVersion,
    };
  }
}

export { defaultCodeIndexPath } from './paths.ts';
export {
  CODE_INDEX_DEFAULT_EXCLUDES,
  CODE_INDEX_MAX_FILE_SIZE_BYTES,
} from './privacy.ts';
export type {
  FileMeta,
  GetSymbolOptions,
  Import,
  IndexStatus,
  ListFilesOptions,
  Reference,
  ReferenceKind,
  IndexSymbol,
  SymbolKind,
  SymbolVisibility,
  TestMapping,
  TestMappingInferredBy,
} from './types.ts';
