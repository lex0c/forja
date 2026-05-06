import { describe, expect, test } from 'bun:test';
import { createSubagentHandleStore } from '../../src/subagents/handle-store.ts';
import type { SpawnSubagentArgs, SpawnSubagentResult } from '../../src/tools/types.ts';

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const okResult = (args: SpawnSubagentArgs, output = `done: ${args.name}`): SpawnSubagentResult => ({
  kind: 'ran',
  output,
  sessionId: `child-${args.name}`,
  status: 'done',
  reason: 'done',
  costUsd: 0,
  steps: 1,
  durationMs: 0,
});

describe('SubagentHandleStore', () => {
  test('spawn returns handle synchronously; await collects the result', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
    });
    const h = store.spawn({ name: 'explore', prompt: 'find auth' });
    expect(typeof h.id).toBe('string');
    expect(h.name).toBe('explore');
    expect(typeof h.spawnedAt).toBe('number');
    const outcome = await store.awaitHandle(h.id);
    expect(outcome.kind).toBe('done');
    if (outcome.kind === 'done' && outcome.result.kind === 'ran') {
      expect(outcome.result.status).toBe('done');
      expect(outcome.result.output).toContain('explore');
    }
  });

  test('repeat awaits on the same handle return the cached envelope', async () => {
    let calls = 0;
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => {
        calls += 1;
        return okResult(args);
      },
    });
    const h = store.spawn({ name: 'review', prompt: 'p' });
    const a = await store.awaitHandle(h.id);
    const b = await store.awaitHandle(h.id);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  test('cap honored: 5 spawns with cap=2 never have more than 2 in flight', async () => {
    let live = 0;
    let maxLive = 0;
    const store = createSubagentHandleStore({
      cap: 2,
      spawnFn: async (args) => {
        live += 1;
        if (live > maxLive) maxLive = live;
        await sleep(20);
        live -= 1;
        return okResult(args);
      },
    });
    const handles = Array.from({ length: 5 }, (_, i) =>
      store.spawn({ name: `worker_${i}`, prompt: 'p' }),
    );
    await Promise.all(handles.map((h) => store.awaitHandle(h.id)));
    expect(maxLive).toBe(2);
  });

  test('cancel aborts a running spawn before it finishes', async () => {
    // Signal-driven barrier: spawnFn flips it BEFORE awaiting
    // sleep, the test waits on it BEFORE cancel. Replaces a
    // wall-clock `sleep(20)` that flaked under loaded CI when
    // the spawnFn's own setTimeout was delayed past the cancel.
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((r) => {
      entered = r;
    });
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        entered();
        try {
          await sleep(500, signal);
        } catch {
          return {
            kind: 'ran',
            output: '',
            sessionId: '',
            status: 'interrupted',
            reason: 'cancelled',
            costUsd: 0,
            steps: 0,
            durationMs: 0,
          };
        }
        return okResult(args);
      },
    });
    const h = store.spawn({ name: 'slow', prompt: 'p' });
    await inFlight;
    const cancelOutcome = store.cancel(h.id);
    expect(cancelOutcome.cancelled).toBe(true);
    const out = await store.awaitHandle(h.id);
    expect(out.kind).toBe('done');
    if (out.kind === 'done' && out.result.kind === 'ran') {
      expect(out.result.status).toBe('interrupted');
      expect(out.result.reason).toBe('cancelled');
    }
  });

  test('cancel before dispatch (queued at cap) yields cancelled_before_dispatch', async () => {
    let dispatched = 0;
    const store = createSubagentHandleStore({
      cap: 1,
      spawnFn: async (args, signal) => {
        dispatched += 1;
        await sleep(100, signal);
        return okResult(args);
      },
    });
    const h1 = store.spawn({ name: 'first', prompt: 'p' });
    const h2 = store.spawn({ name: 'queued', prompt: 'p' });
    // h2 is queued behind h1 at cap=1. Cancelling h2 BEFORE the
    // slot frees should bypass spawnFn entirely.
    const cancelOutcome = store.cancel(h2.id);
    expect(cancelOutcome.cancelled).toBe(true);
    // Wait for both to settle.
    const [a, b] = await Promise.all([store.awaitHandle(h1.id), store.awaitHandle(h2.id)]);
    expect(a.kind).toBe('done');
    expect(b.kind).toBe('done');
    if (b.kind === 'done' && b.result.kind === 'ran') {
      expect(b.result.reason).toBe('cancelled_before_dispatch');
    }
    // Only h1 made it through to spawnFn.
    expect(dispatched).toBe(1);
  });

  test('cancel on unknown handle is idempotent', () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
    });
    const out = store.cancel('nope');
    expect(out).toEqual({ cancelled: false, reason: 'unknown' });
  });

  test('cancel on already-settled handle is idempotent', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
    });
    const h = store.spawn({ name: 'fast', prompt: 'p' });
    await store.awaitHandle(h.id);
    const out = store.cancel(h.id);
    expect(out).toEqual({ cancelled: false, reason: 'already_settled' });
  });

  test('await on unknown handle returns kind: unknown', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
    });
    const out = await store.awaitHandle('nope');
    expect(out).toEqual({ kind: 'unknown' });
  });

  test('await timeout fires while the run is still going', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        await sleep(200, signal);
        return okResult(args);
      },
    });
    const h = store.spawn({ name: 'slow', prompt: 'p' });
    const out = await store.awaitHandle(h.id, { timeoutMs: 30 });
    expect(out.kind).toBe('timeout');
    // The run is still in flight — a later await without timeout
    // resolves with the actual result.
    const out2 = await store.awaitHandle(h.id);
    expect(out2.kind).toBe('done');
  });

  test('await with external signal abort returns kind: aborted', async () => {
    const ctrl = new AbortController();
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        await sleep(200, signal);
        return okResult(args);
      },
    });
    const h = store.spawn({ name: 'slow', prompt: 'p' });
    setTimeout(() => ctrl.abort(), 20);
    const out = await store.awaitHandle(h.id, { signal: ctrl.signal });
    expect(out.kind).toBe('aborted');
  });

  test('drain cancels every running record and awaits settle', async () => {
    // Counter-based barrier: spawnFn increments on entry; the
    // test awaits the third entry before draining. Deterministic
    // under loaded CI vs. a wall-clock sleep.
    let entered = 0;
    let allInFlightResolve: () => void = () => {};
    const allInFlight = new Promise<void>((r) => {
      allInFlightResolve = r;
    });
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        entered += 1;
        if (entered === 3) allInFlightResolve();
        try {
          await sleep(500, signal);
        } catch {
          return {
            kind: 'ran',
            output: '',
            sessionId: '',
            status: 'interrupted',
            reason: 'cancelled',
            costUsd: 0,
            steps: 0,
            durationMs: 0,
          };
        }
        return okResult(args);
      },
    });
    const handles = Array.from({ length: 3 }, (_, i) =>
      store.spawn({ name: `w${i}`, prompt: 'p' }),
    );
    await allInFlight;
    await store.drain();
    expect(store.inFlightCount()).toBe(0);
    expect(store.list()).toHaveLength(handles.length);
    for (const h of handles) {
      const out = await store.awaitHandle(h.id);
      expect(out.kind).toBe('done');
      if (out.kind === 'done' && out.result.kind === 'ran') {
        expect(out.result.status).toBe('interrupted');
        expect(out.result.reason).toBe('cancelled');
      }
    }
  });

  test('spawnFn that throws is captured into a synthesized error envelope', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async () => {
        throw new Error('boom');
      },
    });
    const h = store.spawn({ name: 'broken', prompt: 'p' });
    const out = await store.awaitHandle(h.id);
    expect(out.kind).toBe('done');
    if (out.kind === 'done' && out.result.kind === 'ran') {
      expect(out.result.status).toBe('error');
      expect(out.result.reason).toBe('spawn_failed');
      expect(out.result.auditFailure?.message).toContain('boom');
    }
  });

  test('inFlightCount reflects only running records', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        await sleep(40, signal);
        return okResult(args);
      },
    });
    const h1 = store.spawn({ name: 'a', prompt: 'p' });
    const h2 = store.spawn({ name: 'b', prompt: 'p' });
    expect(store.inFlightCount()).toBe(2);
    await Promise.all([store.awaitHandle(h1.id), store.awaitHandle(h2.id)]);
    expect(store.inFlightCount()).toBe(0);
  });
});
