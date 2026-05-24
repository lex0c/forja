import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migrate } from '../../src/storage/migrate.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import {
  getPromptVersion,
  hashPromptContent,
  listPromptVersionsByName,
  recordPromptVersion,
} from '../../src/storage/repos/prompt-versions.ts';
import { createToolCall } from '../../src/storage/repos/tool-calls.ts';

const setupDb = (): Database => {
  const db = new Database(':memory:');
  migrate(db);
  return db;
};

describe('prompt-versions repo (AUDIT.md §1.3)', () => {
  test('hashPromptContent is deterministic SHA256 hex', () => {
    const content = 'You are the Forja agent — under declarative policy.';
    const a = hashPromptContent(content);
    const b = hashPromptContent(content);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // Different content → different hash. This is the dimension the
    // §1.3.7 eval keys on; a collision here would silently merge two
    // distinct prompt versions in the audit.
    expect(hashPromptContent(`${content} (changed)`)).not.toBe(a);
  });

  test('recordPromptVersion inserts and returns the canonical row', () => {
    const db = setupDb();
    const content = '# System\nbody';
    const hash = hashPromptContent(content);
    const row = recordPromptVersion(db, {
      hash,
      kind: 'system',
      name: 'system.autonomous',
      content,
      author: 'tester@local',
    });
    expect(row.hash).toBe(hash);
    expect(row.kind).toBe('system');
    expect(row.name).toBe('system.autonomous');
    expect(row.content).toBe(content);
    expect(row.author).toBe('tester@local');
    expect(row.parentHash).toBeNull();
    expect(row.sourceCommit).toBeNull();
    expect(row.evalRunId).toBeNull();
    expect(row.notes).toBeNull();
    expect(typeof row.createdAt).toBe('number');
    db.close();
  });

  test('recordPromptVersion is idempotent by hash; first recorder wins', () => {
    // §1.3.3 idempotency: the same content recorded twice collapses
    // to one row and preserves the original author + created_at —
    // a later recorder attests the content existed, never overwrites
    // provenance.
    const db = setupDb();
    const content = 'same';
    const hash = hashPromptContent(content);
    const first = recordPromptVersion(db, {
      hash,
      kind: 'system',
      name: 'system.autonomous',
      content,
      author: 'alice',
      createdAt: 1000,
    });
    const second = recordPromptVersion(db, {
      hash,
      kind: 'system',
      name: 'system.autonomous',
      content,
      author: 'bob', // ignored — first recorder wins
      createdAt: 2000, // ignored
    });
    expect(second.author).toBe('alice');
    expect(second.createdAt).toBe(1000);
    expect(first.hash).toBe(second.hash);
    const all = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM prompt_versions').get();
    expect(all?.n).toBe(1);
    db.close();
  });

  test('recordPromptVersion throws on hash collision with mismatched (kind, name)', () => {
    // Spec §1.3 makes `hash` the primary key under the assumption
    // "same content == same logical prompt". Without this guard,
    // a second caller passing the same hash with a different
    // (kind, name) silently aliases to the first row — and the
    // returned PromptVersion carries the FIRST recorder's
    // (kind, name), not the second's. Operator queries by name
    // (§1.3.5 history-by-name) then miss the second logical
    // prompt entirely; audit attribution under the second name
    // is wrong. This test pins the "throw loudly" behavior so a
    // future refactor cannot quietly drop the guard.
    const db = setupDb();
    const content = 'identical body';
    const hash = hashPromptContent(content);
    recordPromptVersion(db, {
      hash,
      kind: 'system',
      name: 'system.autonomous',
      content,
      author: 'alice',
    });
    // Same content (same hash), DIFFERENT (kind, name) — collision.
    expect(() =>
      recordPromptVersion(db, {
        hash,
        kind: 'playbook',
        name: 'playbook.explore',
        content,
        author: 'bob',
      }),
    ).toThrow(/hash collision with different metadata/);
    // Asserting the error message names BOTH sides of the conflict
    // gives the operator enough context to either differentiate
    // the content or propose migration 069.
    expect(() =>
      recordPromptVersion(db, {
        hash,
        kind: 'playbook',
        name: 'playbook.explore',
        content,
        author: 'bob',
      }),
    ).toThrow(/system.*system\.autonomous/);
    // Same hash + same (kind, name) but different name-only? Still
    // a collision — name change alone shouldn't alias either.
    expect(() =>
      recordPromptVersion(db, {
        hash,
        kind: 'system',
        name: 'system.orchestrated',
        content,
        author: 'bob',
      }),
    ).toThrow(/hash collision with different metadata/);
    db.close();
  });

  test('getPromptVersion returns null for an unknown hash', () => {
    const db = setupDb();
    expect(getPromptVersion(db, 'deadbeef')).toBeNull();
    db.close();
  });

  test('listPromptVersionsByName returns history newest-first; limit honored; name-scoped', () => {
    const db = setupDb();
    const records = [
      { content: 'v1', t: 1000 },
      { content: 'v2', t: 2000 },
      { content: 'v3', t: 3000 },
    ];
    for (const r of records) {
      recordPromptVersion(db, {
        hash: hashPromptContent(r.content),
        kind: 'system',
        name: 'system.autonomous',
        content: r.content,
        author: 'tester',
        createdAt: r.t,
      });
    }
    const list = listPromptVersionsByName(db, 'system.autonomous');
    expect(list).toHaveLength(3);
    expect(list[0]?.content).toBe('v3');
    expect(list[1]?.content).toBe('v2');
    expect(list[2]?.content).toBe('v1');
    const top1 = listPromptVersionsByName(db, 'system.autonomous', 1);
    expect(top1).toHaveLength(1);
    expect(top1[0]?.content).toBe('v3');
    // Name scope is exact — a different name returns no rows.
    expect(listPromptVersionsByName(db, 'system.orchestrated')).toHaveLength(0);
    db.close();
  });

  test('appendMessage persists prompt_hash when provided (AUDIT §1.3.2 join surface)', () => {
    const db = setupDb();
    // Sessions FK is real; seed a row before appending a message.
    db.run(
      "INSERT INTO sessions (id, started_at, model, cwd, status) VALUES ('sess-pm', 0, 'mock/m', '/tmp', 'running')",
    );
    const promptHash = 'a'.repeat(64);
    appendMessage(db, {
      sessionId: 'sess-pm',
      role: 'user',
      content: 'hi',
      promptHash,
    });
    const row = db
      .query<{ prompt_hash: string | null }, []>(
        "SELECT prompt_hash FROM messages WHERE session_id = 'sess-pm'",
      )
      .get();
    expect(row?.prompt_hash).toBe(promptHash);
    db.close();
  });

  test('appendMessage stores NULL when promptHash is omitted (forward-compat with pre-068 callers)', () => {
    const db = setupDb();
    db.run(
      "INSERT INTO sessions (id, started_at, model, cwd, status) VALUES ('sess-pn', 0, 'mock/m', '/tmp', 'running')",
    );
    appendMessage(db, { sessionId: 'sess-pn', role: 'user', content: 'hi' });
    const row = db
      .query<{ prompt_hash: string | null }, []>(
        "SELECT prompt_hash FROM messages WHERE session_id = 'sess-pn'",
      )
      .get();
    expect(row?.prompt_hash).toBeNull();
    db.close();
  });

  test('createToolCall persists prompt_hash when provided', () => {
    const db = setupDb();
    db.run(
      "INSERT INTO sessions (id, started_at, model, cwd, status) VALUES ('sess-tc', 0, 'mock/m', '/tmp', 'running')",
    );
    const msg = appendMessage(db, {
      sessionId: 'sess-tc',
      role: 'assistant',
      content: 'tool call',
    });
    const promptHash = 'b'.repeat(64);
    const tc = createToolCall(db, {
      messageId: msg.id,
      toolName: 'read_file',
      input: { path: '/x' },
      promptHash,
    });
    const row = db
      .query<{ prompt_hash: string | null }, [string]>(
        'SELECT prompt_hash FROM tool_calls WHERE id = ?',
      )
      .get(tc.id);
    expect(row?.prompt_hash).toBe(promptHash);
    db.close();
  });

  test('migration 068 adds prompt_hash columns to messages and tool_calls', () => {
    // The §1.3.5 canonical queries join `messages.prompt_hash`
    // against `prompt_versions.hash`. Without the column the
    // registry is unjoinable — guarding that the migration applied
    // its ALTER TABLE pieces too.
    const db = setupDb();
    const messageCols = db
      .query<{ name: string }, []>("PRAGMA table_info('messages')")
      .all()
      .map((r) => r.name);
    expect(messageCols).toContain('prompt_hash');
    const toolCols = db
      .query<{ name: string }, []>("PRAGMA table_info('tool_calls')")
      .all()
      .map((r) => r.name);
    expect(toolCols).toContain('prompt_hash');
    db.close();
  });
});
