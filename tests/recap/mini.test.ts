import { beforeEach, describe, expect, test } from 'bun:test';
import {
  RECAP_MINI_LIMITS,
  RECAP_MINI_SCHEMA_VERSION,
  type RecapMini,
  projectRecapMini,
  validateRecapMini,
} from '../../src/recap/mini/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { appendFailureEvent } from '../../src/storage/repos/failure-events.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import { completeSession, createSession } from '../../src/storage/repos/sessions.ts';
import { createToolCall, finishToolCall } from '../../src/storage/repos/tool-calls.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

const seedAssistantMessage = (sessionId: string, createdAt: number): string => {
  const msg = appendMessage(db, {
    sessionId,
    role: 'assistant',
    content: 'ok',
    createdAt,
  });
  return msg.id;
};

const seedFileWrite = (
  messageId: string,
  toolName: 'write_file' | 'edit_file' | 'git_apply_patch',
  path: string,
  createdAt: number,
): void => {
  const tc = createToolCall(db, {
    messageId,
    toolName,
    input: { path },
    createdAt,
  });
  finishToolCall(db, {
    id: tc.id,
    status: 'done',
    output: { ok: true },
    durationMs: 1,
  });
};

describe('validateRecapMini', () => {
  const valid = (): RecapMini => ({
    schemaVersion: RECAP_MINI_SCHEMA_VERSION,
    sessionId: 's-1',
    goal: 'do thing',
    status: 'done',
    startedAt: 1_000,
    endedAt: 2_000,
    durationMs: 1_000,
    steps: 3,
    costUsd: 0.04,
    cwd: '/home/lex/proj',
    cwdLabel: 'proj',
    oneLineSummary: 'done: 3 steps, 1 files, do thing',
    filesChanged: 1,
    hasErrors: false,
    incomplete: false,
  });

  test('accepts a fully populated valid shape', () => {
    expect(validateRecapMini(valid()).ok).toBe(true);
  });

  test('rejects unknown status', () => {
    const v = { ...valid(), status: 'mystery' };
    expect(validateRecapMini(v).ok).toBe(false);
  });

  test('rejects extra top-level properties', () => {
    expect(validateRecapMini({ ...valid(), tone: 'cheerful' }).ok).toBe(false);
  });

  test('rejects negative cost', () => {
    expect(validateRecapMini({ ...valid(), costUsd: -1 }).ok).toBe(false);
  });

  test('rejects oneLineSummary over the cap', () => {
    const v = {
      ...valid(),
      oneLineSummary: 'x'.repeat(RECAP_MINI_LIMITS.oneLineSummaryMaxChars + 1),
    };
    expect(validateRecapMini(v).ok).toBe(false);
  });

  test('endedAt may be null (running session)', () => {
    expect(
      validateRecapMini({
        ...valid(),
        status: 'running' as const,
        endedAt: null,
        incomplete: true,
      }).ok,
    ).toBe(true);
  });
});

