import { beforeEach, describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../../src/storage/db.ts';
import type { DB } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { appendCompactionEvent } from '../../src/storage/repos/compaction-events.ts';
import {
  appendMessage,
  countMessagesBySession,
  distinctSessionModels,
  effectiveSessionModels,
  getMessage,
  listMessageTailBySession,
  listMessagesBySession,
  retractMessage,
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

  test('countMessagesBySession excludes retracted (un-sent) rows (migration 079)', () => {
    const u = appendMessage(db, { sessionId, role: 'user', content: 'oops' });
    appendMessage(db, { sessionId, role: 'assistant', content: 'reply' });
    expect(countMessagesBySession(db, sessionId)).toBe(2);
    retractMessage(db, u.id);
    // The un-sent row is excluded so the resume "loaded N into context" count
    // matches what the hydrate path actually loads.
    expect(countMessagesBySession(db, sessionId)).toBe(1);
  });

  test('records the per-turn model on assistant rows and round-trips it (migration 077)', () => {
    const a = appendMessage(db, {
      sessionId,
      role: 'assistant',
      content: 'hi',
      costUsd: 0.01,
      model: 'anthropic/claude-opus-4-8',
    });
    expect(a.model).toBe('anthropic/claude-opus-4-8');
    expect(getMessage(db, a.id)?.model).toBe('anthropic/claude-opus-4-8');
    // Defaults to null when not supplied (user / tool rows have no model).
    const u = appendMessage(db, { sessionId, role: 'user', content: 'q' });
    expect(u.model).toBeNull();
    expect(getMessage(db, u.id)?.model).toBeNull();
  });

  test('distinctSessionModels returns the distinct non-null models that billed the session', () => {
    // A session that started on one model and /model-switched to another.
    appendMessage(db, { sessionId, role: 'assistant', content: 'a', model: 'ollama/glm-5.2' });
    appendMessage(db, { sessionId, role: 'user', content: 'q' }); // no model
    appendMessage(db, { sessionId, role: 'assistant', content: 'b', model: 'ollama/glm-5.2' }); // dup
    appendMessage(db, {
      sessionId,
      role: 'assistant',
      content: 'c',
      model: 'anthropic/claude-opus-4-8',
    });
    expect(distinctSessionModels(db, sessionId).sort()).toEqual([
      'anthropic/claude-opus-4-8',
      'ollama/glm-5.2',
    ]);
    // A session with no recorded model → empty (caller falls back to sessions.model).
    const other = createSession(db, { model: 'm', cwd: '/p' }).id;
    appendMessage(db, { sessionId: other, role: 'user', content: 'q' });
    expect(distinctSessionModels(db, other)).toEqual([]);
  });

  test('effectiveSessionModels returns per-turn models, else [fallback] when none recorded', () => {
    appendMessage(db, { sessionId, role: 'assistant', content: 'a', model: 'ollama/glm-5.2' });
    expect(effectiveSessionModels(db, sessionId, 'fallback/x')).toEqual(['ollama/glm-5.2']);
    // No billed turns → the fallback (sessions.model) as a single-element list, so callers
    // never face an empty set.
    const other = createSession(db, { model: 'm', cwd: '/p' }).id;
    appendMessage(db, { sessionId: other, role: 'user', content: 'q' });
    expect(effectiveSessionModels(db, other, 'fallback/x')).toEqual(['fallback/x']);
  });

  test('effectiveSessionModels keeps the fallback when a billed turn still has a NULL model', () => {
    // Pre-migration session: an assistant turn billed on the (metered) sessions.model but
    // recorded NULL model, then resumed post-migration with an unmetered turn. The fallback
    // MUST stay in the set — else the metered pre-migration spend is dropped and the session
    // would read as unmetered. A NULL-model USER row must NOT trigger it (not a billed turn).
    appendMessage(db, { sessionId, role: 'assistant', content: 'pre', costUsd: 0.5 }); // NULL model
    appendMessage(db, { sessionId, role: 'user', content: 'q' }); // NULL model, not billed
    appendMessage(db, { sessionId, role: 'assistant', content: 'post', model: 'ollama/glm-5.2' });
    expect(effectiveSessionModels(db, sessionId, 'metered/initial').sort()).toEqual([
      'metered/initial',
      'ollama/glm-5.2',
    ]);
  });

  test('effectiveSessionModels folds in a compaction model absent from every assistant turn', () => {
    // The bug: assistant turns all on an unmetered model, but a /compact billed on a metered
    // model (a /model switch then /compact). The compaction model lives in compaction_events,
    // NOT messages, so it must be unioned in — else the session reads as wholly unmetered while
    // its total_cost_usd carries the metered compaction spend.
    appendMessage(db, { sessionId, role: 'assistant', content: 'a', model: 'ollama/glm-5.2' });
    appendCompactionEvent(db, {
      sessionId,
      strategy: 'llm',
      foldedCount: 1,
      beforeHash: 'a',
      afterHash: 'b',
      recordedAt: 1,
      callUsage: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheCreation: 0 },
      model: 'anthropic/claude-opus-4-8',
    });
    expect(effectiveSessionModels(db, sessionId, 'fallback/x').sort()).toEqual([
      'anthropic/claude-opus-4-8',
      'ollama/glm-5.2',
    ]);
  });

  test('effectiveSessionModels falls back when a billed compaction predates 078 (NULL model)', () => {
    // A pre-078 billed (`llm`) compaction has a NULL model = spend on a model we can't recover.
    // With no assistant row recording a model, effectiveSessionModels must STILL include the
    // fallback (sessions.model) via `compaction.hasUntracked` — else the session reads as having
    // no billed model. Exercises the `|| compaction.hasUntracked` wiring, not just the helper.
    appendCompactionEvent(db, {
      sessionId,
      strategy: 'llm',
      foldedCount: 1,
      beforeHash: 'a',
      afterHash: 'b',
      recordedAt: 1,
      callUsage: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheCreation: 0 },
      // no model → NULL (a compaction row written before migration 078)
    });
    expect(effectiveSessionModels(db, sessionId, 'metered/initial')).toEqual(['metered/initial']);
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
