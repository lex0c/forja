// Scanner pipeline: walk → parse → extract → DB write.
// Implements the initial-scan path of CODE_INDEX.md §3.1 step 3
// (incremental updates and reference resolution land in later
// slices). Drives the modules that already exist:
//   - walker.ts → list of indexable files with metadata
//   - language.ts + parser.ts + extract.ts → structured symbols
//   - repo.ts write helpers → SQLite inserts
//
// Per CODE_INDEX.md §3.1: transactions wrap batches of ~100
// files. Trade-off: smaller batches = more commit overhead;
// larger batches = longer write-lock hold + more memory.
// 100 lands at ~10ms per batch on average hardware, which
// keeps the WAL active without blocking concurrent reads.

import { readFile } from 'node:fs/promises';
import type { DB } from '../../storage/db.ts';
import { withTransaction } from '../../storage/db.ts';
import {
  deleteFile as deleteFileRow,
  insertImports,
  insertReferences,
  insertSymbols,
  setMeta,
  upsertFile,
} from '../repo.ts';
import { resolveImports, resolveReferences } from '../resolver.ts';
import type { FileMeta, FileParseStatus, Import, IndexSymbol, Reference } from '../types.ts';
import { extractFromSource } from './extract.ts';
import { parseSource } from './parser.ts';
import { type WalkOptions, type WalkedFile, walkProject } from './walker.ts';

const BATCH_SIZE = 100;

// Schema version persisted on every file row. Must match the
// latest migration's id (slice 4.3.0 ships migration 1). When a
// migration bumps the schema in a way that invalidates parser
// output (new field, kind expansion), files indexed under the
// older value are rebuilt by `agent code-index rebuild`.
const CURRENT_SCHEMA_VERSION = 1;

export interface ScanOptions extends WalkOptions {
  // Hash of the resolved project config — when it changes, the
  // caller treats the index as stale and triggers rebuild
  // (CODE_INDEX.md §8.3). Stored as `index_meta.config_hash`.
  // Optional; tests pass an explicit value.
  configHash?: string;
}

export interface ScanResult {
  filesScanned: number;
  symbolsInserted: number;
  importsInserted: number;
  referencesInserted: number;
  // Files where parse threw (bug in extractor) or read failed.
  // Best-effort: an extractor exception on one file does not
  // abort the scan — the row is recorded with parse_status=
  // 'failed' and the loop continues.
  errors: { path: string; error: string }[];
  // Files where tree-sitter recovered from a syntax error and
  // emitted ERROR nodes. The extractor still produces what it
  // could; `parse_status='partial'` is recorded so consumers
  // know the rows for that file are best-effort.
  partials: number;
  // Imports / references the second-pass resolver bound to
  // concrete files / symbol ids. Counts target_path /
  // target_symbol_id assignments, not row inserts. 0 when no
  // local imports / unique-name references existed.
  importsResolved: number;
  referencesResolved: number;
}

// Hash a string with SHA-256 via Bun's CryptoHasher. Hex is
// 64 chars — slightly bigger than base64's 44, but
// case-insensitive and JSON-safe by default.
const sha256Hex = (text: string): string => {
  const h = new Bun.CryptoHasher('sha256');
  h.update(text);
  return h.digest('hex');
};

// Count logical lines. Convention matches `wc -l`-style "files
// ending in newline have N lines" — a trailing newline closes
// the last line, it doesn't open a new empty one. Examples:
//   ''            → 0
//   'foo'         → 1   (no newline; final line has no terminator)
//   'foo\n'       → 1   (one closed line)
//   'foo\nbar'    → 2
//   'foo\nbar\n'  → 2
const countLines = (text: string): number => {
  if (text.length === 0) return 0;
  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) newlines++;
  }
  // If the file doesn't end in a newline, the trailing partial
  // line still counts as a line.
  return text.charCodeAt(text.length - 1) === 10 ? newlines : newlines + 1;
};

interface ScanFileOutcome {
  file: FileMeta;
  symbols: Omit<IndexSymbol, 'id'>[];
  imports: Omit<Import, 'id'>[];
  references: Omit<Reference, 'id' | 'targetSymbolId'>[];
  partial: boolean;
}

