// SQL access layer for the code-index DB. This slice (4.3.0)
// ships READ helpers only — the scanner slice (4.3.1+) will
// add bulk-insert helpers when it lands actual parsing and
// has rows to write. Reads are exhaustive so the Query API
// skeleton in `index.ts` exercises every path and tests can
// assert empty/populated outcomes against real SQL even
// before the parser writes anything.
//
// Naming convention: db column → camelCase JS field via the
// `fromXxxRow` helpers. Same shape used elsewhere in
// storage/repos/. Future inserts will accept camelCase
// inputs and translate to snake_case at the SQL layer.

import type { DB } from '../storage/db.ts';
import type {
  FileMeta,
  FileParseStatus,
  Import,
  IndexSymbol,
  Reference,
  ReferenceKind,
  SymbolKind,
  SymbolVisibility,
  TestMapping,
  TestMappingInferredBy,
} from './types.ts';

interface FileRow {
  path: string;
  language: string;
  content_hash: string;
  size_bytes: number;
  loc: number;
  last_modified_at: number;
  indexed_at: number;
  parse_status: FileParseStatus;
  parse_error: string | null;
  index_schema_version: number;
}

const fromFileRow = (row: FileRow): FileMeta => ({
  path: row.path,
  language: row.language,
  contentHash: row.content_hash,
  sizeBytes: row.size_bytes,
  loc: row.loc,
  lastModifiedAt: row.last_modified_at,
  indexedAt: row.indexed_at,
  parseStatus: row.parse_status,
  parseError: row.parse_error,
  indexSchemaVersion: row.index_schema_version,
});

interface SymbolRow {
  id: number;
  file_path: string;
  name: string;
  fqn: string | null;
  kind: SymbolKind;
  visibility: SymbolVisibility;
  signature: string | null;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
  parent_symbol_id: number | null;
}

const fromSymbolRow = (row: SymbolRow): IndexSymbol => ({
  id: row.id,
  filePath: row.file_path,
  name: row.name,
  fqn: row.fqn,
  kind: row.kind,
  visibility: row.visibility,
  signature: row.signature,
  startLine: row.start_line,
  startCol: row.start_col,
  endLine: row.end_line,
  endCol: row.end_col,
  parentSymbolId: row.parent_symbol_id,
});

interface ReferenceRow {
  id: number;
  source_file: string;
  source_line: number;
  source_col: number;
  target_symbol_name: string;
  target_symbol_id: number | null;
  ref_kind: ReferenceKind;
}

const fromReferenceRow = (row: ReferenceRow): Reference => ({
  id: row.id,
  sourceFile: row.source_file,
  sourceLine: row.source_line,
  sourceCol: row.source_col,
  targetSymbolName: row.target_symbol_name,
  targetSymbolId: row.target_symbol_id,
  refKind: row.ref_kind,
});

interface ImportRow {
  id: number;
  source_file: string;
  target_path: string | null;
  target_module: string | null;
  // Stored as JSON text per schema; parsed on read. An array of
  // strings: `['login', 'logout']` for named imports, `['*']`
  // for namespace, `['default']` for default import.
  imported_names: string | null;
  is_external: number;
}

const fromImportRow = (row: ImportRow): Import => {
  let importedNames: string[] = [];
  if (row.imported_names !== null && row.imported_names.length > 0) {
    try {
      const parsed = JSON.parse(row.imported_names);
      if (Array.isArray(parsed)) importedNames = parsed.filter((s) => typeof s === 'string');
    } catch {
      // Defensive — corrupted JSON in audit data; surface as empty
      // rather than crash the query. Future schema migration could
      // add a CHECK constraint to enforce array-of-strings shape.
      importedNames = [];
    }
  }
  return {
    id: row.id,
    sourceFile: row.source_file,
    targetPath: row.target_path,
    targetModule: row.target_module,
    importedNames,
    isExternal: row.is_external === 1,
  };
};

interface TestMappingRow {
  test_file: string;
  source_file: string;
  confidence: number;
  inferred_by: TestMappingInferredBy;
}

const fromTestMappingRow = (row: TestMappingRow): TestMapping => ({
  testFile: row.test_file,
  sourceFile: row.source_file,
  confidence: row.confidence,
  inferredBy: row.inferred_by,
});

// ---------- READS ----------

export const getFile = (db: DB, path: string): FileMeta | null => {
  const row = db
    .query<FileRow, [string]>(
      `SELECT path, language, content_hash, size_bytes, loc,
              last_modified_at, indexed_at, parse_status, parse_error,
              index_schema_version
         FROM files
        WHERE path = ?`,
    )
    .get(path);
  return row !== null ? fromFileRow(row) : null;
};

