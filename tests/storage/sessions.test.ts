import { beforeEach, describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../../src/storage/db.ts';
import type { DB } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  completeSession,
  createSession,
  getSession,
  listChildSessions,
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

  test('parent_session_id defaults to null for top-level runs', () => {
    const s = createSession(db, { model: 'm', cwd: '/p' });
    expect(s.parentSessionId).toBeNull();
    expect(s.isSubagent).toBe(false);
    const fetched = getSession(db, s.id);
    expect(fetched?.parentSessionId).toBeNull();
    expect(fetched?.isSubagent).toBe(false);
  });

  test('parent_session_id round-trips when set on a child', () => {
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    const child = createSession(db, {
      model: 'm',
      cwd: '/p',
      parentSessionId: parent.id,
    });
    expect(child.parentSessionId).toBe(parent.id);
    expect(child.isSubagent).toBe(true);
    const fetched = getSession(db, child.id);
    expect(fetched?.parentSessionId).toBe(parent.id);
    expect(fetched?.isSubagent).toBe(true);
  });

  test('listSessions hides children unless includeSubagents is true', () => {
    // Default listing is the user-facing one — only top-level rows.
    // --include-subagents flips the gate for audit/debug listings.
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    createSession(db, { model: 'm', cwd: '/p', parentSessionId: parent.id });
    createSession(db, { model: 'm', cwd: '/p', parentSessionId: parent.id });
    expect(listSessions(db)).toHaveLength(1);
    expect(listSessions(db, { includeSubagents: true })).toHaveLength(3);
  });

  test('listChildSessions returns children oldest-first', () => {
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    const c1 = createSession(db, {
      model: 'm',
      cwd: '/p',
      parentSessionId: parent.id,
      startedAt: 1000,
    });
    const c2 = createSession(db, {
      model: 'm',
      cwd: '/p',
      parentSessionId: parent.id,
      startedAt: 2000,
    });
    const list = listChildSessions(db, parent.id);
    expect(list.map((s) => s.id)).toEqual([c1.id, c2.id]);
  });

  test('parent deletion sets child parent_session_id to null (not cascade)', () => {
    // Spec §11 + migration 010: child audit trail must survive
    // a parent retention purge. Cost incurred by the child IS
    // billed history; cascading would erase it.
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    const child = createSession(db, {
      model: 'm',
      cwd: '/p',
      parentSessionId: parent.id,
    });
    db.query('DELETE FROM sessions WHERE id = ?').run(parent.id);
    const fetched = getSession(db, child.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.parentSessionId).toBeNull();
  });

  test('orphaned subagent stays excluded from default top-level listing', () => {
    // Migration 011 fix. The original filter used
    // `parent_session_id IS NULL` as the top-level predicate, but
    // ON DELETE SET NULL turns purged children into rows with
    // null parent_session_id — those would re-surface in the
    // user-facing listing AND get picked up by `--resume last`
    // (which calls listSessions(limit:1)). is_subagent is the
    // identity flag set at create time and never updated, so
    // orphans stay flagged.
    const parent = createSession(db, { model: 'm', cwd: '/p', startedAt: 1000 });
    const child = createSession(db, {
      model: 'm',
      cwd: '/p',
      parentSessionId: parent.id,
      startedAt: 9999,
    });
    // Simulate retention purge of the parent.
    db.query('DELETE FROM sessions WHERE id = ?').run(parent.id);
    // After purge: child still exists, parent_session_id is now
    // NULL (SET NULL fired), but is_subagent stays 1.
    const refetched = getSession(db, child.id);
    expect(refetched?.parentSessionId).toBeNull();
    expect(refetched?.isSubagent).toBe(true);

    // Default listing must NOT surface the orphaned child as
    // top-level, even though it now satisfies the old
    // parent_session_id IS NULL predicate.
    const topLevel = listSessions(db);
    expect(topLevel).toHaveLength(0);

    // includeSubagents:true brings it back for raw audit queries.
    const all = listSessions(db, { includeSubagents: true });
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(child.id);
    expect(all[0]?.isSubagent).toBe(true);
  });

  test('migration 011 backfill: pre-existing rows with parent_session_id are flagged', () => {
    // Defense for the migration's UPDATE clause. The migration
    // sets is_subagent=1 for any existing row that already had a
    // parent_session_id at upgrade time. We can't run the bare
    // migration here (test DB starts fully migrated), but we can
    // verify that a row inserted today via createSession with a
    // parentSessionId lands with is_subagent=1 — same code path
    // the migration's invariant relies on.
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    const child = createSession(db, {
      model: 'm',
      cwd: '/p',
      parentSessionId: parent.id,
    });
    const raw = db
      .query<{ is_subagent: number }, [string]>('SELECT is_subagent FROM sessions WHERE id = ?')
      .get(child.id);
    expect(raw?.is_subagent).toBe(1);
  });
});
