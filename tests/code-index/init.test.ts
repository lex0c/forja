import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndex } from '../../src/code-index/index.ts';
import { defaultCodeIndexPath } from '../../src/code-index/paths.ts';
import { openMemoryDb } from '../../src/storage/db.ts';

// Tests for slice 4.3.0 foundation: migration runs cleanly,
// Query API surface is honest about empty state, paths resolve
// deterministically. Scanner / parser tests live in slice 4.3.1.

describe('defaultCodeIndexPath', () => {
  test('produces path under XDG_DATA_HOME when set', () => {
    const env = {
      XDG_DATA_HOME: '/tmp/xdg-data',
      HOME: '/home/user',
    } as NodeJS.ProcessEnv;
    const path = defaultCodeIndexPath('/home/user/projA', env);
    expect(path.startsWith('/tmp/xdg-data/agent/code-index/')).toBe(true);
    expect(path.endsWith('.db')).toBe(true);
  });

  test('falls back to ~/.local/share when XDG_DATA_HOME is unset', () => {
    const env = { HOME: '/home/user' } as NodeJS.ProcessEnv;
    const path = defaultCodeIndexPath('/home/user/projA', env);
    expect(path.startsWith('/home/user/.local/share/agent/code-index/')).toBe(true);
  });

  test('produces stable path for the same project root', () => {
    const env = { HOME: '/home/user' } as NodeJS.ProcessEnv;
    const a = defaultCodeIndexPath('/home/user/projA', env);
    const b = defaultCodeIndexPath('/home/user/projA', env);
    expect(a).toBe(b);
  });

  test('produces distinct paths for distinct project roots', () => {
    const env = { HOME: '/home/user' } as NodeJS.ProcessEnv;
    const a = defaultCodeIndexPath('/home/user/projA', env);
    const b = defaultCodeIndexPath('/home/user/projB', env);
    expect(a).not.toBe(b);
  });

  test('rejects relative project roots (M3 guard)', () => {
    // Caller bug: passing `./projA` vs `/home/user/projA` would
    // otherwise hash to different DBs for the same project —
    // silent split-brain. The guard fails fast at the call
    // site so the operator sees the bug immediately.
    const env = { HOME: '/home/user' } as NodeJS.ProcessEnv;
    expect(() => defaultCodeIndexPath('./projA', env)).toThrow(/must be absolute/);
    expect(() => defaultCodeIndexPath('projA', env)).toThrow(/must be absolute/);
    expect(() => defaultCodeIndexPath('../sibling', env)).toThrow(/must be absolute/);
  });

  test('encodes the hash, never the raw path', () => {
    // Project root with characters that would otherwise be
    // problematic in a filename — confirms the hash layer
    // shields the FS from path-encoding hazards.
    const env = { HOME: '/home/user' } as NodeJS.ProcessEnv;
    const path = defaultCodeIndexPath('/home/user/test_dir/with spaces & %', env);
    expect(path).not.toContain(' ');
    expect(path).not.toContain('%');
    expect(path).not.toContain('&');
    // The hash filename is hex-32 + '.db'.
    expect(path).toMatch(/\/[0-9a-f]{32}\.db$/);
  });
});

