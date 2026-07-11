import { beforeEach, describe, expect, test } from 'bun:test';
import type { DB } from '../../src/storage/db.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listApprovalsByToolCall, recordApproval } from '../../src/storage/repos/approvals.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { createToolCall } from '../../src/storage/repos/tool-calls.ts';

let db: DB;
let toolCallId: string;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  const s = createSession(db, { model: 'm', cwd: '/p' });
  const m = appendMessage(db, { sessionId: s.id, role: 'assistant', content: 'x' });
  toolCallId = createToolCall(db, {
    messageId: m.id,
    toolName: 'bash',
    input: { command: 'ls' },
  }).id;
});

describe('approvals repo', () => {
  test('records an approval and reads it back', () => {
    const a = recordApproval(db, {
      toolCallId,
      decision: 'allow',
      decidedBy: 'policy',
      reason: 'matched allow rule: ls *',
    });
    expect(a.id).toBeString();
    expect(a.decision).toBe('allow');
    expect(a.decidedBy).toBe('policy');
    expect(a.reason).toBe('matched allow rule: ls *');
    expect(a.decidedAt).toBeGreaterThan(0);
  });

  test('listApprovalsByToolCall returns in chronological order', () => {
    recordApproval(db, { toolCallId, decision: 'confirm_yes', decidedBy: 'user', decidedAt: 200 });
    recordApproval(db, { toolCallId, decision: 'allow', decidedBy: 'policy', decidedAt: 100 });
    recordApproval(db, { toolCallId, decision: 'deny', decidedBy: 'hook', decidedAt: 300 });
    const list = listApprovalsByToolCall(db, toolCallId);
    expect(list.map((a) => a.decidedAt)).toEqual([100, 200, 300]);
  });

  test('cascades on tool_call delete', () => {
    recordApproval(db, { toolCallId, decision: 'allow', decidedBy: 'policy' });
    db.query('DELETE FROM tool_calls WHERE id = ?').run(toolCallId);
    expect(listApprovalsByToolCall(db, toolCallId)).toEqual([]);
  });

  test('CHECK rejects invalid decision value', () => {
    expect(() =>
      db
        .query(
          `INSERT INTO approvals (id, tool_call_id, decision, decided_by, decided_at)
           VALUES (?, ?, 'bogus', 'policy', 0)`,
        )
        .run(crypto.randomUUID(), toolCallId),
    ).toThrow();
  });

  test('CHECK rejects invalid decided_by value', () => {
    expect(() =>
      db
        .query(
          `INSERT INTO approvals (id, tool_call_id, decision, decided_by, decided_at)
           VALUES (?, ?, 'allow', 'bogus', 0)`,
        )
        .run(crypto.randomUUID(), toolCallId),
    ).toThrow();
  });

  test('FK rejects unknown tool_call_id', () => {
    expect(() =>
      recordApproval(db, {
        toolCallId: 'no-such-tool-call',
        decision: 'allow',
        decidedBy: 'policy',
      }),
    ).toThrow();
  });
});
