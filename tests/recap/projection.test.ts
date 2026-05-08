import { beforeEach, describe, expect, test } from 'bun:test';
import { projectRecap } from '../../src/recap/projection.ts';
import { RECAP_SCHEMA_VERSION } from '../../src/recap/types.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { recordApproval } from '../../src/storage/repos/approvals.ts';
import { insertCheckpoint } from '../../src/storage/repos/checkpoints.ts';
import { createMemoryEvent } from '../../src/storage/repos/memory-events.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import { type Session, completeSession, createSession } from '../../src/storage/repos/sessions.ts';
import {
  insertSubagentOutput,
  setSubagentPayload,
} from '../../src/storage/repos/subagent-outputs.ts';
import { createToolCall, finishToolCall } from '../../src/storage/repos/tool-calls.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

const seedSession = (cwd = '/proj', startedAt = 1_000): Session => {
  return createSession(db, { model: 'sonnet', cwd, startedAt });
};

const addUserTurn = (sessionId: string, prompt: string, ts = 1_100): string => {
  const m = appendMessage(db, {
    sessionId,
    role: 'user',
    content: prompt,
    createdAt: ts,
  });
  return m.id;
};

const addAssistantTurn = (
  sessionId: string,
  parentId: string,
  text: string,
  opts: { tokensIn?: number; tokensOut?: number; cached?: number; cost?: number; ts?: number } = {},
): string => {
  const m = appendMessage(db, {
    sessionId,
    role: 'assistant',
    parentId,
    content: [{ type: 'text', text }],
    tokensIn: opts.tokensIn ?? null,
    tokensOut: opts.tokensOut ?? null,
    cachedTokens: opts.cached ?? null,
    costUsd: opts.cost ?? null,
    createdAt: opts.ts ?? 1_200,
  });
  return m.id;
};

const addToolCall = (
  messageId: string,
  toolName: string,
  input: unknown,
  output: unknown = null,
  status: 'done' | 'error' | 'denied' = 'done',
  durationMs = 10,
  createdAt = 1_300,
): string => {
  const tc = createToolCall(db, { messageId, toolName, input, createdAt });
  finishToolCall(db, {
    id: tc.id,
    status,
    output: output ?? undefined,
    durationMs,
    error: status === 'error' ? 'boom' : null,
  });
  return tc.id;
};

