// Domain types for the code-index subsystem
// (CODE_INDEX.md §2.1, §4.1). Mirror the SQL schema field-for-field
// using camelCase identifiers per Forja convention; the row → object
// converters in `repo.ts` translate snake_case from SQLite back to
// camelCase here.

export type SymbolKind = 'function' | 'class' | 'method' | 'type' | 'interface' | 'const' | 'enum';

export type SymbolVisibility = 'export' | 'public' | 'private' | 'internal' | 'unknown';

export type ReferenceKind = 'call' | 'type' | 'import' | 'extends' | 'implements';

export type FileParseStatus = 'ok' | 'partial' | 'failed' | 'skipped';

export type TestMappingInferredBy = 'filename' | 'import_graph' | 'manual';

export interface FileMeta {
  // Path RELATIVE to the project root. Source-of-truth for joins.
  path: string;
  language: string;
  contentHash: string;
  sizeBytes: number;
  loc: number;
  lastModifiedAt: number;
  indexedAt: number;
  parseStatus: FileParseStatus;
  parseError: string | null;
  indexSchemaVersion: number;
}

export interface IndexSymbol {
  id: number;
  filePath: string;
  name: string;
  fqn: string | null;
  kind: SymbolKind;
  visibility: SymbolVisibility;
  signature: string | null;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  parentSymbolId: number | null;
}

export interface Reference {
  id: number;
  sourceFile: string;
  sourceLine: number;
  sourceCol: number;
  targetSymbolName: string;
  // null when the resolver couldn't bind to a unique symbol —
  // either the target is external (third-party) or the name is
  // ambiguous within the project. Tools surface both cases via
  // `targetSymbolName` so the model can disambiguate.
  targetSymbolId: number | null;
  refKind: ReferenceKind;
}

export interface Import {
  id: number;
  sourceFile: string;
  // `targetPath` = canonical project-relative path when resolvable
  // (local import); null when external (`react`, etc.). Pair with
  // `targetModule` for the raw spec the parser saw.
  targetPath: string | null;
  targetModule: string | null;
  importedNames: string[];
  isExternal: boolean;
}

export interface TestMapping {
  testFile: string;
  sourceFile: string;
  // 0..1 — heuristic confidence. Operators / playbooks should
  // typically gate behavior on `confidence >= 0.7` to keep the
  // false-positive rate acceptable; manual mappings (config) are
  // confidence=1.0 by convention.
  confidence: number;
  inferredBy: TestMappingInferredBy;
}

export interface IndexStatus {
  // Wall-clock ms of the last full scan; null when the index has
  // never been initialized.
  lastFullScanAt: number | null;
  filesIndexed: number;
  filesFailed: number;
  dbSizeBytes: number;
  schemaVersion: number;
}

export interface GetSymbolOptions {
  kind?: SymbolKind;
  // Path-disambiguator: when the same name exists in multiple
  // files, the tool surfaces an `index.symbol.ambiguous` error
  // unless `file` narrows the lookup.
  file?: string;
}

export interface ListFilesOptions {
  language?: string;
  // Filter to files whose `last_modified_at` is at or after this
  // epoch-ms timestamp. Used by incremental scan and stale check.
  modifiedSince?: number;
}
