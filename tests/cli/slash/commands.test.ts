import { describe, expect, test } from 'bun:test';
import { budgetCommand } from '../../../src/cli/slash/commands/budget.ts';
import { clearCommand } from '../../../src/cli/slash/commands/clear.ts';
import { costCommand } from '../../../src/cli/slash/commands/cost.ts';
import { critiqueCommand } from '../../../src/cli/slash/commands/critique.ts';
import { buildHelpCommand } from '../../../src/cli/slash/commands/help.ts';
import { modelCommand } from '../../../src/cli/slash/commands/model.ts';
import { permsCommand, renderPolicy } from '../../../src/cli/slash/commands/perms.ts';
import { planCommand } from '../../../src/cli/slash/commands/plan.ts';
import { quitCommand } from '../../../src/cli/slash/commands/quit.ts';
import { sessionsCommand } from '../../../src/cli/slash/commands/sessions.ts';
import { subagentsCommand } from '../../../src/cli/slash/commands/subagents.ts';
import type { SlashCommand, SlashContext } from '../../../src/cli/slash/types.ts';
import type { HarnessConfig } from '../../../src/harness/index.ts';
import { DEFAULT_BUDGET } from '../../../src/harness/types.ts';
import { createRegistry as createModelRegistry } from '../../../src/providers/registry.ts';
import { openMemoryDb } from '../../../src/storage/db.ts';
import { migrate } from '../../../src/storage/migrate.ts';
import { createSession } from '../../../src/storage/repos/sessions.ts';
import { createBus } from '../../../src/tui/bus.ts';
import { createFocusStack } from '../../../src/tui/focus-stack.ts';
import { createModalManager } from '../../../src/tui/modal-manager.ts';

const makeCtx = (overrides: Partial<SlashContext> = {}): SlashContext => {
  const bus = createBus();
  const fs = createFocusStack();
  const modalManager = createModalManager({ bus, focusStack: fs, now: () => 1 });
  const db = openMemoryDb();
  migrate(db);
  const baseConfig = {
    cwd: '/test/cwd',
    enableCheckpoints: false,
    planMode: false,
    budget: { ...DEFAULT_BUDGET },
    provider: {
      id: 'test/m',
      capabilities: {
        context_window: 200000,
        output_max_tokens: 4096,
      },
    },
  } as unknown as HarnessConfig;
  return {
    baseConfig,
    db,
    bus,
    modalManager,
    cumulative: { costUsd: 0, steps: 0, turns: 0, critiqueCostUsd: 0 },
    now: () => 1,
    requestShutdown: () => undefined,
    isRunning: () => false,
    currentSessionId: () => null,
    replSessionIds: () => [],
    modelRegistry: createModelRegistry(),
    ...overrides,
  };
};

describe('/help', () => {
  test('returns notes listing every registered command', async () => {
    const dummy: SlashCommand = {
      name: 'foo',
      description: 'foo desc',
      exec: async () => ({ kind: 'ok' }),
    };
    const help = buildHelpCommand(() => [dummy, quitCommand]);
    const result = await help.exec([], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.notes).toBeDefined();
    expect(result.notes?.[0]).toBe('Slash commands:');
    expect(result.notes?.some((l) => l.includes('/foo') && l.includes('foo desc'))).toBe(true);
    expect(result.notes?.some((l) => l.includes('/quit'))).toBe(true);
  });
});

describe('/quit', () => {
  test('calls requestShutdown and returns exit', async () => {
    let called = false;
    const ctx = makeCtx({
      requestShutdown: () => {
        called = true;
      },
    });
    const result = await quitCommand.exec([], ctx);
    expect(called).toBe(true);
    expect(result.kind).toBe('exit');
  });
});

describe('/clear', () => {
  test('emits screen:clear on the bus', async () => {
    const ctx = makeCtx();
    const events: string[] = [];
    ctx.bus.onAny((e) => events.push(e.type));
    const result = await clearCommand.exec([], ctx);
    expect(result.kind).toBe('ok');
    expect(events).toContain('screen:clear');
  });
});

describe('/cost', () => {
  test('formats cumulative cost / steps / turns', async () => {
    const ctx = makeCtx();
    ctx.cumulative.costUsd = 0.0234;
    ctx.cumulative.steps = 12;
    ctx.cumulative.turns = 3;
    const result = await costCommand.exec([], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.notes?.[0]).toContain('$0.0234');
    expect(result.notes?.[0]).toContain('12 steps');
    expect(result.notes?.[0]).toContain('3 turns');
  });

  test('cost format degrades with magnitude', async () => {
    const ctx = makeCtx();
    ctx.cumulative.costUsd = 5.5;
    ctx.cumulative.steps = 0;
    ctx.cumulative.turns = 0;
    const r1 = await costCommand.exec([], ctx);
    if (r1.kind !== 'ok') return;
    expect(r1.notes?.[0]).toContain('$5.500');
    ctx.cumulative.costUsd = 100.5;
    const r2 = await costCommand.exec([], ctx);
    if (r2.kind !== 'ok') return;
    expect(r2.notes?.[0]).toContain('$100.50');
  });

  test('omits the critique line when critiqueCostUsd is 0 (mode=off / never ran)', async () => {
    const ctx = makeCtx();
    ctx.cumulative.costUsd = 0.5;
    ctx.cumulative.steps = 5;
    ctx.cumulative.turns = 1;
    ctx.cumulative.critiqueCostUsd = 0;
    const result = await costCommand.exec([], ctx);
    if (result.kind !== 'ok') return;
    expect(result.notes).toHaveLength(1);
    expect(result.notes?.[0]).not.toContain('critique');
  });

  test('shows critique breakdown line when critiqueCostUsd > 0', async () => {
    const ctx = makeCtx();
    ctx.cumulative.costUsd = 0.5;
    ctx.cumulative.steps = 5;
    ctx.cumulative.turns = 1;
    ctx.cumulative.critiqueCostUsd = 0.12;
    const result = await costCommand.exec([], ctx);
    if (result.kind !== 'ok') return;
    expect(result.notes).toHaveLength(2);
    // First line keeps the existing format.
    expect(result.notes?.[0]).toContain('$0.5000');
    // Second line is the breakdown — tree-glyph prefix matches the
    // existing scrollback aesthetic for nested info.
    expect(result.notes?.[1]).toMatch(/^└─ critique: \$0\.1200/);
  });
});

