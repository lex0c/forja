import { describe, expect, test } from 'bun:test';
import { createBuiltinRegistry, dispatch } from '../../../src/cli/slash/index.ts';
import { createRegistry } from '../../../src/cli/slash/registry.ts';
import type { SlashCommand, SlashContext } from '../../../src/cli/slash/types.ts';
import type { HarnessConfig } from '../../../src/harness/index.ts';
import { DEFAULT_BUDGET } from '../../../src/harness/types.ts';
import { createRegistry as createModelRegistry } from '../../../src/providers/registry.ts';
import { type DB, openMemoryDb } from '../../../src/storage/db.ts';
import { migrate } from '../../../src/storage/migrate.ts';
import { createBus } from '../../../src/tui/bus.ts';
import type { UIEvent } from '../../../src/tui/events.ts';
import { createFocusStack } from '../../../src/tui/focus-stack.ts';
import { createModalManager } from '../../../src/tui/modal-manager.ts';

const makeCtx = (): {
  ctx: SlashContext;
  events: UIEvent[];
  db: DB;
  shutdownCalled: () => boolean;
} => {
  const bus = createBus();
  const events: UIEvent[] = [];
  bus.onAny((e) => events.push(e));
  const fs = createFocusStack();
  const modalManager = createModalManager({ bus, focusStack: fs, now: () => 1 });
  const db = openMemoryDb();
  migrate(db);
  let shutdownFired = false;
  const baseConfig = {
    cwd: '/test',
    enableCheckpoints: false,
    planMode: false,
    budget: { ...DEFAULT_BUDGET },
    provider: {
      id: 'test/m',
      capabilities: { context_window: 1000, output_max_tokens: 100 },
    },
  } as unknown as HarnessConfig;
  return {
    ctx: {
      baseConfig,
      db,
      bus,
      modalManager,
      cumulative: { costUsd: 0, steps: 0, turns: 0 },
      now: () => 1,
      requestShutdown: () => {
        shutdownFired = true;
      },
      isRunning: () => false,
      modelRegistry: createModelRegistry(),
    },
    events,
    db,
    shutdownCalled: () => shutdownFired,
  };
};

describe('dispatch', () => {
  test('bare slash returns ok without surfacing an error', async () => {
    const { ctx, events } = makeCtx();
    const result = await dispatch(
      { name: '', args: [] },
      { registry: createBuiltinRegistry(), ctx },
    );
    expect(result.kind).toBe('ok');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  test('unknown command emits error event and returns kind:error', async () => {
    const { ctx, events } = makeCtx();
    const result = await dispatch(
      { name: 'doesnotexist', args: [] },
      { registry: createBuiltinRegistry(), ctx },
    );
    expect(result.kind).toBe('error');
    const errs = events.filter((e) => e.type === 'error');
    expect(errs).toHaveLength(1);
    expect((errs[0] as Extract<UIEvent, { type: 'error' }>).message).toContain('unknown command');
    expect((errs[0] as Extract<UIEvent, { type: 'error' }>).message).toContain('/doesnotexist');
  });

  test('successful command notes are emitted as info lines on the bus (not warn)', async () => {
    const { ctx, events } = makeCtx();
    const result = await dispatch(
      { name: 'cost', args: [] },
      { registry: createBuiltinRegistry(), ctx },
    );
    expect(result.kind).toBe('ok');
    // Help/cost/sessions output is not a warning — it's plain info.
    const infos = events.filter((e) => e.type === 'info');
    const warns = events.filter((e) => e.type === 'warn');
    expect(infos.length).toBeGreaterThan(0);
    expect(warns).toHaveLength(0);
  });

  test('command crash collapses to error event without propagating', async () => {
    const crashing: SlashCommand = {
      name: 'crash',
      description: 'always throws',
      exec: async () => {
        throw new Error('boom');
      },
    };
    const registry = createRegistry([crashing]);
    const { ctx, events } = makeCtx();
    const result = await dispatch({ name: 'crash', args: [] }, { registry, ctx });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('crashed');
    expect(result.message).toContain('boom');
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  test('quit returns kind:exit and triggers shutdown', async () => {
    const { ctx, shutdownCalled } = makeCtx();
    const result = await dispatch(
      { name: 'quit', args: [] },
      { registry: createBuiltinRegistry(), ctx },
    );
    expect(result.kind).toBe('exit');
    expect(shutdownCalled()).toBe(true);
  });

  test('error result from a command is sunk through errorSink', async () => {
    const { ctx, events } = makeCtx();
    // /model with an unknown id returns kind:error (registry lookup
    // miss). Default registry has real entries, so use a clearly
    // bogus id that won't collide with any real provider.
    const result = await dispatch(
      { name: 'model', args: ['no-such-model-xxx'] },
      { registry: createBuiltinRegistry(), ctx },
    );
    expect(result.kind).toBe('error');
    const errs = events.filter((e) => e.type === 'error');
    expect(errs).toHaveLength(1);
  });

  test('custom errorSink overrides the default bus emit', async () => {
    const { ctx, events } = makeCtx();
    const sunk: string[] = [];
    await dispatch(
      { name: 'doesnotexist', args: [] },
      { registry: createBuiltinRegistry(), ctx, errorSink: (m) => sunk.push(m) },
    );
    expect(sunk).toHaveLength(1);
    // No error event on the bus when errorSink overridden.
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});

describe('createBuiltinRegistry', () => {
  test('contains all 9 builtins', () => {
    const r = createBuiltinRegistry();
    const names = r.list().map((c) => c.name);
    expect(names).toEqual([
      'help',
      'quit',
      'clear',
      'cost',
      'sessions',
      'model',
      'plan',
      'budget',
      'perms',
    ]);
  });

  test('help can list every other command (closure works)', async () => {
    const r = createBuiltinRegistry();
    const help = r.lookup('help');
    expect(help).toBeDefined();
    if (help === undefined) return;
    const result = await help.exec([], makeCtx().ctx);
    if (result.kind !== 'ok') return;
    // 9 commands → header + 9 rows + blank + emergency-exit footer = 12.
    expect(result.notes?.length).toBe(12);
  });
});
