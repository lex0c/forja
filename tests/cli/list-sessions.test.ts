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

  test('subagent rows are hidden by default', () => {
    // The dominant case is "show me my own runs". A user who
    // invoked `task()` should see ONE row, not the parent + N
    // subagent children inflating the listing. The default omits
    // children; --include-subagents fans them in.
    const parent = createSession(db, { model: 'mock/a', cwd: '/p' });
    appendMessage(db, { sessionId: parent.id, role: 'user', content: 'parent prompt' });
    createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: parent.id,
    });
    createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: parent.id,
    });
    const out: string[] = [];
    runListSessions({ json: true, dbOverride: db, out: (s) => out.push(s) });
    const lines = out
      .join('')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const item = JSON.parse(lines[0] ?? '{}') as {
      id: string;
      parent_session_id: string | null;
    };
    expect(item.id).toBe(parent.id);
    expect(item.parent_session_id).toBeNull();
  });

  test('--include-subagents fans children under their parent', () => {
    const parent = createSession(db, { model: 'mock/a', cwd: '/p', startedAt: 1000 });
    appendMessage(db, { sessionId: parent.id, role: 'user', content: 'parent prompt' });
    const c1 = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: parent.id,
      startedAt: 1100,
    });
    const c2 = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: parent.id,
      startedAt: 1200,
    });
    const out: string[] = [];
    runListSessions({
      json: true,
      includeSubagents: true,
      dbOverride: db,
      out: (s) => out.push(s),
    });
    const lines = out
      .join('')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    // Order: parent first (newest of the top-level pool), then its
    // children oldest-first.
    const parsed = lines.map(
      (l) => JSON.parse(l) as { id: string; parent_session_id: string | null },
    );
    expect(parsed[0]?.id).toBe(parent.id);
    expect(parsed[0]?.parent_session_id).toBeNull();
    expect(parsed[1]?.id).toBe(c1.id);
    expect(parsed[1]?.parent_session_id).toBe(parent.id);
    expect(parsed[2]?.id).toBe(c2.id);
    expect(parsed[2]?.parent_session_id).toBe(parent.id);
  });

  test('table mode marks subagent rows with the ↳ indent', () => {
    const parent = createSession(db, { model: 'mock/a', cwd: '/p' });
    appendMessage(db, { sessionId: parent.id, role: 'user', content: 'p' });
    const child = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: parent.id,
      startedAt: parent.startedAt + 1,
    });
    const out: string[] = [];
    runListSessions({
      json: false,
      includeSubagents: true,
      dbOverride: db,
      out: (s) => out.push(s),
    });
    const text = out.join('');
    expect(text).toContain(parent.id);
    expect(text).toContain(`↳ ${child.id}`);
  });
});
