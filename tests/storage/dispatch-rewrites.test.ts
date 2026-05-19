// dispatch_rewrites repo tests (FEEDBACK_ADAPTATION §9.1 audit).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  countDispatchRewrites,
  createDispatchRewrite,
  getDispatchRewriteForToolCall,
  listDispatchRewritesByPolicy,
  listDispatchRewritesBySession,
} from '../../src/storage/repos/dispatch-rewrites.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;
let sessionId: string;
let toolCallId: string;

const seedToolCall = (sid: string): string => {
  const msgId = crypto.randomUUID();
  const tcId = crypto.randomUUID();
  db.query(
    `INSERT INTO messages (id, session_id, role, content, created_at)
     VALUES (?, ?, 'tool', '{}', ?)`,
  ).run(msgId, sid, Date.now());
  db.query(
    `INSERT INTO tool_calls (id, message_id, tool_name, input, status, created_at)
     VALUES (?, ?, 'bash', '{}', 'done', ?)`,
  ).run(tcId, msgId, Date.now());
  return tcId;
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  toolCallId = seedToolCall(sessionId);
});

afterEach(() => {
  db.close();
});

describe('createDispatchRewrite', () => {
  test('lands a row with default id + recorded_at', () => {
    const r = createDispatchRewrite(db, {
      toolCallId,
      sessionId,
      policyId: 'pol-1',
      actionSignature: 'alias:grep:ripgrep',
      originalCommand: 'grep foo src/',
      rewrittenCommand: 'ripgrep foo src/',
      matchedScope: 'session',
    });
    expect(r.id).toBeTruthy();
    expect(r.recordedAt).toBeGreaterThan(0);
    expect(r.originalCommand).toBe('grep foo src/');
    expect(r.rewrittenCommand).toBe('ripgrep foo src/');
    expect(countDispatchRewrites(db)).toBe(1);
  });

  test('rejects invalid matched_scope via CHECK', () => {
    expect(() =>
      createDispatchRewrite(db, {
        toolCallId,
        sessionId,
        policyId: 'pol-1',
        actionSignature: 'alias:grep:ripgrep',
        originalCommand: 'grep foo',
        rewrittenCommand: 'ripgrep foo',
        matchedScope: 'bogus' as 'session',
      }),
    ).toThrow();
  });

  test('CASCADE: session purge removes rewrites', () => {
    createDispatchRewrite(db, {
      toolCallId,
      sessionId,
      policyId: 'pol-1',
      actionSignature: 'alias:grep:ripgrep',
      originalCommand: 'grep foo',
      rewrittenCommand: 'ripgrep foo',
      matchedScope: 'session',
    });
    expect(countDispatchRewrites(db)).toBe(1);
    db.query('PRAGMA foreign_keys = ON').run();
    db.query('DELETE FROM sessions WHERE id = ?').run(sessionId);
    expect(countDispatchRewrites(db)).toBe(0);
  });

  test('CASCADE: tool_call purge removes rewrite', () => {
    createDispatchRewrite(db, {
      toolCallId,
      sessionId,
      policyId: 'pol-1',
      actionSignature: 'alias:grep:ripgrep',
      originalCommand: 'grep foo',
      rewrittenCommand: 'ripgrep foo',
      matchedScope: 'session',
    });
    db.query('PRAGMA foreign_keys = ON').run();
    db.query('DELETE FROM tool_calls WHERE id = ?').run(toolCallId);
    expect(countDispatchRewrites(db)).toBe(0);
  });

  test('policy_id has no FK — survives policy invalidation', () => {
    // policy_id stored as plain TEXT; policy table state changes
    // (e.g., invalidated) don't affect the rewrite audit row. The
    // operator forensic story is "this is what fired on THIS call
    // at THAT time" — even if the policy later got revoked.
    createDispatchRewrite(db, {
      toolCallId,
      sessionId,
      policyId: 'nonexistent-policy-id',
      actionSignature: 'alias:grep:ripgrep',
      originalCommand: 'grep foo',
      rewrittenCommand: 'ripgrep foo',
      matchedScope: 'session',
    });
    expect(countDispatchRewrites(db)).toBe(1);
  });
});

describe('getDispatchRewriteForToolCall', () => {
  test('returns the rewrite row for the call', () => {
    createDispatchRewrite(db, {
      toolCallId,
      sessionId,
      policyId: 'pol-1',
      actionSignature: 'alias:grep:ripgrep',
      originalCommand: 'grep foo',
      rewrittenCommand: 'ripgrep foo',
      matchedScope: 'repo',
    });
    const r = getDispatchRewriteForToolCall(db, toolCallId);
    expect(r).not.toBeNull();
    expect(r?.actionSignature).toBe('alias:grep:ripgrep');
    expect(r?.matchedScope).toBe('repo');
  });

  test('null when no rewrite recorded', () => {
    expect(getDispatchRewriteForToolCall(db, toolCallId)).toBeNull();
  });
});

describe('listDispatchRewritesBySession', () => {
  test('returns session rewrites ordered newest first', () => {
    const tc2 = seedToolCall(sessionId);
    createDispatchRewrite(db, {
      toolCallId,
      sessionId,
      policyId: 'pol-1',
      actionSignature: 'alias:grep:ripgrep',
      originalCommand: 'grep foo',
      rewrittenCommand: 'ripgrep foo',
      matchedScope: 'session',
      recordedAt: 1000,
    });
    createDispatchRewrite(db, {
      toolCallId: tc2,
      sessionId,
      policyId: 'pol-2',
      actionSignature: 'alias:find:fd',
      originalCommand: 'find . -name *.ts',
      rewrittenCommand: 'fd . -name *.ts',
      matchedScope: 'global',
      recordedAt: 2000,
    });
    const rows = listDispatchRewritesBySession(db, sessionId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.recordedAt).toBe(2000);
    expect(rows[1]?.recordedAt).toBe(1000);
  });

  test('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      const tc = seedToolCall(sessionId);
      createDispatchRewrite(db, {
        toolCallId: tc,
        sessionId,
        policyId: 'pol-1',
        actionSignature: 'alias:grep:ripgrep',
        originalCommand: 'grep foo',
        rewrittenCommand: 'ripgrep foo',
        matchedScope: 'session',
        recordedAt: 1000 + i,
      });
    }
    expect(listDispatchRewritesBySession(db, sessionId, 3)).toHaveLength(3);
  });
});

describe('listDispatchRewritesByPolicy', () => {
  test('returns rewrites driven by a specific policy', () => {
    const tc2 = seedToolCall(sessionId);
    createDispatchRewrite(db, {
      toolCallId,
      sessionId,
      policyId: 'pol-A',
      actionSignature: 'alias:grep:ripgrep',
      originalCommand: 'grep foo',
      rewrittenCommand: 'ripgrep foo',
      matchedScope: 'session',
    });
    createDispatchRewrite(db, {
      toolCallId: tc2,
      sessionId,
      policyId: 'pol-B',
      actionSignature: 'alias:find:fd',
      originalCommand: 'find .',
      rewrittenCommand: 'fd .',
      matchedScope: 'session',
    });
    expect(listDispatchRewritesByPolicy(db, 'pol-A')).toHaveLength(1);
    expect(listDispatchRewritesByPolicy(db, 'pol-B')).toHaveLength(1);
    expect(listDispatchRewritesByPolicy(db, 'pol-C')).toHaveLength(0);
  });
});
