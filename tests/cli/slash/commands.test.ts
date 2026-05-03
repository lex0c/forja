import { describe, expect, test } from 'bun:test';
import { budgetCommand } from '../../../src/cli/slash/commands/budget.ts';
import { clearCommand } from '../../../src/cli/slash/commands/clear.ts';
import { costCommand } from '../../../src/cli/slash/commands/cost.ts';
import { buildHelpCommand } from '../../../src/cli/slash/commands/help.ts';
import { modelCommand } from '../../../src/cli/slash/commands/model.ts';
import { planCommand } from '../../../src/cli/slash/commands/plan.ts';
import { quitCommand } from '../../../src/cli/slash/commands/quit.ts';
import { sessionsCommand } from '../../../src/cli/slash/commands/sessions.ts';
import type { SlashCommand, SlashContext } from '../../../src/cli/slash/types.ts';
import type { HarnessConfig } from '../../../src/harness/index.ts';
import { DEFAULT_BUDGET } from '../../../src/harness/types.ts';
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
    cumulative: { costUsd: 0, steps: 0, turns: 0 },
    now: () => 1,
    requestShutdown: () => undefined,
    isRunning: () => false,
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

  test('rejects mutation args (read-only in this slice)', async () => {
    const result = await modelCommand.exec(['anthropic/other'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('read-only');
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

  test('shows "no cap" when maxCostUsd is unset', async () => {
    const ctx = makeCtx();
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

  test('/budget cost none idempotent when already uncapped', async () => {
    const ctx = makeCtx();
    // baseConfig starts without maxCostUsd in DEFAULT_BUDGET.
    const result = await budgetCommand.exec(['cost', 'none'], ctx);
    if (result.kind !== 'ok') return;
    expect(result.notes?.[0]).toContain('already uncapped');
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
});
