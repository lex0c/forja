import { beforeAll, describe, expect, test } from 'bun:test';
import { budgetCommand } from '../../../src/cli/slash/commands/budget.ts';
import { clearCommand } from '../../../src/cli/slash/commands/clear.ts';
import { costCommand } from '../../../src/cli/slash/commands/cost.ts';
import { effortCommand } from '../../../src/cli/slash/commands/effort.ts';
import { buildHelpCommand } from '../../../src/cli/slash/commands/help.ts';
import { modelCommand } from '../../../src/cli/slash/commands/model.ts';
import { permsCommand, renderPolicy } from '../../../src/cli/slash/commands/perms.ts';
import { quitCommand } from '../../../src/cli/slash/commands/quit.ts';
import { sessionsCommand } from '../../../src/cli/slash/commands/sessions.ts';
import { statsCommand } from '../../../src/cli/slash/commands/stats.ts';
import { subagentsCommand } from '../../../src/cli/slash/commands/subagents.ts';
import type { SlashCommand, SlashContext } from '../../../src/cli/slash/types.ts';
import { EFFORT_PROFILES } from '../../../src/harness/effort.ts';
import type { HarnessConfig } from '../../../src/harness/index.ts';
import { DEFAULT_BUDGET, effectiveBudget } from '../../../src/harness/types.ts';
import { initBashParser } from '../../../src/permissions/bash-parser.ts';
import { createPermissionEngine } from '../../../src/permissions/index.ts';
import { createRegistry as createModelRegistry } from '../../../src/providers/registry.ts';
import { openMemoryDb } from '../../../src/storage/db.ts';
import { migrate } from '../../../src/storage/migrate.ts';
import { createSession, updateSessionCost } from '../../../src/storage/repos/sessions.ts';
import { createToolRegistry } from '../../../src/tools/registry.ts';
import { createBus } from '../../../src/tui/bus.ts';
import { createFocusStack } from '../../../src/tui/focus-stack.ts';
import { createModalManager } from '../../../src/tui/modal-manager.ts';

// Bash resolver (slice 6) walks the tree-sitter-bash AST and requires
// an async one-time init. Tests that exercise bash checks through
// `/perms why` would otherwise hit `parser unavailable` Refuse when
// this file runs in isolation. Idempotent across files via the module
// singleton, so this is cheap even when other files have warmed it.
beforeAll(async () => {
  await initBashParser();
});

