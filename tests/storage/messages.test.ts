import { beforeEach, describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../../src/storage/db.ts';
import type { DB } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  appendMessage,
  getMessage,
  listMessageTailBySession,
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

  test('source defaults to operator and round-trips an explicit system source (migration 075)', () => {
    const op = appendMessage(db, { sessionId, role: 'user', content: 'hi' });
    expect(op.source).toBe('operator');
    expect(getMessage(db, op.id)?.source).toBe('operator');

    const sys = appendMessage(db, {
      sessionId,
      role: 'user',
      content: '[background] done',
      source: 'system',
    });
    expect(sys.source).toBe('system');
    expect(getMessage(db, sys.id)?.source).toBe('system');
    // And survives the list path (what --resume reads).
    const listed = listMessagesBySession(db, sessionId).find((m) => m.id === sys.id);
    expect(listed?.source).toBe('system');
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

  test('preserves a reasoning block (opaque data byte-identical) through persist→read→list', () => {
    // The reasoning-replay contract: a captured reasoning block must survive the
    // DB round-trip with its `data` (signature / encrypted item) byte-identical,
    // or replay on the resumed session 400s. Covers both the single-message read
    // and the list path that --resume / messagesToProviderMessages consume.
    const sig = 'AbC123==/+signature-with-base64-and-symbols';
    const content = [
      { type: 'reasoning', provider: 'anthropic', data: { thinking: 'reasoned', signature: sig } },
      {
        type: 'reasoning',
        provider: 'openai',
        data: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC==' },
      },
      { type: 'text', text: 'answer' },
    ];
    const m = appendMessage(db, { sessionId, role: 'assistant', content });
    expect(getMessage(db, m.id)?.content).toEqual(content);
    const back = getMessage(db, m.id)?.content as Array<{ data?: { signature?: string } }>;
    expect(back[0]?.data?.signature).toBe(sig);
    const listed = listMessagesBySession(db, sessionId).find((x) => x.id === m.id);
    expect(listed?.content).toEqual(content);
  });

  test('persists and reads back effort (regression-attribution column)', () => {
    const m = appendMessage(db, {
      sessionId,
      role: 'assistant',
      content: 'reply',
      effort: 'high',
    });
    expect(m.effort).toBe('high');
    // Round-trips through every read path (each SELECT lists the column).
    expect(getMessage(db, m.id)?.effort).toBe('high');
    expect(listMessagesBySession(db, sessionId)[0]?.effort).toBe('high');
    expect(listMessageTailBySession(db, sessionId, 10).messages[0]?.effort).toBe('high');
  });

  test('effort defaults to null when omitted (e.g. user/tool rows)', () => {
    const m = appendMessage(db, { sessionId, role: 'user', content: 'hi' });
    expect(m.effort).toBeNull();
    expect(getMessage(db, m.id)?.effort).toBeNull();
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

  test('listMessageTailBySession bounds the row count regardless of session size', () => {
    // Regression: resume's hydration was previously reading the
    // full log into JS via listMessagesBySession and slicing in
    // memory — a 50k-message session would OOM despite the cap.
    // The bounded variant pushes the limit into SQL so the JS
    // heap never sees more than `limit` rows.
    for (let i = 0; i < 200; i++) {
      appendMessage(db, { sessionId, role: 'user', content: `msg-${i}` });
    }
    const tail = listMessageTailBySession(db, sessionId, 50);
    expect(tail.totalCount).toBe(200);
    expect(tail.messages).toHaveLength(50);
    // Tail is the most-recent 50, oldest-first within the slice.
    expect(tail.messages[0]?.content).toBe('msg-150');
    expect(tail.messages[49]?.content).toBe('msg-199');
  });

  test('listMessageTailBySession returns all rows when session is smaller than limit', () => {
    for (let i = 0; i < 5; i++) {
      appendMessage(db, { sessionId, role: 'user', content: `msg-${i}` });
    }
    const tail = listMessageTailBySession(db, sessionId, 100);
    expect(tail.totalCount).toBe(5);
    expect(tail.messages).toHaveLength(5);
    expect(tail.messages.map((m) => m.content)).toEqual([
      'msg-0',
      'msg-1',
      'msg-2',
      'msg-3',
      'msg-4',
    ]);
  });

  test('listMessageTailBySession on empty session returns 0/0', () => {
    const tail = listMessageTailBySession(db, sessionId, 100);
    expect(tail.totalCount).toBe(0);
    expect(tail.messages).toEqual([]);
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
