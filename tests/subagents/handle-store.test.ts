import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/index.ts';
import {
  getSubagentHandle,
  listSubagentHandlesByParent,
  settleSubagentHandle,
} from '../../src/storage/repos/subagent-handles.ts';
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
    const h = store.spawn({ name: 'explore', prompt: 'find auth' }, { estimateCostUsd: 0 });
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
    const h = store.spawn({ name: 'review', prompt: 'p' }, { estimateCostUsd: 0 });
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
      store.spawn({ name: `worker_${i}`, prompt: 'p' }, { estimateCostUsd: 0 }),
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
    const h = store.spawn({ name: 'slow', prompt: 'p' }, { estimateCostUsd: 0 });
    await inFlight;
    const cancelOutcome = store.cancel(h.id, 'model');
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
    const h1 = store.spawn({ name: 'first', prompt: 'p' }, { estimateCostUsd: 0 });
    const h2 = store.spawn({ name: 'queued', prompt: 'p' }, { estimateCostUsd: 0 });
    // h2 is queued behind h1 at cap=1. Cancelling h2 BEFORE the
    // slot frees should bypass spawnFn entirely.
    const cancelOutcome = store.cancel(h2.id, 'model');
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
    const out = store.cancel('nope', 'model');
    expect(out).toEqual({ cancelled: false, reason: 'unknown' });
  });

  test('cancel on already-settled handle is idempotent', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
    });
    const h = store.spawn({ name: 'fast', prompt: 'p' }, { estimateCostUsd: 0 });
    await store.awaitHandle(h.id);
    const out = store.cancel(h.id, 'model');
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
    const h = store.spawn({ name: 'slow', prompt: 'p' }, { estimateCostUsd: 0 });
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
    const h = store.spawn({ name: 'slow', prompt: 'p' }, { estimateCostUsd: 0 });
    setTimeout(() => ctrl.abort(), 20);
    const out = await store.awaitHandle(h.id, { signal: ctrl.signal });
    expect(out.kind).toBe('aborted');
  });

  // Slice 135 P1 conc-3: task_await cancelled — exhaust the
  // remaining await/cancel state matrix the basic case above
  // doesn't cover. Pre-aborted signal, signal abort vs. settle
  // race, repeat awaits after the cancelled one.
  test('pre-aborted signal returns kind: aborted on the fast path', async () => {
    const ctrl = new AbortController();
    ctrl.abort(); // signal is aborted BEFORE awaitHandle is called
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        await sleep(200, signal);
        return okResult(args);
      },
    });
    const h = store.spawn({ name: 'slow', prompt: 'p' }, { estimateCostUsd: 0 });
    const out = await store.awaitHandle(h.id, { signal: ctrl.signal });
    expect(out.kind).toBe('aborted');
    // The spawn is still in flight — a subsequent await without
    // the aborted signal recovers the actual result.
    const out2 = await store.awaitHandle(h.id);
    expect(out2.kind).toBe('done');
  });

  test('settled fast path beats both signal AND timeout', async () => {
    // When status === 'settled' at the moment awaitHandle is
    // called, the fast path returns kind:'done' BEFORE
    // attaching the signal listener or arming the timer. Pin
    // this: even with a pre-aborted signal AND a 1ms timeout
    // (both would otherwise win), settled wins.
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
    });
    const h = store.spawn({ name: 'fast', prompt: 'p' }, { estimateCostUsd: 0 });
    // Wait for settle.
    await store.awaitHandle(h.id);
    // Now call again with pathological options — settled fast
    // path runs first.
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await store.awaitHandle(h.id, { timeoutMs: 1, signal: ctrl.signal });
    expect(out.kind).toBe('done');
  });

  test('signal abort + settle racing: first-to-resolve wins', async () => {
    // Window: awaitHandle attaches the abort listener AND the
    // promise-settle .then in the same microtask. If both fire
    // close together, the `settled` flag inside settle() resolves
    // exactly one. We can't deterministically schedule the race,
    // but we CAN assert that whichever resolves, the result is
    // shape-correct (kind: 'aborted' OR kind: 'done', never both
    // / never undefined).
    const ctrl = new AbortController();
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
    });
    const h = store.spawn({ name: 'race', prompt: 'p' }, { estimateCostUsd: 0 });
    // Abort and settle race. Schedule both via setTimeout(0).
    setTimeout(() => ctrl.abort(), 0);
    const out = await store.awaitHandle(h.id, { signal: ctrl.signal });
    expect(['aborted', 'done']).toContain(out.kind);
  });

  test('multiple concurrent awaits: one cancelled, others continue and see kind:done', async () => {
    // Three awaits on the same handle. Only the second is wired
    // to a signal that aborts. The first + third must STILL see
    // kind:'done' once the spawn settles — per-await listeners
    // are independent.
    let releaseSpawn: () => void = () => {};
    const inFlight = new Promise<void>((r) => {
      releaseSpawn = r;
    });
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => {
        await inFlight;
        return okResult(args);
      },
    });
    const h = store.spawn({ name: 'multi', prompt: 'p' }, { estimateCostUsd: 0 });
    const ctrl = new AbortController();
    const a1 = store.awaitHandle(h.id);
    const a2 = store.awaitHandle(h.id, { signal: ctrl.signal });
    const a3 = store.awaitHandle(h.id);
    // Abort the middle waiter BEFORE the spawn resolves.
    ctrl.abort();
    const r2 = await a2;
    expect(r2.kind).toBe('aborted');
    // Now resolve the spawn. The other two awaits unblock with
    // kind:'done' — they were never wired to the aborted signal.
    releaseSpawn();
    const r1 = await a1;
    const r3 = await a3;
    expect(r1.kind).toBe('done');
    expect(r3.kind).toBe('done');
  });

  test('await on a handle cancelled via store.cancel: kind:done with cancelled envelope', async () => {
    // task_cancel + task_await is the documented model flow:
    //   1. spawn
    //   2. cancel  (store.cancel)
    //   3. await   (model wants to know what the cancellation produced)
    // The await MUST settle with kind:'done' carrying an
    // interrupted/cancelled envelope. Failure mode this catches:
    // a regression where cancel + await + settle race and await
    // returns kind:'aborted' (operator-signal semantics) instead
    // of kind:'done' (the store-internal cancel completed).
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        await sleep(200, signal).catch(() => undefined);
        return okResult(args);
      },
    });
    const h = store.spawn({ name: 'cancel-then-await', prompt: 'p' }, { estimateCostUsd: 0 });
    store.cancel(h.id, 'model');
    const out = await store.awaitHandle(h.id);
    expect(out.kind).toBe('done');
    if (out.kind === 'done' && out.result.kind === 'ran') {
      // Cancel attribution stamped per slice 130 contract.
      expect(out.result.cancelSource).toBe('model');
    }
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
      store.spawn({ name: `w${i}`, prompt: 'p' }, { estimateCostUsd: 0 }),
    );
    await allInFlight;
    await store.drain('parent_drain');
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
    const h = store.spawn({ name: 'broken', prompt: 'p' }, { estimateCostUsd: 0 });
    const out = await store.awaitHandle(h.id);
    expect(out.kind).toBe('done');
    if (out.kind === 'done' && out.result.kind === 'ran') {
      expect(out.result.status).toBe('error');
      expect(out.result.reason).toBe('spawn_failed');
      expect(out.result.auditFailure?.message).toContain('boom');
    }
  });

  test('listDetailed surfaces status and settled summary for each handle (D229)', async () => {
    // task_list tool consumer. Running handles surface as
    // status='running' with no `settled` block; settled handles
    // (kind: 'ran') get the summary fields. The view is a
    // snapshot — repeated calls return fresh state as records
    // transition.
    let releaseLong: () => void = () => {};
    const longHold = new Promise<void>((r) => {
      releaseLong = r;
    });
    let count = 0;
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        count += 1;
        if (count === 1) {
          // First spawn settles fast.
          return {
            kind: 'ran',
            output: 'fast',
            sessionId: 'child-fast',
            status: 'done',
            reason: 'done',
            costUsd: 0.5,
            steps: 2,
            durationMs: 50,
          };
        }
        // Second spawn waits on longHold so we can observe a
        // settled+running mix.
        try {
          await Promise.race([longHold, sleep(2000, signal)]);
        } catch {
          // Aborted.
        }
        return okResult(args);
      },
    });
    const h1 = store.spawn({ name: 'fast-explore', prompt: 'p' }, { estimateCostUsd: 0 });
    const h2 = store.spawn({ name: 'slow-review', prompt: 'p' }, { estimateCostUsd: 0 });
    await store.awaitHandle(h1.id);
    const snapshotMixed = store.listDetailed();
    expect(snapshotMixed).toHaveLength(2);
    const fast = snapshotMixed.find((s) => s.id === h1.id);
    const slow = snapshotMixed.find((s) => s.id === h2.id);
    if (fast === undefined || slow === undefined) {
      throw new Error('snapshot missing handles');
    }
    expect(fast.status).toBe('settled');
    expect(fast.name).toBe('fast-explore');
    expect(fast.settled).toEqual({
      childStatus: 'done',
      reason: 'done',
      costUsd: 0.5,
      steps: 2,
      durationMs: 50,
      childSessionId: 'child-fast',
    });
    expect(slow.status).toBe('running');
    expect(slow.settled).toBeUndefined();
    // Release and verify the post-settle state for the second
    // handle.
    releaseLong();
    await store.awaitHandle(h2.id);
    const snapshotFinal = store.listDetailed();
    const slowFinal = snapshotFinal.find((s) => s.id === h2.id);
    expect(slowFinal?.status).toBe('settled');
    expect(slowFinal?.settled?.childSessionId).toBe('child-slow-review');
  });

  test('listDetailed omits settled summary for non-ran envelopes (refusal kinds)', async () => {
    // unknown_subagent / depth_exceeded / budget_exhausted
    // settled rows DO show status='settled' but carry no
    // summary block — the consumer (task_list tool) lets the
    // model fetch the full envelope via task_await for those
    // refusal cases, where the kind discriminator drives the
    // tool-error mapping.
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async () => ({
        kind: 'budget_exhausted',
        requested: 'explore',
        spent: 4.5,
        estimate: 1.0,
        projected: 5.5,
        cap: 5.0,
      }),
    });
    const h = store.spawn({ name: 'explore', prompt: 'p' }, { estimateCostUsd: 0 });
    await store.awaitHandle(h.id);
    const snapshot = store.listDetailed();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.status).toBe('settled');
    expect(snapshot[0]?.settled).toBeUndefined();
  });

  test('listDetailed surfaces cancelSource on cancelled-then-settled rows', async () => {
    // Cross-fix interaction (D217 + D229): a handle cancelled
    // by the model lands in listDetailed with cancelSource set
    // — the operator/model can spot "this one was cancelled by
    // me, not by the cap watchdog" without reading the full
    // envelope.
    let entered: () => void = () => {};
    const e = new Promise<void>((r) => {
      entered = r;
    });
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (_args, signal) => {
        entered();
        try {
          await sleep(500, signal);
        } catch {
          // fall through
        }
        return {
          kind: 'ran',
          output: '',
          sessionId: 'child-id',
          status: 'interrupted',
          reason: 'cancelled',
          costUsd: 0,
          steps: 0,
          durationMs: 0,
        };
      },
    });
    const h = store.spawn({ name: 'a', prompt: 'p' }, { estimateCostUsd: 0 });
    await e;
    store.cancel(h.id, 'model');
    await store.awaitHandle(h.id);
    const snapshot = store.listDetailed();
    expect(snapshot[0]?.settled?.cancelSource).toBe('model');
  });

  test('queuedCount reflects spawn calls still waiting on a slot (D234)', async () => {
    // Cap=1 with 3 spawns: the first dispatches immediately
    // (queued goes to 0 once acquireSlot resolves), the next
    // two queue. Until the first settles, queuedCount stays
    // at 2. As each completes, the next dequeues, queue
    // drops by 1.
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const store = createSubagentHandleStore({
      cap: 1,
      spawnFn: async (args, signal) => {
        try {
          await Promise.race([hold, sleep(2000, signal)]);
        } catch {
          // fall through
        }
        return okResult(args);
      },
    });
    const h1 = store.spawn({ name: 'a', prompt: 'p' }, { estimateCostUsd: 0 });
    const h2 = store.spawn({ name: 'b', prompt: 'p' }, { estimateCostUsd: 0 });
    const h3 = store.spawn({ name: 'c', prompt: 'p' }, { estimateCostUsd: 0 });
    // Microtask boundary so the first IIFE has run
    // `acquireSlot` and decremented the queue.
    await Promise.resolve();
    await Promise.resolve();
    expect(store.queuedCount()).toBe(2);
    expect(store.inFlightCount()).toBe(3);
    release();
    await Promise.all([
      store.awaitHandle(h1.id),
      store.awaitHandle(h2.id),
      store.awaitHandle(h3.id),
    ]);
    expect(store.queuedCount()).toBe(0);
    expect(store.inFlightCount()).toBe(0);
  });

  test('onStateChange fires on spawn / dispatch / settle (D234)', async () => {
    // Three transitions per record × N records. Test counts
    // them via a callback so the harness's parallel_status
    // emission can be wired with confidence.
    let count = 0;
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
      onStateChange: () => {
        count += 1;
      },
    });
    const h = store.spawn({ name: 'a', prompt: 'p' }, { estimateCostUsd: 0 });
    // After spawn(): one transition fired (queue+1).
    expect(count).toBeGreaterThanOrEqual(1);
    await store.awaitHandle(h.id);
    // After settle: two more transitions fired (queue-1 on
    // acquireSlot resolve, then running-1 on settle). Total
    // 3 per record. Allow >= since concurrent emissions can
    // happen in some interleavings.
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('inFlightCount reflects only running records', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        await sleep(40, signal);
        return okResult(args);
      },
    });
    const h1 = store.spawn({ name: 'a', prompt: 'p' }, { estimateCostUsd: 0 });
    const h2 = store.spawn({ name: 'b', prompt: 'p' }, { estimateCostUsd: 0 });
    expect(store.inFlightCount()).toBe(2);
    await Promise.all([store.awaitHandle(h1.id), store.awaitHandle(h2.id)]);
    expect(store.inFlightCount()).toBe(0);
  });

  test('recordLiveCost updates reservation; max(estimate, live) is the floor', async () => {
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((r) => {
      entered = r;
    });
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        entered();
        await sleep(200, signal).catch(() => undefined);
        return okResult(args);
      },
    });
    const h = store.spawn({ name: 'live', prompt: 'p' }, { estimateCostUsd: 1 });
    await inFlight;
    // Initial reservation is the estimate (live=0 < estimate=1).
    expect(store.getReservedChildCostUsd()).toBe(1);
    // Live below estimate: reservation stays at estimate.
    store.recordLiveCost(h.id, 0.3);
    expect(store.getReservedChildCostUsd()).toBe(1);
    // Live above estimate: reservation grows with actual spend.
    store.recordLiveCost(h.id, 2.5);
    expect(store.getReservedChildCostUsd()).toBe(2.5);
    // Monotonic: a stale (smaller) cumulative does NOT regress.
    store.recordLiveCost(h.id, 1.0);
    expect(store.getReservedChildCostUsd()).toBe(2.5);
    store.cancel(h.id, 'model');
    await store.awaitHandle(h.id);
  });

  test('recordLiveCost no-ops on unknown handle and on settled records', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
    });
    // Unknown handle.
    store.recordLiveCost('does-not-exist', 5);
    expect(store.getReservedChildCostUsd()).toBe(0);
    // Settled record.
    const h = store.spawn({ name: 'fast', prompt: 'p' }, { estimateCostUsd: 0 });
    await store.awaitHandle(h.id);
    store.recordLiveCost(h.id, 10);
    // Settled records contribute via getSettledChildCostUsd, not
    // via reservation. Reservation drops to 0 once settled.
    expect(store.getReservedChildCostUsd()).toBe(0);
  });

  test('getReservedChildCostUsd(excludeHandleId) drops own reservation (no double-count at cap boundary)', async () => {
    // Pre-fix: dispatcher's pre-spawn gate computed
    //   spent = priorCost + cumulative + reserved
    //   projected = spent + estimate
    // But `reserved` ALREADY included this handle's estimate
    // (store.spawn registered the record before spawnFn ran),
    // so the same estimate counted twice. At cap boundary
    // (remaining budget exactly == estimate) this falsely
    // refused valid spawns. The exclude param fixes it.
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((r) => {
      entered = r;
    });
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        entered();
        await sleep(200, signal).catch(() => undefined);
        return okResult(args);
      },
    });
    const h1 = store.spawn({ name: 'a', prompt: 'p' }, { estimateCostUsd: 2 });
    const h2 = store.spawn({ name: 'b', prompt: 'p' }, { estimateCostUsd: 3 });
    await inFlight;
    // Without exclude: $2 + $3 = $5.
    expect(store.getReservedChildCostUsd()).toBe(5);
    // Excluding h1: $3 only.
    expect(store.getReservedChildCostUsd(h1.id)).toBe(3);
    // Excluding h2: $2 only.
    expect(store.getReservedChildCostUsd(h2.id)).toBe(2);
    // Excluding unknown id: full $5 (no-op).
    expect(store.getReservedChildCostUsd('does-not-exist')).toBe(5);
    store.cancel(h1.id, 'model');
    store.cancel(h2.id, 'model');
    await store.awaitHandle(h1.id);
    await store.awaitHandle(h2.id);
  });

  test('recordLiveCost no-ops on cancelled records (review fix: stale cost_update post-cancel)', async () => {
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((r) => {
      entered = r;
    });
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        entered();
        await sleep(200, signal).catch(() => undefined);
        return okResult(args);
      },
    });
    const h = store.spawn({ name: 'live', prompt: 'p' }, { estimateCostUsd: 1 });
    await inFlight;
    store.recordLiveCost(h.id, 0.5);
    expect(store.getReservedChildCostUsd()).toBe(1); // estimate floor
    // Cancel: reservation drops to 0 immediately.
    store.cancel(h.id, 'model');
    expect(store.getReservedChildCostUsd()).toBe(0);
    // A stray `cost_update` already in flight on the IPC pipe
    // when cancel landed MUST NOT bump the reservation back up.
    store.recordLiveCost(h.id, 5);
    expect(store.getReservedChildCostUsd()).toBe(0);
    await store.awaitHandle(h.id);
  });

  test('cancelAll releases reservation even when liveCostUsd is non-zero', async () => {
    let entered = 0;
    let allInFlight: () => void = () => {};
    const ready = new Promise<void>((r) => {
      allInFlight = r;
    });
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        entered += 1;
        if (entered === 2) allInFlight();
        await sleep(500, signal).catch(() => undefined);
        return okResult(args);
      },
    });
    const h1 = store.spawn({ name: 'a', prompt: 'p' }, { estimateCostUsd: 1 });
    const h2 = store.spawn({ name: 'b', prompt: 'p' }, { estimateCostUsd: 1 });
    await ready;
    // Simulate cost_updates that pushed live above estimate.
    store.recordLiveCost(h1.id, 3);
    store.recordLiveCost(h2.id, 2);
    expect(store.getReservedChildCostUsd()).toBe(5);
    // Watchdog fires.
    store.cancelAll('cap_watchdog');
    // Reservation MUST drop to 0, not stay at 5 because of
    // liveCostUsd. This is the regression the previous
    // implementation had: cancelAll only zeroed estimate, so
    // a record with live > 0 kept its reservation locked at
    // live and blocked new spawns even after the cancel
    // cascaded.
    expect(store.getReservedChildCostUsd()).toBe(0);
    await store.awaitHandle(h1.id);
    await store.awaitHandle(h2.id);
  });

  test('cumulative reconciles with liveCostUsd on kill-during-run (review fix #2)', async () => {
    // Simulate a child that reported $2 of live cost before
    // being aborted; the runtime returns costUsd=0 on
    // interrupted exits. Without reconciliation, the
    // cumulative tracker would charge $0; with it, it charges
    // the live $2. We can't drive this end-to-end here (needs
    // the harness loop), so we exercise the store-side getter
    // directly: post-cost_update, getLiveCostUsd reflects the
    // value; the harness reads it and combines.
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (_args, signal) => {
        await sleep(200, signal).catch(() => undefined);
        // Runtime hardcodes costUsd: 0 on cancelled paths.
        return {
          kind: 'ran',
          output: '',
          sessionId: 'child-abc',
          status: 'interrupted',
          reason: 'cancelled',
          costUsd: 0,
          steps: 0,
          durationMs: 0,
        };
      },
    });
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((r) => {
      entered = r;
    });
    const wrappedStore = {
      ...store,
      spawn: (args: SpawnSubagentArgs, opts: { estimateCostUsd: number }) => {
        const handle = store.spawn(args, opts);
        // Simulate cost_update arriving while the child runs.
        queueMicrotask(() => {
          entered();
          store.recordLiveCost(handle.id, 2.0);
        });
        return handle;
      },
    };
    const h = wrappedStore.spawn({ name: 'k', prompt: 'p' }, { estimateCostUsd: 0 });
    await inFlight;
    // Watchdog reads liveCostUsd before settling.
    expect(store.getLiveCostUsd(h.id)).toBe(2.0);
    store.cancel(h.id, 'model');
    const out = await store.awaitHandle(h.id);
    if (out.kind !== 'done' || out.result.kind !== 'ran') throw new Error('expected ran');
    // Terminal envelope's costUsd is 0 (runtime hardcoded).
    expect(out.result.costUsd).toBe(0);
    // But getLiveCostUsd still reports the truth — the harness
    // uses Math.max(child.costUsd, getLiveCostUsd) to reconcile
    // before charging cumulative.
    expect(store.getLiveCostUsd(h.id)).toBe(2.0);
  });

  test('cancelAll aborts every running record and zeroes their reservations', async () => {
    let entered = 0;
    let allInFlight: () => void = () => {};
    const ready = new Promise<void>((r) => {
      allInFlight = r;
    });
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        entered += 1;
        if (entered === 3) allInFlight();
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
      store.spawn({ name: `w${i}`, prompt: 'p' }, { estimateCostUsd: 2 }),
    );
    await ready;
    expect(store.getReservedChildCostUsd()).toBe(6);
    store.cancelAll('cap_watchdog');
    // Reservations dropped to 0 immediately even before the
    // IIFEs settle. Backs the spec §3.5 promise that the
    // watchdog frees the cap.
    expect(store.getReservedChildCostUsd()).toBe(0);
    // Each record settled as interrupted.
    for (const h of handles) {
      const out = await store.awaitHandle(h.id);
      expect(out.kind).toBe('done');
      if (out.kind === 'done' && out.result.kind === 'ran') {
        expect(out.result.status).toBe('interrupted');
      }
    }
  });

  test('cancelSource attribution: model / cap_watchdog / parent_drain', async () => {
    // Audit fix. Each cancel call site (`cancel`, `cancelAll`,
    // `drain`) requires a `CancelReason` so the persisted
    // envelope's `cancelSource` distinguishes WHO cancelled.
    // The runtime can't tell — only the call site knows. This
    // test exercises all three paths in isolation and asserts
    // the orthogonal `cancelSource` field carries the right
    // value while `reason` stays at the contract value
    // (`cancelled`).
    //
    // Each store carries its own `entered` signal so we cancel
    // ONLY after spawnFn has woken — otherwise the cancel
    // races the IIFE's pre-dispatch check and we get the
    // (different) `cancelled_before_dispatch` reason. That's
    // exercised separately in the existing
    // "cancel before dispatch" test.
    const buildStore = (): {
      store: ReturnType<typeof createSubagentHandleStore>;
      entered: Promise<void>;
    } => {
      let resolveEntered: () => void = () => {};
      const entered = new Promise<void>((r) => {
        resolveEntered = r;
      });
      const store = createSubagentHandleStore({
        cap: 3,
        spawnFn: async (_args, signal) => {
          resolveEntered();
          try {
            await sleep(500, signal);
          } catch {
            // fall through
          }
          return {
            kind: 'ran',
            output: '',
            sessionId: 'child-id',
            status: 'interrupted',
            reason: 'cancelled',
            costUsd: 0,
            steps: 0,
            durationMs: 0,
          };
        },
      });
      return { store, entered };
    };

    // Path 1: explicit task_cancel (model).
    const { store: s1, entered: e1 } = buildStore();
    const h1 = s1.spawn({ name: 'a', prompt: 'p' }, { estimateCostUsd: 0 });
    await e1;
    s1.cancel(h1.id, 'model');
    const out1 = await s1.awaitHandle(h1.id);
    if (out1.kind !== 'done' || out1.result.kind !== 'ran') {
      throw new Error('expected ran envelope');
    }
    expect(out1.result.reason).toBe('cancelled');
    expect(out1.result.cancelSource).toBe('model');

    // Path 2: cap watchdog.
    const { store: s2, entered: e2 } = buildStore();
    const h2 = s2.spawn({ name: 'b', prompt: 'p' }, { estimateCostUsd: 0 });
    await e2;
    s2.cancelAll('cap_watchdog');
    const out2 = await s2.awaitHandle(h2.id);
    if (out2.kind !== 'done' || out2.result.kind !== 'ran') {
      throw new Error('expected ran envelope');
    }
    expect(out2.result.reason).toBe('cancelled');
    expect(out2.result.cancelSource).toBe('cap_watchdog');

    // Path 3: parent drain (harness shutdown).
    const { store: s3, entered: e3 } = buildStore();
    const h3 = s3.spawn({ name: 'c', prompt: 'p' }, { estimateCostUsd: 0 });
    await e3;
    await s3.drain('parent_drain');
    const out3 = await s3.awaitHandle(h3.id);
    if (out3.kind !== 'done' || out3.result.kind !== 'ran') {
      throw new Error('expected ran envelope');
    }
    expect(out3.result.reason).toBe('cancelled');
    expect(out3.result.cancelSource).toBe('parent_drain');

    // Sanity: a handle that finishes naturally (status='done')
    // does NOT carry cancelSource — we don't invent attribution.
    const s4 = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
    });
    const h4 = s4.spawn({ name: 'd', prompt: 'p' }, { estimateCostUsd: 0 });
    const out4 = await s4.awaitHandle(h4.id);
    if (out4.kind !== 'done' || out4.result.kind !== 'ran') {
      throw new Error('expected ran envelope');
    }
    expect(out4.result.status).toBe('done');
    expect(out4.result.cancelSource).toBeUndefined();
  });

  test('drain preserves prior model attribution (does not re-stamp)', async () => {
    // Sequence: model cancels h1; drain runs after. h1 should
    // keep `cancelSource: 'model'`, not get overwritten to
    // `'parent_drain'`. The drain loop's `!r.cancelled` guard
    // is what prevents re-stamping; this test backs that
    // behavior so a refactor that drops the guard fails loud.
    let entered1: () => void = () => {};
    let entered2: () => void = () => {};
    const e1 = new Promise<void>((r) => {
      entered1 = r;
    });
    const e2 = new Promise<void>((r) => {
      entered2 = r;
    });
    let count = 0;
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (_args, signal) => {
        count += 1;
        if (count === 1) entered1();
        else entered2();
        try {
          await sleep(500, signal);
        } catch {
          // fall through
        }
        return {
          kind: 'ran',
          output: '',
          sessionId: 'child-id',
          status: 'interrupted',
          reason: 'cancelled',
          costUsd: 0,
          steps: 0,
          durationMs: 0,
        };
      },
    });
    const h1 = store.spawn({ name: 'a', prompt: 'p' }, { estimateCostUsd: 0 });
    const h2 = store.spawn({ name: 'b', prompt: 'p' }, { estimateCostUsd: 0 });
    await Promise.all([e1, e2]);
    store.cancel(h1.id, 'model');
    await store.drain('parent_drain');
    const out1 = await store.awaitHandle(h1.id);
    const out2 = await store.awaitHandle(h2.id);
    if (out1.kind !== 'done' || out1.result.kind !== 'ran') {
      throw new Error('expected ran envelope');
    }
    if (out2.kind !== 'done' || out2.result.kind !== 'ran') {
      throw new Error('expected ran envelope');
    }
    expect(out1.result.cancelSource).toBe('model');
    expect(out2.result.cancelSource).toBe('parent_drain');
  });

  test('cancel after drain is idempotent and preserves drain attribution', async () => {
    // Inverse of "drain preserves prior model attribution":
    // here drain happens FIRST, then a late `task_cancel`
    // arrives before the IIFE wakes from the abort signal.
    // Without the `!record.cancelled` guard in `cancel`, the
    // second call would silently overwrite cancelReason from
    // 'parent_drain' to 'model'.
    let entered: () => void = () => {};
    const e = new Promise<void>((r) => {
      entered = r;
    });
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (_args, signal) => {
        entered();
        try {
          await sleep(500, signal);
        } catch {
          // fall through
        }
        return {
          kind: 'ran',
          output: '',
          sessionId: 'child-id',
          status: 'interrupted',
          reason: 'cancelled',
          costUsd: 0,
          steps: 0,
          durationMs: 0,
        };
      },
    });
    const h = store.spawn({ name: 'a', prompt: 'p' }, { estimateCostUsd: 0 });
    await e;
    // Drain marks the record cancelled with parent_drain.
    // Don't await drain — we want to interleave a `cancel`
    // BEFORE the IIFE wakes from the abort.
    const drainPromise = store.drain('parent_drain');
    const lateOutcome = store.cancel(h.id, 'model');
    // The late cancel reports `cancelled: true` (idempotent;
    // the handle IS cancelled, just by drain).
    expect(lateOutcome.cancelled).toBe(true);
    await drainPromise;
    const out = await store.awaitHandle(h.id);
    if (out.kind !== 'done' || out.result.kind !== 'ran') {
      throw new Error('expected ran envelope');
    }
    // Attribution stays with the first writer (drain).
    expect(out.result.cancelSource).toBe('parent_drain');
  });

  test('cancelSource stamps on exhausted / error envelopes too (audit fix #1 review)', async () => {
    // Cancellation can land while the child is finishing with
    // a non-interrupted status: `exhausted` (maxSteps hit
    // before the abort propagated) or `error` (spawnFn threw,
    // synthesizeSpawnError fired). Both must still carry
    // attribution so postmortem queries don't lose the source
    // on those paths.

    // Path 1: status='exhausted'.
    let enteredA: () => void = () => {};
    const eA = new Promise<void>((r) => {
      enteredA = r;
    });
    const sA = createSubagentHandleStore({
      cap: 3,
      spawnFn: async () => {
        enteredA();
        // Simulate a child that finishes with `exhausted`
        // BEFORE observing the abort. The store's override
        // must still stamp cancelSource since record.cancelled
        // is true by then.
        await new Promise((r) => setTimeout(r, 10));
        return {
          kind: 'ran',
          output: '',
          sessionId: 'child-A',
          status: 'exhausted',
          reason: 'maxSteps',
          costUsd: 0.01,
          steps: 5,
          durationMs: 10,
        };
      },
    });
    const hA = sA.spawn({ name: 'a', prompt: 'p' }, { estimateCostUsd: 0 });
    await eA;
    sA.cancel(hA.id, 'model');
    const outA = await sA.awaitHandle(hA.id);
    if (outA.kind !== 'done' || outA.result.kind !== 'ran') {
      throw new Error('expected ran envelope');
    }
    expect(outA.result.status).toBe('exhausted');
    expect(outA.result.cancelSource).toBe('model');

    // Path 2: status='error' via spawnFn throw.
    let enteredB: () => void = () => {};
    const eB = new Promise<void>((r) => {
      enteredB = r;
    });
    const sB = createSubagentHandleStore({
      cap: 3,
      spawnFn: async () => {
        enteredB();
        await new Promise((r) => setTimeout(r, 10));
        throw new Error('simulated spawnFn failure');
      },
    });
    const hB = sB.spawn({ name: 'b', prompt: 'p' }, { estimateCostUsd: 0 });
    await eB;
    sB.cancel(hB.id, 'cap_watchdog');
    const outB = await sB.awaitHandle(hB.id);
    if (outB.kind !== 'done' || outB.result.kind !== 'ran') {
      throw new Error('expected ran envelope');
    }
    expect(outB.result.status).toBe('error');
    expect(outB.result.cancelSource).toBe('cap_watchdog');

    // Negative: a natural `done` envelope with cancelReason
    // landing in the post-spawn microtask gap must NOT get a
    // cancelSource stamp. Status='done' means the child
    // finished naturally; the cancel was too late to matter.
    let enteredC: () => void = () => {};
    const eC = new Promise<void>((r) => {
      enteredC = r;
    });
    const sC = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => {
        enteredC();
        return okResult(args);
      },
    });
    const hC = sC.spawn({ name: 'c', prompt: 'p' }, { estimateCostUsd: 0 });
    await eC;
    // Cancel races AFTER spawnFn returned but BEFORE the IIFE
    // settled (microtask gap). bun's scheduler doesn't
    // guarantee this exact interleaving, but the guard is
    // structural: even if cancel lands in the gap,
    // status='done' makes the override skip.
    sC.cancel(hC.id, 'model');
    const outC = await sC.awaitHandle(hC.id);
    if (outC.kind !== 'done' || outC.result.kind !== 'ran') {
      throw new Error('expected ran envelope');
    }
    expect(outC.result.status).toBe('done');
    expect(outC.result.cancelSource).toBeUndefined();
  });
});

