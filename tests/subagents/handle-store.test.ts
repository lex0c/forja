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
    const h1 = store.spawn({ name: 'first', prompt: 'p' }, { estimateCostUsd: 0 });
    const h2 = store.spawn({ name: 'queued', prompt: 'p' }, { estimateCostUsd: 0 });
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
    const h = store.spawn({ name: 'fast', prompt: 'p' }, { estimateCostUsd: 0 });
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
    const h = store.spawn({ name: 'broken', prompt: 'p' }, { estimateCostUsd: 0 });
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
    const h1 = store.spawn({ name: 'a', prompt: 'p' }, { estimateCostUsd: 0 });
    const h2 = store.spawn({ name: 'b', prompt: 'p' }, { estimateCostUsd: 0 });
    expect(store.inFlightCount()).toBe(2);
    await Promise.all([store.awaitHandle(h1.id), store.awaitHandle(h2.id)]);
    expect(store.inFlightCount()).toBe(0);
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
    store.cancel(h2.id);
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
});
