import { beforeEach, describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../../src/storage/db.ts';
import type { DB } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import {
  createToolCall,
  finishToolCall,
  getToolCall,
  listToolCallsByMessage,
  startToolCall,
} from '../../src/storage/repos/tool-calls.ts';

let db: DB;
let messageId: string;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  const s = createSession(db, { model: 'm', cwd: '/p' });
  messageId = appendMessage(db, { sessionId: s.id, role: 'assistant', content: 'x' }).id;
});

describe('tool_calls repo', () => {
  test('creates a pending tool call', () => {
    const tc = createToolCall(db, {
      messageId,
      toolName: 'read_file',
      input: { path: '/etc/hosts' },
    });
    expect(tc.status).toBe('pending');
    expect(tc.input).toEqual({ path: '/etc/hosts' });
    expect(tc.output).toBeNull();
    expect(tc.error).toBeNull();
    expect(tc.durationMs).toBeNull();
  });

  test('lifecycle: pending -> running -> done', () => {
    const tc = createToolCall(db, {
      messageId,
      toolName: 'read_file',
      input: { path: '/x' },
    });
    startToolCall(db, tc.id);
    expect(getToolCall(db, tc.id)?.status).toBe('running');
    finishToolCall(db, {
      id: tc.id,
      status: 'done',
      output: { contents: 'data' },
      durationMs: 42,
    });
    const after = getToolCall(db, tc.id);
    expect(after?.status).toBe('done');
    expect(after?.output).toEqual({ contents: 'data' });
    expect(after?.durationMs).toBe(42);
  });

  test('finishToolCall stores error message and leaves output null', () => {
    const tc = createToolCall(db, { messageId, toolName: 'bash', input: { cmd: 'false' } });
    finishToolCall(db, { id: tc.id, status: 'error', durationMs: 10, error: 'exit 1' });
    const after = getToolCall(db, tc.id);
    expect(after?.status).toBe('error');
    expect(after?.error).toBe('exit 1');
    expect(after?.output).toBeNull();
  });

  test('startToolCall rejects non-pending state', () => {
    const tc = createToolCall(db, { messageId, toolName: 'read_file', input: {} });
    startToolCall(db, tc.id);
    expect(() => startToolCall(db, tc.id)).toThrow(/not pending/);
  });

  test('startToolCall rejects unknown id', () => {
    expect(() => startToolCall(db, 'nope')).toThrow(/not found/);
  });

  test('finishToolCall rejects unknown id', () => {
    expect(() => finishToolCall(db, { id: 'nope', status: 'done', durationMs: 0 })).toThrow(
      /not found/,
    );
  });

  test('listToolCallsByMessage scopes to a single message', () => {
    createToolCall(db, { messageId, toolName: 't1', input: {} });
    createToolCall(db, { messageId, toolName: 't2', input: {} });
    const s2 = createSession(db, { model: 'm', cwd: '/p' });
    const m2 = appendMessage(db, { sessionId: s2.id, role: 'assistant', content: 'y' });
    createToolCall(db, { messageId: m2.id, toolName: 't3', input: {} });
    expect(listToolCallsByMessage(db, messageId)).toHaveLength(2);
    expect(listToolCallsByMessage(db, m2.id)).toHaveLength(1);
  });

  test('createToolCall stamps createdAt automatically', () => {
    const before = Date.now();
    const tc = createToolCall(db, { messageId, toolName: 't', input: {} });
    const after = Date.now();
    expect(tc.createdAt).toBeGreaterThanOrEqual(before);
    expect(tc.createdAt).toBeLessThanOrEqual(after);
  });

  test('listToolCallsByMessage orders by createdAt ASC then id', () => {
    createToolCall(db, { messageId, toolName: 'a', input: {}, createdAt: 200 });
    createToolCall(db, { messageId, toolName: 'b', input: {}, createdAt: 100 });
    createToolCall(db, { messageId, toolName: 'c', input: {}, createdAt: 300 });
    const list = listToolCallsByMessage(db, messageId);
    expect(list.map((tc) => tc.toolName)).toEqual(['b', 'a', 'c']);
  });

  test('finishToolCall refuses to overwrite a finished call', () => {
    const tc = createToolCall(db, { messageId, toolName: 'r', input: {} });
    finishToolCall(db, { id: tc.id, status: 'done', durationMs: 5 });
    expect(() =>
      finishToolCall(db, { id: tc.id, status: 'error', durationMs: 5, error: 'oops' }),
    ).toThrow(/cannot be finished from status 'done'/);
  });

  test('finishToolCall accepts pending (skips running) for denied/error', () => {
    const tc = createToolCall(db, { messageId, toolName: 'r', input: {} });
    finishToolCall(db, { id: tc.id, status: 'denied', durationMs: 0 });
    expect(getToolCall(db, tc.id)?.status).toBe('denied');
  });

  test('cascades on message delete', () => {
    createToolCall(db, { messageId, toolName: 't', input: {} });
    db.query('DELETE FROM messages WHERE id = ?').run(messageId);
    expect(listToolCallsByMessage(db, messageId)).toEqual([]);
  });

  test('CHECK constraint rejects invalid status', () => {
    expect(() =>
      db
        .query(
          `INSERT INTO tool_calls (id, message_id, tool_name, input, status)
           VALUES (?, ?, 't', '{}', 'bogus')`,
        )
        .run(crypto.randomUUID(), messageId),
    ).toThrow();
  });
});
