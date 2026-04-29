import { beforeEach, describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../../src/storage/db.ts';
import type { DB } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  appendMessage,
  getMessage,
  listMessagesBySession,
} from '../../src/storage/repos/messages.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;
let sessionId: string;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
});

describe('messages repo', () => {
  test('appends and reads back a user message', () => {
    const m = appendMessage(db, {
      sessionId,
      role: 'user',
      content: { text: 'hello' },
    });
    const fetched = getMessage(db, m.id);
    expect(fetched).toEqual(m);
    expect(fetched?.content).toEqual({ text: 'hello' });
  });

  test('preserves complex JSON content roundtrip', () => {
    const content = {
      blocks: [
        { type: 'text', text: 'olá' },
        { type: 'tool_use', id: 't1', name: 'read_file', input: { path: '/x' } },
      ],
    };
    const m = appendMessage(db, { sessionId, role: 'assistant', content });
    expect(getMessage(db, m.id)?.content).toEqual(content);
  });

  test('preserves token counts when supplied', () => {
    const m = appendMessage(db, {
      sessionId,
      role: 'assistant',
      content: 'reply',
      tokensIn: 100,
      tokensOut: 50,
      cachedTokens: 80,
    });
    const fetched = getMessage(db, m.id);
    expect(fetched?.tokensIn).toBe(100);
    expect(fetched?.tokensOut).toBe(50);
    expect(fetched?.cachedTokens).toBe(80);
  });

  test('listMessagesBySession orders by insertion seq, not created_at', () => {
    // Migration 007 introduced an explicit `seq` column populated
    // at INSERT time so resume replay sees turns in the order they
    // were appended — not the order their timestamps suggest. The
    // assertion here looks counter-intuitive (c has the smallest
    // createdAt but appears LAST) by design: in production every
    // append uses Date.now(), so insertion order equals timestamp
    // order; a test that overrides createdAt out-of-band exposes
    // the divergence and confirms seq wins. Critical for resume:
    // without this, an assistant message with tool_use blocks
    // could land after the user message with the matching
    // tool_result blocks, producing an invalid conversation.
    appendMessage(db, { sessionId, role: 'user', content: 'a', createdAt: 100 });
    appendMessage(db, { sessionId, role: 'assistant', content: 'b', createdAt: 200 });
    appendMessage(db, { sessionId, role: 'user', content: 'c', createdAt: 50 });
    const list = listMessagesBySession(db, sessionId);
    expect(list.map((m) => m.content)).toEqual(['a', 'b', 'c']);
  });

  test('listMessagesBySession ties on same created_at follow insertion order', () => {
    // Direct regression for the bug Migration 007 closes. Two
    // appends at exactly the same created_at would, under the old
    // ORDER BY created_at, id, fall back to UUID lex sort —
    // random for v4. With seq the order is deterministic.
    const ms = 1_700_000_000_000;
    for (let i = 0; i < 10; i++) {
      appendMessage(db, { sessionId, role: 'user', content: `m${i}`, createdAt: ms });
    }
    const list = listMessagesBySession(db, sessionId);
    expect(list.map((m) => m.content)).toEqual([
      'm0',
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
      'm6',
      'm7',
      'm8',
      'm9',
    ]);
  });

  test('cascades on session delete', () => {
    appendMessage(db, { sessionId, role: 'user', content: 'x' });
    db.query('DELETE FROM sessions WHERE id = ?').run(sessionId);
    expect(listMessagesBySession(db, sessionId)).toEqual([]);
  });

  test('FK rejects message with unknown session_id', () => {
    expect(() =>
      appendMessage(db, { sessionId: 'no-such-session', role: 'user', content: 'x' }),
    ).toThrow();
  });

  test('parent_id chains messages', () => {
    const a = appendMessage(db, { sessionId, role: 'user', content: 'a' });
    const b = appendMessage(db, {
      sessionId,
      role: 'assistant',
      content: 'b',
      parentId: a.id,
    });
    expect(getMessage(db, b.id)?.parentId).toBe(a.id);
  });

  test('rejects parent_id from a different session', () => {
    const otherSession = createSession(db, { model: 'm', cwd: '/other' });
    const otherMsg = appendMessage(db, {
      sessionId: otherSession.id,
      role: 'user',
      content: 'x',
    });
    expect(() =>
      appendMessage(db, {
        sessionId,
        role: 'assistant',
        content: 'y',
        parentId: otherMsg.id,
      }),
    ).toThrow(/belongs to session/);
  });

  test('rejects unknown parent_id with a clear error', () => {
    expect(() =>
      appendMessage(db, {
        sessionId,
        role: 'assistant',
        content: 'y',
        parentId: 'nope',
      }),
    ).toThrow(/parent message nope not found/);
  });

  test('CHECK constraint rejects invalid role', () => {
    expect(() =>
      db
        .query(
          `INSERT INTO messages (id, session_id, role, content, created_at)
           VALUES (?, ?, 'bogus', '"x"', 0)`,
        )
        .run(crypto.randomUUID(), sessionId),
    ).toThrow();
  });
});
