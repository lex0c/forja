import { beforeEach, describe, expect, test } from 'bun:test';
import { recapCommand } from '../../../../src/cli/slash/commands/recap.ts';
import type { SlashContext } from '../../../../src/cli/slash/types.ts';
import type { HarnessConfig } from '../../../../src/harness/index.ts';
import { DEFAULT_BUDGET } from '../../../../src/harness/types.ts';
import { createRegistry as createModelRegistry } from '../../../../src/providers/registry.ts';
import { type DB, openMemoryDb } from '../../../../src/storage/db.ts';
import { migrate } from '../../../../src/storage/migrate.ts';
import { appendMessage } from '../../../../src/storage/repos/messages.ts';
import { listRecentRecapRuns } from '../../../../src/storage/repos/recap-runs.ts';
import { createSession } from '../../../../src/storage/repos/sessions.ts';
import { createBus } from '../../../../src/tui/bus.ts';
import { createFocusStack } from '../../../../src/tui/focus-stack.ts';
import { createModalManager } from '../../../../src/tui/modal-manager.ts';

let db: DB;
let currentSessionId: string | null;

const baseConfig = {
  cwd: '/test/cwd',
  enableCheckpoints: false,
  planMode: false,
  budget: { ...DEFAULT_BUDGET },
  provider: {
    id: 'test/m',
    capabilities: { context_window: 200_000, output_max_tokens: 4_096 },
  },
} as unknown as HarnessConfig;

const makeCtx = (overrides: Partial<SlashContext> = {}): SlashContext => {
  const bus = createBus();
  const fs = createFocusStack();
  const modalManager = createModalManager({ bus, focusStack: fs, now: () => 1 });
  return {
    baseConfig,
    db,
    bus,
    modalManager,
    cumulative: { costUsd: 0, steps: 0, turns: 0 },
    now: () => 5_000,
    requestShutdown: () => undefined,
    isRunning: () => false,
    currentSessionId: () => currentSessionId,
    modelRegistry: createModelRegistry(),
    ...overrides,
  };
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  currentSessionId = null;
});

