import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { StorageJsonError, canonicalJson } from '../../src/storage/json-safe.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { getMessage } from '../../src/storage/repos/messages.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

describe('storage JSON safety', () => {
  test('parse error in messages.content surfaces as StorageJsonError', () => {
    const session = createSession(db, { model: 'm', cwd: '/p' });
    // Inject a row whose content column is invalid JSON. The storage path
    // doesn't expose this — we reach for raw SQL to simulate FS-level
    // tampering or version-skew corruption.
    db.query(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES (?, ?, 'user', '{not json', 0)`,
    ).run('msg-1', session.id);

    let err: unknown = null;
    try {
      getMessage(db, 'msg-1');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StorageJsonError);
    if (err instanceof StorageJsonError) {
      expect(err.context).toContain('messages(msg-1).content');
      expect(err.message).toContain('corrupt JSON');
    }
  });
});

describe('canonicalJson', () => {
  // The recap_cache key (RECAP.md §8.3) hashes canonicalize(intermediate);
  // these tests pin the property the hash depends on: structurally equal
  // values produce identical bytes regardless of insertion order.

  test('object key insertion order does not affect output', () => {
    const a = { b: 1, a: 2, c: 3 };
    const b = { c: 3, a: 2, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":2,"b":1,"c":3}');
  });

  test('array index order is preserved (semantic, not cosmetic)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  test('nested objects are sorted at every depth', () => {
    const value = { z: { y: 1, x: 2 }, a: { c: 3, b: 4 } };
    expect(canonicalJson(value)).toBe('{"a":{"b":4,"c":3},"z":{"x":2,"y":1}}');
  });

  test('null and primitives match JSON.stringify', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('hi')).toBe('"hi"');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
  });

  test('undefined object values are dropped (matches JSON.stringify)', () => {
    expect(canonicalJson({ a: 1, b: undefined, c: 2 })).toBe('{"a":1,"c":2}');
  });

  test('NaN and Infinity serialize as null (JSON spec)', () => {
    expect(canonicalJson(Number.NaN)).toBe('null');
    expect(canonicalJson(Number.POSITIVE_INFINITY)).toBe('null');
  });

  test('keys with special characters are JSON-escaped', () => {
    expect(canonicalJson({ 'a"b': 1, 'c\\d': 2 })).toBe('{"a\\"b":1,"c\\\\d":2}');
  });

  test('two structurally equal recap-shaped values collapse to same string', () => {
    // Mirrors what the cache key hashes — two RecapIntermediates
    // with identical content but different in-memory key order.
    const r1 = {
      schemaVersion: 'v1',
      goal: { text: 'do thing', sourceStepId: 's-1' },
      actions: { filesRead: [{ path: '/a', count: 2 }], commandsRun: [] },
    };
    const r2 = {
      actions: { commandsRun: [], filesRead: [{ count: 2, path: '/a' }] },
      goal: { sourceStepId: 's-1', text: 'do thing' },
      schemaVersion: 'v1',
    };
    expect(canonicalJson(r1)).toBe(canonicalJson(r2));
  });
});
