// Loop quente outcome emitter tests (FEEDBACK_ADAPTATION §3.1).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { emitToolCallOutcome } from '../../src/feedback/outcome-emitter.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listOutcomesBySession } from '../../src/storage/repos/outcomes.ts';
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

describe('emitToolCallOutcome', () => {
  test('success path emits tier 1 / result success row', () => {
    const wrote = emitToolCallOutcome(db, {
      sessionId,
      toolCallId,
      toolName: 'bash',
      failed: false,
      durationMs: 42,
    });
    expect(wrote).toBe(true);
    const rows = listOutcomesBySession(db, sessionId);
    expect(rows).toHaveLength(1);
    const o = rows[0];
    if (o === undefined) throw new Error('no outcome row');
    expect(o.tier).toBe(1);
    expect(o.result).toBe('success');
    expect(o.actionSignature).toBe('flag:bash:default:default');
    expect(o.scopeKind).toBe('session');
    expect(o.scopeId).toBe(sessionId);
    const evidence = JSON.parse(o.evidenceJson ?? '{}') as Record<string, unknown>;
    expect(evidence.tool_name).toBe('bash');
    expect(evidence.duration_ms).toBe(42);
    expect(evidence.failed).toBeUndefined();
  });

  test('failed path emits tier 1 / result failure with error_message', () => {
    const wrote = emitToolCallOutcome(db, {
      sessionId,
      toolCallId,
      toolName: 'bash',
      failed: true,
      durationMs: 5,
      errorMessage: 'command not found',
    });
    expect(wrote).toBe(true);
    const rows = listOutcomesBySession(db, sessionId);
    expect(rows).toHaveLength(1);
    const o = rows[0];
    if (o === undefined) throw new Error('no outcome row');
    expect(o.result).toBe('failure');
    const evidence = JSON.parse(o.evidenceJson ?? '{}') as Record<string, unknown>;
    expect(evidence.failed).toBe(true);
    expect(evidence.error_message).toBe('command not found');
  });

  test('denied path skips emission (handled by outcome_signals)', () => {
    const wrote = emitToolCallOutcome(db, {
      sessionId,
      toolCallId,
      toolName: 'bash',
      failed: true,
      denied: true,
      durationMs: 1,
    });
    expect(wrote).toBe(false);
    const rows = listOutcomesBySession(db, sessionId);
    expect(rows).toEqual([]);
  });

  test('action_signature reflects tool name', () => {
    const tc2 = seedToolCall(sessionId);
    emitToolCallOutcome(db, {
      sessionId,
      toolCallId: tc2,
      toolName: 'read_file',
      failed: false,
      durationMs: 10,
    });
    const rows = listOutcomesBySession(db, sessionId);
    expect(rows[0]?.actionSignature).toBe('flag:read_file:default:default');
  });

  test('bash with known L1 alias binary emits BOTH flag + alias signatures', () => {
    emitToolCallOutcome(db, {
      sessionId,
      toolCallId,
      toolName: 'bash',
      failed: false,
      durationMs: 42,
      toolInput: { command: 'grep -r foo src/' },
    });
    const rows = listOutcomesBySession(db, sessionId);
    expect(rows).toHaveLength(2);
    const sigs = rows.map((r) => r.actionSignature).sort();
    expect(sigs).toEqual(['alias:grep:ripgrep', 'flag:bash:default:default']);
  });

  test('bash with unknown binary emits only the generic flag signature', () => {
    emitToolCallOutcome(db, {
      sessionId,
      toolCallId,
      toolName: 'bash',
      failed: false,
      durationMs: 5,
      toolInput: { command: 'ls -la' },
    });
    const rows = listOutcomesBySession(db, sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actionSignature).toBe('flag:bash:default:default');
  });

  test('bash with cd prefix still detects the L1 alias', () => {
    emitToolCallOutcome(db, {
      sessionId,
      toolCallId,
      toolName: 'bash',
      failed: false,
      durationMs: 5,
      toolInput: { command: 'cd /tmp && grep foo' },
    });
    const rows = listOutcomesBySession(db, sessionId);
    expect(rows.map((r) => r.actionSignature).sort()).toContain('alias:grep:ripgrep');
  });

  test('non-bash tool with toolInput does not emit L1 alias', () => {
    emitToolCallOutcome(db, {
      sessionId,
      toolCallId,
      toolName: 'read_file',
      failed: false,
      durationMs: 5,
      toolInput: { command: 'grep -r foo' }, // even with bash-shaped input, the tool isn't bash
    });
    const rows = listOutcomesBySession(db, sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actionSignature).toBe('flag:read_file:default:default');
  });

  test('bash with failure surfaces failure on both flag + alias rows', () => {
    emitToolCallOutcome(db, {
      sessionId,
      toolCallId,
      toolName: 'bash',
      failed: true,
      durationMs: 5,
      errorMessage: 'exit 2',
      toolInput: { command: 'grep -X foo' },
    });
    const rows = listOutcomesBySession(db, sessionId);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.result).toBe('failure');
      const evidence = JSON.parse(r.evidenceJson ?? '{}') as Record<string, unknown>;
      expect(evidence.error_message).toBe('exit 2');
    }
  });

  test('best-effort: failure to emit logs to stderr without throwing', () => {
    // Pass a bogus tool_call_id — FK constraint refuses, emitter
    // logs to stderr and returns false. Capture stderr to assert
    // the warning shape without polluting test output.
    const originalWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const wrote = emitToolCallOutcome(db, {
        sessionId,
        toolCallId: 'nonexistent-tool-call',
        toolName: 'bash',
        failed: false,
        durationMs: 1,
      });
      expect(wrote).toBe(false);
      expect(captured.join('')).toContain('forja outcomes: emit failed');
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
