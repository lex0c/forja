import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import {
  getSubagentWorktree,
  insertSubagentWorktree,
  listActiveSubagentWorktrees,
} from '../../src/storage/repos/subagent-worktrees.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

const seedSession = (parentId?: string) =>
  createSession(db, {
    model: 'm',
    cwd: '/p',
    ...(parentId !== undefined ? { parentSessionId: parentId } : {}),
  });

describe('subagent_worktrees repo', () => {
  test('insert + get round-trip with terminal status', () => {
    const parent = seedSession();
    const child = seedSession(parent.id);
    insertSubagentWorktree(db, {
      sessionId: child.id,
      path: '/h/.cache/agent/worktrees/abcd',
      branch: 'agent/refactor-abcd1234',
      status: 'cleaned',
      createdAt: 1_700_000_000_000,
      cleanedAt: 1_700_000_001_000,
    });
    const wt = getSubagentWorktree(db, child.id);
    expect(wt).not.toBeNull();
    expect(wt?.sessionId).toBe(child.id);
    expect(wt?.path).toBe('/h/.cache/agent/worktrees/abcd');
    expect(wt?.branch).toBe('agent/refactor-abcd1234');
    expect(wt?.status).toBe('cleaned');
    expect(wt?.createdAt).toBe(1_700_000_000_000);
    expect(wt?.cleanedAt).toBe(1_700_000_001_000);
  });

  test('preserved status records dirty cleanup result', () => {
    const child = seedSession(seedSession().id);
    insertSubagentWorktree(db, {
      sessionId: child.id,
      path: '/h/x',
      branch: 'agent/y-z',
      status: 'preserved',
    });
    const wt = getSubagentWorktree(db, child.id);
    expect(wt?.status).toBe('preserved');
    // Default cleanedAt for terminal rows mirrors createdAt — same
    // ms on this fast path; we only assert non-null because the
    // exact value depends on Date.now().
    expect(wt?.cleanedAt).not.toBeNull();
  });

  test('active status leaves cleaned_at null (reserved for 4.2b)', () => {
    // 4.2a never inserts 'active' rows directly, but the schema
    // accepts them so that subprocess execution in 4.2b can use
    // the same table without another migration. The repo must
    // honor that path: cleaned_at stays null until a future UPDATE
    // transitions the row.
    const child = seedSession(seedSession().id);
    insertSubagentWorktree(db, {
      sessionId: child.id,
      path: '/h/a',
      branch: 'agent/a-b',
      status: 'active',
    });
    const wt = getSubagentWorktree(db, child.id);
    expect(wt?.status).toBe('active');
    expect(wt?.cleanedAt).toBeNull();
  });

  test('FK CASCADE on session delete drops the worktree row', () => {
    const child = seedSession(seedSession().id);
    insertSubagentWorktree(db, {
      sessionId: child.id,
      path: '/h/a',
      branch: 'agent/a-b',
      status: 'preserved',
    });
    db.query('DELETE FROM sessions WHERE id = ?').run(child.id);
    expect(getSubagentWorktree(db, child.id)).toBeNull();
  });

  test('parent-session purge does NOT cascade through parent_session_id', () => {
    // The CASCADE only fires on the child's own row (subagent_worktrees
    // FK targets sessions(id)). Deleting the parent runs the
    // sessions-level ON DELETE SET NULL on `parent_session_id`,
    // which keeps the child + its worktree audit intact. Mirrors
    // the behavior locked in for migration 012.
    const parent = seedSession();
    const child = seedSession(parent.id);
    insertSubagentWorktree(db, {
      sessionId: child.id,
      path: '/h/x',
      branch: 'agent/x-y',
      status: 'preserved',
    });
    db.query('DELETE FROM sessions WHERE id = ?').run(parent.id);
    const wt = getSubagentWorktree(db, child.id);
    expect(wt).not.toBeNull();
  });

  test('CHECK constraint refuses an unknown status', () => {
    const child = seedSession(seedSession().id);
    expect(() =>
      db
        .query(
          `INSERT INTO subagent_worktrees
             (session_id, path, branch, status, created_at, cleaned_at)
           VALUES (?, '/h/x', 'agent/x-y', 'merged', 1, 1)`,
        )
        .run(child.id),
    ).toThrow();
  });

  test('listActiveSubagentWorktrees enumerates non-cleaned rows oldest-first', () => {
    // The sweep semantics for 4.2d depend on this ordering: the
    // longest-orphaned worktrees are surfaced first.
    const a = seedSession(seedSession().id);
    const b = seedSession(seedSession().id);
    const c = seedSession(seedSession().id);
    insertSubagentWorktree(db, {
      sessionId: a.id,
      path: '/a',
      branch: 'agent/a',
      status: 'active',
      createdAt: 100,
    });
    insertSubagentWorktree(db, {
      sessionId: b.id,
      path: '/b',
      branch: 'agent/b',
      status: 'preserved',
      createdAt: 200,
    });
    insertSubagentWorktree(db, {
      sessionId: c.id,
      path: '/c',
      branch: 'agent/c',
      status: 'cleaned',
      createdAt: 50,
    });
    const list = listActiveSubagentWorktrees(db);
    // 'cleaned' row excluded; remaining sorted by created_at ASC.
    expect(list.map((r) => r.sessionId)).toEqual([a.id, b.id]);
  });

  test('getSubagentWorktree returns null for an unknown session', () => {
    expect(getSubagentWorktree(db, 'never-inserted')).toBeNull();
  });
});
