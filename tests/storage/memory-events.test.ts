import { beforeEach, describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../../src/storage/db.ts';
import type { DB } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  createMemoryEvent,
  listMemoryEventsByName,
  listMemoryEventsBySession,
} from '../../src/storage/repos/memory-events.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;
let sessionId: string;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
});

describe('memory_events repo', () => {
  test('inserts and reads back a basic event', () => {
    const event = createMemoryEvent(db, {
      scope: 'project_local',
      action: 'created',
      memoryName: 'commit-style',
      source: 'inferred',
      sessionId,
      cwd: '/p',
      details: { reason: 'first write' },
    });
    expect(event.id).toBeString();
    expect(event.scope).toBe('project_local');
    expect(event.action).toBe('created');
    expect(event.memoryName).toBe('commit-style');
    expect(event.source).toBe('inferred');
    expect(event.sessionId).toBe(sessionId);
    expect(event.cwd).toBe('/p');
    expect(event.details).toEqual({ reason: 'first write' });
    expect(event.createdAt).toBeGreaterThan(0);
  });

  test('listMemoryEventsBySession returns chronological order', () => {
    createMemoryEvent(db, {
      scope: 'user',
      action: 'proposed',
      memoryName: 'a',
      source: 'inferred',
      sessionId,
      createdAt: 200,
    });
    createMemoryEvent(db, {
      scope: 'user',
      action: 'created',
      memoryName: 'a',
      source: 'inferred',
      sessionId,
      createdAt: 100,
    });
    createMemoryEvent(db, {
      scope: 'user',
      action: 'read',
      memoryName: 'a',
      source: 'inferred',
      sessionId,
      createdAt: 300,
    });
    const list = listMemoryEventsBySession(db, sessionId);
    expect(list.map((e) => e.action)).toEqual(['created', 'proposed', 'read']);
  });

  test('listMemoryEventsByName returns most-recent first and respects limit', () => {
    for (let i = 1; i <= 5; i++) {
      createMemoryEvent(db, {
        scope: 'project_shared',
        action: 'edited',
        memoryName: 'team-conv',
        source: 'user_explicit',
        sessionId,
        createdAt: i * 100,
      });
    }
    const all = listMemoryEventsByName(db, 'team-conv');
    expect(all.map((e) => e.createdAt)).toEqual([500, 400, 300, 200, 100]);
    const top2 = listMemoryEventsByName(db, 'team-conv', 2);
    expect(top2.map((e) => e.createdAt)).toEqual([500, 400]);
  });

  test('listMemoryEventsByName is empty for unknown name', () => {
    expect(listMemoryEventsByName(db, 'never-existed')).toEqual([]);
  });

  test('FK SET NULL preserves audit row when session is purged', () => {
    createMemoryEvent(db, {
      scope: 'user',
      action: 'created',
      memoryName: 'persist-me',
      source: 'user_explicit',
      sessionId,
    });
    db.query('DELETE FROM sessions WHERE id = ?').run(sessionId);
    const list = listMemoryEventsByName(db, 'persist-me');
    expect(list).toHaveLength(1);
    expect(list[0]?.sessionId).toBeNull();
  });

  test('null session_id is allowed (events outside any session)', () => {
    const event = createMemoryEvent(db, {
      scope: 'user',
      action: 'expired',
      memoryName: 'old-thing',
      source: 'inferred',
    });
    expect(event.sessionId).toBeNull();
    expect(event.cwd).toBeNull();
  });

  test('CHECK rejects invalid scope', () => {
    expect(() =>
      db
        .query(
          `INSERT INTO memory_events (id, scope, action, memory_name, source, created_at)
           VALUES (?, 'bogus', 'created', 'x', 'inferred', 0)`,
        )
        .run(crypto.randomUUID()),
    ).toThrow();
  });

  test('CHECK rejects invalid action', () => {
    expect(() =>
      db
        .query(
          `INSERT INTO memory_events (id, scope, action, memory_name, source, created_at)
           VALUES (?, 'user', 'pondered', 'x', 'inferred', 0)`,
        )
        .run(crypto.randomUUID()),
    ).toThrow();
  });

  test('CHECK rejects invalid source', () => {
    expect(() =>
      db
        .query(
          `INSERT INTO memory_events (id, scope, action, memory_name, source, created_at)
           VALUES (?, 'user', 'created', 'x', 'rumored', 0)`,
        )
        .run(crypto.randomUUID()),
    ).toThrow();
  });

  test('malformed JSON in details is read back as null without crashing', () => {
    const id = crypto.randomUUID();
    db.query(
      `INSERT INTO memory_events (id, scope, action, memory_name, source, created_at, details)
       VALUES (?, 'user', 'created', 'x', 'inferred', 0, '{not valid json')`,
    ).run(id);
    const list = listMemoryEventsByName(db, 'x');
    expect(list).toHaveLength(1);
    expect(list[0]?.details).toBeNull();
  });

  test('all nine action verbs are accepted', () => {
    const actions = [
      'proposed',
      'created',
      'edited',
      'deleted',
      'read',
      'refused',
      'promoted',
      'demoted',
      'expired',
    ] as const;
    for (const action of actions) {
      createMemoryEvent(db, {
        scope: 'user',
        action,
        memoryName: 'verbs',
        source: 'user_explicit',
      });
    }
    expect(listMemoryEventsByName(db, 'verbs')).toHaveLength(actions.length);
  });
});