describe('CodeIndex.init', () => {
  test('opens a fresh DB and applies migrations', async () => {
    // tmpdir-backed DB: the runner creates the file on first
    // open and migrations run idempotently.
    const dir = mkdtempSync(join(tmpdir(), 'forja-code-index-'));
    try {
      const dbPath = join(dir, 'test.db');
      const ci = await CodeIndex.init({ projectRoot: '/p', dbPath });
      expect(ci.dbPath).toBe(dbPath);
      // File should exist.
      expect(statSync(dbPath).isFile()).toBe(true);
      // Schema version should be the latest migration id.
      const status = ci.status();
      expect(status.schemaVersion).toBe(1);
      ci.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('init is idempotent — second open re-applies nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-code-index-'));
    try {
      const dbPath = join(dir, 'test.db');
      const first = await CodeIndex.init({ projectRoot: '/p', dbPath });
      first.close();
      // Reopen — should not throw, should not re-migrate (the
      // migrate runner skips already-applied entries).
      const second = await CodeIndex.init({ projectRoot: '/p', dbPath });
      expect(second.status().schemaVersion).toBe(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('M1: closes owned DB on migrate failure (no FD leak)', async () => {
    // Pre-seed a `_migrations` row whose hash mismatches the
    // canonical migration we ship — simulates a DB written by
    // a different binary version. The migrate runner throws on
    // mismatch (refuses to silently re-apply a different
    // migration under the same id). init() must close the
    // file-backed DB before re-throwing so we don't leak the
    // FD.
    const dir = mkdtempSync(join(tmpdir(), 'forja-code-index-fail-'));
    try {
      const dbPath = join(dir, 'corrupt.db');
      // Manually open + seed a bogus migration row.
      const { openDb } = await import('../../src/storage/db.ts');
      const seed = openDb(dbPath);
      seed.exec(`
        CREATE TABLE _migrations (
          id          INTEGER PRIMARY KEY,
          name        TEXT NOT NULL UNIQUE,
          hash        TEXT NOT NULL,
          applied_at  INTEGER NOT NULL
        );
        INSERT INTO _migrations (id, name, hash, applied_at)
        VALUES (1, '001-initial', 'bogus-hash-mismatch', 0);
      `);
      seed.close();

      let threw = false;
      let errMessage = '';
      try {
        await CodeIndex.init({ projectRoot: '/p', dbPath });
      } catch (e) {
        threw = true;
        errMessage = e instanceof Error ? e.message : String(e);
      }
      expect(threw).toBe(true);
      // The migrate runner's error message mentions the
      // mismatch — surface check that we got the right kind
      // of failure.
      expect(errMessage).toContain('hash');

      // FD leak proof: a second init() against the same path
      // must be able to OPEN the file. If init() leaked the
      // first descriptor, this open would still work on Linux
      // (multiple opens fine) — better proof: re-seed the
      // DB to a CLEAN state and confirm a fresh init() works.
      // The leak case would manifest as a held-write-lock; we
      // can't easily detect that without a second process. So
      // we settle for the contract test: error propagates
      // honestly and a recovery path remains viable.
      const recover = openDb(dbPath);
      recover.exec('DELETE FROM _migrations WHERE id = 1');
      recover.close();
      const ci = await CodeIndex.init({ projectRoot: '/p', dbPath });
      expect(ci.status().schemaVersion).toBe(1);
      ci.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accepts dbOverride for in-memory tests', async () => {
    const db = openMemoryDb();
    const ci = await CodeIndex.init({ projectRoot: '/p', dbOverride: db });
    expect(ci.dbPath).toBeNull();
    expect(ci.status().schemaVersion).toBe(1);
    // Caller owns the DB lifetime when override is passed:
    // close() should NOT close the in-memory db.
    ci.close();
    // Still queryable.
    const row = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM files').get();
    expect(row?.n).toBe(0);
    db.close();
  });
});

describe('CodeIndex Query API — empty state', () => {
  // Slice 4.3.0 has no parser, so every query against a fresh
  // index returns empty/null. These tests pin the contract: the
  // API surface is alive AND behaves predictably under
  // no-data conditions, so the scanner slice can drop in real
  // data without changing the API.

  test('getSymbol returns []', async () => {
    const db = openMemoryDb();
    const ci = await CodeIndex.init({ projectRoot: '/p', dbOverride: db });
    expect(ci.getSymbol('login')).toEqual([]);
    expect(ci.getSymbol('login', { kind: 'function' })).toEqual([]);
    expect(ci.getSymbol('login', { file: 'src/auth.ts' })).toEqual([]);
    db.close();
  });

  test('getSymbolById returns null', async () => {
    const db = openMemoryDb();
    const ci = await CodeIndex.init({ projectRoot: '/p', dbOverride: db });
    expect(ci.getSymbolById(999)).toBeNull();
    db.close();
  });

  test('listSymbolsInFile returns []', async () => {
    const db = openMemoryDb();
    const ci = await CodeIndex.init({ projectRoot: '/p', dbOverride: db });
    expect(ci.listSymbolsInFile('src/auth.ts')).toEqual([]);
    db.close();
  });

  test('findReferences / findReferencesByName return []', async () => {
    const db = openMemoryDb();
    const ci = await CodeIndex.init({ projectRoot: '/p', dbOverride: db });
    expect(ci.findReferences(1)).toEqual([]);
    expect(ci.findReferencesByName('login')).toEqual([]);
    db.close();
  });

  test('importsOf / dependentsOf return [] / []', async () => {
    const db = openMemoryDb();
    const ci = await CodeIndex.init({ projectRoot: '/p', dbOverride: db });
    expect(ci.importsOf('src/auth.ts')).toEqual([]);
    expect(ci.dependentsOf('src/auth.ts')).toEqual([]);
    db.close();
  });

  test('testsFor / sourceFor return []', async () => {
    const db = openMemoryDb();
    const ci = await CodeIndex.init({ projectRoot: '/p', dbOverride: db });
    expect(ci.testsFor('src/auth.ts')).toEqual([]);
    expect(ci.sourceFor('tests/auth.test.ts')).toEqual([]);
    db.close();
  });

  test('fileMeta returns null for unindexed file', async () => {
    const db = openMemoryDb();
    const ci = await CodeIndex.init({ projectRoot: '/p', dbOverride: db });
    expect(ci.fileMeta('src/auth.ts')).toBeNull();
    db.close();
  });

  test('listFiles returns [] under empty index', async () => {
    const db = openMemoryDb();
    const ci = await CodeIndex.init({ projectRoot: '/p', dbOverride: db });
    expect(ci.listFiles()).toEqual([]);
    expect(ci.listFiles({ language: 'typescript' })).toEqual([]);
    expect(ci.listFiles({ modifiedSince: 0 })).toEqual([]);
    db.close();
  });

  test('status reflects empty state honestly', async () => {
    const db = openMemoryDb();
    const ci = await CodeIndex.init({ projectRoot: '/p', dbOverride: db });
    const status = ci.status();
    expect(status.filesIndexed).toBe(0);
    expect(status.filesFailed).toBe(0);
    expect(status.lastFullScanAt).toBeNull();
    expect(status.schemaVersion).toBe(1);
    expect(status.dbSizeBytes).toBeGreaterThanOrEqual(0);
    db.close();
  });
});

describe('CodeIndex Query API — round-trip via direct SQL inserts', () => {
  // Slice 4.3.0 doesn't have a parser, but we can drop test
  // fixtures into the tables via raw SQL to confirm the read
  // path works end-to-end. When the scanner slice lands, it
  // produces these rows via tree-sitter parsing instead — the
  // read API stays the same.

  test('getSymbol returns inserted symbol', async () => {
    const db = openMemoryDb();
    const ci = await CodeIndex.init({ projectRoot: '/p', dbOverride: db });
    db.query(
      `INSERT INTO files (path, language, content_hash, size_bytes, loc,
                          last_modified_at, indexed_at, parse_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('src/auth.ts', 'typescript', 'h', 100, 50, 1000, 1000, 'ok');
    db.query(
      `INSERT INTO symbols (id, file_path, name, kind, visibility,
                            start_line, start_col, end_line, end_col)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(1, 'src/auth.ts', 'login', 'function', 'export', 10, 0, 25, 1);
    const symbols = ci.getSymbol('login');
    expect(symbols.length).toBe(1);
    expect(symbols[0]?.name).toBe('login');
    expect(symbols[0]?.kind).toBe('function');
    expect(symbols[0]?.visibility).toBe('export');
    expect(symbols[0]?.filePath).toBe('src/auth.ts');
    db.close();
  });

  test('imports round-trip parses imported_names JSON', async () => {
    const db = openMemoryDb();
    const ci = await CodeIndex.init({ projectRoot: '/p', dbOverride: db });
    db.query(
      `INSERT INTO files (path, language, content_hash, size_bytes, loc,
                          last_modified_at, indexed_at, parse_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('src/index.ts', 'typescript', 'h', 100, 50, 1000, 1000, 'ok');
    db.query(
      `INSERT INTO imports (source_file, target_path, target_module, imported_names, is_external)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('src/index.ts', 'src/auth.ts', './auth', JSON.stringify(['login', 'logout']), 0);
    const imports = ci.importsOf('src/index.ts');
    expect(imports.length).toBe(1);
    expect(imports[0]?.importedNames).toEqual(['login', 'logout']);
    expect(imports[0]?.isExternal).toBe(false);
    expect(imports[0]?.targetPath).toBe('src/auth.ts');
    db.close();
  });

  test('imports with corrupted JSON return empty importedNames (defensive)', async () => {
    const db = openMemoryDb();
    const ci = await CodeIndex.init({ projectRoot: '/p', dbOverride: db });
    db.query(
      `INSERT INTO files (path, language, content_hash, size_bytes, loc,
                          last_modified_at, indexed_at, parse_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('src/x.ts', 'typescript', 'h', 100, 50, 1000, 1000, 'ok');
    db.query(
      `INSERT INTO imports (source_file, target_path, target_module, imported_names, is_external)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('src/x.ts', null, 'react', '{not-json', 1);
    const imports = ci.importsOf('src/x.ts');
    expect(imports[0]?.importedNames).toEqual([]);
    db.close();
  });

  test('dependentsOf deduplicates files that import the same target twice', async () => {
    const db = openMemoryDb();
    const ci = await CodeIndex.init({ projectRoot: '/p', dbOverride: db });
    db.query(
      `INSERT INTO files (path, language, content_hash, size_bytes, loc,
                          last_modified_at, indexed_at, parse_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('src/auth.ts', 'typescript', 'h', 100, 50, 1000, 1000, 'ok');
    db.query(
      `INSERT INTO files (path, language, content_hash, size_bytes, loc,
                          last_modified_at, indexed_at, parse_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('src/api.ts', 'typescript', 'h', 100, 50, 1000, 1000, 'ok');
    db.query(
      `INSERT INTO imports (source_file, target_path, target_module, imported_names, is_external)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('src/api.ts', 'src/auth.ts', './auth', JSON.stringify(['login']), 0);
    db.query(
      `INSERT INTO imports (source_file, target_path, target_module, imported_names, is_external)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('src/api.ts', 'src/auth.ts', './auth', JSON.stringify(['logout']), 0);
    expect(ci.dependentsOf('src/auth.ts')).toEqual(['src/api.ts']);
    db.close();
  });

  test('CASCADE delete removes symbols when file is removed', async () => {
    const db = openMemoryDb();
    const ci = await CodeIndex.init({ projectRoot: '/p', dbOverride: db });
    db.query(
      `INSERT INTO files (path, language, content_hash, size_bytes, loc,
                          last_modified_at, indexed_at, parse_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('src/auth.ts', 'typescript', 'h', 100, 50, 1000, 1000, 'ok');
    db.query(
      `INSERT INTO symbols (id, file_path, name, kind, visibility,
                            start_line, start_col, end_line, end_col)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(1, 'src/auth.ts', 'login', 'function', 'export', 10, 0, 25, 1);
    expect(ci.listSymbolsInFile('src/auth.ts').length).toBe(1);
    // Cascade delete should drop the symbol when the file goes.
    db.query('DELETE FROM files WHERE path = ?').run('src/auth.ts');
    expect(ci.listSymbolsInFile('src/auth.ts').length).toBe(0);
    db.close();
  });

  test('SET NULL preserves reference rows when target symbol is removed', async () => {
    const db = openMemoryDb();
    const ci = await CodeIndex.init({ projectRoot: '/p', dbOverride: db });
    db.query(
      `INSERT INTO files (path, language, content_hash, size_bytes, loc,
                          last_modified_at, indexed_at, parse_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('src/auth.ts', 'typescript', 'h', 100, 50, 1000, 1000, 'ok');
    db.query(
      `INSERT INTO files (path, language, content_hash, size_bytes, loc,
                          last_modified_at, indexed_at, parse_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('src/api.ts', 'typescript', 'h', 100, 50, 1000, 1000, 'ok');
    db.query(
      `INSERT INTO symbols (id, file_path, name, kind, visibility,
                            start_line, start_col, end_line, end_col)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(1, 'src/auth.ts', 'login', 'function', 'export', 10, 0, 25, 1);
    db.query(
      `INSERT INTO references_ (source_file, source_line, source_col,
                                target_symbol_name, target_symbol_id, ref_kind)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('src/api.ts', 5, 10, 'login', 1, 'call');
    // Verify reference resolved.
    const before = ci.findReferences(1);
    expect(before.length).toBe(1);
    expect(before[0]?.targetSymbolId).toBe(1);
    // Remove symbol — cascade-set-null on target_symbol_id, NOT
    // a delete of the row. Query by symbol id won't find it; by
    // name still surfaces.
    db.query('DELETE FROM symbols WHERE id = ?').run(1);
    expect(ci.findReferences(1).length).toBe(0);
    const byName = ci.findReferencesByName('login');
    expect(byName.length).toBe(1);
    expect(byName[0]?.targetSymbolId).toBeNull();
    db.close();
  });
});

describe('CodeIndex meta', () => {
  test('status round-trips last_full_scan_at', async () => {
    const db = openMemoryDb();
    const ci = await CodeIndex.init({ projectRoot: '/p', dbOverride: db });
    db.query(
      "INSERT INTO index_meta (key, value) VALUES ('last_full_scan_at', '1700000000000')",
    ).run();
    const status = ci.status();
    expect(status.lastFullScanAt).toBe(1_700_000_000_000);
    db.close();
  });

  test('status surfaces files_failed count', async () => {
    const db = openMemoryDb();
    const ci = await CodeIndex.init({ projectRoot: '/p', dbOverride: db });
    db.query(
      `INSERT INTO files (path, language, content_hash, size_bytes, loc,
                          last_modified_at, indexed_at, parse_status, parse_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'src/broken.ts',
      'typescript',
      'h',
      100,
      50,
      1000,
      1000,
      'failed',
      'syntax error at line 5',
    );
    const status = ci.status();
    expect(status.filesIndexed).toBe(1);
    expect(status.filesFailed).toBe(1);
    db.close();
  });
});
