import { beforeEach, describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../../src/storage/db.ts';
import type { DB } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  completeSession,
  createSession,
  getSession,
  listSessions,
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
    completeSession(db, session.id, 'done', 0.5);
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
    completeSession(db, s.id, 'done', 1.23);
    const fetched = getSession(db, s.id);
    expect(fetched?.status).toBe('done');
    expect(fetched?.totalCostUsd).toBe(1.23);
    expect(typeof fetched?.endedAt).toBe('number');
  });

  test('completeSession refuses to re-terminate a finished session', () => {
    const s = createSession(db, { model: 'm', cwd: '/p' });
    completeSession(db, s.id, 'done', 0);
    expect(() => completeSession(db, s.id, 'done', 0)).toThrow(/not in 'running' state/);
  });

  test('completeSession rejects unknown session', () => {
    expect(() => completeSession(db, 'nope', 'done', 0)).toThrow(/not found/);
  });

  test('updateSessionCost overwrites the cost field', () => {
    const s = createSession(db, { model: 'm', cwd: '/p' });
    updateSessionCost(db, s.id, 0.01);
    expect(getSession(db, s.id)?.totalCostUsd).toBe(0.01);
    updateSessionCost(db, s.id, 0.05);
    expect(getSession(db, s.id)?.totalCostUsd).toBe(0.05);
  });

  test('CHECK constraint rejects invalid status at the SQL layer', () => {
    expect(() =>
      db.exec(
        'INSERT INTO sessions (id, started_at, model, cwd, status, total_cost_usd) ' +
          "VALUES ('x', 0, 'm', '/p', 'bogus', 0)",
      ),
    ).toThrow();
  });
});
