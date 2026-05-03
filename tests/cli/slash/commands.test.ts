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

  test('rejects mutation args', async () => {
    const result = await planCommand.exec(['on'], makeCtx());
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

  test('shows "no cap" when maxCostUsd is unset', async () => {
    const ctx = makeCtx();
    const result = await budgetCommand.exec([], ctx);
    if (result.kind !== 'ok') return;
    expect(result.notes?.some((l) => l.includes('no cap'))).toBe(true);
  });

  test('rejects mutation args', async () => {
    const result = await budgetCommand.exec(['cost', '5'], makeCtx());
    expect(result.kind).toBe('error');
  });
});
