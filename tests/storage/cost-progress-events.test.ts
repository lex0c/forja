import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  insertCostProgressEvent,
  listCostProgressByHandle,
  listCostProgressByParent,
} from '../../src/storage/repos/cost-progress-events.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { insertSubagentHandle } from '../../src/storage/repos/subagent-handles.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

const seedHandle = (
  parentSessionId: string,
  handleId: string,
  name = 'explore',
  spawnedAt = Date.now(),
): void => {
  insertSubagentHandle(db, {
    handleId,
    parentSessionId,
    name,
    spawnedAt,
  });
};

describe('cost_progress_events repo', () => {
  test('insert + listByHandle round-trip with deterministic ordering', () => {
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    seedHandle(parent.id, 'h-1');
    insertCostProgressEvent(db, {
      handleId: 'h-1',
      parentSessionId: parent.id,
      delta: 0.001,
      cumulative: 0.001,
      recordedAt: 1_700_000_000_000,
    });
    insertCostProgressEvent(db, {
      handleId: 'h-1',
      parentSessionId: parent.id,
      delta: 0.002,
      cumulative: 0.003,
      recordedAt: 1_700_000_001_000,
    });
    insertCostProgressEvent(db, {
      handleId: 'h-1',
      parentSessionId: parent.id,
      delta: 0.0015,
      cumulative: 0.0045,
      recordedAt: 1_700_000_002_000,
    });
    const rows = listCostProgressByHandle(db, 'h-1');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.cumulative)).toEqual([0.001, 0.003, 0.0045]);
    expect(rows.map((r) => r.delta)).toEqual([0.001, 0.002, 0.0015]);
    expect(rows[0]?.parentSessionId).toBe(parent.id);
  });

  test('id-tiebreak preserves insertion order on same-tick recorded_at', () => {
    // Multiple cost_updates in the same ms tick (fast provider,
    // local mock) must keep insertion order. The PRIMARY KEY
    // AUTOINCREMENT id is the tiebreaker after recorded_at.
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    seedHandle(parent.id, 'h-1');
    const t = 1_700_000_000_000;
    insertCostProgressEvent(db, {
      handleId: 'h-1',
      parentSessionId: parent.id,
      delta: 0.001,
      cumulative: 0.001,
      recordedAt: t,
    });
    insertCostProgressEvent(db, {
      handleId: 'h-1',
      parentSessionId: parent.id,
      delta: 0.002,
      cumulative: 0.003,
      recordedAt: t,
    });
    insertCostProgressEvent(db, {
      handleId: 'h-1',
      parentSessionId: parent.id,
      delta: 0.003,
      cumulative: 0.006,
      recordedAt: t,
    });
    const rows = listCostProgressByHandle(db, 'h-1');
    expect(rows.map((r) => r.cumulative)).toEqual([0.001, 0.003, 0.006]);
  });

  test('listByParent aggregates across handles in time order', () => {
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    seedHandle(parent.id, 'h-A');
    seedHandle(parent.id, 'h-B');
    insertCostProgressEvent(db, {
      handleId: 'h-A',
      parentSessionId: parent.id,
      delta: 0.01,
      cumulative: 0.01,
      recordedAt: 1_700_000_000_000,
    });
    insertCostProgressEvent(db, {
      handleId: 'h-B',
      parentSessionId: parent.id,
      delta: 0.02,
      cumulative: 0.02,
      recordedAt: 1_700_000_000_500,
    });
    insertCostProgressEvent(db, {
      handleId: 'h-A',
      parentSessionId: parent.id,
      delta: 0.005,
      cumulative: 0.015,
      recordedAt: 1_700_000_001_000,
    });
    const rows = listCostProgressByParent(db, parent.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.handleId)).toEqual(['h-A', 'h-B', 'h-A']);
  });

  test('FK cascade: dropping parent session reaps cost rows', () => {
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    seedHandle(parent.id, 'h-1');
    insertCostProgressEvent(db, {
      handleId: 'h-1',
      parentSessionId: parent.id,
      delta: 0.01,
      cumulative: 0.01,
    });
    expect(listCostProgressByParent(db, parent.id)).toHaveLength(1);
    db.query('DELETE FROM sessions WHERE id = ?').run(parent.id);
    expect(listCostProgressByParent(db, parent.id)).toHaveLength(0);
    // The handle row was also reaped (CASCADE via subagent_handles).
    const handleRows = db
      .query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM subagent_handles WHERE handle_id = ?',
      )
      .get('h-1');
    expect(handleRows?.n).toBe(0);
  });

  test('FK cascade: dropping handle row reaps its cost stream', () => {
    // Distinct from parent-session cascade: a future cleanup
    // path that reaps individual handles (without dropping the
    // session) must also reap their cost stream.
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    seedHandle(parent.id, 'h-keep');
    seedHandle(parent.id, 'h-drop');
    insertCostProgressEvent(db, {
      handleId: 'h-keep',
      parentSessionId: parent.id,
      delta: 0.01,
      cumulative: 0.01,
    });
    insertCostProgressEvent(db, {
      handleId: 'h-drop',
      parentSessionId: parent.id,
      delta: 0.02,
      cumulative: 0.02,
    });
    db.query('DELETE FROM subagent_handles WHERE handle_id = ?').run('h-drop');
    const remaining = listCostProgressByParent(db, parent.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.handleId).toBe('h-keep');
  });

  test('insert with default recordedAt uses Date.now()', () => {
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    seedHandle(parent.id, 'h-1');
    const before = Date.now();
    insertCostProgressEvent(db, {
      handleId: 'h-1',
      parentSessionId: parent.id,
      delta: 0.01,
      cumulative: 0.01,
    });
    const after = Date.now();
    const rows = listCostProgressByHandle(db, 'h-1');
    expect(rows).toHaveLength(1);
    const recorded = rows[0]?.recordedAt ?? 0;
    expect(recorded).toBeGreaterThanOrEqual(before);
    expect(recorded).toBeLessThanOrEqual(after);
  });
});