const scanOneFile = async (entry: WalkedFile, indexedAt: number): Promise<ScanFileOutcome> => {
  const source = await readFile(entry.absPath, 'utf8');
  const contentHash = sha256Hex(source);
  const loc = countLines(source);

  let parseStatus: FileParseStatus = 'ok';
  let parseError: string | null = null;
  let symbols: Omit<IndexSymbol, 'id'>[] = [];
  let imports: Omit<Import, 'sourceFile' | 'targetPath' | 'id'>[] = [];
  let extractedRefs: Omit<Reference, 'id' | 'sourceFile' | 'targetSymbolId'>[] = [];
  let partial = false;
  try {
    const extracted = extractFromSource(source, entry.language, entry.relPath, parseSource);
    symbols = extracted.symbols;
    imports = extracted.imports;
    extractedRefs = extracted.references;
    partial = extracted.partial;
    // tree-sitter is permissive: invalid syntax produces ERROR
    // and MISSING nodes but the surrounding constructs still
    // extract. Mark the file as 'partial' so consumers can
    // distinguish a healthy index from edit-time partials —
    // queries against this file's symbols/imports may be
    // incomplete relative to the operator's intent.
    if (partial) parseStatus = 'partial';
  } catch (e) {
    parseStatus = 'failed';
    parseError = e instanceof Error ? e.message : String(e);
  }

  // imports come out of the extractor without sourceFile and
  // targetPath — fill sourceFile here; targetPath stays null
  // until the resolver runs (slice 4.3.3.a). targetModule is
  // the raw spec from the import statement.
  const completedImports: Omit<Import, 'id'>[] = imports.map((imp) => ({
    sourceFile: entry.relPath,
    targetPath: null,
    targetModule: imp.targetModule,
    importedNames: imp.importedNames,
    isExternal: imp.isExternal,
  }));

  // References come out of the extractor without sourceFile.
  // Fill it here; target_symbol_id stays null at insert time
  // and the resolver pass binds it (slice 4.3.3.b).
  const completedReferences: Omit<Reference, 'id' | 'targetSymbolId'>[] = extractedRefs.map(
    (r) => ({
      sourceFile: entry.relPath,
      sourceLine: r.sourceLine,
      sourceCol: r.sourceCol,
      targetSymbolName: r.targetSymbolName,
      refKind: r.refKind,
    }),
  );

  return {
    file: {
      path: entry.relPath,
      language: entry.language,
      contentHash,
      sizeBytes: entry.sizeBytes,
      loc,
      lastModifiedAt: entry.mtimeMs,
      indexedAt,
      parseStatus,
      parseError,
      indexSchemaVersion: CURRENT_SCHEMA_VERSION,
    },
    symbols,
    imports: completedImports,
    references: completedReferences,
    partial,
  };
};

// One slot in the batch — either a successfully parsed outcome
// or a read/parse failure captured outside the transaction.
type BatchSlot =
  | { ok: true; outcome: ScanFileOutcome }
  | { ok: false; path: string; error: string };

// Per-DB serialization. Concurrent scans on the same DB
// connection are unsafe: they share the connection's temporary
// table (`_scan_seen`), so one scan's CREATE/DROP would knock
// the other's path-set out from underneath it. The mutex
// queues calls so they run end-to-end one at a time, even when
// the caller awaits the same `idx.scan()` from multiple
// places. Walker-only work (FS reads in walkProject) inside a
// scan still runs in parallel within that single scan.
//
// WeakMap-keyed by DB so closing the DB releases the entry.
// The stored promise is `.catch`-swallowed so a rejection in
// scan N doesn't poison scan N+1 — the rejection still
// propagates to N's caller via `ours`.
const scanMutexes = new WeakMap<DB, Promise<unknown>>();

// Run a full scan against `projectRoot`. Idempotent — every
// indexed file is delete-then-inserted, so repeated runs
// converge on the current FS state. Files that existed in a
// prior scan but no longer appear in the walk are pruned at
// the end via a path-set diff (NOT an `indexed_at <` window —
// `Date.now()` ms resolution allows successive fast scans to
// collide on the same value, which would let removed files
// escape pruning until a later scan crossed the ms boundary).
// Reference resolution is NOT run here (slice 4.3.3); the
// caller can re-run the scan after that lands without losing
// data.
//
// Concurrent calls on the same DB are serialized via mutex —
// see `scanMutexes` above.
export const scanProject = async (db: DB, opts: ScanOptions): Promise<ScanResult> => {
  const prior = scanMutexes.get(db) ?? Promise.resolve();
  const ours = (async () => {
    await prior.catch(() => {
      // Swallow prior's failure — independent scans don't
      // share fate. The rejection already propagated to its
      // own caller; we just need to know prior is done.
    });
    return doScan(db, opts);
  })();
  // Park the catch-swallowed handle so the next caller's
  // `await prior` resolves regardless of our outcome. The real
  // outcome is returned to OUR caller via `ours`.
  scanMutexes.set(
    db,
    ours.catch(() => {}),
  );
  return ours;
};