describe('/recap', () => {
  test('without args, requires an active session', async () => {
    const result = await recapCommand.exec([], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('no active session');
  });

  test('renders human markdown for the current session', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, {
      sessionId: s.id,
      role: 'user',
      content: 'refactor the queue retry logic',
      createdAt: 1_100,
    });
    currentSessionId = s.id;

    const result = await recapCommand.exec([], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.notes).toBeDefined();
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('# Recap —');
    expect(text).toContain('refactor the queue retry logic');
    expect(text).toContain('## Cost');
  });

  test('renders json output for /recap json', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    currentSessionId = s.id;
    const result = await recapCommand.exec(['json'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(() => JSON.parse(text)).not.toThrow();
    const parsed = JSON.parse(text) as { schemaVersion: string; scope: { sessionIds: string[] } };
    expect(parsed.schemaVersion).toBe('v1');
    expect(parsed.scope.sessionIds).toEqual([s.id]);
  });

  test('/recap session <id> targets a specific session', async () => {
    const a = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    const b = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 2_000 });
    appendMessage(db, {
      sessionId: a.id,
      role: 'user',
      content: 'goal of A',
      createdAt: 1_100,
    });
    appendMessage(db, {
      sessionId: b.id,
      role: 'user',
      content: 'goal of B',
      createdAt: 2_100,
    });
    currentSessionId = b.id;
    const result = await recapCommand.exec(['session', a.id], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('goal of A');
    expect(text).not.toContain('goal of B');
  });

  test('/recap json session <id> emits json for a specific session', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    const result = await recapCommand.exec(['json', 'session', s.id], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    const parsed = JSON.parse(text) as { scope: { sessionIds: string[] } };
    expect(parsed.scope.sessionIds).toEqual([s.id]);
  });

  test('/recap last <N> truncates step window', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'first', createdAt: 1_100 });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'second', createdAt: 1_200 });
    currentSessionId = s.id;
    const result = await recapCommand.exec(['last', '1'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('second');
    // 'first' should be truncated out by the limit; goal extraction
    // takes the first user message of the (truncated) window.
    expect(text).not.toContain('**Goal:** first');
  });

  test('records a recap_runs row on every successful invocation', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    currentSessionId = s.id;
    await recapCommand.exec([], makeCtx({ now: () => 5_000 }));
    await recapCommand.exec(['json'], makeCtx({ now: () => 5_001 }));
    const runs = listRecentRecapRuns(db);
    expect(runs).toHaveLength(2);
    // listRecentRecapRuns is created_at DESC; the json call was second.
    expect(runs[0]?.renderer).toBe('json');
    expect(runs[0]?.usedLlm).toBe(false);
    expect(runs[0]?.sessionIds).toEqual([s.id]);
    expect(runs[1]?.renderer).toBe('human');
    expect(runs[1]?.scopeKind).toBe('session_current');
  });

  test('does NOT record a recap_runs row on parse errors', async () => {
    const result = await recapCommand.exec(['mystery'], makeCtx());
    expect(result.kind).toBe('error');
    expect(listRecentRecapRuns(db)).toHaveLength(0);
  });

  test('does NOT record a recap_runs row when projection rejects unknown session', async () => {
    const result = await recapCommand.exec(['session', 'ghost'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('not found');
    expect(listRecentRecapRuns(db)).toHaveLength(0);
  });

  test('rejects /recap last without an argument', async () => {
    currentSessionId = 'unused';
    const result = await recapCommand.exec(['last'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('missing step count');
  });

  test('rejects /recap last with invalid count', async () => {
    currentSessionId = 'unused';
    const result = await recapCommand.exec(['last', 'foo'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('invalid step count');
  });

  test('rejects /recap last 0 (must be positive)', async () => {
    currentSessionId = 'unused';
    const result = await recapCommand.exec(['last', '0'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('invalid step count');
  });

  test('rejects /recap session without an id', async () => {
    const result = await recapCommand.exec(['session'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('missing session id');
  });

  test('surfaces a clear "not yet available" for future renderers', async () => {
    for (const sub of ['pr', 'changelog', 'slack', 'terse']) {
      const result = await recapCommand.exec([sub], makeCtx());
      expect(result.kind).toBe('error');
      if (result.kind !== 'error') return;
      expect(result.message).toContain('M4.2');
    }
  });

  test('surfaces a clear "not yet available" for future cross-session scopes', async () => {
    for (const sub of ['day', 'range']) {
      const result = await recapCommand.exec([sub], makeCtx());
      expect(result.kind).toBe('error');
      if (result.kind !== 'error') return;
      expect(result.message).toContain('M4.3');
    }
  });

  test('rejects unknown subcommand with a hint to /recap variants', async () => {
    const result = await recapCommand.exec(['mystery'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('unknown subcommand');
    expect(result.message).toContain('/recap session');
  });

  test('audit INSERT failure does NOT destroy the recap output (warn instead)', async () => {
    // Simulate disk-full / schema-corruption on the audit row by
    // dropping the table after the projection succeeds. The slash
    // must still return the recap notes; the operator gets a warn
    // bracketing the audit gap, not a crash.
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, {
      sessionId: s.id,
      role: 'user',
      content: 'do work',
      createdAt: 1_100,
    });
    currentSessionId = s.id;
    db.query('DROP TABLE recap_runs').run();

    const events: { type: string; message?: string }[] = [];
    const ctx = makeCtx();
    ctx.bus.on('warn', (e) => events.push({ type: 'warn', message: e.message }));
    ctx.bus.on('error', (e) => events.push({ type: 'error', message: e.message }));

    const result = await recapCommand.exec([], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('do work');
    // Exactly one warn, no error.
    const warns = events.filter((e) => e.type === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toContain('audit row not written');
    expect(warns[0]?.message).toContain('output is intact');
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });

  test('rejects extra trailing arguments', async () => {
    const result = await recapCommand.exec(['session', 'sid', 'extra'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('exactly one argument');
  });
});
