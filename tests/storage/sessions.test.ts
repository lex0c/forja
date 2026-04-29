import { beforeEach, describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../../src/storage/db.ts';
import type { DB } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  completeSession,
  createSession,
  getSession,
  listSessions,
  reopenSession,
  updateSessionCost,
} from '../../src/storage/repos/sessions.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

describe('sessions repo', () => {
  test('creates a session in running status', () => {
    const s = createSession(db, { model: 'claude-opus-4-7', cwd: '/tmp/proj' });
    expect(typeof s.id).toBe('string');
    expect(s.status).toBe('running');
    expect(s.endedAt).toBeNull();
    expect(s.totalCostUsd).toBe(0);
  });

  test('roundtrip: create then get matches', () => {
    const created = createSession(db, { model: 'claude-opus-4-7', cwd: '/tmp/proj' });
    expect(getSession(db, created.id)).toEqual(created);
  });

  test('getSession returns null for unknown id', () => {
    expect(getSession(db, 'unknown')).toBeNull();
  });

  test('listSessions orders by started_at DESC', () => {
    createSession(db, { model: 'm', cwd: '/p', startedAt: 1000 });
    createSession(db, { model: 'm', cwd: '/p', startedAt: 3000 });
    createSession(db, { model: 'm', cwd: '/p', startedAt: 2000 });
    const list = listSessions(db);
    expect(list.map((s) => s.startedAt)).toEqual([3000, 2000, 1000]);
  });

  test('listSessions filters by cwd and status', () => {
    createSession(db, { model: 'm', cwd: '/a' });
    createSession(db, { model: 'm', cwd: '/b' });
    const session = createSession(db, { model: 'm', cwd: '/a' });
    completeSession(db, session.id, 'done', 0.5, true);
    expect(listSessions(db, { cwd: '/a' })).toHaveLength(2);
    expect(listSessions(db, { status: 'done' })).toHaveLength(1);
    expect(listSessions(db, { cwd: '/a', status: 'done' })).toHaveLength(1);
    expect(listSessions(db, { cwd: '/b', status: 'done' })).toHaveLength(0);
  });

  test('listSessions respects limit', () => {
    for (let i = 0; i < 5; i++) {
      createSession(db, { model: 'm', cwd: '/p', startedAt: 1000 + i });
    }
    expect(listSessions(db, { limit: 3 })).toHaveLength(3);
  });

  test('completeSession transitions running to terminal', () => {
    const s = createSession(db, { model: 'm', cwd: '/p' });
    completeSession(db, s.id, 'done', 1.23, true);
    const fetched = getSession(db, s.id);
    expect(fetched?.status).toBe('done');
    expect(fetched?.totalCostUsd).toBe(1.23);
    expect(fetched?.usageComplete).toBe(true);
    expect(typeof fetched?.endedAt).toBe('number');
  });

  test('completeSession persists usageComplete=false for partial telemetry', () => {
    const s = createSession(db, { model: 'm', cwd: '/p' });
    completeSession(db, s.id, 'interrupted', 0.42, false);
    const fetched = getSession(db, s.id);
    expect(fetched?.totalCostUsd).toBe(0.42);
    expect(fetched?.usageComplete).toBe(false);
  });

  test('completeSession refuses to re-terminate a finished session', () => {
    const s = createSession(db, { model: 'm', cwd: '/p' });
    completeSession(db, s.id, 'done', 0, true);
    expect(() => completeSession(db, s.id, 'done', 0, true)).toThrow(/not in 'running' state/);
  });

  test('completeSession rejects unknown session', () => {
    expect(() => completeSession(db, 'nope', 'done', 0, true)).toThrow(/not found/);
  });

  test('updateSessionCost overwrites the cost field', () => {
    const s = createSession(db, { model: 'm', cwd: '/p' });
    updateSessionCost(db, s.id, 0.01);
    expect(getSession(db, s.id)?.totalCostUsd).toBe(0.01);
    updateSessionCost(db, s.id, 0.05);
    expect(getSession(db, s.id)?.totalCostUsd).toBe(0.05);
  });

  test('listSessions ties on same started_at follow insertion order (newest first)', () => {
    // Direct regression for migration 008. Without the seq
    // tiebreaker, two sessions sharing started_at fall back to
    // SQLite's implementation-defined order; --resume last would
    // attach to whichever the impl picked first, possibly an
    // older session. With seq DESC as the secondary key, the
    // most-recently-inserted session wins deterministically.
    const ms = 1_700_000_000_000;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(createSession(db, { model: 'm', cwd: '/p', startedAt: ms }).id);
    }
    const list = listSessions(db, { limit: 5 });
    // Newest-first: ids inserted last appear first in the listing.
    expect(list.map((s) => s.id)).toEqual([...ids].reverse());
    // 'last' resolution (limit=1) returns the most-recently-inserted.
    const last = listSessions(db, { limit: 1 });
    expect(last[0]?.id).toBe(ids[ids.length - 1]);
  });

  test('CHECK constraint rejects invalid status at the SQL layer', () => {
    expect(() =>
      db.exec(
        'INSERT INTO sessions (id, started_at, model, cwd, status, total_cost_usd) ' +
          "VALUES ('x', 0, 'm', '/p', 'bogus', 0)",
      ),
    ).toThrow();
  });

  test('reopenSession flips a finished session back to running', () => {
    // Resume continuation reuses a prior session id; without
    // reopen, completeSession at the end of the resumed run trips
    // its WHERE status='running' guard.
    const s = createSession(db, { model: 'm', cwd: '/p' });
    completeSession(db, s.id, 'done', 0.5, true);
    expect(getSession(db, s.id)?.status).toBe('done');
    reopenSession(db, s.id);
    expect(getSession(db, s.id)?.status).toBe('running');
    expect(getSession(db, s.id)?.endedAt).toBeNull();
    // completeSession should now succeed again on the resumed run.
    completeSession(db, s.id, 'done', 1.5, true);
    expect(getSession(db, s.id)?.status).toBe('done');
    expect(getSession(db, s.id)?.totalCostUsd).toBe(1.5);
  });

  test('reopenSession is idempotent on an already-running session', () => {
    const s = createSession(db, { model: 'm', cwd: '/p' });
    expect(() => reopenSession(db, s.id)).not.toThrow();
    expect(getSession(db, s.id)?.status).toBe('running');
  });

  test('reopenSession rejects unknown id', () => {
    expect(() => reopenSession(db, 'nope')).toThrow(/not found/);
  });
});