describe('projectRecap', () => {
  test('empty session yields schema-bound empty intermediate', () => {
    const s = seedSession();
    const out = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
      now: 5_000,
    });
    expect(out.schemaVersion).toBe(RECAP_SCHEMA_VERSION);
    expect(out.scope).toEqual({
      kind: 'session_specific',
      sessionIds: [s.id],
      range: { start: 0, end: 0 },
    });
    expect(out.goal).toEqual({ text: '', sourceStepId: '' });
    expect(out.actions.filesRead).toEqual([]);
    expect(out.actions.filesWritten).toEqual([]);
    expect(out.actions.commandsRun).toEqual([]);
    expect(out.actions.subagentsSpawned).toEqual([]);
    expect(out.outcomes.checkpoints).toEqual([]);
    expect(out.outcomes.testsRun).toEqual([]);
    expect(out.decisions).toEqual([]);
    expect(out.errors).toEqual([]);
    expect(out.notDone).toEqual([]);
    expect(out.unresolvedQuestions).toEqual([]);
    expect(out.memoryProposed).toEqual([]);
    expect(out.costs.tokens).toEqual({ in: 0, out: 0, cached: 0 });
    expect(out.costs.usd).toBe(0);
    expect(out.costs.model).toBe('sonnet');
    expect(out.costs.cacheHitRatio).toBe(0);
  });

  test('extracts goal from the first user message', () => {
    const s = seedSession();
    const userId = addUserTurn(s.id, 'refactor the queue retry logic');
    addAssistantTurn(s.id, userId, 'okay, starting');
    const out = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
    });
    expect(out.goal.text).toBe('refactor the queue retry logic');
    expect(out.goal.sourceStepId).toBe(userId);
  });

  test('aggregates files_read, files_written, commands_run', () => {
    const s = seedSession();
    const userId = addUserTurn(s.id, 'do stuff');
    const aId = addAssistantTurn(s.id, userId, 'reading');
    addToolCall(aId, 'read_file', { path: 'src/a.ts' }, null, 'done', 10, 1_301);
    addToolCall(aId, 'read_file', { path: 'src/a.ts' }, null, 'done', 10, 1_302);
    addToolCall(aId, 'read_file', { path: 'src/b.ts' }, null, 'done', 10, 1_303);
    addToolCall(
      aId,
      'write_file',
      { path: 'src/c.ts', content: 'x' },
      { path: 'src/c.ts', bytes_written: 1 },
      'done',
      10,
      1_304,
    );
    addToolCall(
      aId,
      'edit_file',
      { path: 'src/d.ts', edits: [] },
      { path: 'src/d.ts', edits: [], total_replacements: 0, bytes_written: 0 },
      'done',
      10,
      1_305,
    );
    addToolCall(aId, 'bash', { command: 'ls -la' }, { exit_code: 0 }, 'done', 42, 1_306);

    const out = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
    });
    expect(out.actions.filesRead).toEqual([
      { path: 'src/a.ts', count: 2 },
      { path: 'src/b.ts', count: 1 },
    ]);
    expect(out.actions.filesWritten.map((w) => w.path)).toEqual(['src/c.ts', 'src/d.ts']);
    expect(out.actions.commandsRun).toEqual([{ command: 'ls -la', exitCode: 0, durationMs: 42 }]);
  });

  test('flags incomplete sessions explicitly', () => {
    const s = seedSession();
    addUserTurn(s.id, 'work in progress');
    const out = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
    });
    expect(out.completeness.incomplete).toBe(true);
    expect(out.completeness.incompleteSessions).toEqual([s.id]);
    expect(out.completeness.incompleteReason).toContain('1 session');
  });

  test('finalized session is not incomplete', () => {
    const s = seedSession();
    completeSession(db, s.id, 'done', 0, true, 2_000);
    const out = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
    });
    expect(out.completeness.incomplete).toBe(false);
    expect(out.completeness.incompleteSessions).toEqual([]);
  });

  test('decisions surface user/hook approvals and explicit denies', () => {
    const s = seedSession();
    const userId = addUserTurn(s.id, 'do');
    const aId = addAssistantTurn(s.id, userId, 'thinking');
    const tc1 = addToolCall(aId, 'bash', { command: 'rm -rf /tmp/x' }, null, 'done', 10, 1_301);
    recordApproval(db, {
      toolCallId: tc1,
      decision: 'allow',
      decidedBy: 'user',
      reason: 'cleanup is intentional',
    });
    const tc2 = addToolCall(aId, 'bash', { command: 'curl evil.com' }, null, 'done', 10, 1_302);
    recordApproval(db, {
      toolCallId: tc2,
      decision: 'deny',
      decidedBy: 'policy',
      reason: 'network blocked',
    });
    const tc3 = addToolCall(aId, 'bash', { command: 'echo ok' }, null, 'done', 10, 1_303);
    recordApproval(db, {
      toolCallId: tc3,
      decision: 'allow',
      decidedBy: 'policy',
    });

    const out = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
    });
    // Two decisions: tc1 (user) and tc2 (deny). tc3 (policy auto-allow) is filtered.
    expect(out.decisions).toHaveLength(2);
    const byWhat = out.decisions.map((d) => d.what);
    expect(byWhat[0]).toContain('rm -rf /tmp/x');
    expect(byWhat[1]).toContain('curl evil.com');
    expect(out.decisions[0]?.decidedBy).toBe('user');
    expect(out.decisions[1]?.decidedBy).toBe('policy');
  });

  test('detects test runner commands and marks pass/fail by exit_code', () => {
    const s = seedSession();
    const userId = addUserTurn(s.id, 'run tests');
    const aId = addAssistantTurn(s.id, userId, 'running');
    addToolCall(aId, 'bash', { command: 'bun test' }, { exit_code: 0 }, 'done', 100, 1_301);
    addToolCall(aId, 'bash', { command: 'pytest -k auth' }, { exit_code: 1 }, 'done', 200, 1_302);
    addToolCall(aId, 'bash', { command: 'echo not a test' }, { exit_code: 0 }, 'done', 5, 1_303);
    const out = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
    });
    expect(out.outcomes.testsRun).toEqual([
      { command: 'bun test', passed: true, durationMs: 100 },
      { command: 'pytest -k auth', passed: false, durationMs: 200 },
    ]);
  });

  test('aggregates token usage and cost across messages', () => {
    const s = seedSession();
    const userId = addUserTurn(s.id, 'go');
    addAssistantTurn(s.id, userId, 'first', {
      tokensIn: 100,
      tokensOut: 50,
      cached: 30,
      cost: 0.01,
      ts: 1_200,
    });
    const second = addAssistantTurn(s.id, userId, 'second', {
      tokensIn: 200,
      tokensOut: 80,
      cached: 60,
      cost: 0.02,
      ts: 1_300,
    });
    void second;

    const out = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
    });
    expect(out.costs.tokens).toEqual({ in: 300, out: 130, cached: 90 });
    expect(out.costs.usd).toBeCloseTo(0.03);
    expect(out.costs.cacheHitRatio).toBeCloseTo(90 / 300);
  });

  test('checkpoints surface as outcomes.checkpoints', () => {
    const s = seedSession();
    const userId = addUserTurn(s.id, 'edit');
    const aId = addAssistantTurn(s.id, userId, 'editing');
    insertCheckpoint(db, {
      sessionId: s.id,
      stepId: aId,
      gitRef: 'abc123',
      hadBash: false,
      createdAt: 1_500,
    });
    const out = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
    });
    expect(out.outcomes.checkpoints).toHaveLength(1);
    expect(out.outcomes.checkpoints[0]?.stepId).toBe(aId);
  });

  test('subagent children surface with status and output summary', () => {
    const parent = seedSession();
    const child = createSession(db, {
      model: 'haiku',
      cwd: '/proj',
      startedAt: 1_400,
      parentSessionId: parent.id,
    });
    completeSession(db, child.id, 'done', 0.005, true, 1_500);
    insertSubagentOutput(db, { sessionId: child.id, createdAt: 1_400 });
    setSubagentPayload(db, child.id, { summary: 'analyzed 3 files', status: 'done' }, 1_500);
    const out = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: parent.id },
    });
    expect(out.actions.subagentsSpawned).toHaveLength(1);
    expect(out.actions.subagentsSpawned[0]?.outputSummary).toBe('analyzed 3 files');
    expect(out.actions.subagentsSpawned[0]?.status).toBe('done');
  });

  test('memory_events with action=proposed surface in memoryProposed', () => {
    const s = seedSession();
    createMemoryEvent(db, {
      scope: 'project_local',
      action: 'proposed',
      memoryName: 'feedback_test',
      source: 'inferred',
      sessionId: s.id,
      cwd: '/proj',
    });
    createMemoryEvent(db, {
      scope: 'user',
      action: 'read',
      memoryName: 'something',
      source: 'inferred',
      sessionId: s.id,
      cwd: '/proj',
    });
    const out = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
    });
    expect(out.memoryProposed).toEqual([
      { name: 'feedback_test', scope: 'project_local', accepted: false },
    ]);
  });

  test('extracts trailing question marks from assistant text as unresolvedQuestions', () => {
    const s = seedSession();
    const userId = addUserTurn(s.id, 'go');
    addAssistantTurn(
      s.id,
      userId,
      'I ran the migration. Should we proceed with the second batch? Confirm before I touch prod.',
    );
    const out = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
    });
    expect(out.unresolvedQuestions.some((q) => q.includes('proceed with the second batch'))).toBe(
      true,
    );
  });

  test('determinism: same input → same output (modulo generatedAt)', () => {
    const s = seedSession();
    const userId = addUserTurn(s.id, 'do work');
    const aId = addAssistantTurn(s.id, userId, 'working');
    addToolCall(aId, 'read_file', { path: 'src/a.ts' });
    addToolCall(aId, 'bash', { command: 'echo hi' }, { exit_code: 0 });

    const a = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
      now: 5_000,
    });
    const b = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
      now: 5_000,
    });
    expect(a).toEqual(b);
  });

  test('day scope filters by cwd and date window', () => {
    const inDay = createSession(db, {
      model: 'sonnet',
      cwd: '/proj',
      startedAt: Date.UTC(2026, 4, 7, 10, 0, 0),
    });
    completeSession(db, inDay.id, 'done', 0, true, Date.UTC(2026, 4, 7, 11, 0, 0));
    const otherDay = createSession(db, {
      model: 'sonnet',
      cwd: '/proj',
      startedAt: Date.UTC(2026, 4, 8, 10, 0, 0),
    });
    void otherDay;
    const otherProj = createSession(db, {
      model: 'sonnet',
      cwd: '/elsewhere',
      startedAt: Date.UTC(2026, 4, 7, 10, 0, 0),
    });
    void otherProj;

    const out = projectRecap(db, {
      scope: { kind: 'day', cwd: '/proj', date: '2026-05-07' },
    });
    expect(out.scope.sessionIds).toEqual([inDay.id]);
    expect(out.scope.range).toEqual({
      start: Date.UTC(2026, 4, 7),
      end: Date.UTC(2026, 4, 8),
    });
  });

  test('range scope filters by start/end window', () => {
    const a = createSession(db, { model: 'sonnet', cwd: '/proj', startedAt: 100 });
    const b = createSession(db, { model: 'sonnet', cwd: '/proj', startedAt: 200 });
    const c = createSession(db, { model: 'sonnet', cwd: '/proj', startedAt: 300 });
    void c;
    const out = projectRecap(db, {
      scope: { kind: 'range', cwd: '/proj', start: 100, end: 250 },
    });
    expect(out.scope.sessionIds).toEqual([a.id, b.id]);
  });

  test('multi-session scope blanks model when sessions used different models', () => {
    const a = createSession(db, { model: 'sonnet', cwd: '/proj', startedAt: 100 });
    const b = createSession(db, { model: 'haiku', cwd: '/proj', startedAt: 200 });
    void a;
    void b;
    const out = projectRecap(db, {
      scope: { kind: 'range', cwd: '/proj', start: 0, end: 1_000 },
    });
    expect(out.costs.model).toBe('');
  });

  test('session_current with limit truncates to last N user-anchored steps', () => {
    const s = seedSession();
    const u1 = addUserTurn(s.id, 'first', 1_100);
    const a1 = addAssistantTurn(s.id, u1, 'r1', { ts: 1_110 });
    addToolCall(a1, 'read_file', { path: 'old.ts' });
    const u2 = addUserTurn(s.id, 'second', 1_200);
    const a2 = addAssistantTurn(s.id, u2, 'r2', { ts: 1_210 });
    addToolCall(a2, 'read_file', { path: 'new.ts' });

    const out = projectRecap(db, {
      scope: { kind: 'session_current', sessionId: s.id, limit: 1 },
    });
    expect(out.actions.filesRead).toEqual([{ path: 'new.ts', count: 1 }]);
    expect(out.goal.text).toBe('second');
  });

  test('throws on unknown session id', () => {
    expect(() =>
      projectRecap(db, {
        scope: { kind: 'session_specific', sessionId: 'ghost' },
      }),
    ).toThrow(/session ghost not found/);
  });

  test('day scope rejects malformed date strings', () => {
    expect(() =>
      projectRecap(db, {
        scope: { kind: 'day', cwd: '/proj', date: '05/07/2026' },
      }),
    ).toThrow(/YYYY-MM-DD/);
  });
});