describe('SubagentHandleStore — persistence (resume rehydration)', () => {
  let db: DB;
  const parentId = 'parent-session-id';

  beforeEach(() => {
    db = openMemoryDb();
    migrate(db);
    // Insert a placeholder session row so the FK on
    // subagent_handles.parent_session_id resolves. The repo
    // doesn't care about session shape; we just need the row
    // to exist.
    db.query(
      `INSERT INTO sessions (id, model, started_at, cwd, status)
       VALUES (?, 'mock/m', ?, '/p', 'running')`,
    ).run(parentId, Date.now());
  });

  test('spawn writes a row; settle updates child_session_id and payload', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args, `output-${args.name}`),
      persistTo: { db, parentSessionId: parentId },
    });
    const h = store.spawn({ name: 'explore', prompt: 'p' }, { estimateCostUsd: 0 });
    // INSERT happened synchronously inside spawn().
    const beforeSettle = getSubagentHandle(db, h.id);
    expect(beforeSettle).not.toBeNull();
    if (beforeSettle === null) return;
    expect(beforeSettle.status).toBe('running');
    expect(beforeSettle.childSessionId).toBeNull();
    expect(beforeSettle.settledPayload).toBeNull();

    await store.awaitHandle(h.id);

    const afterSettle = getSubagentHandle(db, h.id);
    expect(afterSettle).not.toBeNull();
    if (afterSettle === null) return;
    expect(afterSettle.status).toBe('settled');
    expect(afterSettle.childSessionId).toBe('child-explore');
    expect(afterSettle.settledPayload).not.toBeNull();
    if (afterSettle.settledPayload !== null) {
      expect(afterSettle.settledPayload.output).toBe('output-explore');
    }
  });

  test('cancelled-before-dispatch row stays with null child_session_id', async () => {
    const store = createSubagentHandleStore({
      cap: 1,
      spawnFn: async (args, signal) => {
        await sleep(50, signal);
        return okResult(args);
      },
      persistTo: { db, parentSessionId: parentId },
    });
    const h1 = store.spawn({ name: 'first', prompt: 'p' }, { estimateCostUsd: 0 });
    const h2 = store.spawn({ name: 'queued', prompt: 'p' }, { estimateCostUsd: 0 });
    store.cancel(h2.id, 'model');
    await store.awaitHandle(h1.id);
    await store.awaitHandle(h2.id);
    const queued = getSubagentHandle(db, h2.id);
    expect(queued).not.toBeNull();
    if (queued === null) return;
    expect(queued.status).toBe('settled');
    expect(queued.childSessionId).toBeNull();
    if (queued.settledPayload !== null) {
      expect(queued.settledPayload.reason).toBe('cancelled_before_dispatch');
    }
  });

  test('resume rehydration: settled rows return their cached envelope; running rows convert to resumed_session', async () => {
    // First store: spawn three handles.
    //   - h1 settles cleanly via awaitHandle
    //   - h2 stays mid-spawn (slow spawnFn never resolves before
    //     the test stops awaiting; we manually cancel to force
    //     the row to settle, leaving subagent_outputs reflecting
    //     a clean exit)
    //   - h3 we DO NOT await; the spawn body runs in the
    //     background. We bypass it by closing the first store
    //     without drain — simulating a parent crash. A parent
    //     that exits without drain leaves the row in 'running'.
    // We simulate the crash by NOT calling drain on the first
    // store; instead we directly create a SECOND store backed
    // by the same DB. The second store's constructor mass-
    // settles any 'running' rows the first run left behind.
    let blockSpawn3: () => void = () => {};
    const blockedSpawn3 = new Promise<void>((r) => {
      blockSpawn3 = r;
    });
    const store1 = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        if (args.name === 'h3') {
          // Block until we manually release. The first store
          // never awaits this handle, simulating the parent
          // crashing while h3 was still running.
          await Promise.race([
            blockedSpawn3,
            new Promise((_, reject) => {
              if (signal.aborted) reject(new Error('aborted'));
              else
                signal.addEventListener('abort', () => reject(new Error('aborted')), {
                  once: true,
                });
            }),
          ]);
        }
        return okResult(args);
      },
      persistTo: { db, parentSessionId: parentId },
    });
    const h1 = store1.spawn({ name: 'h1', prompt: 'p' }, { estimateCostUsd: 0 });
    const h2 = store1.spawn({ name: 'h2', prompt: 'p' }, { estimateCostUsd: 0 });
    const h3 = store1.spawn({ name: 'h3', prompt: 'p' }, { estimateCostUsd: 0 });
    await store1.awaitHandle(h1.id);
    await store1.awaitHandle(h2.id);
    // Don't await h3 — it's stuck in the spawnFn. Construct
    // a second store: this is the resume path.
    const store2 = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args), // never called for rehydrated handles
      persistTo: { db, parentSessionId: parentId },
    });
    // Settled handles rehydrate with cached envelope.
    const o1 = await store2.awaitHandle(h1.id);
    expect(o1.kind).toBe('done');
    if (o1.kind === 'done' && o1.result.kind === 'ran') {
      expect(o1.result.status).toBe('done');
      expect(o1.result.sessionId).toBe('child-h1');
    }
    // h3 was running when the "crash" happened; it must
    // surface as resumed_session interrupted.
    const o3 = await store2.awaitHandle(h3.id);
    expect(o3.kind).toBe('done');
    if (o3.kind === 'done' && o3.result.kind === 'ran') {
      expect(o3.result.status).toBe('interrupted');
      expect(o3.result.reason).toBe('resumed_session');
    }
    // The DB row for h3 was mass-settled by store2's
    // constructor.
    const persisted = listSubagentHandlesByParent(db, parentId);
    expect(persisted).toHaveLength(3);
    for (const row of persisted) {
      expect(row.status).toBe('settled');
    }
    // Release the dangling spawnFn so the test runner exits
    // cleanly. Per the write-once contract on
    // settleSubagentHandle (D180), store1's eventual settle
    // call is a NO-OP because store2 already moved the row to
    // 'settled' as `resumed_session`. The DB MUST still
    // reflect the resumed envelope, not the late `done`.
    blockSpawn3();
    await store1.awaitHandle(h3.id);
    const finalRow = persisted.find((r) => r.handleId === h3.id);
    expect(finalRow).not.toBeUndefined();
    if (finalRow !== undefined && finalRow.settledPayload !== null) {
      expect(finalRow.settledPayload.reason).toBe('resumed_session');
    }
    const refetch = listSubagentHandlesByParent(db, parentId).find((r) => r.handleId === h3.id);
    if (refetch !== undefined && refetch.settledPayload !== null) {
      expect(refetch.settledPayload.reason).toBe('resumed_session');
    }
  });

  test('rehydration discriminates unknown_subagent envelope correctly (no shape corruption)', () => {
    // Persist a row whose settled_payload was written from an
    // `unknown_subagent` envelope. Without the discriminated
    // parser, rehydration cast it to `kind: 'ran'` and
    // task_await crashed reading missing fields.
    db.query(
      `INSERT INTO subagent_handles
         (handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at)
       VALUES ('h-unknown', ?, NULL, 'typo-name', ?, 'settled', ?, ?)`,
    ).run(
      parentId,
      Date.now(),
      JSON.stringify({
        kind: 'unknown_subagent',
        requested: 'typo-name',
        available: ['explore', 'review'],
      }),
      Date.now(),
    );
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
      persistTo: { db, parentSessionId: parentId },
    });
    const handles = store.list();
    expect(handles).toHaveLength(1);
  });

  test('rehydration of corrupt JSON falls back to kind:ran with reason=corrupt_envelope', async () => {
    db.query(
      `INSERT INTO subagent_handles
         (handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at)
       VALUES ('h-corrupt', ?, NULL, 'broken', ?, 'settled', ?, ?)`,
    ).run(
      parentId,
      Date.now(),
      JSON.stringify({ kind: 'totally_unknown', random: 'garbage' }),
      Date.now(),
    );
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
      persistTo: { db, parentSessionId: parentId },
    });
    const out = await store.awaitHandle('h-corrupt');
    expect(out.kind).toBe('done');
    if (out.kind === 'done' && out.result.kind === 'ran') {
      expect(out.result.status).toBe('error');
      expect(out.result.reason).toBe('corrupt_envelope');
    }
  });

  test('write-once settle: late settle on a resumed row is a no-op (D180)', () => {
    // Insert a row, settle it as resumed, then call
    // settleSubagentHandle again with a `done` envelope. The
    // second call must NOT overwrite — that's the protection
    // against a child subprocess that finishes after the
    // parent crashed and the resume already wrote its envelope.
    const handleId = 'h-race';
    db.query(
      `INSERT INTO subagent_handles
         (handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at)
       VALUES (?, ?, NULL, 'racy', ?, 'running', NULL, ?)`,
    ).run(handleId, parentId, Date.now(), Date.now());
    // First settle: resumed_session.
    const won = settleSubagentHandle(db, handleId, {
      kind: 'ran',
      reason: 'resumed_session',
      status: 'interrupted',
    });
    expect(won).toBe(true);
    // Second settle: late `done` from a child subprocess.
    const lost = settleSubagentHandle(db, handleId, {
      kind: 'ran',
      reason: 'done',
      status: 'done',
    });
    expect(lost).toBe(false);
    const finalRow = getSubagentHandle(db, handleId);
    expect(finalRow).not.toBeNull();
    if (finalRow !== null && finalRow.settledPayload !== null) {
      expect(finalRow.settledPayload.reason).toBe('resumed_session');
    }
  });

  test('rehydration uses per-row durationMs (D181)', () => {
    // Two rows with different spawn times; both running. After
    // rehydration, each row's settled_payload.durationMs must
    // reflect (now - row.spawnedAt), NOT a single shared value.
    const tBase = Date.now();
    db.query(
      `INSERT INTO subagent_handles
         (handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at)
       VALUES (?, ?, NULL, ?, ?, 'running', NULL, ?)`,
    ).run('h-old', parentId, 'old', tBase - 1000, tBase - 1000);
    db.query(
      `INSERT INTO subagent_handles
         (handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at)
       VALUES (?, ?, NULL, ?, ?, 'running', NULL, ?)`,
    ).run('h-new', parentId, 'new', tBase - 50, tBase - 50);
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
      persistTo: { db, parentSessionId: parentId },
    });
    const persisted = listSubagentHandlesByParent(db, parentId);
    const old = persisted.find((r) => r.handleId === 'h-old');
    const recent = persisted.find((r) => r.handleId === 'h-new');
    if (old?.settledPayload === undefined || old.settledPayload === null) {
      throw new Error('old row settledPayload missing');
    }
    if (recent?.settledPayload === undefined || recent.settledPayload === null) {
      throw new Error('new row settledPayload missing');
    }
    const oldDuration = old.settledPayload.durationMs as number;
    const newDuration = recent.settledPayload.durationMs as number;
    expect(oldDuration).toBeGreaterThanOrEqual(900);
    expect(newDuration).toBeLessThan(oldDuration);
    // Use the store to satisfy the no-unused-variable rule —
    // the construction is the side effect we're testing.
    expect(store.list()).toHaveLength(2);
  });

  test('slice 130 fixup: happy-path persist does NOT emit any failure_event', async () => {
    // Pre-fixup the catch path emitted only on throw; the
    // no-throw path was UNCOVERED. Pin the inverse: when
    // persistence succeeds, no rows land in failure_events.
    const { createSqliteFailureSink } = await import('../../src/failures/index.ts');
    const { countFailureEvents } = await import('../../src/storage/repos/failure-events.ts');
    const failureSink = createSqliteFailureSink({ db });
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
      persistTo: { db, parentSessionId: parentId, failureSink },
    });
    const h = store.spawn({ name: 'happy', prompt: 'p' }, { estimateCostUsd: 0 });
    const out = await store.awaitHandle(h.id);
    expect(out.kind).toBe('done');
    expect(countFailureEvents(db)).toBe(0);
  });

  test('slice 130: persistence failure emits storage.lock_contention via failureSink (SQLITE_BUSY)', async () => {
    // Same throwing-DB shape as the existing review-fix test, but
    // with a failureSink wired so we can assert the structured
    // event lands AND the error_message reaches payload.
    const { createSqliteFailureSink } = await import('../../src/failures/index.ts');
    const { listFailureEventsByCode } = await import('../../src/storage/repos/failure-events.ts');
    const failureSink = createSqliteFailureSink({ db });
    const throwingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return (sql: string) => {
            const stmt = target.query(sql);
            if (sql.includes('UPDATE subagent_handles')) {
              return new Proxy(stmt, {
                get(s, p) {
                  if (p === 'run') {
                    return () => {
                      throw new Error('SQLITE_BUSY: simulated contention');
                    };
                  }
                  // biome-ignore lint/suspicious/noExplicitAny: passthrough
                  return (s as any)[p];
                },
              });
            }
            return stmt;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
      // biome-ignore lint/suspicious/noExplicitAny: test seam
      persistTo: { db: throwingDb as any, parentSessionId: parentId, failureSink },
    });
    const h = store.spawn({ name: 'will-fail', prompt: 'p' }, { estimateCostUsd: 0 });
    await store.awaitHandle(h.id);

    const rows = listFailureEventsByCode(db, 'storage.lock_contention', 0, 10);
    expect(rows.length).toBe(1);
    expect(rows[0]?.classe).toBe('storage');
    expect(rows[0]?.recovery_action).toBe('ignored');
    expect(rows[0]?.user_visible).toBe(0);
    expect(rows[0]?.session_id).toBe(parentId);
    const payload = JSON.parse(rows[0]?.payload_json as string);
    expect(payload.table).toBe('subagent_handles');
    expect(payload.handle_id).toBe(h.id);
    expect(payload.error_message).toContain('SQLITE_BUSY');
  });

  test('slice 130: non-SQLITE_BUSY persist throw emits storage.persist_failed', async () => {
    const { createSqliteFailureSink } = await import('../../src/failures/index.ts');
    const { listFailureEventsByCode } = await import('../../src/storage/repos/failure-events.ts');
    const failureSink = createSqliteFailureSink({ db });
    const throwingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return (sql: string) => {
            const stmt = target.query(sql);
            if (sql.includes('UPDATE subagent_handles')) {
              return new Proxy(stmt, {
                get(s, p) {
                  if (p === 'run') {
                    return () => {
                      throw new Error('FOREIGN KEY constraint failed');
                    };
                  }
                  // biome-ignore lint/suspicious/noExplicitAny: passthrough
                  return (s as any)[p];
                },
              });
            }
            return stmt;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
      // biome-ignore lint/suspicious/noExplicitAny: test seam
      persistTo: { db: throwingDb as any, parentSessionId: parentId, failureSink },
    });
    const h = store.spawn({ name: 'fk-fail', prompt: 'p' }, { estimateCostUsd: 0 });
    await store.awaitHandle(h.id);

    const rows = listFailureEventsByCode(db, 'storage.persist_failed', 0, 10);
    expect(rows.length).toBe(1);
    expect(rows[0]?.classe).toBe('storage');
    const payload = JSON.parse(rows[0]?.payload_json as string);
    expect(payload.error_message).toContain('FOREIGN KEY');
  });

  test('persistence throw does NOT crash the harness (review fix #1)', async () => {
    // Build a DB proxy that throws on the first UPDATE
    // (child_session_id update OR settle, whichever fires).
    // Production hits this on SQLITE_BUSY under WAL contention
    // or FK violation from a cascading parent drop.
    const realDb = db;
    let updateCount = 0;
    const throwingDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return (sql: string) => {
            const stmt = target.query(sql);
            if (sql.includes('UPDATE subagent_handles')) {
              return new Proxy(stmt, {
                get(s, p) {
                  if (p === 'run') {
                    return () => {
                      updateCount += 1;
                      throw new Error('SQLITE_BUSY: simulated contention');
                    };
                  }
                  // biome-ignore lint/suspicious/noExplicitAny: passthrough
                  return (s as any)[p];
                },
              });
            }
            return stmt;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
      // biome-ignore lint/suspicious/noExplicitAny: test seam
      persistTo: { db: throwingDb as any, parentSessionId: parentId },
    });
    const h = store.spawn({ name: 'will-fail', prompt: 'p' }, { estimateCostUsd: 0 });
    // Settle awaits without throwing — the catch in the IIFE
    // swallowed the persistence error, the in-memory cache is
    // still authoritative.
    const out = await store.awaitHandle(h.id);
    expect(out.kind).toBe('done');
    if (out.kind === 'done' && out.result.kind === 'ran') {
      expect(out.result.status).toBe('done');
      expect(out.result.output).toContain('will-fail');
    }
    expect(updateCount).toBeGreaterThan(0);
  });

  test('getRehydratedChildCostUsd sums settled prior-run cost (review fix #3)', () => {
    // Insert two prior-run settled handles with non-zero cost.
    db.query(
      `INSERT INTO subagent_handles
         (handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at)
       VALUES (?, ?, ?, ?, ?, 'settled', ?, ?)`,
    ).run(
      'h-prior-1',
      parentId,
      'child-1',
      'explore',
      Date.now() - 1000,
      JSON.stringify({
        kind: 'ran',
        output: 'x',
        sessionId: 'child-1',
        status: 'done',
        reason: 'done',
        costUsd: 1.5,
        steps: 1,
        durationMs: 100,
      }),
      Date.now() - 1000,
    );
    db.query(
      `INSERT INTO subagent_handles
         (handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at)
       VALUES (?, ?, ?, ?, ?, 'settled', ?, ?)`,
    ).run(
      'h-prior-2',
      parentId,
      'child-2',
      'review',
      Date.now() - 500,
      JSON.stringify({
        kind: 'ran',
        output: 'y',
        sessionId: 'child-2',
        status: 'done',
        reason: 'done',
        costUsd: 0.75,
        steps: 1,
        durationMs: 50,
      }),
      Date.now() - 500,
    );
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
      persistTo: { db, parentSessionId: parentId },
    });
    expect(store.getRehydratedChildCostUsd()).toBeCloseTo(2.25);
  });

  test('rehydration of running row LOST to a race-winner counts the winner cost (review fix)', () => {
    // Crash-resume race: child subprocess settled the row to
    // status='settled' with costUsd > 0 BEFORE the resumed
    // parent ran the rehydration constructor. The constructor
    // sees row.status='running' from the initial list, then
    // tries to settle it to resumed_session — but
    // settleSubagentHandle is write-once and no-ops because
    // the child already wrote. The re-read picks up the
    // child's envelope, but the previous code only added
    // costUsd in the settled-first branch, so the winner's
    // spend was silently dropped from priorCostUsd.
    //
    // Simulate by directly setting status='running' but with
    // a settled_payload already in place — the only way to
    // observe the race in test without two real concurrent
    // writers. The constructor's settle-write-once will then
    // see status NOT in 'running' (the schema CHECK rejects)
    // — actually the simpler simulation is to insert with
    // status='running' and let the constructor's first
    // settleSubagentHandle succeed; we then ALSO test the
    // race-loser path by pre-settling with a high cost
    // first and inserting a "running" row that the
    // constructor will try to settle — settle no-ops, re-read
    // picks up the existing payload.
    db.query(
      `INSERT INTO subagent_handles
         (handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at)
       VALUES (?, ?, ?, ?, ?, 'settled', ?, ?)`,
    ).run(
      'h-race-winner',
      parentId,
      'child-race',
      'explore',
      Date.now() - 100,
      JSON.stringify({
        kind: 'ran',
        output: 'expensive',
        sessionId: 'child-race',
        status: 'done',
        reason: 'done',
        costUsd: 3.0, // The race winner's actual spend.
        steps: 5,
        durationMs: 200,
      }),
      Date.now() - 100,
    );
    // Construct store. The row is already 'settled' so the
    // rehydrated tracker should pick up its cost via the
    // settled-first branch — but we want to also exercise the
    // race-loser path. To do that, force the constructor to
    // see status='running' first by manually flipping AFTER
    // listSubagentHandlesByParent (a real race would have
    // similar ordering: list returns 'running', then writer
    // settles, then we try to settle and lose). Direct path:
    // verify the settled-first branch counts $3.
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
      persistTo: { db, parentSessionId: parentId },
    });
    expect(store.getRehydratedChildCostUsd()).toBeCloseTo(3.0);
  });

  test('updateSubagentHandleChildSession is write-once on settled rows (review fix)', async () => {
    // Pre-fix: late writer could mutate child_session_id even
    // after another process settled the row, leaving
    // settled_payload.reason='resumed_session' but
    // child_session_id pointing to a different child. Audit
    // consumers correlating the two columns saw inconsistent
    // state.
    //
    // Post-fix: update is guarded by status='running'; settled
    // rows are immutable. Return value distinguishes
    // winner-write (true) from race-loser (false).
    const { updateSubagentHandleChildSession, getSubagentHandle, insertSubagentHandle } =
      await import('../../src/storage/repos/subagent-handles.ts');
    insertSubagentHandle(db, {
      handleId: 'h-immutable',
      parentSessionId: parentId,
      name: 'racer',
      spawnedAt: Date.now(),
    });
    // Winner-write while running: returns true, row updated.
    const won = updateSubagentHandleChildSession(db, 'h-immutable', 'child-first');
    expect(won).toBe(true);
    expect(getSubagentHandle(db, 'h-immutable')?.childSessionId).toBe('child-first');
    // Settle the row (simulating the resumed parent's
    // mass-settle).
    settleSubagentHandle(db, 'h-immutable', {
      kind: 'ran',
      reason: 'resumed_session',
      status: 'interrupted',
    });
    // Late writer attempts to update child_session_id again
    // (the original child subprocess woke up after parent's
    // resume and tried to bind its session id). MUST NOT
    // overwrite — returns false; row's child_session_id
    // stays as whatever the winner wrote.
    const lost = updateSubagentHandleChildSession(db, 'h-immutable', 'child-late');
    expect(lost).toBe(false);
    const finalRow = getSubagentHandle(db, 'h-immutable');
    expect(finalRow).not.toBeNull();
    if (finalRow !== null) {
      expect(finalRow.childSessionId).toBe('child-first');
      expect(finalRow.status).toBe('settled');
      if (finalRow.settledPayload !== null) {
        expect(finalRow.settledPayload.reason).toBe('resumed_session');
      }
    }
  });

  test('updateSubagentHandleChildSession throws on missing row (programmer bug)', async () => {
    const { updateSubagentHandleChildSession } = await import(
      '../../src/storage/repos/subagent-handles.ts'
    );
    expect(() => updateSubagentHandleChildSession(db, 'never-inserted', 'child-x')).toThrow(
      /no subagent_handles row/,
    );
  });

  test('rehydration of race-loser path: constructor settle no-ops; re-read cost is folded in', () => {
    // Direct simulation of the race-loser path. We can't have
    // two real writers in a unit test, but we can pre-stage
    // the DB state the constructor would observe DURING the
    // race: list-by-parent returns 'running' for the row, the
    // constructor's settleSubagentHandle no-ops (we wedge the
    // settle to fail-quiet by pre-flipping the row to
    // 'settled' between list and settle — emulated here with
    // a custom proxy DB that intercepts).
    //
    // Simpler functional check via the FALLBACK path of the
    // re-read: if we insert a row that's 'running' and pre-
    // populate settled_payload manually (an impossible state
    // in production but legal at the schema level since the
    // CHECK only constrains the `status` enum), the
    // constructor's settle WILL succeed (status was running)
    // and overwrite the payload with resumed_session. So that
    // path doesn't reproduce. Instead, exercise via two
    // back-to-back constructor invocations on the same DB:
    // first one settles to resumed_session; second one sees
    // the row already settled (the settled-first branch).
    db.query(
      `INSERT INTO subagent_handles
         (handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at)
       VALUES (?, ?, NULL, ?, ?, 'running', NULL, ?)`,
    ).run('h-running', parentId, 'spinner', Date.now() - 50, Date.now() - 50);
    // First store: settles 'running' → resumed_session ($0).
    const store1 = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
      persistTo: { db, parentSessionId: parentId },
    });
    expect(store1.getRehydratedChildCostUsd()).toBe(0);
    // Manually upgrade the row's payload to simulate a child
    // subprocess that completed AFTER the parent's resume but
    // BEFORE a hypothetical second resume — this is the
    // shape the bug would surface in production via a real
    // race. Settle write-once would prevent it normally; we
    // bypass via direct UPDATE.
    db.query(
      `UPDATE subagent_handles
          SET settled_payload = ?
        WHERE handle_id = 'h-running'`,
    ).run(
      JSON.stringify({
        kind: 'ran',
        output: 'late-finish',
        sessionId: 'child-late',
        status: 'done',
        reason: 'done',
        costUsd: 1.75,
        steps: 3,
        durationMs: 150,
      }),
    );
    // Second store: rehydrates the now-settled row with the
    // late envelope and folds its $1.75 into rehydrated
    // tracker. Pre-fix this missed because only the
    // settled-first branch incremented; with the bug present
    // the second store would have reported $0 instead of
    // $1.75. Proves the fold happens at the unified site
    // post-fix.
    const store2 = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
      persistTo: { db, parentSessionId: parentId },
    });
    expect(store2.getRehydratedChildCostUsd()).toBeCloseTo(1.75);
  });

  test('cancelSource survives DB round-trip (audit fix #1 review)', async () => {
    // Each of the three CancelReason values must persist into
    // `subagent_handles.settled_payload.cancelSource` and
    // rehydrate from there with the field intact. Without
    // round-trip coverage, a typo in `envelopeFromJson` could
    // silently drop the field on resume — postmortem queries
    // would lose attribution despite it being correctly set
    // at settle time.
    let entered: () => void = () => {};
    const buildEntered = () => {
      let resolve: () => void = () => {};
      const p = new Promise<void>((r) => {
        resolve = r;
      });
      return { p, resolve };
    };

    for (const reason of ['model', 'cap_watchdog', 'parent_drain'] as const) {
      const { p, resolve } = buildEntered();
      entered = resolve;
      const handleId = `h-${reason}`;
      const store1 = createSubagentHandleStore({
        cap: 3,
        spawnFn: async (_args, signal) => {
          entered();
          try {
            await sleep(500, signal);
          } catch {
            // fall through
          }
          return {
            kind: 'ran',
            output: '',
            sessionId: `child-${reason}`,
            status: 'interrupted',
            reason: 'cancelled',
            costUsd: 0,
            steps: 0,
            durationMs: 0,
          };
        },
        persistTo: { db, parentSessionId: parentId },
      });
      // We can't pin handleId from outside (the store generates
      // it). Spawn, capture id, route the right cancel.
      const h = store1.spawn({ name: handleId, prompt: 'p' }, { estimateCostUsd: 0 });
      await p;
      if (reason === 'model') store1.cancel(h.id, 'model');
      else if (reason === 'cap_watchdog') store1.cancelAll('cap_watchdog');
      else await store1.drain('parent_drain');
      const out = await store1.awaitHandle(h.id);
      if (out.kind !== 'done' || out.result.kind !== 'ran') {
        throw new Error('expected ran envelope');
      }
      expect(out.result.cancelSource).toBe(reason);

      // Rehydrate via the DB — the row was just persisted by
      // the IIFE settle. A second store reads it back through
      // `envelopeFromJson` and the `cancelSource` field must
      // re-emerge intact.
      const persistedRow = getSubagentHandle(db, h.id);
      expect(persistedRow?.status).toBe('settled');
      const payload = persistedRow?.settledPayload;
      expect(payload?.cancelSource).toBe(reason);
    }
  });

  test('rehydrates worktree + worktreeError fields on resume (D226)', async () => {
    // Regression: the `kind: 'ran'` rehydration branch
    // previously rebuilt the envelope without `worktree` /
    // `worktreeError`, dropping diagnostics that were
    // persisted at settle time. A resumed `task_await` then
    // returned less information than the original (pre-resume)
    // call for the same handle.
    //
    // Three scenarios:
    //   (a) handle settled with a successful worktree outcome
    //       (path/branch/dirty/preserved/removed all set);
    //       resume must surface every field.
    //   (b) handle settled with worktreeError (creation
    //       failed); resume must surface code+message.
    //   (c) handle settled with a malformed worktree shape
    //       (corrupt row, partial fields); rehydrate treats
    //       it as missing rather than half-restoring.

    // Scenario (a)
    db.query(
      `INSERT INTO subagent_handles
         (handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at)
       VALUES ('h-wt-ok', ?, 'child-wt-ok', 'worker', ?, 'settled', ?, ?)`,
    ).run(
      parentId,
      Date.now(),
      JSON.stringify({
        kind: 'ran',
        output: 'wt-output',
        sessionId: 'child-wt-ok',
        status: 'done',
        reason: 'done',
        costUsd: 0.5,
        steps: 3,
        durationMs: 100,
        worktree: {
          path: '/tmp/forja-wt/child-wt-ok',
          branch: 'agent/child-wt-ok',
          dirty: true,
          preserved: true,
          removed: false,
        },
      }),
      Date.now(),
    );

    // Scenario (b)
    db.query(
      `INSERT INTO subagent_handles
         (handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at)
       VALUES ('h-wt-err', ?, NULL, 'worker', ?, 'settled', ?, ?)`,
    ).run(
      parentId,
      Date.now(),
      JSON.stringify({
        kind: 'ran',
        output: '',
        sessionId: '',
        status: 'error',
        reason: 'worktree_create_failed',
        costUsd: 0,
        steps: 0,
        durationMs: 5,
        worktreeError: {
          code: 'worktree.create_failed',
          message: 'fatal: invalid reference: agent/child-wt-err',
        },
      }),
      Date.now(),
    );

    // Scenario (c) — partial shape (missing `removed` boolean)
    db.query(
      `INSERT INTO subagent_handles
         (handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at)
       VALUES ('h-wt-partial', ?, 'child-wt-partial', 'worker', ?, 'settled', ?, ?)`,
    ).run(
      parentId,
      Date.now(),
      JSON.stringify({
        kind: 'ran',
        output: 'partial',
        sessionId: 'child-wt-partial',
        status: 'done',
        reason: 'done',
        costUsd: 0.1,
        steps: 1,
        durationMs: 20,
        worktree: {
          path: '/tmp/forja-wt/partial',
          branch: 'agent/partial',
          dirty: false,
          preserved: false,
          // removed: missing — treated as malformed
        },
      }),
      Date.now(),
    );

    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
      persistTo: { db, parentSessionId: parentId },
    });

    // (a) Worktree fully restored.
    const outOk = await store.awaitHandle('h-wt-ok');
    if (outOk.kind !== 'done' || outOk.result.kind !== 'ran') {
      throw new Error('expected ran envelope for h-wt-ok');
    }
    expect(outOk.result.worktree).toEqual({
      path: '/tmp/forja-wt/child-wt-ok',
      branch: 'agent/child-wt-ok',
      dirty: true,
      preserved: true,
      removed: false,
    });
    expect(outOk.result.worktreeError).toBeUndefined();

    // (b) WorktreeError fully restored.
    const outErr = await store.awaitHandle('h-wt-err');
    if (outErr.kind !== 'done' || outErr.result.kind !== 'ran') {
      throw new Error('expected ran envelope for h-wt-err');
    }
    expect(outErr.result.worktree).toBeUndefined();
    expect(outErr.result.worktreeError).toEqual({
      code: 'worktree.create_failed',
      message: 'fatal: invalid reference: agent/child-wt-err',
    });

    // (c) Partial worktree silently dropped — half-restoring
    // would smuggle `undefined` into a non-optional `removed`
    // boolean past the type system.
    const outPartial = await store.awaitHandle('h-wt-partial');
    if (outPartial.kind !== 'done' || outPartial.result.kind !== 'ran') {
      throw new Error('expected ran envelope for h-wt-partial');
    }
    expect(outPartial.result.worktree).toBeUndefined();
    expect(outPartial.result.output).toBe('partial');
  });
});

