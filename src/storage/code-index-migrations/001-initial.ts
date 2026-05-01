import type { Migration } from '../migrations/index.ts';

// Initial schema for the code-index DB. Mirrors `CODE_INDEX.md` §2.1
// verbatim — five domain tables plus the `index_meta` key/value
// store. Lives in its own database (separate from `sessions.db`) so
// the audit trail and the structural index have independent
// retention policies — operator can `rm code-index/<hash>.db` to
// reset a project's index without touching session history.
//
// `references` is a SQLite reserved word, so the table is named
// `references_` (trailing underscore). Code that interacts with the
// table must use the underscored form everywhere.
//
// FK `ON DELETE CASCADE` on file_path cascades a file's removal
// (`DELETE FROM files WHERE path = ?`) into all dependent rows. The
// references_ FK to symbols.id uses `SET NULL` so a row remains
// queryable as "unresolved" when the target symbol gets re-indexed
// during incremental updates — the resolver re-runs and re-binds.
//
// All indexes declared here are CRITICAL hot paths from §4.1. Adding
// new ones in future migrations is fine; removing one of these
// requires a perf review (`PERFORMANCE.md §11`).
export const m001Initial: Migration = {
  id: 1,
  name: '001-initial',
  sql: `
    CREATE TABLE files (
      path                  TEXT PRIMARY KEY,
      language              TEXT NOT NULL,
      content_hash          TEXT NOT NULL,
      size_bytes            INTEGER NOT NULL,
      loc                   INTEGER NOT NULL,
      last_modified_at      INTEGER NOT NULL,
      indexed_at            INTEGER NOT NULL,
      parse_status          TEXT NOT NULL CHECK (parse_status IN ('ok','partial','failed','skipped')),
      parse_error           TEXT,
      index_schema_version  INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX idx_files_language ON files(language);
    CREATE INDEX idx_files_modified ON files(last_modified_at DESC);

    CREATE TABLE symbols (
      id                INTEGER PRIMARY KEY,
      file_path         TEXT NOT NULL,
      name              TEXT NOT NULL,
      fqn               TEXT,
      kind              TEXT NOT NULL CHECK (kind IN ('function','class','method','type','interface','const','enum')),
      visibility        TEXT NOT NULL CHECK (visibility IN ('export','public','private','internal','unknown')),
      signature         TEXT,
      start_line        INTEGER NOT NULL,
      start_col         INTEGER NOT NULL,
      end_line          INTEGER NOT NULL,
      end_col           INTEGER NOT NULL,
      parent_symbol_id  INTEGER,
      FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
    );

    CREATE INDEX idx_symbols_name ON symbols(name);
    CREATE INDEX idx_symbols_fqn ON symbols(fqn) WHERE fqn IS NOT NULL;
    CREATE INDEX idx_symbols_file ON symbols(file_path);
    CREATE INDEX idx_symbols_kind ON symbols(kind);

    CREATE TABLE references_ (
      id                  INTEGER PRIMARY KEY,
      source_file         TEXT NOT NULL,
      source_line         INTEGER NOT NULL,
      source_col          INTEGER NOT NULL,
      target_symbol_name  TEXT NOT NULL,
      target_symbol_id    INTEGER,
      ref_kind            TEXT NOT NULL CHECK (ref_kind IN ('call','type','import','extends','implements')),
      FOREIGN KEY (source_file) REFERENCES files(path) ON DELETE CASCADE,
      FOREIGN KEY (target_symbol_id) REFERENCES symbols(id) ON DELETE SET NULL
    );

    CREATE INDEX idx_references_target ON references_(target_symbol_id) WHERE target_symbol_id IS NOT NULL;
    CREATE INDEX idx_references_target_name ON references_(target_symbol_name);
    CREATE INDEX idx_references_source ON references_(source_file);

    CREATE TABLE imports (
      id              INTEGER PRIMARY KEY,
      source_file     TEXT NOT NULL,
      target_path     TEXT,
      target_module   TEXT,
      imported_names  TEXT,
      is_external     INTEGER NOT NULL CHECK (is_external IN (0,1)),
      FOREIGN KEY (source_file) REFERENCES files(path) ON DELETE CASCADE
    );

    CREATE INDEX idx_imports_source ON imports(source_file);
    CREATE INDEX idx_imports_target ON imports(target_path) WHERE target_path IS NOT NULL;

    CREATE TABLE test_mapping (
      test_file    TEXT NOT NULL,
      source_file  TEXT NOT NULL,
      confidence   REAL NOT NULL,
      inferred_by  TEXT NOT NULL CHECK (inferred_by IN ('filename','import_graph','manual')),
      PRIMARY KEY (test_file, source_file),
      FOREIGN KEY (test_file) REFERENCES files(path) ON DELETE CASCADE,
      FOREIGN KEY (source_file) REFERENCES files(path) ON DELETE CASCADE
    );

    CREATE TABLE index_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `,
};