const doScan = async (db: DB, opts: ScanOptions): Promise<ScanResult> => {
  const { files, seenPaths, failedDirs } = await walkProject(opts);
  const result: ScanResult = {
    filesScanned: 0,
    symbolsInserted: 0,
    importsInserted: 0,
    referencesInserted: 0,
    errors: [],
    partials: 0,
    importsResolved: 0,
    referencesResolved: 0,
  };
  const indexedAt = Date.now();

  // Temp table holding every path observed by this scan's
  // walker — successfully indexed AND read-failed alike. The
  // final prune deletes `files` rows whose path is NOT in this
  // set, so removed files (and only those) get cleaned up. Read
  // failures preserve their prior row by virtue of being in the
  // seen set even though no new row is written.
  // Drop-if-exists guards against an interrupted prior scan
  // that left the table behind on this connection (temp tables
  // are connection-scoped and survive across calls until the DB
  // closes). CREATE lives inside the try so a throw between
  // DROP and CREATE leaves the cleanup path intact.
  try {
    db.exec('DROP TABLE IF EXISTS _scan_seen');
    db.exec('CREATE TEMPORARY TABLE _scan_seen (path TEXT PRIMARY KEY)');
    withTransaction(db, () => {
      const stmt = db.query('INSERT OR IGNORE INTO _scan_seen (path) VALUES (?)');
      // Use the walker's full seenPaths set (includes paths
      // whose lstat failed) — populating only `files` would
      // let the prune delete rows for transiently unreachable
      // paths.
      for (const p of seenPaths) stmt.run(p);

      // For each directory the walker couldn't enumerate,
      // promote every prior `files` row under that subtree into
      // _scan_seen so the prune doesn't treat the whole subtree
      // as deleted. Plain prefix matching via substr — no LIKE
      // wildcards in the path, so no need to escape `%`/`_` in
      // directory names. `length(?)` runs in SQLite over the
      // TEXT (Unicode chars), matching `substr`'s view; doing
      // `prefix.length` in JS would mismatch on non-BMP chars
      // (UTF-16 surrogate pairs count as 2 code units in JS but
      // 1 character in SQLite).
      const subtreeStmt = db.query(
        `INSERT OR IGNORE INTO _scan_seen (path)
           SELECT path FROM files WHERE substr(path, 1, length(?)) = ?`,
      );
      for (const dir of failedDirs) {
        const prefix = `${dir}/`;
        subtreeStmt.run(prefix, prefix);
      }
    });

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      // Read + parse + extract for each file in PARALLEL outside
      // the transaction. Holding the SQLite write lock through
      // tree-sitter parses for 100 files (potentially ~1-3 s)
      // would block concurrent readers; doing the heavy work
      // first lets the transaction be a tight write-only block.
      const slots: BatchSlot[] = await Promise.all(
        batch.map(async (entry): Promise<BatchSlot> => {
          try {
            return { ok: true, outcome: await scanOneFile(entry, indexedAt) };
          } catch (e) {
            return {
              ok: false,
              path: entry.relPath,
              error: e instanceof Error ? e.message : String(e),
            };
          }
        }),
      );

      withTransaction(db, () => {
        for (const slot of slots) {
          if (!slot.ok) {
            result.errors.push({ path: slot.path, error: slot.error });
            continue;
          }
          const outcome = slot.outcome;
          // Per-file try/catch isolates malformed rows from
          // tanking the rest of the batch. SQLite reverts the
          // failing statement only — the transaction stays open.
          // Half-written symbol sets are accepted as a worse-than-
          // perfect state (file row + partial symbols) until
          // savepoints land; the alternative was rolling back 100
          // unrelated files for one bad row.
          try {
            deleteFileRow(db, outcome.file.path);
            upsertFile(db, outcome.file);
            if (outcome.file.parseStatus === 'failed') {
              result.errors.push({
                path: outcome.file.path,
                error: outcome.file.parseError ?? 'parse failed',
              });
            } else {
              insertSymbols(db, outcome.symbols);
              insertImports(db, outcome.imports);
              insertReferences(db, outcome.references);
              result.symbolsInserted += outcome.symbols.length;
              result.importsInserted += outcome.imports.length;
              result.referencesInserted += outcome.references.length;
            }
            if (outcome.partial) result.partials++;
            result.filesScanned++;
          } catch (e) {
            result.errors.push({
              path: outcome.file.path,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      });
    }

    // Prune rows for files that existed in a prior scan but
    // didn't appear in this one (deleted, renamed, moved into
    // an exclude pattern). FK CASCADE cleans up their
    // symbols/imports/references.
    withTransaction(db, () => {
      db.query('DELETE FROM files WHERE path NOT IN (SELECT path FROM _scan_seen)').run();
    });

    // Second pass — link `imports.target_path` to concrete
    // file rows AND `references_.target_symbol_id` to symbol
    // ids (CODE_INDEX.md §3.1 step 4). Both helpers filter on
    // their respective NULL columns, so re-running over an
    // already-resolved DB is a no-op.
    withTransaction(db, () => {
      const importsRes = resolveImports(db);
      const refsRes = resolveReferences(db);
      result.importsResolved = importsRes.resolved;
      result.referencesResolved = refsRes.resolved;
    });

    setMeta(db, 'last_full_scan_at', String(indexedAt));
    if (opts.configHash !== undefined) {
      setMeta(db, 'config_hash', opts.configHash);
    }
    return result;
  } finally {
    try {
      db.exec('DROP TABLE IF EXISTS _scan_seen');
    } catch {
      // Best-effort cleanup; if the connection is closing or
      // the table never got created, swallow.
    }
  }
};
