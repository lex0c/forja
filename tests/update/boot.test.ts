import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { recordUpdateProbe } from '../../src/storage/repos/update-check.ts';
import { kickUpdateRefresh, takeUpdateNotice } from '../../src/update/boot.ts';

const freshDb = () => {
  const db = openDb(':memory:');
  migrate(db);
  return db;
};

describe('takeUpdateNotice', () => {
  test('no cached latest → null', () => {
    const db = freshDb();
    expect(takeUpdateNotice(db, '0.1.3')).toBeNull();
    db.close();
  });

  test('newer known → notice with release url, then silent (once per release)', () => {
    const db = freshDb();
    recordUpdateProbe(db, 1000, '0.2.0');
    expect(takeUpdateNotice(db, '0.1.3')).toEqual({
      current: '0.1.3',
      latest: '0.2.0',
      url: 'https://github.com/lex0c/forja/releases/latest',
    });
    // Marked notified → the same release is silent on the next boot.
    expect(takeUpdateNotice(db, '0.1.3')).toBeNull();
    db.close();
  });

  test('same version → null (no self-nag)', () => {
    const db = freshDb();
    recordUpdateProbe(db, 1000, '0.1.3');
    expect(takeUpdateNotice(db, '0.1.3')).toBeNull();
    db.close();
  });

  test('downgrade (dev ahead of release) → null', () => {
    const db = freshDb();
    recordUpdateProbe(db, 1000, '0.1.0');
    expect(takeUpdateNotice(db, '0.2.0')).toBeNull();
    db.close();
  });
});

describe('kickUpdateRefresh', () => {
  test('throttled kick returns synchronously and never throws (no network)', async () => {
    const db = freshDb();
    // Last probe is recent relative to `now` + small interval → shouldRefresh
    // is false, so refreshUpdateCache returns before any fetch. This exercises
    // the fire-and-forget wrapper without touching the real GitHub endpoint.
    recordUpdateProbe(db, 1_000_000, '0.2.0');
    expect(() => kickUpdateRefresh(db, 1_005_000, 10_000)).not.toThrow();
    await Promise.resolve();
    db.close();
  });
});
