import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runListSessions } from '../../src/cli/list-sessions.ts';
import { type DB, openDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import { completeSession, createSession } from '../../src/storage/repos/sessions.ts';

let tempDir: string;
let dbPath: string;
let db: DB;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'forja-list-sessions-'));
  dbPath = join(tempDir, 'agent.sqlite');
  db = openDb(dbPath);
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('runListSessions', () => {
  test('empty DB prints "no sessions found"', () => {
    const out: string[] = [];
    const code = runListSessions({
      json: false,
      dbOverride: db,
      out: (s) => out.push(s),
    });
    expect(code).toBe(0);
    expect(out.join('')).toContain('no sessions');
  });

  test('json mode emits one NDJSON line per session, newest first', () => {
    const a = createSession(db, { model: 'mock/a', cwd: '/p', startedAt: 1000 });
    const b = createSession(db, { model: 'mock/b', cwd: '/p', startedAt: 2000 });
    appendMessage(db, { sessionId: a.id, role: 'user', content: 'first prompt' });
    appendMessage(db, { sessionId: b.id, role: 'user', content: 'second prompt' });
    completeSession(db, a.id, 'done', 0.0123, true);

    const out: string[] = [];
    runListSessions({ json: true, dbOverride: db, out: (s) => out.push(s) });
    const lines = out.join('').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? '{}') as { id: string; status: string };
    const second = JSON.parse(lines[1] ?? '{}') as { id: string; status: string };
    expect(first.id).toBe(b.id); // newest first
    expect(first.status).toBe('running');
    expect(second.id).toBe(a.id);
    expect(second.status).toBe('done');
  });

  test('json mode includes prompt_preview from first user message', () => {
    const s = createSession(db, { model: 'mock/a', cwd: '/p' });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'list the source files' });
    const out: string[] = [];
    runListSessions({ json: true, dbOverride: db, out: (s) => out.push(s) });
    const item = JSON.parse(out[0] ?? '{}') as { prompt_preview: string };
    expect(item.prompt_preview).toBe('list the source files');
  });

  test('truncates long prompt_preview', () => {
    const s = createSession(db, { model: 'mock/a', cwd: '/p' });
    const longPrompt = 'x'.repeat(200);
    appendMessage(db, { sessionId: s.id, role: 'user', content: longPrompt });
    const out: string[] = [];
    runListSessions({ json: true, dbOverride: db, out: (s) => out.push(s) });
    const item = JSON.parse(out[0] ?? '{}') as { prompt_preview: string };
    // Truncated to 80 with the ellipsis sentinel.
    expect(item.prompt_preview.length).toBeLessThanOrEqual(80);
    expect(item.prompt_preview.endsWith('…')).toBe(true);
  });

  test('table mode prints a header and one row per session', () => {
    const s = createSession(db, { model: 'mock/a', cwd: '/p' });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'a prompt' });
    const out: string[] = [];
    runListSessions({ json: false, dbOverride: db, out: (s) => out.push(s) });
    const text = out.join('');
    expect(text).toContain('STARTED');
    expect(text).toContain(s.id);
    expect(text).toContain('a prompt');
  });

  test('respects custom limit', () => {
    for (let i = 0; i < 5; i++) {
      const s = createSession(db, { model: 'mock/a', cwd: '/p', startedAt: 1000 + i });
      appendMessage(db, { sessionId: s.id, role: 'user', content: `p${i}` });
    }
    const out: string[] = [];
    runListSessions({ json: true, limit: 3, dbOverride: db, out: (s) => out.push(s) });
    const lines = out.join('').trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  test('handles a session with no messages (preview is empty string)', () => {
    // Race window: session created but prompt not yet appended.
    // The listing must not crash.
    createSession(db, { model: 'mock/a', cwd: '/p' });
    const out: string[] = [];
    runListSessions({ json: true, dbOverride: db, out: (s) => out.push(s) });
    const item = JSON.parse(out[0] ?? '{}') as { prompt_preview: string };
    expect(item.prompt_preview).toBe('');
  });
});