describe('/critique', () => {
  test('config-only sub-command shows mode/threshold/maxOverheadMs/promptVersion + provider', async () => {
    const { DEFAULT_CRITIQUE_PROMPT_VERSION } = await import('../../../src/critique/index.ts');
    const ctx = makeCtx({
      baseConfig: {
        cwd: '/p',
        provider: { id: 'anthropic/sonnet-4-6' },
        critique: { mode: 'on_writes', threshold: 0.85, maxOverheadMs: 5000 },
      } as unknown as HarnessConfig,
    });
    const result = await critiqueCommand.exec(['config'], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const out = (result.notes ?? []).join('\n');
    expect(out).toContain('mode:             on_writes');
    expect(out).toContain('threshold:        0.85');
    expect(out).toContain('max_overhead_ms:  5000');
    // Pinned via the constant so the displayed default tracks
    // whatever the engine actually resolves to (V1 → V2 → ...).
    // Hardcoding the literal would let /critique drift from the
    // engine's runtime default again.
    expect(out).toContain(`prompt_version:   ${DEFAULT_CRITIQUE_PROMPT_VERSION}`);
    expect(out).toContain('(executor: anthropic/sonnet-4-6)');
  });

  test('config falls back to DEFAULT_CRITIQUE_CONFIG when [critique] is not set', async () => {
    // Read the source-of-truth defaults so a future change to
    // DEFAULT_CRITIQUE_CONFIG forces an explicit acknowledgment
    // here. Hardcoding the same values both in /critique and the
    // test would let them drift in lockstep silently.
    const { DEFAULT_CRITIQUE_CONFIG, DEFAULT_CRITIQUE_PROMPT_VERSION } = await import(
      '../../../src/critique/index.ts'
    );
    const result = await critiqueCommand.exec(['config'], makeCtx());
    if (result.kind !== 'ok') return;
    const out = (result.notes ?? []).join('\n');
    expect(out).toContain(`mode:             ${DEFAULT_CRITIQUE_CONFIG.mode}`);
    expect(out).toContain(`threshold:        ${DEFAULT_CRITIQUE_CONFIG.threshold.toFixed(2)}`);
    expect(out).toContain(`max_overhead_ms:  ${DEFAULT_CRITIQUE_CONFIG.maxOverheadMs}`);
    // The displayed prompt_version MUST match what the engine
    // would resolve to at runtime (engine.ts:
    // `options.promptVersion ?? DEFAULT_CRITIQUE_PROMPT_VERSION`).
    // Without this assertion, /critique drifted: it reported 'v1'
    // for runs that actually used V2 after the calibration. Now
    // pinned via the constant so a future bump propagates.
    expect(out).toContain(`prompt_version:   ${DEFAULT_CRITIQUE_PROMPT_VERSION}`);
  });

  test('shows distinct critic provider when configured', async () => {
    const ctx = makeCtx({
      baseConfig: {
        cwd: '/p',
        provider: { id: 'anthropic/sonnet-4-6' },
        critiqueProvider: { id: 'anthropic/haiku-4-5' },
      } as unknown as HarnessConfig,
    });
    const result = await critiqueCommand.exec(['config'], ctx);
    if (result.kind !== 'ok') return;
    const out = (result.notes ?? []).join('\n');
    expect(out).toContain('critic provider:  anthropic/haiku-4-5');
    expect(out).not.toContain('(executor:');
  });

  test('"no session yet" when currentSessionId is null', async () => {
    const result = await critiqueCommand.exec([], makeCtx());
    if (result.kind !== 'ok') return;
    const out = (result.notes ?? []).join('\n');
    expect(out).toContain('no session yet');
  });

  test('lists recent runs newest-first with aggregate when session has critique rows', async () => {
    const ctx = makeCtx();
    const session = createSession(ctx.db, {
      cwd: '/p',
      model: 'mock/m',
    });
    const { recordCritiqueRun } = await import('../../../src/storage/index.ts');
    // Three runs: clean, warning_ignored, warning_redo. Aggregate
    // should count each code, total cost should sum, and the
    // listing order is newest-first (step 3 → 2 → 1).
    recordCritiqueRun(ctx.db, {
      sessionId: session.id,
      stepN: 1,
      mode: 'always',
      strategy: 'llm',
      decision: 'no_modal',
      code: 'critique.clean',
      rawCount: 0,
      filteredCount: 0,
      overallConfidence: 0.95,
      durationMs: 1100,
      costUsd: 0.001,
      toolPlanWrites: false,
      promptVersion: 'v1',
      threshold: 0.7,
    });
    recordCritiqueRun(ctx.db, {
      sessionId: session.id,
      stepN: 2,
      mode: 'always',
      strategy: 'llm',
      decision: 'ignore',
      code: 'critique.warning_ignored',
      rawCount: 2,
      filteredCount: 1,
      overallConfidence: 0.5,
      durationMs: 2200,
      costUsd: 0.002,
      toolPlanWrites: false,
      promptVersion: 'v1',
      threshold: 0.7,
    });
    recordCritiqueRun(ctx.db, {
      sessionId: session.id,
      stepN: 3,
      mode: 'always',
      strategy: 'llm',
      decision: 'redo',
      code: 'critique.warning_redo',
      rawCount: 1,
      filteredCount: 1,
      overallConfidence: 0.3,
      durationMs: 1500,
      costUsd: 0.003,
      toolPlanWrites: true,
      promptVersion: 'v1',
      threshold: 0.7,
    });
    const ctxWithSession = makeCtx({
      db: ctx.db,
      currentSessionId: () => session.id,
      replSessionIds: () => [session.id],
    });
    const result = await critiqueCommand.exec([], ctxWithSession);
    if (result.kind !== 'ok') return;
    const out = (result.notes ?? []).join('\n');
    expect(out).toContain('recent runs (3 of 3):');
    // Newest first.
    const step3 = out.indexOf('step 3');
    const step2 = out.indexOf('step 2');
    const step1 = out.indexOf('step 1');
    expect(step3).toBeGreaterThan(-1);
    expect(step3).toBeLessThan(step2);
    expect(step2).toBeLessThan(step1);
    // Writes flag rendered for step 3 (the only writes:true row).
    expect(out).toMatch(/step 3.*\[writes\]/);
    expect(out).toMatch(/step 1.*\[text\]/);
    // Aggregate by code.
    expect(out).toContain('aggregate (3 runs');
    expect(out).toContain('critique.warning_ignored:1');
    expect(out).toContain('critique.warning_redo:1');
    expect(out).toContain('critique.clean:1');
  });

  test('limit argument caps the list size', async () => {
    const ctx = makeCtx();
    const session = createSession(ctx.db, {
      cwd: '/p',
      model: 'mock/m',
    });
    const { recordCritiqueRun } = await import('../../../src/storage/index.ts');
    for (let i = 1; i <= 5; i++) {
      recordCritiqueRun(ctx.db, {
        sessionId: session.id,
        stepN: i,
        mode: 'always',
        strategy: 'llm',
        decision: 'no_modal',
        code: 'critique.clean',
        rawCount: 0,
        filteredCount: 0,
        overallConfidence: 0.9,
        durationMs: 1000,
        costUsd: 0.001,
        toolPlanWrites: false,
        promptVersion: 'v1',
        threshold: 0.7,
      });
    }
    const ctxWithSession = makeCtx({
      db: ctx.db,
      currentSessionId: () => session.id,
      replSessionIds: () => [session.id],
    });
    const result = await critiqueCommand.exec(['2'], ctxWithSession);
    if (result.kind !== 'ok') return;
    const out = (result.notes ?? []).join('\n');
    // "(2 of 5)" — 5 total, 2 shown.
    expect(out).toContain('recent runs (2 of 5):');
  });

  test('aggregates across multiple REPL session ids (cross-turn / playbook)', async () => {
    // Two different sessions in the same DB, both with critique
    // runs. /critique should walk both via replSessionIds and
    // surface the union — not just the most recent.
    const ctx = makeCtx();
    const sessionA = createSession(ctx.db, { cwd: '/p', model: 'mock/m' });
    const sessionB = createSession(ctx.db, { cwd: '/p', model: 'mock/m' });
    const { recordCritiqueRun } = await import('../../../src/storage/index.ts');
    recordCritiqueRun(ctx.db, {
      sessionId: sessionA.id,
      stepN: 1,
      mode: 'always',
      strategy: 'llm',
      decision: 'no_modal',
      code: 'critique.clean',
      rawCount: 0,
      filteredCount: 0,
      overallConfidence: 0.95,
      durationMs: 1000,
      costUsd: 0.001,
      toolPlanWrites: false,
      promptVersion: 'v1',
      threshold: 0.7,
    });
    recordCritiqueRun(ctx.db, {
      sessionId: sessionB.id,
      stepN: 1,
      mode: 'always',
      strategy: 'llm',
      decision: 'redo',
      code: 'critique.warning_redo',
      rawCount: 1,
      filteredCount: 1,
      overallConfidence: 0.4,
      durationMs: 1500,
      costUsd: 0.002,
      toolPlanWrites: false,
      promptVersion: 'v1',
      threshold: 0.7,
    });
    const ctx2 = makeCtx({
      db: ctx.db,
      currentSessionId: () => sessionB.id,
      replSessionIds: () => [sessionA.id, sessionB.id],
    });
    const result = await critiqueCommand.exec([], ctx2);
    if (result.kind !== 'ok') return;
    const out = (result.notes ?? []).join('\n');
    // Two rows total — both sessions surfaced.
    expect(out).toContain('recent runs (2 of 2):');
    // Aggregate spans both codes.
    expect(out).toContain('critique.clean:1');
    expect(out).toContain('critique.warning_redo:1');
  });

  test('non-numeric limit produces a clean error', async () => {
    const result = await critiqueCommand.exec(['10foo'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('invalid limit');
  });

  test('rejects more than one argument', async () => {
    const result = await critiqueCommand.exec(['1', '2'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('at most one argument');
  });
});

describe('/sessions', () => {
  test('returns "no sessions" notice when DB is empty', async () => {
    const ctx = makeCtx();
    const result = await sessionsCommand.exec([], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.notes?.[0]).toContain('no sessions found');
  });

  test('lists sessions with id (8-char), timestamp, status, cost, model', async () => {
    const ctx = makeCtx();
    createSession(ctx.db, { model: 'm-a', cwd: '/test/cwd' });
    createSession(ctx.db, { model: 'm-b', cwd: '/test/cwd' });
    const result = await sessionsCommand.exec([], ctx);
    if (result.kind !== 'ok') return;
    expect(result.notes?.[0]).toContain('recent sessions');
    expect(result.notes?.length).toBeGreaterThanOrEqual(3); // header + 2 rows
    // Each row contains the model name and an 8-char prefix of the session id.
    expect(result.notes?.some((l) => l.includes('m-a'))).toBe(true);
    expect(result.notes?.some((l) => l.includes('m-b'))).toBe(true);
  });

  test('respects positional limit arg', async () => {
    const ctx = makeCtx();
    for (let i = 0; i < 5; i++) createSession(ctx.db, { model: `m-${i}`, cwd: '/test/cwd' });
    const result = await sessionsCommand.exec(['2'], ctx);
    if (result.kind !== 'ok') return;
    expect(result.notes?.length).toBe(3); // header + 2 rows
  });

  test('rejects non-numeric / non-positive limit', async () => {
    const ctx = makeCtx();
    const r1 = await sessionsCommand.exec(['abc'], ctx);
    expect(r1.kind).toBe('error');
    const r2 = await sessionsCommand.exec(['0'], ctx);
    expect(r2.kind).toBe('error');
    const r3 = await sessionsCommand.exec(['-5'], ctx);
    expect(r3.kind).toBe('error');
  });

  test('renders timestamps in local wall-clock time (regression: not UTC)', async () => {
    // Pre-fix the formatter was toISOString().slice(...) which emits
    // UTC while LOOKING like a local timestamp. An operator in UTC-3
    // saw every session shifted +3h and would scan recency wrong.
    // The fix uses local getters; this test pins the contract by
    // constructing the Date via local-component constructor (the
    // mirror of the local getters the formatter uses), so the
    // assertion holds regardless of the test env's timezone.
    const ctx = makeCtx();
    const localStartedAt = new Date(2026, 4, 3, 14, 30, 45).getTime(); // May 3, 2026 14:30:45 LOCAL
    createSession(ctx.db, { model: 'm-tz', cwd: '/test/cwd', startedAt: localStartedAt });
    const result = await sessionsCommand.exec([], ctx);
    if (result.kind !== 'ok') return;
    const row = result.notes?.find((l) => l.includes('m-tz')) ?? '';
    expect(row).toContain('2026-05-03 14:30:45');
  });

  test('rejects partially-numeric and decimal limits (no silent coercion)', async () => {
    // Number.parseInt would coerce '10foo' → 10 and '1.5' → 1, but
    // the command's error message advertises "must be a positive
    // integer" — those inputs need to fail explicitly so a typo
    // doesn't silently return an unexpected number of rows.
    const ctx = makeCtx();
    for (const bad of ['10foo', '1.5', '1e3', '0x10', ' 5', '5 ', '+5', '5.0']) {
      const result = await sessionsCommand.exec([bad], ctx);
      expect(result.kind).toBe('error');
      if (result.kind !== 'error') continue;
      expect(result.message).toContain(bad);
      expect(result.message).toContain('positive integer');
    }
  });

  test('scopes to current cwd', async () => {
    const ctx = makeCtx();
    createSession(ctx.db, { model: 'm-here', cwd: '/test/cwd' });
    createSession(ctx.db, { model: 'm-elsewhere', cwd: '/other/cwd' });
    const result = await sessionsCommand.exec([], ctx);
    if (result.kind !== 'ok') return;
    expect(result.notes?.some((l) => l.includes('m-here'))).toBe(true);
    expect(result.notes?.some((l) => l.includes('m-elsewhere'))).toBe(false);
  });
});

describe('/model', () => {
  test('shows current model + capabilities', async () => {
    const ctx = makeCtx();
    const result = await modelCommand.exec([], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.notes?.some((l) => l.includes('test/m'))).toBe(true);
    expect(result.notes?.some((l) => l.includes('200,000'))).toBe(true);
    expect(result.notes?.some((l) => l.includes('4,096'))).toBe(true);
  });

  test('/model unknown id rejects with Known list', async () => {
    const ctx = makeCtx();
    // Seed the registry with one known entry so the error message
    // proves the Known suggestion came from the registry.
    ctx.modelRegistry.register({
      id: 'fake/sonnet',
      family: 'anthropic',
      modelName: 'sonnet',
      capabilities: {
        tools: 'native',
        cache: false as const,
        vision: false,
        streaming: true,
        constrained: 'tools',
        context_window: 1000,
        output_max_tokens: 100,
        cost_per_1k_input: 0,
        cost_per_1k_output: 0,
        notes: [],
      },
      factory: () => ({}) as never,
    });
    const result = await modelCommand.exec(['no-such-model'], ctx);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('unknown model');
    expect(result.message).toContain('fake/sonnet');
  });

  test('/model <id> swaps baseConfig.provider and notes next-turn pickup', async () => {
    const ctx = makeCtx();
    const newProvider = {
      id: 'fake/swap',
      family: 'anthropic' as const,
      capabilities: {
        tools: 'native' as const,
        cache: false as const,
        vision: false,
        streaming: true,
        constrained: 'tools' as const,
        context_window: 500,
        output_max_tokens: 200,
        cost_per_1k_input: 0,
        cost_per_1k_output: 0,
        notes: [] as string[],
      },
      generate: async function* () {},
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };
    ctx.modelRegistry.register({
      id: 'fake/swap',
      family: 'anthropic',
      modelName: 'swap',
      capabilities: newProvider.capabilities,
      factory: () => newProvider,
    });
    const result = await modelCommand.exec(['fake/swap'], ctx);
    if (result.kind !== 'ok') {
      throw new Error(`expected ok, got ${result.kind}: ${JSON.stringify(result)}`);
    }
    expect(ctx.baseConfig.provider).toBe(newProvider);
    expect(result.notes?.[0]).toContain('fake/swap');
    expect(result.notes?.[0]).toContain('next turn');
  });

  test('/model <id> idempotent when already on that model', async () => {
    const ctx = makeCtx();
    // baseConfig.provider.id is 'test/m' from the test fixture; register
    // a registry entry under the same id so the lookup succeeds before
    // the idempotency check fires.
    ctx.modelRegistry.register({
      id: 'test/m',
      family: 'anthropic',
      modelName: 'm',
      capabilities: ctx.baseConfig.provider.capabilities,
      factory: () => ctx.baseConfig.provider,
    });
    const result = await modelCommand.exec(['test/m'], ctx);
    if (result.kind !== 'ok') return;
    expect(result.notes?.[0]).toContain('already');
    expect(result.notes?.[0]).not.toContain('next turn');
  });

  test('/model <id> reports a clean error when the factory throws', async () => {
    // Typical: missing API key. The SDK throws at construction time.
    const ctx = makeCtx();
    ctx.modelRegistry.register({
      id: 'fake/no-key',
      family: 'anthropic',
      modelName: 'no-key',
      capabilities: ctx.baseConfig.provider.capabilities,
      factory: () => {
        throw new Error('ANTHROPIC_API_KEY not set');
      },
    });
    const result = await modelCommand.exec(['fake/no-key'], ctx);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('failed to instantiate');
    expect(result.message).toContain('ANTHROPIC_API_KEY not set');
  });

  test('/model <id> appends current-turn cue when running', async () => {
    const ctx = makeCtx({ isRunning: () => true });
    const newProvider = {
      ...ctx.baseConfig.provider,
      id: 'fake/cue',
    };
    ctx.modelRegistry.register({
      id: 'fake/cue',
      family: 'anthropic',
      modelName: 'cue',
      capabilities: newProvider.capabilities,
      factory: () => newProvider,
    });
    const result = await modelCommand.exec(['fake/cue'], ctx);
    if (result.kind !== 'ok') return;
    expect(result.notes?.length).toBe(2);
    expect(result.notes?.[1]).toContain('current turn');
  });

  test('/model with too many args returns error', async () => {
    const result = await modelCommand.exec(['a', 'b'], makeCtx());
    expect(result.kind).toBe('error');
  });
});

describe('/plan', () => {
  test('reports plan mode disabled by default', async () => {
    const result = await planCommand.exec([], makeCtx());
    if (result.kind !== 'ok') return;
    expect(result.notes?.[0]).toContain('disabled');
  });

  test('reports plan mode enabled when set', async () => {
    const ctx = makeCtx();
    (ctx.baseConfig as { planMode: boolean }).planMode = true;
    const result = await planCommand.exec([], ctx);
    if (result.kind !== 'ok') return;
    expect(result.notes?.[0]).toContain('enabled');
  });

  test('/plan on flips planMode true and notes next-turn pickup', async () => {
    const ctx = makeCtx();
    expect(ctx.baseConfig.planMode).toBeFalsy();
    const result = await planCommand.exec(['on'], ctx);
    if (result.kind !== 'ok') return;
    expect(ctx.baseConfig.planMode).toBe(true);
    expect(result.notes?.[0]).toContain('enabled');
    expect(result.notes?.[0]).toContain('next turn');
  });

  test('/plan off flips planMode false', async () => {
    const ctx = makeCtx();
    (ctx.baseConfig as { planMode: boolean }).planMode = true;
    const result = await planCommand.exec(['off'], ctx);
    if (result.kind !== 'ok') return;
    expect(ctx.baseConfig.planMode).toBe(false);
    expect(result.notes?.[0]).toContain('disabled');
  });

  test('/plan on when already enabled is a no-op (idempotent note)', async () => {
    const ctx = makeCtx();
    (ctx.baseConfig as { planMode: boolean }).planMode = true;
    const result = await planCommand.exec(['on'], ctx);
    if (result.kind !== 'ok') return;
    expect(result.notes?.[0]).toContain('already');
    // No mutation note; the next-turn cue only appears on actual flips.
    expect(result.notes?.[0]).not.toContain('next turn');
  });

  test('/plan with unknown arg returns error', async () => {
    const result = await planCommand.exec(['maybe'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('unknown arg');
  });

  test('/plan with too many args returns error', async () => {
    const result = await planCommand.exec(['on', 'extra'], makeCtx());
    expect(result.kind).toBe('error');
  });

  test('/plan on appends current-turn cue when a turn is running', async () => {
    const ctx = makeCtx({ isRunning: () => true });
    const result = await planCommand.exec(['on'], ctx);
    if (result.kind !== 'ok') return;
    expect(result.notes?.length).toBe(2);
    expect(result.notes?.[1]).toContain('current turn');
  });
});

describe('/budget', () => {
  test('shows the four budget caps from config', async () => {
    const ctx = makeCtx();
    const result = await budgetCommand.exec([], ctx);
    if (result.kind !== 'ok') return;
    expect(result.notes?.some((l) => l.includes('max steps'))).toBe(true);
    expect(result.notes?.some((l) => l.includes('max wall-clock'))).toBe(true);
    expect(result.notes?.some((l) => l.includes('max tool errors'))).toBe(true);
    expect(result.notes?.some((l) => l.includes('max cost'))).toBe(true);
  });

  test('shows the DEFAULT_BUDGET cost cap when operator has not overridden', async () => {
    // DEFAULT_BUDGET ships a 5 USD cost cap (AGENTIC_CLI.md §5).
    // The slash UI falls back to the default when the operator
    // has not explicitly set or cleared the cap, so a fresh
    // session shows "$5.00", not "no cap".
    const ctx = makeCtx();
    const result = await budgetCommand.exec([], ctx);
    if (result.kind !== 'ok') return;
    const costLine = result.notes?.find((l) => l.startsWith('max cost:'));
    expect(costLine).toBeDefined();
    expect(costLine).not.toContain('no cap');
    // Pinning the formatted default keeps the contract change
    // visible if the spec bumps the value.
    expect(costLine).toContain('$5.00');
  });

  test('shows "no cap" only after the operator explicitly opts out', async () => {
    const ctx = makeCtx();
    await budgetCommand.exec(['cost', 'off'], ctx);
    const result = await budgetCommand.exec([], ctx);
    if (result.kind !== 'ok') return;
    expect(result.notes?.some((l) => l.includes('no cap'))).toBe(true);
  });

  test('/budget steps N updates maxSteps and notes next-turn pickup', async () => {
    const ctx = makeCtx();
    const result = await budgetCommand.exec(['steps', '120'], ctx);
    if (result.kind !== 'ok') return;
    expect(ctx.baseConfig.budget?.maxSteps).toBe(120);
    expect(result.notes?.[0]).toContain('120');
    expect(result.notes?.[0]).toContain('next turn');
  });

  test('/budget steps rejects non-positive integers', async () => {
    for (const bad of ['0', '-5', 'abc', '3.5', '']) {
      const ctx = makeCtx();
      const result = await budgetCommand.exec(['steps', bad], ctx);
      expect(result.kind).toBe('error');
      // Original maxSteps untouched.
      expect(ctx.baseConfig.budget?.maxSteps).not.toBe(0);
    }
  });

  test('/budget steps requires exactly one value', async () => {
    expect((await budgetCommand.exec(['steps'], makeCtx())).kind).toBe('error');
    expect((await budgetCommand.exec(['steps', '1', '2'], makeCtx())).kind).toBe('error');
  });

  test('/budget cost X.XX updates maxCostUsd', async () => {
    const ctx = makeCtx();
    const result = await budgetCommand.exec(['cost', '5.50'], ctx);
    if (result.kind !== 'ok') return;
    expect(ctx.baseConfig.budget?.maxCostUsd).toBeCloseTo(5.5);
    expect(result.notes?.[0]).toContain('next turn');
  });

  test('/budget cost 0 is allowed (no-spend mode)', async () => {
    const ctx = makeCtx();
    const result = await budgetCommand.exec(['cost', '0'], ctx);
    expect(result.kind).toBe('ok');
    expect(ctx.baseConfig.budget?.maxCostUsd).toBe(0);
  });

  test('/budget cost none clears the cap entirely', async () => {
    const ctx = makeCtx();
    // Seed a cap first so the clear has something to remove.
    await budgetCommand.exec(['cost', '5'], ctx);
    expect(ctx.baseConfig.budget?.maxCostUsd).toBe(5);
    const result = await budgetCommand.exec(['cost', 'none'], ctx);
    if (result.kind !== 'ok') return;
    expect(ctx.baseConfig.budget?.maxCostUsd).toBeUndefined();
    expect(result.notes?.[0]).toContain('no cap');
  });

  test('/budget cost off is an alias for none', async () => {
    const ctx = makeCtx();
    await budgetCommand.exec(['cost', '5'], ctx);
    const result = await budgetCommand.exec(['cost', 'OFF'], ctx);
    expect(result.kind).toBe('ok');
    expect(ctx.baseConfig.budget?.maxCostUsd).toBeUndefined();
  });

  test('/budget cost rejects negatives and NaN', async () => {
    for (const bad of ['-1', 'abc', '1.2.3', '']) {
      const ctx = makeCtx();
      const result = await budgetCommand.exec(['cost', bad], ctx);
      expect(result.kind).toBe('error');
    }
  });

  test('/budget with unknown subcommand returns error', async () => {
    const result = await budgetCommand.exec(['wallclock', '60000'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('unknown subcommand');
  });

  test('/budget steps idempotent: same value returns "already" without next-turn cue', async () => {
    const ctx = makeCtx();
    await budgetCommand.exec(['steps', '50'], ctx);
    const result = await budgetCommand.exec(['steps', '50'], ctx);
    if (result.kind !== 'ok') return;
    expect(result.notes?.[0]).toContain('already');
    expect(result.notes?.[0]).not.toContain('next turn');
  });

  test('/budget cost idempotent: same value returns "already"', async () => {
    const ctx = makeCtx();
    await budgetCommand.exec(['cost', '5'], ctx);
    const result = await budgetCommand.exec(['cost', '5'], ctx);
    if (result.kind !== 'ok') return;
    expect(result.notes?.[0]).toContain('already');
  });

  test('/budget cost none idempotent only after an explicit opt-out', async () => {
    // Now that DEFAULT_BUDGET ships a cost cap, "absent maxCostUsd
    // in baseConfig" is NOT the uncapped state — it inherits the
    // 5 USD default. The first `cost off` transitions the run from
    // default→explicit_undefined and reports the change. A second
    // `cost off` is the no-op.
    const ctx = makeCtx();
    const first = await budgetCommand.exec(['cost', 'off'], ctx);
    if (first.kind !== 'ok') return;
    expect(first.notes?.[0]).toContain('no cap');
    expect(first.notes?.[0]).not.toContain('already');
    const second = await budgetCommand.exec(['cost', 'off'], ctx);
    if (second.kind !== 'ok') return;
    expect(second.notes?.[0]).toContain('already uncapped');
  });

  test('/budget mutations append current-turn cue when a turn is running', async () => {
    const ctx = makeCtx({ isRunning: () => true });
    const result = await budgetCommand.exec(['steps', '120'], ctx);
    if (result.kind !== 'ok') return;
    expect(result.notes?.length).toBe(2);
    expect(result.notes?.[1]).toContain('current turn');
  });

  test('/budget mutations preserve unrelated cap fields', async () => {
    const ctx = makeCtx();
    // Seed two distinct fields, mutate one, assert the other survived.
    await budgetCommand.exec(['steps', '50'], ctx);
    await budgetCommand.exec(['cost', '2.0'], ctx);
    expect(ctx.baseConfig.budget?.maxSteps).toBe(50);
    expect(ctx.baseConfig.budget?.maxCostUsd).toBe(2.0);
    await budgetCommand.exec(['cost', 'none'], ctx);
    expect(ctx.baseConfig.budget?.maxSteps).toBe(50);
    expect(ctx.baseConfig.budget?.maxCostUsd).toBeUndefined();
  });

  test('/budget parallel-tools N updates maxConcurrentToolCalls within cap', async () => {
    const ctx = makeCtx();
    const result = await budgetCommand.exec(['parallel-tools', '7'], ctx);
    if (result.kind !== 'ok') return;
    expect(ctx.baseConfig.budget?.maxConcurrentToolCalls).toBe(7);
    expect(result.notes?.[0]).toContain('7');
    expect(result.notes?.[0]).toContain('next turn');
  });

  test('/budget parallel-tools rejects values above hard cap', async () => {
    const ctx = makeCtx();
    const before = ctx.baseConfig.budget?.maxConcurrentToolCalls;
    const result = await budgetCommand.exec(['parallel-tools', '50'], ctx);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('[1, 16]');
    // Untouched: same as before (default seeded by makeCtx).
    expect(ctx.baseConfig.budget?.maxConcurrentToolCalls).toBe(before);
  });

  test('/budget parallel-tools rejects 0 / negatives / non-integers', async () => {
    for (const bad of ['0', '-1', 'abc', '3.5', '']) {
      const ctx = makeCtx();
      const before = ctx.baseConfig.budget?.maxConcurrentToolCalls;
      const result = await budgetCommand.exec(['parallel-tools', bad], ctx);
      expect(result.kind).toBe('error');
      expect(ctx.baseConfig.budget?.maxConcurrentToolCalls).toBe(before);
    }
  });

  test('/budget subagents N updates maxConcurrentSubagents within cap', async () => {
    const ctx = makeCtx();
    const result = await budgetCommand.exec(['subagents', '5'], ctx);
    if (result.kind !== 'ok') return;
    expect(ctx.baseConfig.budget?.maxConcurrentSubagents).toBe(5);
    expect(result.notes?.[0]).toContain('5');
    expect(result.notes?.[0]).toContain('next turn');
  });

  test('/budget subagents rejects values above hard cap', async () => {
    const ctx = makeCtx();
    const before = ctx.baseConfig.budget?.maxConcurrentSubagents;
    const result = await budgetCommand.exec(['subagents', '20'], ctx);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('[1, 8]');
    expect(ctx.baseConfig.budget?.maxConcurrentSubagents).toBe(before);
  });

  test('/budget parallel-tools setting the same value returns no-change note', async () => {
    const ctx = makeCtx();
    const current = ctx.baseConfig.budget?.maxConcurrentToolCalls;
    if (current === undefined) throw new Error('default missing');
    const result = await budgetCommand.exec(['parallel-tools', String(current)], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.notes?.[0]).toContain('already');
    expect(result.notes?.[0]).not.toContain('next turn');
  });

  test('/budget subagents setting the same value returns no-change note', async () => {
    const ctx = makeCtx();
    const current = ctx.baseConfig.budget?.maxConcurrentSubagents;
    if (current === undefined) throw new Error('default missing');
    const result = await budgetCommand.exec(['subagents', String(current)], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.notes?.[0]).toContain('already');
    expect(result.notes?.[0]).not.toContain('next turn');
  });
});

describe('/subagents', () => {
  test('reports "no session yet" before any turn ran', async () => {
    const ctx = makeCtx();
    const result = await subagentsCommand.exec([], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.notes?.[0]).toContain('no session yet');
  });

  test('reports "no async subagents" when session has no handles', async () => {
    const ctx = makeCtx();
    const session = createSession(ctx.db, { model: 'm', cwd: '/test/cwd' });
    const ctx2 = { ...ctx, currentSessionId: () => session.id };
    const result = await subagentsCommand.exec([], ctx2);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = (result.notes ?? []).join('\n');
    expect(text).toContain('no async subagent handles');
    // Disambiguation note: footer counter may show non-zero for
    // sync task runs even when /subagents is empty.
    expect(text).toContain('sync `task` calls do not appear here');
  });

  test('lists handles with status and reason for the current session', async () => {
    const ctx = makeCtx();
    const session = createSession(ctx.db, { model: 'm', cwd: '/test/cwd' });
    const { insertSubagentHandle, settleSubagentHandle } = await import(
      '../../../src/storage/repos/subagent-handles.ts'
    );
    insertSubagentHandle(ctx.db, {
      handleId: 'h-running',
      parentSessionId: session.id,
      name: 'explore',
      spawnedAt: Date.now(),
    });
    insertSubagentHandle(ctx.db, {
      handleId: 'h-settled',
      parentSessionId: session.id,
      name: 'review',
      spawnedAt: Date.now(),
    });
    settleSubagentHandle(ctx.db, 'h-settled', {
      kind: 'ran',
      reason: 'done',
      status: 'done',
    });
    const ctx2 = { ...ctx, currentSessionId: () => session.id };
    const result = await subagentsCommand.exec([], ctx2);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.notes).toBeDefined();
    // 1 header + 2 rows.
    expect(result.notes?.length).toBe(3);
    expect(result.notes?.[0]).toContain('Async subagent handles');
    const text = (result.notes ?? []).join('\n');
    expect(text).toContain('explore');
    expect(text).toContain('review');
    expect(text).toContain('running');
    expect(text).toContain('settled');
    expect(text).toContain('(done)');
  });

  test('does not leak handles from other sessions', async () => {
    const ctx = makeCtx();
    const sessionA = createSession(ctx.db, { model: 'm', cwd: '/test/cwd' });
    const sessionB = createSession(ctx.db, { model: 'm', cwd: '/test/cwd' });
    const { insertSubagentHandle } = await import('../../../src/storage/repos/subagent-handles.ts');
    insertSubagentHandle(ctx.db, {
      handleId: 'h-other',
      parentSessionId: sessionB.id,
      name: 'foreign',
      spawnedAt: Date.now(),
    });
    const ctx2 = { ...ctx, currentSessionId: () => sessionA.id };
    const result = await subagentsCommand.exec([], ctx2);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = (result.notes ?? []).join('\n');
    expect(text).toContain('no async subagent handles');
  });

  test('handles with malformed settled_payload JSON render without "reason" suffix', async () => {
    // `parsePayload` in the repo returns null on JSON parse errors
    // and on non-object roots. The slash command must NOT crash
    // and must NOT show a misleading reason — it just omits the
    // suffix and renders the row at status='settled' bare.
    const ctx = makeCtx();
    const session = createSession(ctx.db, { model: 'm', cwd: '/test/cwd' });
    // Insert directly via SQL — the repo never produces this
    // shape, but storage corruption / migration drift could.
    ctx.db
      .query(
        `INSERT INTO subagent_handles
           (handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at)
         VALUES ('h-bad', ?, NULL, 'broken', ?, 'settled', 'not-json{', ?)`,
      )
      .run(session.id, Date.now(), Date.now());
    const ctx2 = { ...ctx, currentSessionId: () => session.id };
    const result = await subagentsCommand.exec([], ctx2);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = (result.notes ?? []).join('\n');
    expect(text).toContain('broken');
    expect(text).toContain('settled');
    // No `(reason)` suffix rendered for the corrupt row.
    expect(text).not.toContain('(undefined)');
  });
});

describe('/perms', () => {
  // Build a ctx whose baseConfig carries a stubbed engine returning
  // the supplied policy. Lets us exercise the renderer's branches
  // (default-strict empty, mode=acceptEdits, populated tool sections,
  // rule-list elision) without spinning up the real hierarchy.
  const ctxWith = (policy: unknown): SlashContext => {
    const ctx = makeCtx();
    (ctx.baseConfig as { permissionEngine: unknown }).permissionEngine = {
      policy: () => policy,
    };
    return ctx;
  };

  test('rejects positional arguments', async () => {
    const ctx = ctxWith({ defaults: { mode: 'strict' }, tools: {} });
    const result = await permsCommand.exec(['foo'], ctx);
    expect(result.kind).toBe('error');
  });

  test('default-strict empty policy includes how-to-fix hint', async () => {
    const ctx = ctxWith({ defaults: { mode: 'strict' }, tools: {} });
    const result = await permsCommand.exec([], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = (result.notes ?? []).join('\n');
    expect(text).toContain('mode=strict');
    expect(text).toContain('no tool sections defined');
    expect(text).toContain('.agent/permissions.yaml');
  });

  test('renders bash + read_file rule sections', async () => {
    const ctx = ctxWith({
      defaults: { mode: 'strict' },
      tools: {
        bash: { allow: ['ls *', 'rg *'], deny: ['rm -rf *'] },
        read_file: { allow_paths: ['./**'], deny_paths: ['**/.env*'] },
      },
    });
    const result = await permsCommand.exec([], ctx);
    if (result.kind !== 'ok') return;
    const lines = result.notes ?? [];
    expect(lines.some((l) => l.includes('bash:'))).toBe(true);
    expect(lines.some((l) => l.includes("'ls *'"))).toBe(true);
    expect(lines.some((l) => l.includes("'rm -rf *'"))).toBe(true);
    expect(lines.some((l) => l.includes('read_file:'))).toBe(true);
    expect(lines.some((l) => l.includes('default-deny in strict mode'))).toBe(true);
  });

  test('elides large rule lists with a count', () => {
    const lines = renderPolicy({
      defaults: { mode: 'strict' },
      tools: {
        bash: {
          allow: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'],
        },
      },
    });
    expect(lines.some((l) => /allow:.*12 entries/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes("'a'"))).toBe(false);
  });

  test('section with only locked (no rules) emits no header', () => {
    // Higher-layer enterprise/user can lock a section by setting
    // `{ locked: true }` with no rule lists — lower layers can't
    // override, but there are no rules to display either. Pre-fix
    // the formatter pushed a bare `bash:` header followed by
    // nothing, which read like a render bug.
    const lines = renderPolicy({
      defaults: { mode: 'strict' },
      tools: { bash: { locked: true } },
    });
    expect(lines.some((l) => l.trim() === 'bash:')).toBe(false);
    expect(lines[0]).toBe('policy: mode=strict');
  });

  test('mode=acceptEdits omits the strict-mode footer', () => {
    const lines = renderPolicy({
      defaults: { mode: 'acceptEdits' },
      tools: { bash: { allow: ['ls'] } },
    });
    expect(lines[0]).toBe('policy: mode=acceptEdits');
    expect(lines.some((l) => l.includes('default-deny in strict mode'))).toBe(false);
  });
});
