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

  test('day scope finds older sessions even when 500+ exist (no silent cap)', () => {
    // Regression: an earlier draft used
    // `listSessions(limit:500).filter(date)` which silently
    // dropped older day windows once the project crossed 500
    // sessions. The fix uses `listSessionsInRange` which filters
    // in SQL, so the predicate is exact regardless of project
    // size.
    const targetDay = Date.UTC(2024, 0, 15, 12, 0, 0);
    const target = createSession(db, {
      model: 'sonnet',
      cwd: '/proj',
      startedAt: targetDay,
    });
    completeSession(db, target.id, 'done', 0, true, targetDay + 1_000);
    // 600 newer sessions on a different day to exhaust the old cap.
    const newerDayBase = Date.UTC(2024, 1, 1, 12, 0, 0);
    for (let i = 0; i < 600; i += 1) {
      const s = createSession(db, {
        model: 'sonnet',
        cwd: '/proj',
        startedAt: newerDayBase + i,
      });
      completeSession(db, s.id, 'done', 0, true, newerDayBase + i + 100);
    }
    const out = projectRecap(db, {
      scope: { kind: 'day', cwd: '/proj', date: '2024-01-15' },
    });
    expect(out.scope.sessionIds).toEqual([target.id]);
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

  test('timeline is totally ordered: ties on (ts, event) tiebreak on detail deterministically', () => {
    // Regression: prior comparator returned 1 (instead of 0) for
    // equal (ts, event) pairs, violating antisymmetry. Two
    // approvals decided in the same ms with the same `approval_*`
    // label would sort unstably across V8 versions. We force the
    // collision by stamping two approvals at the same decided_at
    // and verify the resulting order matches `detail` ASC.
    const s = seedSession();
    const userId = addUserTurn(s.id, 'do');
    const aId = addAssistantTurn(s.id, userId, 'thinking');
    const tcZebra = addToolCall(aId, 'bash', { command: 'echo zebra' }, null, 'done', 1, 1_301);
    const tcAlpha = addToolCall(aId, 'bash', { command: 'echo alpha' }, null, 'done', 1, 1_302);
    // Same `decidedAt`, same `decision` ⇒ same event label
    // (`approval_allow`). Only `detail` differs (tool name +
    // decided_by composition).
    recordApproval(db, {
      toolCallId: tcZebra,
      decision: 'allow',
      decidedBy: 'user',
      decidedAt: 9_000,
    });
    recordApproval(db, {
      toolCallId: tcAlpha,
      decision: 'allow',
      decidedBy: 'user',
      decidedAt: 9_000,
    });

    const a = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
      now: 10_000,
    });
    const b = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
      now: 10_000,
    });
    // Determinism across runs.
    expect(a.timeline).toEqual(b.timeline);
    // Same event label `approval_allow` for both rows; the detail
    // tiebreak places them in stable lexicographic order.
    const approvals = a.timeline.filter((e) => e.event === 'approval_allow');
    expect(approvals).toHaveLength(2);
    const ordered = [...approvals].sort((x, y) =>
      x.detail < y.detail ? -1 : x.detail > y.detail ? 1 : 0,
    );
    expect(approvals).toEqual(ordered);
  });

  test('throws on unknown session id', () => {
    expect(() =>
      projectRecap(db, {
        scope: { kind: 'session_specific', sessionId: 'ghost' },
      }),
    ).toThrow(/session ghost not found/);
  });

  test('denied tool calls are excluded from action aggregates (filesRead, filesWritten, commandsRun, testsRun)', () => {
    // Regression: every tool_calls row used to feed the action
    // counters regardless of status, so a denied write_file
    // showed up under "Files edited" and a denied bash test
    // surfaced as a failed test (passed:false via exit -1)
    // even though nothing executed. The recap was materially
    // false in policy-heavy sessions. New policy: only
    // status='done' counts toward actions; denied / error /
    // pending / running rows are dropped from the aggregates
    // (decisions still surface them via the approvals path).
    const s = seedSession();
    const userId = addUserTurn(s.id, 'try a few things');
    const aId = addAssistantTurn(s.id, userId, 'attempting');
    // Denied across every category that aggregates tool_calls.
    addToolCall(aId, 'read_file', { path: 'src/secret.ts' }, null, 'denied', 0, 1_301);
    addToolCall(aId, 'write_file', { path: 'src/x.ts', content: 'x' }, null, 'denied', 0, 1_302);
    addToolCall(aId, 'bash', { command: 'curl evil.com' }, null, 'denied', 0, 1_303);
    addToolCall(aId, 'bash', { command: 'pytest' }, null, 'denied', 0, 1_304);

    const out = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
    });
    expect(out.actions.filesRead).toEqual([]);
    expect(out.actions.filesWritten).toEqual([]);
    expect(out.actions.commandsRun).toEqual([]);
    expect(out.outcomes.testsRun).toEqual([]);
  });

  test('errored tool calls are excluded from action aggregates', () => {
    // `error` covers the harness's failure-without-success
    // shape: ToolError returned, exception caught, etc. The
    // call may have run partially or not at all — we cannot
    // tell from the row, so the safe default is to leave it
    // out of "what the session did" and surface it via the
    // separate errors[] channel (currently empty until the
    // failure_events table lands).
    const s = seedSession();
    const userId = addUserTurn(s.id, 'do');
    const aId = addAssistantTurn(s.id, userId, 'reading');
    addToolCall(aId, 'read_file', { path: 'missing.ts' }, null, 'error', 1, 1_301);
    addToolCall(aId, 'write_file', { path: 'src/y.ts', content: 'x' }, null, 'error', 1, 1_302);
    addToolCall(aId, 'bash', { command: 'bun test' }, null, 'error', 5, 1_303);

    const out = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
    });
    expect(out.actions.filesRead).toEqual([]);
    expect(out.actions.filesWritten).toEqual([]);
    expect(out.actions.commandsRun).toEqual([]);
    expect(out.outcomes.testsRun).toEqual([]);
  });

  test('mixed: only the executed sibling is aggregated; denied sibling stays as a decision', () => {
    // End-to-end shape the reviewer flagged: a session has a
    // done write_file and a denied write_file targeting the
    // same path; recap should report ONE files_written entry
    // (the done one) and ONE decision row (the denied one).
    // Without this, audit consumers double-count an edit that
    // never landed.
    const s = seedSession();
    const userId = addUserTurn(s.id, 'edit foo');
    const aId = addAssistantTurn(s.id, userId, 'editing');
    const okId = addToolCall(
      aId,
      'write_file',
      { path: 'src/foo.ts', content: 'ok' },
      { path: 'src/foo.ts', bytes_written: 2 },
      'done',
      5,
      1_301,
    );
    const deniedId = addToolCall(
      aId,
      'write_file',
      { path: 'src/forbidden.ts', content: '...' },
      null,
      'denied',
      0,
      1_302,
    );
    void okId;
    recordApproval(db, {
      toolCallId: deniedId,
      decision: 'deny',
      decidedBy: 'policy',
      reason: 'matched deny rule: forbidden.ts',
      decidedAt: 1_310,
    });

    const out = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
    });
    expect(out.actions.filesWritten.map((w) => w.path)).toEqual(['src/foo.ts']);
    // Decision row preserves the denial — the audit trail of WHY
    // forbidden.ts is missing from filesWritten lives here.
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]?.what).toContain('forbidden.ts');
    expect(out.decisions[0]?.decidedBy).toBe('policy');
  });

  test('bash_background commands report exitCode=-1 instead of 0', () => {
    // Regression: `bash_background` reaches tool_calls.status=
    // 'done' as soon as the process spawns, NOT when it exits.
    // The previous extractExitCode fallback returned 0 for any
    // done call without explicit exit_code, so the recap falsely
    // claimed a clean exit for a process that may still be
    // running, may have crashed, or may not have started at all.
    // The fix: foreground bash uses the existing exit-code path;
    // background variants get -1 ("no exit observed").
    const s = seedSession();
    const userId = addUserTurn(s.id, 'launch a watcher');
    const aId = addAssistantTurn(s.id, userId, 'launching');
    addToolCall(
      aId,
      'bash_background',
      { command: 'bun run dev --watch' },
      { process_id: 'pid-1', label: 'watcher' },
      'done',
      40,
      1_301,
    );
    const out = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
    });
    expect(out.actions.commandsRun).toHaveLength(1);
    expect(out.actions.commandsRun[0]).toEqual({
      command: 'bun run dev --watch',
      exitCode: -1,
      durationMs: 40,
    });
  });

  test('backgrounded test runner is NOT reported as passed', () => {
    // Regression: a backgrounded `bun test` would land in
    // outcomes.testsRun with passed=true via the spawn-only
    // exit-code-0 fallback. There is no recap-time signal of
    // actual pass/fail — the process may still be running or
    // may have failed unobserved. Test-runner heuristic must
    // fire ONLY on foreground bash so the operator never
    // reads validation success from a spawn that hasn't
    // settled. The command still appears under commandsRun
    // (with exitCode=-1) so it is not silently dropped.
    const s = seedSession();
    const userId = addUserTurn(s.id, 'kick off the suite in bg');
    const aId = addAssistantTurn(s.id, userId, 'running');
    addToolCall(
      aId,
      'bash_background',
      { command: 'bun test' },
      { process_id: 'pid-bg-1' },
      'done',
      30,
      1_301,
    );
    const out = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
    });
    expect(out.outcomes.testsRun).toEqual([]);
    // commandsRun preserves the call so audit consumers can
    // still see the spawn happened — they just see exitCode=-1
    // signaling unknown completion.
    expect(out.actions.commandsRun).toHaveLength(1);
    expect(out.actions.commandsRun[0]?.exitCode).toBe(-1);
  });

  test('foreground bash test runner still enters testsRun (positive control)', () => {
    // Negative space for the FOREGROUND_BASH_TOOLS gate: the
    // fix must not over-narrow and stop reporting honest
    // foreground test runs. Without this control, a regression
    // that excluded `bash` from the heuristic would silently
    // empty the testsRun section across every session.
    const s = seedSession();
    const userId = addUserTurn(s.id, 'run tests');
    const aId = addAssistantTurn(s.id, userId, 'running');
    addToolCall(aId, 'bash', { command: 'bun test' }, { exit_code: 0 }, 'done', 120, 1_301);
    const out = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId: s.id },
    });
    expect(out.outcomes.testsRun).toEqual([{ command: 'bun test', passed: true, durationMs: 120 }]);
  });

  test('day scope rejects malformed date strings', () => {
    expect(() =>
      projectRecap(db, {
        scope: { kind: 'day', cwd: '/proj', date: '05/07/2026' },
      }),
    ).toThrow(/YYYY-MM-DD/);
  });

  test('day scope rejects calendar-overflow dates that the regex would accept', () => {
    // Regression: `Date.UTC` silently normalizes invalid
    // calendar dates (Feb 31 → Mar 3, day 0 → previous month's
    // last day, month 13 → next-year January). Without
    // round-trip validation, the regex passes, the bounds get
    // computed against the wrong day, and the operator sees a
    // recap of a different date with no error. Each shape below
    // exercises one normalization path.
    const invalid: { date: string; what: string }[] = [
      { date: '2026-02-31', what: 'Feb 31 → Mar 3 (day-of-month overflow in short month)' },
      { date: '2026-04-31', what: 'Apr 31 → May 1 (day-of-month overflow in 30-day month)' },
      { date: '2025-02-29', what: 'Feb 29 in a non-leap year → Mar 1' },
      { date: '2026-13-01', what: 'month 13 → January of next year' },
      { date: '2026-00-15', what: 'month 0 → December of previous year' },
      { date: '2026-02-00', what: 'day 0 → last day of previous month' },
      { date: '2026-02-32', what: 'day 32 → next month' },
    ];
    for (const { date, what } of invalid) {
      expect(() =>
        projectRecap(db, {
          scope: { kind: 'day', cwd: '/proj', date },
        }),
      ).toThrow(new RegExp(`invalid calendar date.*${date.replace(/-/g, '\\-')}`));
      // Sanity: error message names the bad input so an operator
      // looking at logs ($what) can pivot directly to it.
      void what;
    }
  });

  test('day scope accepts valid leap-year and month-end dates', () => {
    // Positive control: 2024 is a leap year so Feb 29 is real;
    // 31-day month boundaries (Mar 31, Dec 31) must not trigger
    // the round-trip rejection.
    for (const date of ['2024-02-29', '2026-03-31', '2026-12-31', '2026-01-01']) {
      expect(() =>
        projectRecap(db, {
          scope: { kind: 'day', cwd: '/proj', date },
        }),
      ).not.toThrow();
    }
  });
});
