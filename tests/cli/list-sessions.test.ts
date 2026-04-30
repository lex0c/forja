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
      (l) =>
        JSON.parse(l) as {
          id: string;
          parent_session_id: string | null;
          depth: number;
        },
    );
    expect(parsed[0]?.id).toBe(parent.id);
    expect(parsed[0]?.parent_session_id).toBeNull();
    expect(parsed[0]?.depth).toBe(0);
    expect(parsed[1]?.id).toBe(c1.id);
    expect(parsed[1]?.parent_session_id).toBe(parent.id);
    expect(parsed[1]?.depth).toBe(1);
    expect(parsed[2]?.id).toBe(c2.id);
    expect(parsed[2]?.parent_session_id).toBe(parent.id);
    expect(parsed[2]?.depth).toBe(1);
  });

  test('--include-subagents recursively walks the full descendant tree', () => {
    // Recursion contract: subagents can spawn subagents up to
    // MAX_SUBAGENT_DEPTH=4. The listing must surface all of them
    // when --include-subagents is set, not just the immediate
    // children — otherwise a debugging session inspecting a deep
    // playbook chain can't find the grandchild's session id for
    // follow-up commands. DFS order: parent, then full subtree
    // (oldest sibling first), then next top-level row.
    const parent = createSession(db, { model: 'mock/a', cwd: '/p', startedAt: 1000 });
    appendMessage(db, { sessionId: parent.id, role: 'user', content: 'parent' });
    const child = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: parent.id,
      startedAt: 1100,
    });
    const grandchild = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: child.id,
      startedAt: 1200,
    });
    const greatGrandchild = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: grandchild.id,
      startedAt: 1300,
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
    expect(lines).toHaveLength(4);
    const parsed = lines.map(
      (l) =>
        JSON.parse(l) as {
          id: string;
          parent_session_id: string | null;
          depth: number;
        },
    );
    expect(parsed[0]?.id).toBe(parent.id);
    expect(parsed[0]?.depth).toBe(0);
    expect(parsed[1]?.id).toBe(child.id);
    expect(parsed[1]?.depth).toBe(1);
    expect(parsed[2]?.id).toBe(grandchild.id);
    expect(parsed[2]?.depth).toBe(2);
    expect(parsed[3]?.id).toBe(greatGrandchild.id);
    expect(parsed[3]?.depth).toBe(3);
  });

  test('--include-subagents handles a self-referential row without looping', () => {
    // Defense in depth: parent_session_id is a FK but SQLite does
    // NOT prevent a row from referencing itself. A corrupt write
    // (or a future migration accident) could insert a self-loop;
    // the listing must not deadlock on it. The `seen` guard in
    // fanOut catches the cycle on the second visit and emits the
    // row exactly once.
    const s = createSession(db, { model: 'mock/a', cwd: '/p' });
    db.query('UPDATE sessions SET parent_session_id = id WHERE id = ?').run(s.id);
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'looped' });
    const out: string[] = [];
    runListSessions({
      json: true,
      includeSubagents: true,
      dbOverride: db,
      out: (s) => out.push(s),
    });
    // The row is is_subagent=false (created as top-level) so it
    // surfaces as a root. fanOut visits it, then walks children:
    // listChildSessions returns the same row (self-reference),
    // but the seen guard short-circuits before recursing. Result:
    // exactly one line, no infinite loop, no duplicates.
    const lines = out
      .join('')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '{}') as { id: string; depth: number };
    expect(parsed.id).toBe(s.id);
    expect(parsed.depth).toBe(0);
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