describe('projectRecapMini', () => {
  test('throws when session does not exist', () => {
    expect(() => projectRecapMini(db, { sessionId: 'ghost' })).toThrow(/not found/);
  });

  test('done session: status, durationMs, costUsd are taken from the row', () => {
    const s = createSession(db, {
      model: 'sonnet',
      cwd: '/home/lex/proj-x',
      startedAt: 1_000,
    });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'do thing', createdAt: 1_100 });
    seedAssistantMessage(s.id, 1_200);
    completeSession(db, s.id, 'done', 0.42, true, 5_000);
    const result = projectRecapMini(db, { sessionId: s.id });
    expect(validateRecapMini(result).ok).toBe(true);
    expect(result.status).toBe('done');
    expect(result.endedAt).toBe(5_000);
    expect(result.durationMs).toBe(4_000);
    expect(result.costUsd).toBe(0.42);
    expect(result.cwd).toBe('/home/lex/proj-x');
    expect(result.cwdLabel).toBe('proj-x');
    expect(result.goal).toBe('do thing');
    expect(result.steps).toBe(1);
    expect(result.incomplete).toBe(false);
  });

  test('running session: durationMs uses now - startedAt', () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/p', startedAt: 1_000 });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'g', createdAt: 1_100 });
    const result = projectRecapMini(db, { sessionId: s.id, now: 5_500 });
    expect(result.status).toBe('running');
    expect(result.endedAt).toBeNull();
    expect(result.durationMs).toBe(4_500);
    expect(result.incomplete).toBe(true);
  });

  test('counts assistant messages as steps and file-writer tool calls as filesChanged', () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/p', startedAt: 1_000 });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'go', createdAt: 1_100 });
    const m1 = seedAssistantMessage(s.id, 1_200);
    const m2 = seedAssistantMessage(s.id, 1_300);
    seedFileWrite(m1, 'write_file', '/p/a.ts', 1_201);
    seedFileWrite(m2, 'edit_file', '/p/b.ts', 1_301);
    seedFileWrite(m2, 'edit_file', '/p/c.ts', 1_302);
    // git_apply_patch is a file-writer too — it must count toward filesChanged.
    seedFileWrite(m2, 'git_apply_patch', '/p/d.ts', 1_303);
    completeSession(db, s.id, 'done', 0.01, true, 2_000);
    const result = projectRecapMini(db, { sessionId: s.id });
    expect(result.steps).toBe(2);
    expect(result.filesChanged).toBe(4);
  });

  test('goal is the first line of the first user message, capped', () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/p', startedAt: 1_000 });
    const longGoal = `Refactor queue retry logic\nDetails:\n${'x'.repeat(300)}`;
    appendMessage(db, { sessionId: s.id, role: 'user', content: longGoal, createdAt: 1_100 });
    const result = projectRecapMini(db, { sessionId: s.id });
    expect(result.goal).toBe('Refactor queue retry logic');
    expect(result.goal.length).toBeLessThanOrEqual(RECAP_MINI_LIMITS.goalMaxChars);
  });

  test('oneLineSummary follows the deterministic template', () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/p', startedAt: 1_000 });
    appendMessage(db, {
      sessionId: s.id,
      role: 'user',
      content: 'extract helper',
      createdAt: 1_100,
    });
    seedAssistantMessage(s.id, 1_200);
    completeSession(db, s.id, 'done', 0.01, true, 2_000);
    const result = projectRecapMini(db, { sessionId: s.id });
    expect(result.oneLineSummary.startsWith('done: 1 steps, 0 files, ')).toBe(true);
    expect(result.oneLineSummary).toContain('extract helper');
  });

  test('empty session (no user message) yields empty goal but valid shape', () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/p', startedAt: 1_000 });
    completeSession(db, s.id, 'done', 0, true, 1_500);
    const result = projectRecapMini(db, { sessionId: s.id });
    expect(validateRecapMini(result).ok).toBe(true);
    expect(result.goal).toBe('');
    expect(result.steps).toBe(0);
    expect(result.filesChanged).toBe(0);
  });

  const seedFailure = (sessionId: string, userVisible: 0 | 1, n: number): void => {
    appendFailureEvent(db, {
      id: `mfail${String(n).padStart(3, '0')}-0000-0000-0000-000000000000`,
      session_id: sessionId,
      step_id: null,
      code: 'provider.timeout',
      classe: 'provider',
      recovery_action: 'retried_3x',
      user_visible: userVisible,
      payload_json: null,
      created_at: 1_400,
      prev_chain_hash: 'seed-prev',
      this_chain_hash: `seed-this-${n}`,
    });
  };

  test('hasErrors true when the session has a user-visible failure', () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/p', startedAt: 1_000 });
    seedFailure(s.id, 1, 1);
    completeSession(db, s.id, 'error', 0, true, 1_500);
    const result = projectRecapMini(db, { sessionId: s.id });
    expect(result.hasErrors).toBe(true);
  });

  test('hasErrors false when failures exist but none are user-visible', () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/p', startedAt: 1_000 });
    seedFailure(s.id, 0, 2);
    completeSession(db, s.id, 'error', 0, true, 1_500);
    const result = projectRecapMini(db, { sessionId: s.id });
    // `error` status alone does not flip hasErrors — the signal is
    // a user-visible failure_events row, not the terminal status.
    expect(result.status).toBe('error');
    expect(result.hasErrors).toBe(false);
  });

  test('hasErrors false when the session has no failure_events', () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/p', startedAt: 1_000 });
    completeSession(db, s.id, 'done', 0, true, 1_500);
    const result = projectRecapMini(db, { sessionId: s.id });
    expect(result.hasErrors).toBe(false);
  });

  test('cwd basename used for cwdLabel', () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/home/lex/proj/sub', startedAt: 1_000 });
    completeSession(db, s.id, 'done', 0, true, 1_500);
    const result = projectRecapMini(db, { sessionId: s.id });
    expect(result.cwdLabel).toBe('sub');
  });
});
