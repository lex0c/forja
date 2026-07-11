import { describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/index.ts';
import { createSubagentHandleStore } from '../../src/subagents/handle-store.ts';
import { taskListTool } from '../../src/tools/builtin/task-list.ts';
import type { SpawnSubagentArgs, SpawnSubagentResult } from '../../src/tools/types.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

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

const okResult = (args: SpawnSubagentArgs): SpawnSubagentResult => ({
  kind: 'ran',
  output: `done: ${args.name}`,
  sessionId: `child-${args.name}`,
  status: 'done',
  reason: 'done',
  costUsd: 0.1,
  steps: 1,
  durationMs: 10,
});

describe('task_list tool', () => {
  test('empty list when the store has no handles', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
    });
    const ctx = makeCtx({ subagentHandleStore: store });
    const out = await taskListTool.execute({}, ctx);
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.handles).toEqual([]);
    expect(out.in_flight).toBe(0);
    expect(out.settled).toBe(0);
  });

  test('lists running and settled handles in spawn order with counters', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    let count = 0;
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        count += 1;
        if (count === 1) return okResult(args);
        // Second handle blocks until released so we observe a
        // settled + running mix in the snapshot.
        try {
          await Promise.race([hold, sleep(2000, signal)]);
        } catch {
          // fall through
        }
        return okResult(args);
      },
    });
    const ctx = makeCtx({ subagentHandleStore: store });
    const h1 = store.spawn({ name: 'alpha', prompt: 'p' }, { estimateCostUsd: 0 });
    const h2 = store.spawn({ name: 'beta', prompt: 'p' }, { estimateCostUsd: 0 });
    await store.awaitHandle(h1.id);
    const snap = await taskListTool.execute({}, ctx);
    if (isToolError(snap)) throw new Error('unexpected error');
    expect(snap.handles).toHaveLength(2);
    expect(snap.in_flight).toBe(1);
    expect(snap.settled).toBe(1);
    // Spawn-order ordering: h1 (alpha) before h2 (beta).
    expect(snap.handles[0]?.handle_id).toBe(h1.id);
    expect(snap.handles[1]?.handle_id).toBe(h2.id);
    expect(snap.handles[0]?.status).toBe('settled');
    expect(snap.handles[0]?.settled).toEqual({
      child_status: 'done',
      reason: 'done',
      cost_usd: 0.1,
      steps: 1,
      duration_ms: 10,
      child_session_id: 'child-alpha',
    });
    expect(snap.handles[1]?.status).toBe('running');
    expect(snap.handles[1]?.settled).toBeUndefined();
    release();
    await store.awaitHandle(h2.id);
  });

  test('status filter narrows the snapshot', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    let count = 0;
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        count += 1;
        if (count === 1) return okResult(args);
        try {
          await Promise.race([hold, sleep(2000, signal)]);
        } catch {
          // fall through
        }
        return okResult(args);
      },
    });
    const ctx = makeCtx({ subagentHandleStore: store });
    const h1 = store.spawn({ name: 'a', prompt: 'p' }, { estimateCostUsd: 0 });
    const h2 = store.spawn({ name: 'b', prompt: 'p' }, { estimateCostUsd: 0 });
    await store.awaitHandle(h1.id);

    const runningOnly = await taskListTool.execute({ status: 'running' }, ctx);
    if (isToolError(runningOnly)) throw new Error('unexpected error');
    expect(runningOnly.handles).toHaveLength(1);
    expect(runningOnly.handles[0]?.handle_id).toBe(h2.id);
    // Counters reflect the FILTERED set, matching how the model
    // reads them.
    expect(runningOnly.in_flight).toBe(1);
    expect(runningOnly.settled).toBe(0);

    const settledOnly = await taskListTool.execute({ status: 'settled' }, ctx);
    if (isToolError(settledOnly)) throw new Error('unexpected error');
    expect(settledOnly.handles).toHaveLength(1);
    expect(settledOnly.handles[0]?.handle_id).toBe(h1.id);
    expect(settledOnly.in_flight).toBe(0);
    expect(settledOnly.settled).toBe(1);
    release();
    await store.awaitHandle(h2.id);
  });

  test('refusal-kind settled handles surface without a settled summary block', async () => {
    // unknown_subagent / depth_exceeded / budget_exhausted are
    // not `kind: 'ran'` envelopes — listDetailed (and thus
    // task_list) shows status='settled' without a summary so
    // the model knows to follow up via task_await for the full
    // refusal payload.
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async () => ({
        kind: 'unknown_subagent',
        requested: 'mistyped',
        available: ['explore'],
      }),
    });
    const ctx = makeCtx({ subagentHandleStore: store });
    const h = store.spawn({ name: 'mistyped', prompt: 'p' }, { estimateCostUsd: 0 });
    await store.awaitHandle(h.id);
    const out = await taskListTool.execute({}, ctx);
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.handles).toHaveLength(1);
    expect(out.handles[0]?.status).toBe('settled');
    expect(out.handles[0]?.settled).toBeUndefined();
  });

  test('surfaces cancelSource on cancelled-then-settled handles', async () => {
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
    const ctx = makeCtx({ subagentHandleStore: store });
    const h = store.spawn({ name: 'a', prompt: 'p' }, { estimateCostUsd: 0 });
    await e;
    store.cancel(h.id, 'model');
    await store.awaitHandle(h.id);
    const out = await taskListTool.execute({}, ctx);
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.handles[0]?.settled?.cancel_source).toBe('model');
    expect(out.handles[0]?.settled?.child_status).toBe('interrupted');
  });

  test('subagent.unavailable when no store is wired', async () => {
    const ctx = makeCtx({});
    const out = await taskListTool.execute({}, ctx);
    expect(isToolError(out)).toBe(true);
    if (!isToolError(out)) return;
    expect(out.error_code).toBe('subagent.unavailable');
  });

  test('aborts cleanly when ctx.signal already fired', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
    });
    const ctrl = new AbortController();
    ctrl.abort();
    const ctx = makeCtx({ subagentHandleStore: store, signal: ctrl.signal });
    const out = await taskListTool.execute({}, ctx);
    expect(isToolError(out)).toBe(true);
    if (!isToolError(out)) return;
    expect(out.error_code).toBe('tool.aborted');
  });

  test('rehydrated handles from a prior run surface in the snapshot (review fix Q7)', async () => {
    // Headline use case for task_list: long context dropped
    // earlier turns OR the session was resumed after a crash.
    // Either way the model has no record of the prior handle
    // ids; task_list must recover them by reading rehydrated
    // store records. Setup mirrors the rehydrate-test pattern
    // in handle-store.test.ts: pre-seed sessions + handle rows
    // in the DB, then construct a fresh store with persistTo
    // and verify task_list returns the rehydrated entries.
    const db: DB = openMemoryDb();
    migrate(db);
    const parentId = 'rehydrate-parent';
    db.query(
      `INSERT INTO sessions (id, started_at, model, cwd, status, total_cost_usd, seq, parent_session_id, is_subagent)
       VALUES (?, ?, 'mock', '/p', 'running', 0, 0, NULL, 0)`,
    ).run(parentId, Date.now() - 60_000);
    db.query(
      `INSERT INTO subagent_handles
         (handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at)
       VALUES ('h-prior-A', ?, 'child-A', 'explore', ?, 'settled', ?, ?)`,
    ).run(
      parentId,
      Date.now() - 50_000,
      JSON.stringify({
        kind: 'ran',
        output: 'prior',
        sessionId: 'child-A',
        status: 'done',
        reason: 'done',
        costUsd: 0.25,
        steps: 2,
        durationMs: 100,
      }),
      Date.now() - 50_000,
    );
    db.query(
      `INSERT INTO subagent_handles
         (handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at)
       VALUES ('h-prior-B', ?, 'child-B', 'review', ?, 'settled', ?, ?)`,
    ).run(
      parentId,
      Date.now() - 40_000,
      JSON.stringify({
        kind: 'ran',
        output: 'prior2',
        sessionId: 'child-B',
        status: 'done',
        reason: 'done',
        costUsd: 0.5,
        steps: 3,
        durationMs: 200,
      }),
      Date.now() - 40_000,
    );
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
      persistTo: { db, parentSessionId: parentId },
    });
    const ctx = makeCtx({ subagentHandleStore: store });
    const out = await taskListTool.execute({}, ctx);
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.handles).toHaveLength(2);
    expect(out.total_settled).toBe(2);
    expect(out.total_in_flight).toBe(0);
    // Both surface as settled with `kind: 'ran'` and a
    // populated summary block — exactly what the model needs
    // to decide which one to task_await.
    expect(out.handles[0]?.kind).toBe('ran');
    expect(out.handles[0]?.settled?.cost_usd).toBe(0.25);
    expect(out.handles[1]?.kind).toBe('ran');
    expect(out.handles[1]?.settled?.cost_usd).toBe(0.5);
  });

  test('cancelled-before-dispatch surfaces child_session_id: null (review fix Q7)', async () => {
    // The cancelled-before-dispatch envelope (cancel landed
    // before the IIFE woke from acquireSlot) carries an empty
    // sessionId because no child session was ever created.
    // listDetailed maps that to childSessionId: null; task_list
    // pipes through as child_session_id: null. Verify the
    // mapping holds end-to-end.
    const store = createSubagentHandleStore({
      cap: 1,
      spawnFn: async (args, signal) => {
        await new Promise((r) => setTimeout(r, 100));
        if (signal.aborted) {
          // Should not be reached for h2 because cancel
          // landed before dispatch. h1 takes this path under
          // its own cancel.
          return { ...okResult(args), status: 'interrupted' as const };
        }
        return okResult(args);
      },
    });
    const ctx = makeCtx({ subagentHandleStore: store });
    const h1 = store.spawn({ name: 'first', prompt: 'p' }, { estimateCostUsd: 0 });
    const h2 = store.spawn({ name: 'queued', prompt: 'p' }, { estimateCostUsd: 0 });
    // Cancel h2 BEFORE the slot frees so it bypasses spawnFn.
    store.cancel(h2.id, 'model');
    await Promise.all([store.awaitHandle(h1.id), store.awaitHandle(h2.id)]);
    const out = await taskListTool.execute({ status: 'settled' }, ctx);
    if (isToolError(out)) throw new Error('unexpected error');
    const queued = out.handles.find((h) => h.handle_id === h2.id);
    expect(queued).toBeDefined();
    expect(queued?.kind).toBe('ran');
    expect(queued?.settled?.child_session_id).toBeNull();
    expect(queued?.settled?.reason).toBe('cancelled_before_dispatch');
    expect(queued?.settled?.cancel_source).toBe('model');
  });

  test('multiple refusal kinds in one snapshot are all discriminated by `kind` (review fix Q7)', async () => {
    // Three settled handles, each with a different refusal
    // kind. Without the `kind` discriminator (review fix Q3)
    // the model couldn't tell them apart from one another nor
    // from a settled `ran` envelope without round-tripping
    // through task_await.
    let n = 0;
    const refusals: SpawnSubagentResult[] = [
      {
        kind: 'unknown_subagent',
        requested: 'typo-1',
        available: ['explore'],
      },
      {
        kind: 'depth_exceeded',
        requested: 'explore',
        depth: 5,
        maxDepth: 4,
      },
      {
        kind: 'budget_exhausted',
        requested: 'explore',
        spent: 4.5,
        estimate: 1.0,
        projected: 5.5,
        cap: 5.0,
      },
    ];
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async () => {
        const r = refusals[n++];
        if (r === undefined) throw new Error('no more refusals');
        return r;
      },
    });
    const ctx = makeCtx({ subagentHandleStore: store });
    const handles = await Promise.all([
      Promise.resolve(store.spawn({ name: 'a', prompt: 'p' }, { estimateCostUsd: 0 })),
      Promise.resolve(store.spawn({ name: 'b', prompt: 'p' }, { estimateCostUsd: 0 })),
      Promise.resolve(store.spawn({ name: 'c', prompt: 'p' }, { estimateCostUsd: 0 })),
    ]);
    await Promise.all(handles.map((h) => store.awaitHandle(h.id)));
    const out = await taskListTool.execute({}, ctx);
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.handles).toHaveLength(3);
    const kinds = out.handles.map((h) => h.kind).sort();
    expect(kinds).toEqual(['budget_exhausted', 'depth_exceeded', 'unknown_subagent']);
    // None of the refusal entries carry a settled summary
    // block — that's the contract that distinguishes
    // refusal-without-output from a successful ran envelope.
    for (const h of out.handles) {
      expect(h.status).toBe('settled');
      expect(h.settled).toBeUndefined();
    }
  });
});
