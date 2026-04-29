import { beforeEach, describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../../src/storage/db.ts';
import type { DB } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  deleteCheckpoint,
  deleteCheckpointsBySession,
  getCheckpoint,
  getLatestCheckpointBySession,
  insertCheckpoint,
  listCheckpointsBySession,
  listCheckpointsOlderThan,
} from '../../src/storage/repos/checkpoints.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;
let sessionId: string;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
});

describe('checkpoints repo', () => {
  test('inserts and reads back with all fields', () => {
    const ckpt = insertCheckpoint(db, {
      sessionId,
      stepId: 'msg-1',
      gitRef: 'abcdef0',
      hadBash: true,
      createdAt: 5_000,
    });
    expect(ckpt.id).toBeString();
    expect(ckpt.sessionId).toBe(sessionId);
    expect(ckpt.stepId).toBe('msg-1');
    expect(ckpt.gitRef).toBe('abcdef0');
    expect(ckpt.hadBash).toBe(true);
    expect(ckpt.createdAt).toBe(5_000);

    const fetched = getCheckpoint(db, ckpt.id);
    expect(fetched).toEqual(ckpt);
  });

  test('hadBash defaults to 0 (false) round-trips through INTEGER column', () => {
    const ckpt = insertCheckpoint(db, {
      sessionId,
      stepId: 'msg-2',
      gitRef: 'sha2',
      hadBash: false,
    });
    expect(ckpt.hadBash).toBe(false);
    expect(getCheckpoint(db, ckpt.id)?.hadBash).toBe(false);
  });

  test('listCheckpointsBySession returns newest first', () => {
    insertCheckpoint(db, {
      sessionId,
      stepId: 's1',
      gitRef: 'a',
      hadBash: false,
      createdAt: 1_000,
    });
    insertCheckpoint(db, {
      sessionId,
      stepId: 's2',
      gitRef: 'b',
      hadBash: false,
      createdAt: 2_000,
    });
    insertCheckpoint(db, {
      sessionId,
      stepId: 's3',
      gitRef: 'c',
      hadBash: false,
      createdAt: 3_000,
    });
    const list = listCheckpointsBySession(db, sessionId);
    expect(list.map((c) => c.gitRef)).toEqual(['c', 'b', 'a']);
  });

  test('listCheckpointsBySession scopes to session', () => {
    const other = createSession(db, { model: 'm', cwd: '/p' }).id;
    insertCheckpoint(db, { sessionId, stepId: 's', gitRef: 'mine', hadBash: false });
    insertCheckpoint(db, {
      sessionId: other,
      stepId: 's',
      gitRef: 'theirs',
      hadBash: false,
    });
    const list = listCheckpointsBySession(db, sessionId);
    expect(list).toHaveLength(1);
    expect(list[0]?.gitRef).toBe('mine');
  });

  test('getLatestCheckpointBySession returns null when no checkpoints', () => {
    expect(getLatestCheckpointBySession(db, sessionId)).toBeNull();
  });

  test('getLatestCheckpointBySession returns newest', () => {
    insertCheckpoint(db, {
      sessionId,
      stepId: 's1',
      gitRef: 'a',
      hadBash: false,
      createdAt: 1_000,
    });
    insertCheckpoint(db, {
      sessionId,
      stepId: 's2',
      gitRef: 'b',
      hadBash: false,
      createdAt: 2_000,
    });
    expect(getLatestCheckpointBySession(db, sessionId)?.gitRef).toBe('b');
  });

  test('deleteCheckpoint removes a single row', () => {
    const a = insertCheckpoint(db, {
      sessionId,
      stepId: 's1',
      gitRef: 'a',
      hadBash: false,
    });
    const b = insertCheckpoint(db, {
      sessionId,
      stepId: 's2',
      gitRef: 'b',
      hadBash: false,
    });
    deleteCheckpoint(db, a.id);
    expect(getCheckpoint(db, a.id)).toBeNull();
    expect(getCheckpoint(db, b.id)).not.toBeNull();
  });

  test('deleteCheckpointsBySession returns count and clears scope', () => {
    insertCheckpoint(db, { sessionId, stepId: 's1', gitRef: 'a', hadBash: false });
    insertCheckpoint(db, { sessionId, stepId: 's2', gitRef: 'b', hadBash: false });
    const other = createSession(db, { model: 'm', cwd: '/p' }).id;
    insertCheckpoint(db, { sessionId: other, stepId: 's3', gitRef: 'c', hadBash: false });

    const deleted = deleteCheckpointsBySession(db, sessionId);
    expect(deleted).toBe(2);
    expect(listCheckpointsBySession(db, sessionId)).toHaveLength(0);
    expect(listCheckpointsBySession(db, other)).toHaveLength(1);
  });

  test('listCheckpointsOlderThan honours the cutoff', () => {
    insertCheckpoint(db, {
      sessionId,
      stepId: 's1',
      gitRef: 'old',
      hadBash: false,
      createdAt: 100,
    });
    insertCheckpoint(db, {
      sessionId,
      stepId: 's2',
      gitRef: 'mid',
      hadBash: false,
      createdAt: 500,
    });
    insertCheckpoint(db, {
      sessionId,
      stepId: 's3',
      gitRef: 'new',
      hadBash: false,
      createdAt: 1_000,
    });

    const aged = listCheckpointsOlderThan(db, 500);
    expect(aged.map((c) => c.gitRef)).toEqual(['old']);
  });

  test('listCheckpointsOlderThan with cwd scopes to that project only', () => {
    // Two sessions in different cwds, both with aged-out rows. The
    // cwd-scoped variant returns only the local one — protects the
    // lazy retention sweep from crossing project boundaries.
    const otherSession = createSession(db, { model: 'm', cwd: '/other' }).id;
    insertCheckpoint(db, {
      sessionId,
      stepId: 's1',
      gitRef: 'local',
      hadBash: false,
      createdAt: 100,
    });
    insertCheckpoint(db, {
      sessionId: otherSession,
      stepId: 's2',
      gitRef: 'foreign',
      hadBash: false,
      createdAt: 100,
    });

    const aged = listCheckpointsOlderThan(db, 500, '/p');
    expect(aged.map((c) => c.gitRef)).toEqual(['local']);
  });

  test('listCheckpointsOlderThan without cwd returns rows globally', () => {
    // Backwards-compatible signature: undefined cwd preserves the
    // pre-fix shape for any future tooling that wants a cross-project
    // sweep.
    const otherSession = createSession(db, { model: 'm', cwd: '/other' }).id;
    insertCheckpoint(db, {
      sessionId,
      stepId: 's1',
      gitRef: 'a',
      hadBash: false,
      createdAt: 100,
    });
    insertCheckpoint(db, {
      sessionId: otherSession,
      stepId: 's2',
      gitRef: 'b',
      hadBash: false,
      createdAt: 100,
    });

    const aged = listCheckpointsOlderThan(db, 500);
    expect(aged.map((c) => c.gitRef).sort()).toEqual(['a', 'b']);
  });

  test('cascade: deleting a session drops its checkpoints', () => {
    insertCheckpoint(db, { sessionId, stepId: 's1', gitRef: 'a', hadBash: false });
    db.query('DELETE FROM sessions WHERE id = ?').run(sessionId);
    expect(listCheckpointsBySession(db, sessionId)).toHaveLength(0);
  });
});
