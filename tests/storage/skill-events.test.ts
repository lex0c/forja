import { beforeEach, describe, expect, test } from 'bun:test';
import type { DB } from '../../src/storage/db.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import {
  createSkillEvent,
  listRecentSkillEvents,
  listSkillEventsByName,
  listSkillEventsBySession,
  type SkillEventAction,
  type SkillEventScope,
} from '../../src/storage/repos/skill-events.ts';

let db: DB;
let sessionId: string;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
});

describe('skill_events repo', () => {
  test('inserts and reads back an event', () => {
    const event = createSkillEvent(db, {
      scope: 'project_shared',
      action: 'invoked',
      skillName: 'git-bisect-regression',
      sessionId,
      cwd: '/p',
      details: { outcome: 'ok' },
    });
    expect(event.id).toBeString();
    expect(event.scope).toBe('project_shared');
    expect(event.action).toBe('invoked');
    expect(event.skillName).toBe('git-bisect-regression');
    expect(event.sessionId).toBe(sessionId);
    expect(event.cwd).toBe('/p');
    expect(event.details).toEqual({ outcome: 'ok' });
    expect(event.createdAt).toBeGreaterThan(0);
    expect(listSkillEventsBySession(db, sessionId)[0]).toEqual(event);
  });

  test('details is null when absent', () => {
    createSkillEvent(db, { scope: 'user', action: 'surfaced', skillName: 'x', sessionId });
    expect(listSkillEventsBySession(db, sessionId)[0]?.details).toBeNull();
  });

  test('listSkillEventsBySession returns chronological order', () => {
    createSkillEvent(db, {
      scope: 'user',
      action: 'invoked',
      skillName: 'a',
      sessionId,
      createdAt: 200,
    });
    createSkillEvent(db, {
      scope: 'user',
      action: 'surfaced',
      skillName: 'a',
      sessionId,
      createdAt: 100,
    });
    createSkillEvent(db, {
      scope: 'user',
      action: 'filtered',
      skillName: 'a',
      sessionId,
      createdAt: 300,
    });
    expect(listSkillEventsBySession(db, sessionId).map((e) => e.action)).toEqual([
      'surfaced',
      'invoked',
      'filtered',
    ]);
  });

  test('listSkillEventsByName returns most-recent-first and respects limit', () => {
    createSkillEvent(db, {
      scope: 'user',
      action: 'surfaced',
      skillName: 'deploy',
      sessionId,
      createdAt: 100,
    });
    createSkillEvent(db, {
      scope: 'user',
      action: 'invoked',
      skillName: 'deploy',
      sessionId,
      createdAt: 300,
    });
    createSkillEvent(db, {
      scope: 'user',
      action: 'invoked',
      skillName: 'other',
      sessionId,
      createdAt: 200,
    });
    expect(listSkillEventsByName(db, 'deploy').map((e) => e.action)).toEqual([
      'invoked',
      'surfaced',
    ]);
    expect(listSkillEventsByName(db, 'deploy', 1).map((e) => e.action)).toEqual(['invoked']);
  });

  test('listRecentSkillEvents caps and orders by recency', () => {
    for (let i = 0; i < 5; i++) {
      createSkillEvent(db, {
        scope: 'user',
        action: 'surfaced',
        skillName: `s${i}`,
        sessionId,
        createdAt: i + 1,
      });
    }
    const recent = listRecentSkillEvents(db, 3);
    expect(recent.map((e) => e.skillName)).toEqual(['s4', 's3', 's2']);
  });

  test('the action CHECK constraint rejects an unknown verb', () => {
    expect(() =>
      createSkillEvent(db, {
        scope: 'user',
        action: 'bogus' as SkillEventAction,
        skillName: 'x',
        sessionId,
      }),
    ).toThrow();
  });

  test('the scope CHECK constraint rejects an unknown scope', () => {
    expect(() =>
      createSkillEvent(db, {
        scope: 'imported' as SkillEventScope,
        action: 'surfaced',
        skillName: 'x',
        sessionId,
      }),
    ).toThrow();
  });

  test('the session FK sets session_id NULL when the session is deleted', () => {
    createSkillEvent(db, { scope: 'user', action: 'invoked', skillName: 'survivor', sessionId });
    db.query('DELETE FROM sessions WHERE id = ?').run(sessionId);
    const events = listSkillEventsByName(db, 'survivor');
    expect(events).toHaveLength(1);
    expect(events[0]?.sessionId).toBeNull();
  });

  test('a corrupt details blob is read back as null, not a crash', () => {
    db.query(
      `INSERT INTO skill_events
         (id, scope, action, skill_name, session_id, cwd, created_at, details)
       VALUES (?, 'user', 'surfaced', 'corrupt', ?, NULL, ?, ?)`,
    ).run('id-corrupt', sessionId, 1, '{not valid json');
    const [event] = listSkillEventsBySession(db, sessionId);
    expect(event?.skillName).toBe('corrupt');
    expect(event?.details).toBeNull();
  });
});
