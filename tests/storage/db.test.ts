import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb, openMemoryDb, withTransaction } from '../../src/storage/db.ts';

describe('openDb', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'forja-storage-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates the parent directory if missing', () => {
    const dbPath = join(tmpDir, 'nested', 'sub', 'sessions.db');
    const db = openDb(dbPath);
    expect(existsSync(dbPath)).toBe(true);
    db.close();
  });

  test('enforces foreign keys', () => {
    const db = openDb(join(tmpDir, 'fk.db'));
    const row = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
    db.close();
  });

  test('uses WAL on file-backed DBs', () => {
    const db = openDb(join(tmpDir, 'wal.db'));
    const row = db.query('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(row.journal_mode).toBe('wal');
    db.close();
  });

  test('memory DB does not enable WAL', () => {
    const db = openMemoryDb();
    const row = db.query('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(row.journal_mode).toBe('memory');
    db.close();
  });

  test('file-backed DB sets busy_timeout to absorb WAL contention', () => {
    // Critical for the parallelism architecture: parent + up
    // to 8 child subagent subprocesses compete for the WAL
    // writer lock. Default busy_timeout=0 throws SQLITE_BUSY
    // on any collision; 5s absorbs transient contention
    // without surfacing the error.
    const db = openDb(join(tmpDir, 'busy.db'));
    const row = db.query('PRAGMA busy_timeout').get() as { timeout: number };
    expect(row.timeout).toBe(5000);
    db.close();
  });

  test('memory DB does not set busy_timeout (single-connection by construction)', () => {
    const db = openMemoryDb();
    const row = db.query('PRAGMA busy_timeout').get() as { timeout: number };
    expect(row.timeout).toBe(0);
    db.close();
  });
});

