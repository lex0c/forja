import { describe, expect, test } from 'bun:test';
import { relayCommand } from '../../../src/cli/slash/commands/relay.ts';
import type { SlashContext } from '../../../src/cli/slash/types.ts';

// Minimal serving-toggle stub — only what /relay touches on the mesh manager.
const makeManager = () => {
  let serving = false;
  return {
    alias: 'billing',
    isServing: () => serving,
    startServing: async () => {
      serving = true;
    },
    stopServing: async () => {
      serving = false;
    },
  };
};

type Emitted = { type: string; active?: boolean };

// Minimal SlashContext for /relay: a mesh manager, a scripted modal answer, and
// a bus that just captures emitted events.
const makeCtx = (opts: { manager?: unknown; answer?: 'yes' | 'no' | 'cancel' }) => {
  const emitted: Emitted[] = [];
  const ctx = {
    baseConfig: { meshManager: opts.manager },
    bus: { emit: (e: Emitted) => emitted.push(e) },
    modalManager: { askRelayStart: async () => opts.answer ?? 'yes' },
    now: () => 1,
  } as unknown as SlashContext;
  return { ctx, emitted };
};

describe('/relay', () => {
  test('reports an error when the mesh subsystem is unavailable', async () => {
    const { ctx } = makeCtx({ manager: undefined });
    expect((await relayCommand.exec([], ctx)).kind).toBe('error');
  });

  test('confirm yes → starts serving and emits relay:change(active)', async () => {
    const mgr = makeManager();
    const { ctx, emitted } = makeCtx({ manager: mgr, answer: 'yes' });
    const r = await relayCommand.exec([], ctx);
    expect(r.kind).toBe('ok');
    expect(mgr.isServing()).toBe(true);
    expect(emitted.some((e) => e.type === 'relay:change' && e.active === true)).toBe(true);
  });

  test('confirm no → does not start, emits nothing', async () => {
    const mgr = makeManager();
    const { ctx, emitted } = makeCtx({ manager: mgr, answer: 'no' });
    const r = await relayCommand.exec([], ctx);
    expect(r.kind).toBe('ok');
    expect(mgr.isServing()).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  test('off → stops serving and emits relay:change(inactive)', async () => {
    const mgr = makeManager();
    await mgr.startServing();
    const { ctx, emitted } = makeCtx({ manager: mgr });
    const r = await relayCommand.exec(['off'], ctx);
    expect(r.kind).toBe('ok');
    expect(mgr.isServing()).toBe(false);
    expect(emitted.some((e) => e.type === 'relay:change' && e.active === false)).toBe(true);
  });

  test('unknown arg → error', async () => {
    const { ctx } = makeCtx({ manager: makeManager() });
    expect((await relayCommand.exec(['bogus'], ctx)).kind).toBe('error');
  });
});
