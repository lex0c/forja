import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, openMemoryDb, withTransaction } from '../../src/storage/db.ts';

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