describe('withTransaction', () => {
  test('commits on success', () => {
    const db = openMemoryDb();
    db.exec('CREATE TABLE t (n INTEGER)');
    withTransaction(db, () => {
      db.query('INSERT INTO t (n) VALUES (1)').run();
      db.query('INSERT INTO t (n) VALUES (2)').run();
    });
    const count = (db.query('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c;
    expect(count).toBe(2);
    db.close();
  });

  test('rolls back on throw', () => {
    const db = openMemoryDb();
    db.exec('CREATE TABLE t (n INTEGER)');
    db.query('INSERT INTO t (n) VALUES (1)').run();
    expect(() =>
      withTransaction(db, () => {
        db.query('INSERT INTO t (n) VALUES (2)').run();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    const count = (db.query('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c;
    expect(count).toBe(1);
    db.close();
  });

  test('returns the body return value', () => {
    const db = openMemoryDb();
    expect(withTransaction(db, () => 42)).toBe(42);
    db.close();
  });
});

// Slice 163 (review — Batch A audit hardening). PRAGMA
// integrity_check at SessionStart + chmod 0600 / 0700 lockdown.
describe('openDb — PRAGMA integrity_check (slice 163)', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'forja-db-integrity-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('fresh DB passes integrity_check on open', () => {
    const path = join(tmpRoot, 'fresh.db');
    expect(() => openDb(path).close()).not.toThrow();
  });

  test('reopening a clean DB still passes integrity_check', () => {
    const path = join(tmpRoot, 'reopen.db');
    const db1 = openDb(path);
    db1.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);');
    db1.close();
    // Second open re-runs integrity_check against the populated DB.
    const db2 = openDb(path);
    const rows = db2.query('SELECT x FROM t').all() as Array<{ x: number }>;
    expect(rows).toEqual([{ x: 1 }]);
    db2.close();
  });

  test('in-memory DB skips integrity_check', () => {
    // Documented optimization: :memory: DBs are single-connection
    // and can't be corrupted by FS write. The check is skipped.
    const db = openMemoryDb();
    db.exec('CREATE TABLE t (x INTEGER)');
    db.close();
  });

  test('skipIntegrityCheck option bypasses the check (test seam)', () => {
    const path = join(tmpRoot, 'skip.db');
    const db = openDb(path, { skipIntegrityCheck: true });
    db.close();
    // Production callers MUST NOT pass this; it exists only for
    // fixtures that intentionally leave the DB inconsistent.
  });
});

describe('openDb — file permissions (slice 163 SEC §8.3)', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'forja-db-perms-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('new DB file is mode 0600', () => {
    const path = join(tmpRoot, 'perms.db');
    const db = openDb(path);
    db.close();
    const stat = statSync(path);
    // Mode includes file-type bits; mask to permission bits.
    const perms = stat.mode & 0o777;
    expect(perms).toBe(0o600);
  });

  test('parent dir is mode 0700', () => {
    const dir = join(tmpRoot, 'nested');
    const path = join(dir, 'sub.db');
    const db = openDb(path);
    db.close();
    const stat = statSync(dir);
    const perms = stat.mode & 0o777;
    expect(perms).toBe(0o700);
  });

  test('reopening re-tightens perms (operator chmod between opens)', () => {
    const path = join(tmpRoot, 'reset.db');
    openDb(path).close();
    // Operator chmod 0644 between opens.
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    openDb(path).close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('readonly open does NOT re-chmod (read-only path is non-mutating)', () => {
    const path = join(tmpRoot, 'ro.db');
    openDb(path).close();
    chmodSync(path, 0o644);
    openDb(path, { readonly: true }).close();
    // Readonly path didn't chmod — operator's 0644 stays.
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });
});

describe('closeDb — WAL durability (slice 174 hardening A3)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'forja-closedb-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('checkpoints the WAL and truncates -wal/-shm to zero', () => {
    const path = join(tmpRoot, 'ck.db');
    const db = openDb(path);
    db.exec('CREATE TABLE t(x INTEGER);');
    db.exec('INSERT INTO t(x) VALUES (1), (2), (3);');
    // Before close: WAL file should have content from the writes.
    const walSizeBefore = statSync(`${path}-wal`).size;
    expect(walSizeBefore).toBeGreaterThan(0);
    closeDb(db);
    // After closeDb: TRUNCATE checkpoint mode resizes the WAL
    // file to zero (committed pages went back to the main DB).
    // The -wal and -shm files may persist as empty siblings or
    // be removed entirely depending on SQLite version; either
    // way, no bytes remain to be lost.
    const walSizeAfter = existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0;
    expect(walSizeAfter).toBe(0);
  });

  test('rows committed before closeDb are visible on reopen', () => {
    const path = join(tmpRoot, 'persist.db');
    const db = openDb(path);
    db.exec('CREATE TABLE audit(id INTEGER PRIMARY KEY, msg TEXT);');
    db.exec("INSERT INTO audit(id, msg) VALUES (1, 'committed before close');");
    closeDb(db);
    const reopened = openDb(path);
    const row = reopened.query('SELECT msg FROM audit WHERE id = 1').get() as { msg: string };
    expect(row.msg).toBe('committed before close');
    closeDb(reopened);
  });

  test('is a no-op-equivalent for :memory: DBs (no checkpoint, no throw)', () => {
    const db = openMemoryDb();
    db.exec('CREATE TABLE x(y INTEGER);');
    db.exec('INSERT INTO x(y) VALUES (1);');
    // Should not throw — wal_checkpoint is harmless on a DB
    // that's not in WAL mode.
    expect(() => closeDb(db)).not.toThrow();
  });

  test('still closes the DB even if the checkpoint fails', () => {
    // Simulate a failing checkpoint by closing the DB before
    // calling closeDb — bun:sqlite throws on exec against a
    // closed connection. closeDb must swallow the throw and
    // not propagate it (finally blocks would otherwise mask
    // their original error).
    const path = join(tmpRoot, 'precosed.db');
    const db = openDb(path);
    db.close();
    expect(() => closeDb(db)).not.toThrow();
  });

  test('a throwing db.close() is swallowed so finally-block errors are preserved', () => {
    // Production shape: `try { migrate(db); } catch (e) {
    // closeDb(db); throw e; }`. If db.close() also throws (already-
    // closed handle, double-close from a prior cleanup, FS error),
    // a propagating throw from inside closeDb would replace the
    // caller's `e` — the operator would see the close error and
    // lose the migration error. Pin that the close-side throw is
    // logged and suppressed, matching the checkpoint posture.
    const fakeDb = {
      exec: () => {
        // No-op checkpoint (succeeds) — isolate the test to
        // db.close()'s catch path.
      },
      close: () => {
        throw new Error('database is not open');
      },
    } as unknown as Parameters<typeof closeDb>[0];
    expect(() => closeDb(fakeDb)).not.toThrow();
  });
});
