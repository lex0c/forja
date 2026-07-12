import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { recordUpdateProbe } from '../../src/storage/repos/update-check.ts';
import {
  isCiEnv,
  kickUpdateRefresh,
  markNoticeShown,
  peekUpdateNotice,
} from '../../src/update/boot.ts';

const freshDb = () => {
  const db = openDb(':memory:');
  migrate(db);
  return db;
};

describe('peekUpdateNotice / markNoticeShown', () => {
  test('no cached latest → null', () => {
    const db = freshDb();
    expect(peekUpdateNotice(db, '0.1.3')).toBeNull();
    db.close();
  });

  test('newer known → notice; silent only AFTER markNoticeShown (once per release)', () => {
    const db = freshDb();
    recordUpdateProbe(db, 1000, '0.2.0');
    // peek does NOT mark — it stays showable until the caller confirms it shown,
    // so a crash between decide and render can't lose the notice. The decision
    // (versions + a non-empty command) is checked here; the command VALUE per
    // install origin/platform is pinned in origin.test.ts, not re-derived from
    // the SUT (that would be a tautology and would couple this test to the
    // runner's platform).
    const first = peekUpdateNotice(db, '0.1.3');
    expect(first).toMatchObject({ current: '0.1.3', latest: '0.2.0' });
    expect(first?.command.length).toBeGreaterThan(0);
    expect(peekUpdateNotice(db, '0.1.3')).toMatchObject({ current: '0.1.3', latest: '0.2.0' });
    // Marking (after emit) makes the same release silent on the next boot.
    markNoticeShown(db, '0.2.0');
    expect(peekUpdateNotice(db, '0.1.3')).toBeNull();
    db.close();
  });

  test('same version → null (no self-nag)', () => {
    const db = freshDb();
    recordUpdateProbe(db, 1000, '0.1.3');
    expect(peekUpdateNotice(db, '0.1.3')).toBeNull();
    db.close();
  });

  test('downgrade (dev ahead of release) → null', () => {
    const db = freshDb();
    recordUpdateProbe(db, 1000, '0.1.0');
    expect(peekUpdateNotice(db, '0.2.0')).toBeNull();
    db.close();
  });
});

describe('isCiEnv', () => {
  test('detects common CI flags, treats false/empty/0 as not-CI', () => {
    expect(isCiEnv({ CI: 'true' })).toBe(true);
    expect(isCiEnv({ CI: '1' })).toBe(true);
    expect(isCiEnv({})).toBe(false);
    expect(isCiEnv({ CI: '' })).toBe(false);
    expect(isCiEnv({ CI: 'false' })).toBe(false);
    expect(isCiEnv({ CI: '0' })).toBe(false);
  });
});

describe('kickUpdateRefresh', () => {
  test('throttled kick returns synchronously and never throws (no network)', async () => {
    const db = freshDb();
    // Last probe is recent relative to `now` + small interval → shouldRefresh
    // is false, so refreshUpdateCache returns before any fetch. Exercises the
    // fire-and-forget wrapper without touching the real GitHub endpoint.
    recordUpdateProbe(db, 1_000_000, '0.2.0');
    expect(() => kickUpdateRefresh(db, 1_005_000, 10_000)).not.toThrow();
    await Promise.resolve();
    db.close();
  });
});