const makeCtx = (overrides: Partial<SlashContext> = {}): SlashContext => {
  const bus = createBus();
  const fs = createFocusStack();
  const modalManager = createModalManager({ bus, focusStack: fs, now: () => 1 });
  const db = openMemoryDb();
  migrate(db);
  const baseConfig = {
    cwd: '/test/cwd',
    enableCheckpoints: false,
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
    cumulative: { costUsd: 0, steps: 0, turns: 0 },
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
  // Cost is DB-derived (same source as /stats), so the fixtures set a
  // session's persisted total_cost_usd and point replSessionIds at it.
  // steps/turns still come from the in-memory cumulative counter.
  const ctxWithCost = (costUsd: number): SlashContext => {
    const ctx = makeCtx();
    const s = createSession(ctx.db, { model: 'm', cwd: '/test/cwd' });
    updateSessionCost(ctx.db, s.id, costUsd);
    ctx.replSessionIds = () => [s.id];
    return ctx;
  };

  test('formats DB-derived cost / steps / turns', async () => {
    const ctx = ctxWithCost(0.0234);
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
    const r1 = await costCommand.exec([], ctxWithCost(5.5));
    if (r1.kind !== 'ok') return;
    expect(r1.notes?.[0]).toContain('$5.500');
    const r2 = await costCommand.exec([], ctxWithCost(100.5));
    if (r2.kind !== 'ok') return;
    expect(r2.notes?.[0]).toContain('$100.50');
  });

  test('cost agrees with /stats (same DB-derived source)', async () => {
    const ctx = ctxWithCost(0.5);
    const cost = await costCommand.exec([], ctx);
    const stats = await statsCommand.exec([], ctx);
    if (cost.kind !== 'ok' || stats.kind !== 'ok') return;
    // Both surface $0.5000 from computeUsageStats over the same tree.
    expect(cost.notes?.[0]).toContain('$0.5000');
    expect((stats.notes ?? []).join('\n')).toContain('$0.5000');
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
    expect(result.notes?.[0]).toContain('fake/cue');
    // The running cue is always appended LAST by withRunningCue; a
    // model-pin autosave note (written / warning) may sit between it and
    // the model line, so assert position-from-the-end, not index 1.
    expect(result.notes?.at(-1)).toContain('current turn');
  });

  test('/model with too many args returns error', async () => {
    const result = await modelCommand.exec(['a', 'b'], makeCtx());
    expect(result.kind).toBe('error');
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
    // DEFAULT_BUDGET ships a 100 USD cost cap (AGENTIC_CLI.md §5).
    // The slash UI falls back to the default when the operator
    // has not explicitly set or cleared the cap, so a fresh
    // session shows "$100.00", not "no cap".
    const ctx = makeCtx();
    const result = await budgetCommand.exec([], ctx);
    if (result.kind !== 'ok') return;
    const costLine = result.notes?.find((l) => l.startsWith('max cost:'));
    expect(costLine).toBeDefined();
    expect(costLine).not.toContain('no cap');
    // Pinning the formatted default keeps the contract change
    // visible if the spec bumps the value.
    expect(costLine).toContain('$100.00');
  });

  test('shows "no cap" only after the operator explicitly opts out', async () => {
    const ctx = makeCtx();
    await budgetCommand.exec(['cost', 'off'], ctx);
    const result = await budgetCommand.exec([], ctx);
    if (result.kind !== 'ok') return;
    expect(result.notes?.some((l) => l.includes('no cap'))).toBe(true);
  });

  test('shows the compaction relevance pre-pass state (default on)', async () => {
    const ctx = makeCtx();
    const result = await budgetCommand.exec([], ctx);
    if (result.kind !== 'ok') return;
    expect(result.notes?.some((l) => l.includes('compaction relevance pre-pass: on'))).toBe(true);
  });

  test('/budget relevance off disables the pre-pass and is reflected in the display', async () => {
    const ctx = makeCtx();
    const result = await budgetCommand.exec(['relevance', 'off'], ctx);
    if (result.kind !== 'ok') return;
    expect(ctx.baseConfig.budget?.compactionRelevance).toBe(false);
    expect(result.notes?.[0]).toContain('off');
    expect(result.notes?.[0]).toContain('next turn');
    const shown = await budgetCommand.exec([], ctx);
    if (shown.kind !== 'ok') return;
    expect(shown.notes?.some((l) => l.includes('compaction relevance pre-pass: off'))).toBe(true);
  });

  test('/budget relevance rejects args that are not on|off', async () => {
    expect((await budgetCommand.exec(['relevance', 'maybe'], makeCtx())).kind).toBe('error');
    expect((await budgetCommand.exec(['relevance'], makeCtx())).kind).toBe('error');
  });

  test('/budget relevance accepts true/false aliases', async () => {
    const offCtx = makeCtx();
    await budgetCommand.exec(['relevance', 'false'], offCtx);
    expect(offCtx.baseConfig.budget?.compactionRelevance).toBe(false);
    const onCtx = makeCtx();
    await budgetCommand.exec(['relevance', 'true'], onCtx);
    expect(onCtx.baseConfig.budget?.compactionRelevance).toBe(true);
  });

  test('/budget relevance off twice is idempotent (already off)', async () => {
    const ctx = makeCtx();
    await budgetCommand.exec(['relevance', 'off'], ctx);
    const again = await budgetCommand.exec(['relevance', 'off'], ctx);
    if (again.kind !== 'ok') return;
    expect(again.notes?.[0]).toContain('already off');
  });

  test('/budget relevance on re-enables after a config-set false (not a silent no-op)', async () => {
    // The operator's real recovery path: `[budget] compaction_relevance = false`
    // in config, then `/budget relevance on` to flip it back for this session.
    const ctx = makeCtx();
    ctx.baseConfig.budget = { ...ctx.baseConfig.budget, compactionRelevance: false };
    const result = await budgetCommand.exec(['relevance', 'on'], ctx);
    if (result.kind !== 'ok') return;
    expect(ctx.baseConfig.budget?.compactionRelevance).toBe(true);
    expect(result.notes?.[0]).toContain('on');
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

  test('/budget subagents overrides the effort preset (compares effective, not DEFAULT)', async () => {
    // Regression: under /effort low the effective subagents cap is the
    // preset (1), but the idempotency check used to fall back to
    // DEFAULT_BUDGET (3), so `/budget subagents 3` reported "already 3"
    // and never wrote — leaving the effective cap stuck at 1.
    const ctx = makeCtx();
    ctx.baseConfig.budget = {}; // no explicit override (realistic)
    ctx.baseConfig.effort = 'low'; // preset subagents = 1
    const result = await budgetCommand.exec(['subagents', '3'], ctx);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.notes?.[0]).not.toContain('already');
    expect(result.notes?.[0]).toContain('next turn');
    expect(ctx.baseConfig.budget?.maxConcurrentSubagents).toBe(3);
  });

  test('/budget subagents pins an explicit override even when it equals the effort preset', async () => {
    // Explicit-override surface: typing the value RECORDS it (pins), so
    // it survives a later /effort change — not a silent "already" that
    // leaves the value preset-derived and movable.
    const ctx = makeCtx();
    ctx.baseConfig.budget = {};
    ctx.baseConfig.effort = 'low';
    const n = EFFORT_PROFILES.low.maxConcurrentSubagents; // = 1 (== preset)
    const result = await budgetCommand.exec(['subagents', String(n)], ctx);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.notes?.[0]).not.toContain('already');
    expect(result.notes?.[0]).toContain('next turn');
    expect(ctx.baseConfig.budget?.maxConcurrentSubagents).toBe(n);
  });

  test('/budget subagents "already" only when the raw explicit override is already that value', async () => {
    const ctx = makeCtx();
    ctx.baseConfig.budget = { maxConcurrentSubagents: 2 };
    ctx.baseConfig.effort = 'low'; // preset would be 1, but raw 2 is explicit
    const result = await budgetCommand.exec(['subagents', '2'], ctx);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.notes?.[0]).toContain('already 2');
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
    expect(text).toContain('.forja/permissions.yaml');
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

  test('renders sandbox section after tools.* (slice 37)', () => {
    const lines = renderPolicy({
      defaults: { mode: 'strict' },
      tools: { bash: { allow: ['ls *'] } },
      sandbox: { required: true, hostAllowed: false, locked: true },
    });
    const text = lines.join('\n');
    // Sandbox header + each set field + locked footer. No layer hints
    // because /perms (no args) doesn't carry provenance — bare values.
    expect(text).toContain('sandbox:');
    expect(text).toContain('required: true');
    expect(text).toContain('host_allowed: false');
    expect(text).toContain('(locked)');
    // Pre-slice-37 /perms quietly omitted sandbox even when set.
    // Regression guard for that gap.
    expect(text.indexOf('bash:')).toBeLessThan(text.indexOf('sandbox:'));
  });

  test('sandbox-only policy (no tools sections) still renders sandbox', () => {
    // Edge case: a policy that ONLY configures sandbox (typical for an
    // enterprise lockdown that defers tool sections to lower layers).
    // Pre-slice-37 the "no tool sections defined" notice fired and
    // sandbox stayed invisible; now the section renders and the
    // strict-mode footer drops (no tool sections to caveat).
    const lines = renderPolicy({
      defaults: { mode: 'strict' },
      tools: {},
      sandbox: { required: true, locked: true },
    });
    const text = lines.join('\n');
    expect(text).toContain('sandbox:');
    expect(text).toContain('required: true');
    expect(text).toContain('(locked)');
    expect(text).not.toContain('no tool sections defined');
  });
});

describe('/perms why', () => {
  // Build a ctx with a real permission engine + tool registry so the
  // dry-check exercises the full path (engine.check + source
  // population). Stubs the bare minimum of Tool — only `metadata`
  // matters for the dispatch (category drives args shape; name
  // drives lookup).
  const buildCtx = (
    policy: Parameters<typeof createPermissionEngine>[0],
    tools: Array<{ name: string; category: string }>,
    provenance?: Parameters<typeof createPermissionEngine>[1]['provenance'],
  ): SlashContext => {
    const ctx = makeCtx();
    const engineOpts: Parameters<typeof createPermissionEngine>[1] = { cwd: '/proj' };
    if (provenance !== undefined) engineOpts.provenance = provenance;
    const engine = createPermissionEngine(policy, engineOpts);
    const registry = createToolRegistry();
    for (const t of tools) {
      registry.register({
        name: t.name,
        description: 'test',
        input_schema: { type: 'object' as const, properties: {} },
        // biome-ignore lint/suspicious/noExplicitAny: stub — only metadata.category is consulted by /perms why
        metadata: { category: t.category as any, writes: false },
        execute: async () => ({ content: '' }),
      } as unknown as Parameters<typeof registry.register>[0]);
    }
    (ctx.baseConfig as { permissionEngine: unknown }).permissionEngine = engine;
    (ctx.baseConfig as { toolRegistry: unknown }).toolRegistry = registry;
    return ctx;
  };

  test('rejects /perms why with no tool name', async () => {
    const ctx = buildCtx({ defaults: { mode: 'strict' }, tools: {} }, []);
    const result = await permsCommand.exec(['why'], ctx);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('missing tool name');
  });

  test('rejects unknown tool', async () => {
    const ctx = buildCtx({ defaults: { mode: 'strict' }, tools: {} }, []);
    const result = await permsCommand.exec(['why', 'bogus'], ctx);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain("unknown tool 'bogus'");
  });

  test('bash with no command surfaces a usage example', async () => {
    const ctx = buildCtx({ defaults: { mode: 'strict' }, tools: {} }, [
      { name: 'bash', category: 'bash' },
    ]);
    const result = await permsCommand.exec(['why', 'bash'], ctx);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('missing command');
    expect(result.message).toContain('npm test');
  });

  test('bash allow rule renders decision + rule + layer + section', async () => {
    // `ls -la` lands as high-confidence + score 0; the slice-7
    // approval gate doesn't fire, so the matched allow rule
    // surfaces as decision: allow in the render. Using a medium-
    // confidence command (e.g. `npm test`) would force confirm via
    // §6.6 and shadow the layer/rule attribution we're testing.
    const ctx = buildCtx(
      { defaults: { mode: 'strict' }, tools: { bash: { allow: ['ls*'] } } },
      [{ name: 'bash', category: 'bash' }],
      { defaults: 'project', bash: 'project' },
    );
    const result = await permsCommand.exec(['why', 'bash', 'ls', '-la'], ctx);
    if (result.kind !== 'ok') throw new Error('expected ok');
    const text = (result.notes ?? []).join('\n');
    // Header echoes the input verbatim so scrollback is greppable.
    expect(text).toContain('/perms why bash ls -la');
    expect(text).toContain('decision: allow');
    expect(text).toContain('rule:     ls*');
    expect(text).toContain('layer:    project policy');
    expect(text).toContain('section:  bash');
  });

  test('bash deny rule renders deny decision', async () => {
    const ctx = buildCtx(
      { defaults: { mode: 'strict' }, tools: { bash: { deny: ['rm -rf *'] } } },
      [{ name: 'bash', category: 'bash' }],
      { defaults: 'project', bash: 'enterprise' },
    );
    // Slice 147: use a cwd-relative target so the resolver doesn't
    // refuse on RM_REFUSE_ROOTS BEFORE the policy stage runs.
    // /perms why pins the POLICY attribution; the resolver-refuse
    // path is exercised in the resolver suite.
    const result = await permsCommand.exec(['why', 'bash', 'rm', '-rf', 'build/garbage'], ctx);
    if (result.kind !== 'ok') throw new Error('expected ok');
    const text = (result.notes ?? []).join('\n');
    expect(text).toContain('decision: deny');
    expect(text).toContain('rule:     rm -rf *');
    expect(text).toContain('layer:    enterprise policy');
  });

  test('bash confirm rule includes the prompt line', async () => {
    const ctx = buildCtx(
      { defaults: { mode: 'strict' }, tools: { bash: { confirm: ['git push *'] } } },
      [{ name: 'bash', category: 'bash' }],
      { defaults: 'project', bash: 'project' },
    );
    const result = await permsCommand.exec(['why', 'bash', 'git', 'push', 'origin', 'main'], ctx);
    if (result.kind !== 'ok') throw new Error('expected ok');
    const text = (result.notes ?? []).join('\n');
    expect(text).toContain('decision: confirm');
    expect(text).toContain('prompt:   Run bash: git push origin main');
    expect(text).toContain('rule:     git push *');
  });

  test('default-deny renders without rule but with layer + section', async () => {
    // Bash section exists in project layer but no rule matches.
    // Operator's takeaway: edit project YAML's bash section to add
    // an allow rule.
    const ctx = buildCtx(
      { defaults: { mode: 'strict' }, tools: { bash: { allow: ['ls *'] } } },
      [{ name: 'bash', category: 'bash' }],
      { defaults: 'project', bash: 'project' },
    );
    const result = await permsCommand.exec(['why', 'bash', 'whoami'], ctx);
    if (result.kind !== 'ok') throw new Error('expected ok');
    const text = (result.notes ?? []).join('\n');
    expect(text).toContain('decision: deny');
    expect(text).toContain('layer:    project policy');
    expect(text).toContain('section:  bash');
    // No rule line when nothing matched.
    expect(text).not.toMatch(/^\s*rule:/m);
  });

  test('layer="default" renders as "built-in default"', async () => {
    // No layer wrote any section AND no provenance passed —
    // engine falls back to default everywhere.
    const ctx = buildCtx(
      { defaults: { mode: 'strict' }, tools: { bash: { deny: ['rm *'] } } },
      [{ name: 'bash', category: 'bash' }],
      // No provenance: every source.layer collapses to 'default'.
    );
    const result = await permsCommand.exec(['why', 'bash', 'rm', '-rf', '/'], ctx);
    if (result.kind !== 'ok') throw new Error('expected ok');
    const text = (result.notes ?? []).join('\n');
    expect(text).toContain('layer:    built-in default');
  });

  test('write_file dry-check requires a path', async () => {
    const ctx = buildCtx({ defaults: { mode: 'strict' }, tools: {} }, [
      { name: 'write_file', category: 'fs.write' },
    ]);
    const result = await permsCommand.exec(['why', 'write_file'], ctx);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('missing path');
  });

  test('write_file allow_paths matches', async () => {
    const ctx = buildCtx(
      {
        defaults: { mode: 'strict' },
        tools: { write_file: { allow_paths: ['src/**'] } },
      },
      [{ name: 'write_file', category: 'fs.write' }],
      { defaults: 'project', write_file: 'project' },
    );
    const result = await permsCommand.exec(['why', 'write_file', 'src/foo.ts'], ctx);
    if (result.kind !== 'ok') throw new Error('expected ok');
    const text = (result.notes ?? []).join('\n');
    expect(text).toContain('decision: allow');
    expect(text).toContain('rule:     src/**');
    expect(text).toContain('section:  write_file');
  });

  test('grep without path is accepted (engine falls back to session cwd)', async () => {
    // grep allows missing path arg; the engine resolves to
    // session cwd. Operator using `/perms why grep` without args
    // gets the dry-check result for "grep with no explicit root".
    const ctx = buildCtx(
      {
        defaults: { mode: 'strict' },
        tools: { grep: { allow_paths: ['./**'] } },
      },
      [{ name: 'grep', category: 'fs.read' }],
      { defaults: 'project', grep: 'project' },
    );
    const result = await permsCommand.exec(['why', 'grep'], ctx);
    if (result.kind !== 'ok') throw new Error('expected ok');
    const text = (result.notes ?? []).join('\n');
    expect(text).toContain('decision: allow');
  });

  test('git without path — and a pathless mode token — are accepted (no missing-path error)', async () => {
    // git shares the read_file section; its pathless modes resolve to
    // cwd. `/perms why git` and `/perms why git status` must dry-check,
    // not report a missing path.
    const ctx = buildCtx(
      { defaults: { mode: 'strict' }, tools: { read_file: { allow_paths: ['./**'] } } },
      [{ name: 'git', category: 'fs.read' }],
      { defaults: 'project', read_file: 'project' },
    );
    for (const argv of [
      ['why', 'git'],
      ['why', 'git', 'status'],
    ]) {
      const result = await permsCommand.exec(argv, ctx);
      if (result.kind !== 'ok') {
        throw new Error(
          `expected ok for ${argv.join(' ')}: ${result.kind === 'error' ? result.message : result.kind}`,
        );
      }
      expect((result.notes ?? []).join('\n')).toContain('decision: allow');
    }
  });

  test('git checks the path, not the mode token', async () => {
    const ctx = buildCtx(
      { defaults: { mode: 'strict' }, tools: { read_file: { allow_paths: ['src/**'] } } },
      [{ name: 'git', category: 'fs.read' }],
      { defaults: 'project', read_file: 'project' },
    );
    // `diff` is consumed as a mode; the path is what gets checked.
    const allowed = await permsCommand.exec(['why', 'git', 'diff', 'src/foo.ts'], ctx);
    if (allowed.kind !== 'ok') throw new Error('expected ok');
    expect((allowed.notes ?? []).join('\n')).toContain('decision: allow');
    // a path outside the allow → deny (not silently passed as the mode).
    const denied = await permsCommand.exec(['why', 'git', 'blame', 'docs/x.md'], ctx);
    if (denied.kind !== 'ok') throw new Error('expected ok render');
    expect((denied.notes ?? []).join('\n')).toContain('decision: deny');
  });

  test('git preserves the mode so show_file/blame match exact-file rules in history', async () => {
    const ctx = buildCtx(
      { defaults: { mode: 'strict' }, tools: { read_file: { allow_paths: ['old.ts'] } } },
      [{ name: 'git', category: 'fs.read' }],
      { defaults: 'project', read_file: 'project' },
    );
    // `old.ts` is allowed EXACTLY but does not exist in the dry-check cwd
    // (/proj) — a file readable only at a past ref. show_file/blame are
    // single-file modes, so the engine honors the exact allow regardless of
    // worktree existence. The mode token must reach the engine: dropping it
    // (the prior bug) would default-deny via the worktree-stat guard.
    const showFile = await permsCommand.exec(['why', 'git', 'show_file', 'old.ts'], ctx);
    if (showFile.kind !== 'ok') throw new Error('expected ok');
    expect((showFile.notes ?? []).join('\n')).toContain('decision: allow');
    const blame = await permsCommand.exec(['why', 'git', 'blame', 'old.ts'], ctx);
    if (blame.kind !== 'ok') throw new Error('expected ok');
    expect((blame.notes ?? []).join('\n')).toContain('decision: allow');
    // a non-single-file mode (ls_files) on the same missing path stays deny
    // (the worktree-stat guard still applies to enumeration modes).
    const lsFiles = await permsCommand.exec(['why', 'git', 'ls_files', 'old.ts'], ctx);
    if (lsFiles.kind !== 'ok') throw new Error('expected ok');
    expect((lsFiles.notes ?? []).join('\n')).toContain('decision: deny');
  });

  test('fetch_url URL rendering', async () => {
    const ctx = buildCtx(
      {
        defaults: { mode: 'strict' },
        tools: { fetch_url: { deny_hosts: ['evil.com'] } },
      },
      [{ name: 'fetch_url', category: 'web.fetch' }],
      { defaults: 'project', fetch_url: 'enterprise' },
    );
    const result = await permsCommand.exec(['why', 'fetch_url', 'https://evil.com/x'], ctx);
    if (result.kind !== 'ok') throw new Error('expected ok');
    const text = (result.notes ?? []).join('\n');
    expect(text).toContain('decision: deny');
    expect(text).toContain('rule:     evil.com');
    expect(text).toContain('layer:    enterprise policy');
  });

  test('rejects unknown sub-command', async () => {
    const ctx = buildCtx({ defaults: { mode: 'strict' }, tools: {} }, []);
    const result = await permsCommand.exec(['bogus'], ctx);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('unknown sub-command');
  });

  test('/perms why sandbox: section declared → renders state + per-field provenance (slice 37)', async () => {
    const ctx = buildCtx(
      {
        defaults: { mode: 'strict' },
        tools: {},
        sandbox: { required: true, hostAllowed: false, locked: true },
      },
      [],
      {
        defaults: 'enterprise',
        sandbox: { required: 'enterprise', hostAllowed: 'user', locked: 'enterprise' },
      },
    );
    const result = await permsCommand.exec(['why', 'sandbox'], ctx);
    if (result.kind !== 'ok') throw new Error('expected ok');
    const text = (result.notes ?? []).join('\n');
    // Header echoes the input; renderSandbox produces the body.
    expect(text).toContain('/perms why sandbox');
    expect(text).toContain('sandbox:');
    expect(text).toContain('required: true [from enterprise policy]');
    expect(text).toContain('host_allowed: false [from user policy]');
    expect(text).toContain('(locked by enterprise policy)');
  });

  test('/perms why sandbox: no section declared → renders "not declared" notice with defaults', async () => {
    // Bootstrap defaults are required=false, host_allowed=false. The
    // notice surfaces this so the operator knows the engine ISN'T
    // running sandboxed without having to dig into the source. Same
    // shape as the "no tool sections defined" footer in `/perms`.
    const ctx = buildCtx({ defaults: { mode: 'strict' }, tools: {} }, []);
    const result = await permsCommand.exec(['why', 'sandbox'], ctx);
    if (result.kind !== 'ok') throw new Error('expected ok');
    const text = (result.notes ?? []).join('\n');
    expect(text).toContain('/perms why sandbox');
    expect(text).toContain('sandbox section not declared');
    expect(text).toContain('bootstrap defaults');
    expect(text).toContain('required=false');
    expect(text).toContain('host_allowed=false');
  });

  test('/perms why sandbox: lock-only section renders just the lock footer (no field lines)', async () => {
    // Lock-only-layer case from slice 34: no required / host_allowed
    // set, just locked=true. /perms why sandbox should render the
    // header + lock footer with attribution, NOT phantom "required:
    // unset" lines.
    const ctx = buildCtx(
      {
        defaults: { mode: 'strict' },
        tools: {},
        sandbox: { locked: true },
      },
      [],
      { defaults: 'enterprise', sandbox: { locked: 'enterprise' } },
    );
    const result = await permsCommand.exec(['why', 'sandbox'], ctx);
    if (result.kind !== 'ok') throw new Error('expected ok');
    const text = (result.notes ?? []).join('\n');
    expect(text).toContain('sandbox:');
    expect(text).toContain('(locked by enterprise policy)');
    expect(text).not.toContain('required:');
    expect(text).not.toContain('host_allowed:');
  });
});

describe('/effort', () => {
  test('bare /effort shows "not set" + levels when unset', async () => {
    const ctx = makeCtx();
    const r = await effortCommand.exec([], ctx);
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.notes?.[0]).toContain('not set');
    expect((r.notes ?? []).join('\n')).toContain('low | medium | high | xhigh | max');
  });

  test('/effort <level> records the level only; caps resolve via effectiveBudget (next turn)', async () => {
    const ctx = makeCtx();
    // Realistic baseConfig.budget: only operator-declared overrides
    // (bootstrap builds it as `{ ...config.toml[budget], ...CLI }`, an
    // object — empty here, never a full DEFAULT_BUDGET).
    ctx.baseConfig.budget = {};
    const r = await effortCommand.exec(['high'], ctx);
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(ctx.baseConfig.effort).toBe('high');
    // No in-place mutation of baseConfig.budget — the preset is layered
    // at read time by effectiveBudget(budget, effort), not baked in.
    expect(ctx.baseConfig.budget).toEqual({});
    const eff = effectiveBudget(ctx.baseConfig.budget, ctx.baseConfig.effort);
    expect(eff.maxSteps).toBe(EFFORT_PROFILES.high.maxSteps);
    expect(eff.maxConcurrentSubagents).toBe(EFFORT_PROFILES.high.maxConcurrentSubagents);
    expect(eff.maxToolErrors).toBe(EFFORT_PROFILES.high.maxToolErrors);
    expect(r.notes?.[0]).toContain('next turn');
  });

  test('/effort is case-insensitive', async () => {
    const ctx = makeCtx();
    const r = await effortCommand.exec(['MAX'], ctx);
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(ctx.baseConfig.effort).toBe('max');
  });

  test('/effort never mutates baseConfig.budget; explicit caps win over the preset (order-independent)', async () => {
    // Operator ran `/budget steps 50` FIRST (explicit override), then
    // `/effort low`. The explicit step cap must survive — the bug the
    // resolver fixes — and `/effort` must not touch baseConfig.budget.
    const ctx = makeCtx();
    ctx.baseConfig.budget = { maxSteps: 50, maxCostUsd: 42 };
    await effortCommand.exec(['low'], ctx);
    expect(ctx.baseConfig.budget).toEqual({ maxSteps: 50, maxCostUsd: 42 }); // untouched
    const eff = effectiveBudget(ctx.baseConfig.budget, ctx.baseConfig.effort);
    expect(eff.maxSteps).toBe(50); // explicit beats preset (low = 60)
    expect(eff.maxToolErrors).toBe(EFFORT_PROFILES.low.maxToolErrors); // preset fills the rest
  });

  test('/effort idempotent when already at that level', async () => {
    const ctx = makeCtx();
    await effortCommand.exec(['medium'], ctx);
    const r = await effortCommand.exec(['medium'], ctx);
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.notes?.[0]).toContain('already medium');
  });

  test('/effort rejects unknown level with a Known list', async () => {
    const ctx = makeCtx();
    const r = await effortCommand.exec(['ultra'], ctx);
    if (r.kind !== 'error') throw new Error('expected error');
    expect(r.message).toContain('unknown level');
    expect(r.message).toContain('low, medium, high, xhigh, max');
  });

  test('/effort rejects too many args', async () => {
    const ctx = makeCtx();
    const r = await effortCommand.exec(['high', 'extra'], ctx);
    expect(r.kind).toBe('error');
  });

  test('bare /effort shows the level + resolved caps when set', async () => {
    const ctx = makeCtx();
    await effortCommand.exec(['high'], ctx);
    const r = await effortCommand.exec([], ctx);
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.notes?.[0]).toContain('effort: high');
    // The provider-effort line was dropped; caps remain.
    const joined = (r.notes ?? []).join('\n');
    expect(joined).not.toContain('provider effort');
    expect(joined).toContain('max steps:');
  });

  test('a running turn appends the snapshot cue', async () => {
    const ctx = makeCtx({ isRunning: () => true });
    const r = await effortCommand.exec(['low'], ctx);
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.notes?.some((n) => n.includes('already snapshot'))).toBe(true);
  });
});
