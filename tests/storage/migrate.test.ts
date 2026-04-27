import { describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import type { Migration } from '../../src/storage/migrations/index.ts';

describe('migrate', () => {
  test('applies all bundled migrations on first run', () => {
    const db = openMemoryDb();
    const result = migrate(db);
    expect(result.applied).toContain('001-initial');
    expect(result.skipped).toEqual([]);
    db.close();
  });

  test('skips already-applied migrations on second run', () => {
    const db = openMemoryDb();
    migrate(db);
    const result = migrate(db);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toContain('001-initial');
    db.close();
  });

  test('refuses to proceed when an applied migration changed (hash mismatch)', () => {
    const db = openMemoryDb();
    const original: Migration = {
      id: 99,
      name: 'test',
      sql: 'CREATE TABLE foo (id TEXT);',
    };
    const tampered: Migration = {
      id: 99,
      name: 'test',
      sql: 'CREATE TABLE foo (id INTEGER);',
    };
    migrate(db, [original]);
    expect(() => migrate(db, [tampered])).toThrow(/different hash/);
    db.close();
  });

  test('creates the expected tables and tracking table', () => {
    const db = openMemoryDb();
    migrate(db);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('sessions');
    expect(names).toContain('messages');
    expect(names).toContain('tool_calls');
    expect(names).toContain('_migrations');
    db.close();
  });

  test('whitespace-only changes do not invalidate the hash', () => {
    const db = openMemoryDb();
    const original: Migration = {
      id: 99,
      name: 'test',
      sql: 'CREATE TABLE foo (id TEXT);',
    };
    const reformatted: Migration = {
      id: 99,
      name: 'test',
      sql: '  CREATE  TABLE   foo\n  (id TEXT);  ',
    };
    migrate(db, [original]);
    expect(() => migrate(db, [reformatted])).not.toThrow();
    db.close();
  });

  test('hash mismatch error includes both hashes', () => {
    const db = openMemoryDb();
    migrate(db, [{ id: 99, name: 'test', sql: 'CREATE TABLE foo (id TEXT);' }]);
    const err = (() => {
      try {
        migrate(db, [{ id: 99, name: 'test', sql: 'CREATE TABLE foo (id INTEGER);' }]);
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(err).not.toBeNull();
    expect(err?.message).toContain('applied hash:');
    expect(err?.message).toContain('current hash:');
    db.close();
  });

  test('records hash and timestamp in _migrations', () => {
    const db = openMemoryDb();
    migrate(db);
    const rows = db.query('SELECT id, name, hash, applied_at FROM _migrations').all() as {
      id: number;
      name: string;
      hash: string;
      applied_at: number;
    }[];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.id).toBe(1);
    expect(row.name).toBe('001-initial');
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.applied_at).toBeGreaterThan(0);
    db.close();
  });
});