export interface ListFilesFilter {
  language?: string;
  modifiedSince?: number;
}

export const listFiles = (db: DB, filter: ListFilesFilter = {}): FileMeta[] => {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.language !== undefined) {
    clauses.push('language = ?');
    params.push(filter.language);
  }
  if (filter.modifiedSince !== undefined) {
    clauses.push('last_modified_at >= ?');
    params.push(filter.modifiedSince);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .query<FileRow, typeof params>(
      `SELECT path, language, content_hash, size_bytes, loc,
              last_modified_at, indexed_at, parse_status, parse_error,
              index_schema_version
         FROM files
         ${where}
         ORDER BY path ASC`,
    )
    .all(...params);
  return rows.map(fromFileRow);
};

export interface GetSymbolFilter {
  kind?: SymbolKind;
  file?: string;
}

export const getSymbolsByName = (
  db: DB,
  name: string,
  filter: GetSymbolFilter = {},
): IndexSymbol[] => {
  const clauses: string[] = ['name = ?'];
  const params: Array<string | number> = [name];
  if (filter.kind !== undefined) {
    clauses.push('kind = ?');
    params.push(filter.kind);
  }
  if (filter.file !== undefined) {
    clauses.push('file_path = ?');
    params.push(filter.file);
  }
  const rows = db
    .query<SymbolRow, typeof params>(
      `SELECT id, file_path, name, fqn, kind, visibility, signature,
              start_line, start_col, end_line, end_col, parent_symbol_id
         FROM symbols
        WHERE ${clauses.join(' AND ')}
        ORDER BY file_path ASC, start_line ASC`,
    )
    .all(...params);
  return rows.map(fromSymbolRow);
};

export const getSymbolById = (db: DB, id: number): IndexSymbol | null => {
  const row = db
    .query<SymbolRow, [number]>(
      `SELECT id, file_path, name, fqn, kind, visibility, signature,
              start_line, start_col, end_line, end_col, parent_symbol_id
         FROM symbols
        WHERE id = ?`,
    )
    .get(id);
  return row !== null ? fromSymbolRow(row) : null;
};

export const listSymbolsInFile = (db: DB, path: string): IndexSymbol[] => {
  const rows = db
    .query<SymbolRow, [string]>(
      `SELECT id, file_path, name, fqn, kind, visibility, signature,
              start_line, start_col, end_line, end_col, parent_symbol_id
         FROM symbols
        WHERE file_path = ?
        ORDER BY start_line ASC, start_col ASC`,
    )
    .all(path);
  return rows.map(fromSymbolRow);
};

export const findReferencesBySymbolId = (db: DB, symbolId: number): Reference[] => {
  const rows = db
    .query<ReferenceRow, [number]>(
      `SELECT id, source_file, source_line, source_col,
              target_symbol_name, target_symbol_id, ref_kind
         FROM references_
        WHERE target_symbol_id = ?
        ORDER BY source_file ASC, source_line ASC`,
    )
    .all(symbolId);
  return rows.map(fromReferenceRow);
};

export const findReferencesByName = (db: DB, name: string): Reference[] => {
  const rows = db
    .query<ReferenceRow, [string]>(
      `SELECT id, source_file, source_line, source_col,
              target_symbol_name, target_symbol_id, ref_kind
         FROM references_
        WHERE target_symbol_name = ?
        ORDER BY source_file ASC, source_line ASC`,
    )
    .all(name);
  return rows.map(fromReferenceRow);
};

export const listImportsBySource = (db: DB, sourceFile: string): Import[] => {
  const rows = db
    .query<ImportRow, [string]>(
      `SELECT id, source_file, target_path, target_module, imported_names, is_external
         FROM imports
        WHERE source_file = ?
        ORDER BY id ASC`,
    )
    .all(sourceFile);
  return rows.map(fromImportRow);
};

export const listDependentsOf = (db: DB, targetPath: string): Import[] => {
  const rows = db
    .query<ImportRow, [string]>(
      `SELECT id, source_file, target_path, target_module, imported_names, is_external
         FROM imports
        WHERE target_path = ?
        ORDER BY source_file ASC`,
    )
    .all(targetPath);
  return rows.map(fromImportRow);
};

export const listTestsForSource = (db: DB, sourceFile: string): TestMapping[] => {
  const rows = db
    .query<TestMappingRow, [string]>(
      `SELECT test_file, source_file, confidence, inferred_by
         FROM test_mapping
        WHERE source_file = ?
        ORDER BY confidence DESC, test_file ASC`,
    )
    .all(sourceFile);
  return rows.map(fromTestMappingRow);
};