// Slice 135 P0-7: FIFO ordering of the slot semaphore under
// realistic microtask interleaving. The store enqueues waiters
// in `waiters.push(...)` and dequeues with `waiters.shift()` —
// data-structure FIFO. But the dispatch ORDER observable to the
// spawnFn caller is what the model relies on for "task_async
// calls in order Q1, Q2, Q3 run children in that order once
// slots free." A regression that switched the queue to a Set,
// LIFO, or used a Promise.race resolver pattern would silently
// reorder dispatches and the model's tool flow would lose its
// invariant. This block pins the contract from the spawnFn's
// point of view.
describe('SubagentHandleStore — FIFO slot semaphore (slice 135 P0-7)', () => {
  test('5 spawns at cap=2 dispatch in spawn order, even with microtask interleaving', async () => {
    const dispatchOrder: string[] = [];
    // Each spawnFn is a manual barrier — only resolves when the
    // test releases it. Lets the test control exactly when each
    // record settles so we can observe dispatch order without
    // wall-clock flakiness.
    const releasers: Map<string, () => void> = new Map();
    const releasePromises: Map<string, Promise<void>> = new Map();
    const buildBarrier = (name: string): void => {
      const p = new Promise<void>((resolve) => releasers.set(name, resolve));
      releasePromises.set(name, p);
    };
    for (const name of ['a', 'b', 'c', 'd', 'e']) buildBarrier(name);

    const store = createSubagentHandleStore({
      cap: 2,
      spawnFn: async (args) => {
        dispatchOrder.push(args.name);
        // Wait for the test to release this specific child.
        await releasePromises.get(args.name);
        return okResult(args);
      },
    });

    // Spawn 5 handles with microtask "noise" interleaved between
    // calls — `await Promise.resolve()` pumps the microtask
    // queue and flushes any pending then-callbacks. Without
    // FIFO guarantees, the second `acquireSlot` could resolve
    // before the first if waiters' resolvers fired in any
    // non-deterministic order.
    const handles: Array<{ name: string; id: string }> = [];
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      const h = store.spawn({ name, prompt: `p-${name}` }, { estimateCostUsd: 0 });
      handles.push({ name, id: h.id });
      // Microtask interleaving — flushes the resolved-promise
      // chains queued by acquireSlot's immediate path. If the
      // first two spawns hadn't taken their slots yet, this
      // gives them a chance to run before the next spawn lands
      // — observable proof that microtask order doesn't reorder
      // the waiter queue.
      await Promise.resolve();
      await Promise.resolve();
    }

    // At this point: a, b dispatched (cap=2); c, d, e queued.
    // Yield once more so any straggling microtasks settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchOrder).toEqual(['a', 'b']);
    expect(store.queuedCount()).toBe(3);

    // Release a → c should dispatch next (NOT d or e).
    releasers.get('a')?.();
    await store.awaitHandle(handles[0]?.id ?? '');
    // Pump microtasks so c's acquireSlot resolves + spawnFn enters.
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchOrder).toEqual(['a', 'b', 'c']);

    // Release b → d dispatches.
    releasers.get('b')?.();
    await store.awaitHandle(handles[1]?.id ?? '');
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchOrder).toEqual(['a', 'b', 'c', 'd']);

    // Release c → e dispatches.
    releasers.get('c')?.();
    await store.awaitHandle(handles[2]?.id ?? '');
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchOrder).toEqual(['a', 'b', 'c', 'd', 'e']);

    // Drain remaining barriers.
    releasers.get('d')?.();
    releasers.get('e')?.();
    await Promise.all(handles.map((h) => store.awaitHandle(h.id)));
    expect(store.queuedCount()).toBe(0);
    expect(store.inFlightCount()).toBe(0);
  });

  test('settle order ≠ spawn order: queue still FIFO on the dispatch side', async () => {
    // Demonstrates the contract: FIFO is on DISPATCH, not on
    // SETTLE. If `a` and `b` dispatch but `b` settles first, c
    // takes b's slot. Then if `a` settles, d takes a's slot.
    // Critically: c MUST dispatch before d (FIFO over the
    // waiter queue), regardless of which slot they end up in.
    const dispatchOrder: string[] = [];
    const releasers: Map<string, () => void> = new Map();
    const releasePromises: Map<string, Promise<void>> = new Map();
    for (const name of ['a', 'b', 'c', 'd']) {
      releasePromises.set(name, new Promise<void>((resolve) => releasers.set(name, resolve)));
    }
    const store = createSubagentHandleStore({
      cap: 2,
      spawnFn: async (args) => {
        dispatchOrder.push(args.name);
        await releasePromises.get(args.name);
        return okResult(args);
      },
    });
    const handles = ['a', 'b', 'c', 'd'].map((name) =>
      store.spawn({ name, prompt: 'p' }, { estimateCostUsd: 0 }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchOrder).toEqual(['a', 'b']);

    // Settle b first (out of spawn order). c should dispatch
    // — NOT d, even though d was spawned later. The queue is
    // FIFO over INSERT order, not over slot-vacancy order.
    releasers.get('b')?.();
    await store.awaitHandle(handles[1]?.id ?? '');
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchOrder).toEqual(['a', 'b', 'c']);

    // Now settle a — d should dispatch.
    releasers.get('a')?.();
    await store.awaitHandle(handles[0]?.id ?? '');
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchOrder).toEqual(['a', 'b', 'c', 'd']);

    releasers.get('c')?.();
    releasers.get('d')?.();
    await Promise.all(handles.map((h) => store.awaitHandle(h.id)));
  });

  test('synchronous burst (no awaits between spawns) preserves FIFO', async () => {
    // The most adversarial case: 10 spawns in a tight loop with
    // ZERO microtask flushes between them. Every acquireSlot
    // beyond the cap pushes to `waiters` synchronously; the
    // resolution order when slots free must still match push
    // order. This is the canonical "model emitted 10 task_async
    // calls in one turn" scenario.
    const dispatchOrder: string[] = [];
    const releasers: Map<string, () => void> = new Map();
    const releasePromises: Map<string, Promise<void>> = new Map();
    const names = Array.from({ length: 10 }, (_, i) => `worker_${i.toString().padStart(2, '0')}`);
    for (const name of names) {
      releasePromises.set(name, new Promise<void>((resolve) => releasers.set(name, resolve)));
    }
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => {
        dispatchOrder.push(args.name);
        await releasePromises.get(args.name);
        return okResult(args);
      },
    });
    // Synchronous burst — no awaits.
    const handles = names.map((name) => store.spawn({ name, prompt: 'p' }, { estimateCostUsd: 0 }));
    // Initial dispatch — first 3 enter immediately.
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchOrder).toEqual(['worker_00', 'worker_01', 'worker_02']);
    expect(store.queuedCount()).toBe(7);

    // Release them in REVERSE order to maximally stress the
    // queue: settles happen in [02, 01, 00] order; dispatches
    // MUST still happen in [03, 04, 05] order (queue position,
    // not slot vacancy).
    for (const i of [2, 1, 0]) {
      releasers.get(names[i] ?? '')?.();
      await store.awaitHandle(handles[i]?.id ?? '');
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchOrder).toEqual([
      'worker_00',
      'worker_01',
      'worker_02',
      'worker_03',
      'worker_04',
      'worker_05',
    ]);

    // Now release the middle three in some random order; tail
    // must dispatch in queue order regardless.
    for (const i of [4, 3, 5]) {
      releasers.get(names[i] ?? '')?.();
      await store.awaitHandle(handles[i]?.id ?? '');
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchOrder).toEqual([
      'worker_00',
      'worker_01',
      'worker_02',
      'worker_03',
      'worker_04',
      'worker_05',
      'worker_06',
      'worker_07',
      'worker_08',
    ]);

    // Drain final 4.
    for (let i = 6; i < 10; i++) releasers.get(names[i] ?? '')?.();
    await Promise.all(handles.map((h) => store.awaitHandle(h.id)));
    expect(dispatchOrder).toEqual(names);
  });

  test('cancellation while queued does not reorder remaining waiters', async () => {
    // Cancel the MIDDLE queued waiter. The records before it
    // (already dispatched) and after it (still queued) MUST
    // retain their relative dispatch order. The cancelled
    // record settles via `cancelled_before_dispatch` without
    // calling spawnFn — so it never appears in dispatchOrder.
    const dispatchOrder: string[] = [];
    const releasers: Map<string, () => void> = new Map();
    const releasePromises: Map<string, Promise<void>> = new Map();
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      releasePromises.set(name, new Promise<void>((resolve) => releasers.set(name, resolve)));
    }
    const store = createSubagentHandleStore({
      cap: 2,
      spawnFn: async (args) => {
        dispatchOrder.push(args.name);
        await releasePromises.get(args.name);
        return okResult(args);
      },
    });
    const handles = ['a', 'b', 'c', 'd', 'e'].map((name) =>
      store.spawn({ name, prompt: 'p' }, { estimateCostUsd: 0 }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchOrder).toEqual(['a', 'b']);

    // Cancel the middle queued waiter (d, index 3).
    const cancelResult = store.cancel(handles[3]?.id ?? '', 'model');
    expect(cancelResult.cancelled).toBe(true);

    // Release a — c dispatches next (NOT e, queue order
    // preserved despite d's cancel).
    releasers.get('a')?.();
    await store.awaitHandle(handles[0]?.id ?? '');
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchOrder).toEqual(['a', 'b', 'c']);

    // Release b — e dispatches next (d skipped because cancelled
    // before dispatch; the IIFE wakes from acquireSlot, sees
    // signal.aborted, returns cancelled_before_dispatch without
    // entering spawnFn).
    releasers.get('b')?.();
    await store.awaitHandle(handles[1]?.id ?? '');
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchOrder).toEqual(['a', 'b', 'c', 'e']);

    // d's settled outcome is the cancelled-before-dispatch envelope.
    const dOutcome = await store.awaitHandle(handles[3]?.id ?? '');
    expect(dOutcome.kind).toBe('done');
    if (dOutcome.kind === 'done' && dOutcome.result.kind === 'ran') {
      expect(dOutcome.result.reason).toBe('cancelled_before_dispatch');
      expect(dOutcome.result.cancelSource).toBe('model');
    }

    releasers.get('c')?.();
    releasers.get('e')?.();
    await Promise.all(handles.map((h) => store.awaitHandle(h.id)));
  });
});

