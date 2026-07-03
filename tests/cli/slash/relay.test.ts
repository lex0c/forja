import { describe, expect, test } from 'bun:test';
import { relayCommand } from '../../../src/cli/slash/commands/relay.ts';
import type { SlashContext } from '../../../src/cli/slash/types.ts';

// Minimal serving-toggle stub — only what /relay touches on the mesh manager.
const makeManager = () => {
  let serving = false;
  return {
    alias: 'billing',
    isServing: () => serving,
    inboundSummary: () => [] as { conversationId: string; peerAlias: string }[],
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

  test('on: confirm yes → starts serving and emits relay:change(active)', async () => {
    const mgr = makeManager();
    const { ctx, emitted } = makeCtx({ manager: mgr, answer: 'yes' });
    const r = await relayCommand.exec(['on'], ctx);
    expect(r.kind).toBe('ok');
    expect(mgr.isServing()).toBe(true);
    expect(emitted.some((e) => e.type === 'relay:change' && e.active === true)).toBe(true);
    // The success note warns that sending is disabled while serving (M8).
    expect(r.kind === 'ok' && r.notes?.some((n) => n.includes('mesh_send'))).toBe(true);
  });

  test('on: confirm no → does not start, emits nothing', async () => {
    const mgr = makeManager();
    const { ctx, emitted } = makeCtx({ manager: mgr, answer: 'no' });
    const r = await relayCommand.exec(['on'], ctx);
    expect(r.kind).toBe('ok');
    expect(mgr.isServing()).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  test('bare /relay reports status without starting (on/off are the verbs)', async () => {
    const mgr = makeManager();
    let modalAsked = false;
    const { ctx } = makeCtx({ manager: mgr });
    ctx.modalManager.askRelayStart = async () => {
      modalAsked = true;
      return 'yes';
    };
    const r = await relayCommand.exec([], ctx);
    expect(r.kind).toBe('ok');
    expect(mgr.isServing()).toBe(false); // never started
    expect(modalAsked).toBe(false); // no consent gate opened
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

  test('on while already serving → reports status, does not re-open the modal', async () => {
    const mgr = makeManager();
    await mgr.startServing();
    let modalAsked = false;
    const { ctx } = makeCtx({ manager: mgr });
    ctx.modalManager.askRelayStart = async () => {
      modalAsked = true;
      return 'yes';
    };
    const r = await relayCommand.exec(['on'], ctx);
    expect(r.kind).toBe('ok');
    expect(mgr.isServing()).toBe(true);
    expect(modalAsked).toBe(false);
  });

  test('off while not serving → already off', async () => {
    const mgr = makeManager();
    const { ctx } = makeCtx({ manager: mgr });
    const r = await relayCommand.exec(['off'], ctx);
    expect(r.kind).toBe('ok');
    expect(mgr.isServing()).toBe(false);
  });
});