export const listSourcesForTest = (db: DB, testFile: string): TestMapping[] => {
  const rows = db
    .query<TestMappingRow, [string]>(
      `SELECT test_file, source_file, confidence, inferred_by
         FROM test_mapping
        WHERE test_file = ?
        ORDER BY confidence DESC, source_file ASC`,
    )
    .all(testFile);
  return rows.map(fromTestMappingRow);
};

// ---------- WRITES ----------
//
// Bulk inserts run inside a transaction at the call site (the
// pipeline batches per ~100 files per CODE_INDEX.md §3.1). The
// helpers below assume the caller has wrapped them; opening a
// transaction here would prevent batching across files.

// Insert OR replace a file row. Symbols/imports/references that
// belong to the prior version of the file should be deleted by
// the caller BEFORE upsert (the FK ON DELETE CASCADE only fires
// on a real DELETE, not on REPLACE — REPLACE behaves as
// DELETE + INSERT but cascades on the OLD row only when the
// row is removed by REPLACE conflict resolution; we don't rely
// on that subtlety and call deleteFile explicitly when
// re-indexing).
export const upsertFile = (db: DB, file: FileMeta): void => {
  db.query(
    `INSERT INTO files
       (path, language, content_hash, size_bytes, loc,
        last_modified_at, indexed_at, parse_status, parse_error,
        index_schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       language             = excluded.language,
       content_hash         = excluded.content_hash,
       size_bytes           = excluded.size_bytes,
       loc                  = excluded.loc,
       last_modified_at     = excluded.last_modified_at,
       indexed_at           = excluded.indexed_at,
       parse_status         = excluded.parse_status,
       parse_error          = excluded.parse_error,
       index_schema_version = excluded.index_schema_version`,
  ).run(
    file.path,
    file.language,
    file.contentHash,
    file.sizeBytes,
    file.loc,
    file.lastModifiedAt,
    file.indexedAt,
    file.parseStatus,
    file.parseError,
    file.indexSchemaVersion,
  );
};

// Remove a file and cascade to its symbols/references/imports.
// Used by the pipeline before a re-scan (delete-then-insert
// keeps the old/new transition atomic when wrapped in a tx).
export const deleteFile = (db: DB, path: string): void => {
  db.query('DELETE FROM files WHERE path = ?').run(path);
};

// Bulk insert symbols. Caller passes rows without `id` — SQLite
// auto-assigns. We don't return the assigned IDs because the
// reference resolver (slice 4.3.3) re-queries by name + file
// after the second pass, and the import graph stores
// target_path strings rather than IDs. Per-call overhead is one
// prepared statement reused; OK for batches of any size.
export const insertSymbols = (db: DB, symbols: Omit<IndexSymbol, 'id'>[]): void => {
  if (symbols.length === 0) return;
  const stmt = db.query(
    `INSERT INTO symbols
       (file_path, name, fqn, kind, visibility, signature,
        start_line, start_col, end_line, end_col, parent_symbol_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const s of symbols) {
    stmt.run(
      s.filePath,
      s.name,
      s.fqn,
      s.kind,
      s.visibility,
      s.signature,
      s.startLine,
      s.startCol,
      s.endLine,
      s.endCol,
      s.parentSymbolId,
    );
  }
};

// Bulk insert imports. `importedNames` is stored as JSON text
// per the schema choice in slice 4.3.0 — keeps imports' shape
// flexible (named/default/namespace as a uniform string array).
export const insertImports = (db: DB, rows: Omit<Import, 'id'>[]): void => {
  if (rows.length === 0) return;
  const stmt = db.query(
    `INSERT INTO imports
       (source_file, target_path, target_module, imported_names, is_external)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const imp of rows) {
    stmt.run(
      imp.sourceFile,
      imp.targetPath,
      imp.targetModule,
      JSON.stringify(imp.importedNames),
      imp.isExternal ? 1 : 0,
    );
  }
};

// ---------- META ----------

export const getMeta = (db: DB, key: string): string | null => {
  const row = db
    .query<{ value: string }, [string]>('SELECT value FROM index_meta WHERE key = ?')
    .get(key);
  return row !== null ? row.value : null;
};

export const setMeta = (db: DB, key: string, value: string): void => {
  db.query(
    `INSERT INTO index_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
};

// ---------- COUNTS (used by IndexStatus) ----------

export const countFiles = (db: DB, parseStatus?: FileParseStatus): number => {
  if (parseStatus === undefined) {
    const row = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM files').get();
    return row?.n ?? 0;
  }
  const row = db
    .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM files WHERE parse_status = ?')
    .get(parseStatus);
  return row?.n ?? 0;
};