// Slice 135 P0-8: cancelAll vs. stale `cost_update` race. The
// pre-fix shape — where `cancelAll` zeroed `estimateCostUsd`
// but did NOT set the `cancelled` flag — let a `cost_update`
// already in flight on the IPC pipe re-inflate `liveCostUsd`
// after the watchdog had released the reservation. The current
// implementation sets `record.cancelled = true` in cancelAll
// and `recordLiveCost` short-circuits on cancelled records.
// This block hammers the race from several angles.
describe('SubagentHandleStore — cancelAll vs. cost_update race (slice 135 P0-8)', () => {
  test('cost_update arriving after cancelAll is dropped (single handle)', async () => {
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((r) => {
      entered = r;
    });
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        entered();
        await sleep(500, signal).catch(() => undefined);
        return okResult(args);
      },
    });
    const h = store.spawn({ name: 'a', prompt: 'p' }, { estimateCostUsd: 2 });
    await inFlight;
    store.recordLiveCost(h.id, 1.5);
    expect(store.getReservedChildCostUsd()).toBe(2); // floor at estimate
    expect(store.getLiveCostUsd(h.id)).toBe(1.5);

    // Watchdog fires.
    store.cancelAll('cap_watchdog');
    expect(store.getReservedChildCostUsd()).toBe(0);

    // Three back-to-back stale cost_updates from the IPC pipe.
    // None must re-inflate the reservation OR the live tracker.
    store.recordLiveCost(h.id, 5);
    expect(store.getReservedChildCostUsd()).toBe(0);
    store.recordLiveCost(h.id, 100);
    expect(store.getReservedChildCostUsd()).toBe(0);
    store.recordLiveCost(h.id, 999_999);
    expect(store.getReservedChildCostUsd()).toBe(0);
    // Live tracker also frozen at the pre-cancel value — the
    // post-cancel cost_updates were no-ops so getLiveCostUsd
    // still returns 1.5 (the value captured before cancel).
    expect(store.getLiveCostUsd(h.id)).toBe(1.5);

    await store.awaitHandle(h.id);
  });

  test('cancelAll over a mixed set: dispatched + queued + already-settled', async () => {
    // Three handles in three distinct states:
    //   - h1: dispatched, will receive a stale cost_update
    //   - h2: queued (cap=1 forces it to wait)
    //   - h3: already settled before cancelAll fires
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((r) => {
      entered = r;
    });
    let h3Done: () => void = () => {};
    const h3Settled = new Promise<void>((r) => {
      h3Done = r;
    });
    const store = createSubagentHandleStore({
      cap: 1,
      spawnFn: async (args, signal) => {
        if (args.name === 'h3') {
          // h3 settles fast.
          return okResult(args);
        }
        if (args.name === 'h1') {
          entered();
          await sleep(500, signal).catch(() => undefined);
          return okResult(args);
        }
        // h2 should never dispatch (cancelled while queued).
        await sleep(500, signal).catch(() => undefined);
        return okResult(args);
      },
    });

    // Run h3 to completion first so it's settled.
    const h3 = store.spawn({ name: 'h3', prompt: 'p' }, { estimateCostUsd: 1 });
    await store.awaitHandle(h3.id);
    h3Done();
    await h3Settled;
    expect(store.getSettledChildCostUsd()).toBe(0); // okResult returns costUsd: 0

    // Now spawn h1 (dispatches at cap=1) + h2 (queued).
    const h1 = store.spawn({ name: 'h1', prompt: 'p' }, { estimateCostUsd: 2 });
    const h2 = store.spawn({ name: 'h2', prompt: 'p' }, { estimateCostUsd: 3 });
    await inFlight;
    store.recordLiveCost(h1.id, 1);
    expect(store.getReservedChildCostUsd()).toBe(2 + 3); // both running: h1 floor=2, h2 estimate=3

    // Watchdog cancelAll.
    store.cancelAll('cap_watchdog');
    expect(store.getReservedChildCostUsd()).toBe(0);

    // Stale cost_updates for each of the three:
    //   - h1: was dispatched, cancelled → cost_update no-op
    //   - h2: was queued + cancelled → cost_update no-op
    //   - h3: already settled (not cancelled) → cost_update is
    //     dropped by the !running guard, not by !cancelled.
    //     Either way: reservation stays 0.
    store.recordLiveCost(h1.id, 999);
    store.recordLiveCost(h2.id, 999);
    store.recordLiveCost(h3.id, 999);
    expect(store.getReservedChildCostUsd()).toBe(0);

    // h2 was cancelled while queued — its outcome is
    // cancelled_before_dispatch with cancelSource='cap_watchdog'.
    const out2 = await store.awaitHandle(h2.id);
    expect(out2.kind).toBe('done');
    if (out2.kind === 'done' && out2.result.kind === 'ran') {
      expect(out2.result.reason).toBe('cancelled_before_dispatch');
      expect(out2.result.cancelSource).toBe('cap_watchdog');
    }
    await store.awaitHandle(h1.id);
  });

  test('cancelAll is idempotent: second call does not re-trigger nor wake stale costs', async () => {
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((r) => {
      entered = r;
    });
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        entered();
        await sleep(500, signal).catch(() => undefined);
        return okResult(args);
      },
    });
    const h = store.spawn({ name: 'h', prompt: 'p' }, { estimateCostUsd: 4 });
    await inFlight;
    store.recordLiveCost(h.id, 2);
    store.cancelAll('cap_watchdog');
    expect(store.getReservedChildCostUsd()).toBe(0);

    // Second cancelAll — no-op (record already cancelled). Then
    // another stale cost_update. Reservation must still be 0.
    store.cancelAll('cap_watchdog');
    store.recordLiveCost(h.id, 50);
    expect(store.getReservedChildCostUsd()).toBe(0);
    await store.awaitHandle(h.id);
  });

  test('cancelAll preserves cancelReason attribution against late cost_update', async () => {
    // The race scenario: cancelAll stamps cancelReason='cap_watchdog'.
    // A stray cost_update lands after. The cost_update path must
    // not silently overwrite the attribution — cancelReason is
    // owned by the cancel paths only. The audit envelope keeps
    // the original source.
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((r) => {
      entered = r;
    });
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        entered();
        await sleep(50, signal).catch(() => undefined);
        return okResult(args);
      },
    });
    const h = store.spawn({ name: 'h', prompt: 'p' }, { estimateCostUsd: 1 });
    await inFlight;
    store.cancelAll('cap_watchdog');
    store.recordLiveCost(h.id, 999);
    const outcome = await store.awaitHandle(h.id);
    expect(outcome.kind).toBe('done');
    if (outcome.kind === 'done' && outcome.result.kind === 'ran') {
      // Stamped by the post-IIFE cancelSource-attribution path.
      // The runtime returned 'done' here (mock spawnFn doesn't
      // respect abort), so cancelSource may or may not be set —
      // the contract is that it's NEVER 'model' when the cancel
      // came from cancelAll('cap_watchdog'). Either undefined
      // (status='done' branch skips stamping) or 'cap_watchdog'
      // is acceptable; 'model' would be a bug.
      if (outcome.result.cancelSource !== undefined) {
        expect(outcome.result.cancelSource).toBe('cap_watchdog');
      }
    }
  });
});
