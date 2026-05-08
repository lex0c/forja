import { describe, expect, test } from 'bun:test';
import { createSubagentHandleStore } from '../../src/subagents/handle-store.ts';
import { taskAsyncTool } from '../../src/tools/builtin/task-async.ts';
import { taskAwaitTool } from '../../src/tools/builtin/task-await.ts';
import { taskCancelTool } from '../../src/tools/builtin/task-cancel.ts';
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
  costUsd: 0,
  steps: 1,
  durationMs: 0,
});

describe('task_async / task_await / task_cancel tools', () => {
  test('async + await: round-trip returns the child envelope', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
    });
    const ctx = makeCtx({ subagentHandleStore: store });
    const spawnRes = await taskAsyncTool.execute(
      { subagent: 'explore', prompt: 'find auth files' },
      ctx,
    );
    if (isToolError(spawnRes)) throw new Error(`unexpected error: ${spawnRes.error_message}`);
    expect(spawnRes.name).toBe('explore');
    expect(typeof spawnRes.handle_id).toBe('string');
    expect(spawnRes.handle_id.length).toBeGreaterThan(0);

    const awaitRes = await taskAwaitTool.execute({ handle_id: spawnRes.handle_id }, ctx);
    if (isToolError(awaitRes)) throw new Error(`unexpected error: ${awaitRes.error_message}`);
    expect(awaitRes.status).toBe('done');
    expect(awaitRes.output).toContain('explore');
    expect(awaitRes.session_id).toBe('child-explore');
  });

  test('three async spawns then sequential awaits collect each in order', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        await sleep(10, signal);
        return okResult(args);
      },
    });
    const ctx = makeCtx({ subagentHandleStore: store });
    const handles: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      const r = await taskAsyncTool.execute({ subagent: name, prompt: 'p' }, ctx);
      if (isToolError(r)) throw new Error('spawn failed');
      handles.push(r.handle_id);
    }
    const outputs: string[] = [];
    for (const h of handles) {
      const r = await taskAwaitTool.execute({ handle_id: h }, ctx);
      if (isToolError(r)) throw new Error('await failed');
      outputs.push(r.output);
    }
    expect(outputs).toEqual(['done: a', 'done: b', 'done: c']);
  });

  test('task_cancel aborts a still-running spawn; task_await returns interrupted envelope as error', async () => {
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
            sessionId: 'child-cancelled',
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
    const ctx = makeCtx({ subagentHandleStore: store });
    const spawn = await taskAsyncTool.execute({ subagent: 'slow', prompt: 'p' }, ctx);
    if (isToolError(spawn)) throw new Error('spawn failed');
    await inFlight;
    const cancel = await taskCancelTool.execute({ handle_id: spawn.handle_id }, ctx);
    if (isToolError(cancel)) throw new Error('cancel failed');
    expect(cancel.cancelled).toBe(true);
    const awaitRes = await taskAwaitTool.execute({ handle_id: spawn.handle_id }, ctx);
    expect(isToolError(awaitRes)).toBe(true);
    if (!isToolError(awaitRes)) return;
    expect(awaitRes.error_code).toBe('subagent.run_failed');
    expect(awaitRes.details?.status).toBe('interrupted');
  });

  test('task_await appends `detail` to the run_failed error when the child forwarded one', async () => {
    // Symmetric with the same fix in `task.ts`: detail flows
    // through SpawnSubagentResult → settled handle → task_await
    // → tool error string. Without it, an async-spawned child
    // that hits a provider error surfaces as just
    // "providerError" with no actionable cause on the `└─`.
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async () => ({
        kind: 'ran',
        output: '',
        sessionId: 'child-1',
        status: 'error',
        reason: 'providerError',
        costUsd: 0,
        steps: 0,
        durationMs: 5,
        detail: 'AnthropicError 401 invalid x-api-key',
      }),
    });
    const ctx = makeCtx({ subagentHandleStore: store });
    const spawn = await taskAsyncTool.execute({ subagent: 'review', prompt: 'p' }, ctx);
    if (isToolError(spawn)) throw new Error('spawn failed');
    const awaitRes = await taskAwaitTool.execute({ handle_id: spawn.handle_id }, ctx);
    expect(isToolError(awaitRes)).toBe(true);
    if (!isToolError(awaitRes)) return;
    expect(awaitRes.error_code).toBe('subagent.run_failed');
    expect(awaitRes.error_message).toContain("reason='providerError'");
    expect(awaitRes.error_message).toContain('AnthropicError 401 invalid x-api-key');
    expect(awaitRes.error_message).toMatch(/reason='providerError': AnthropicError/);
  });

  test('task_cancel on unknown handle is idempotent (cancelled: false, reason)', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
    });
    const ctx = makeCtx({ subagentHandleStore: store });
    const r = await taskCancelTool.execute({ handle_id: 'nope' }, ctx);
    if (isToolError(r)) throw new Error('cancel should not be tool error');
    expect(r).toEqual({ cancelled: false, reason: 'unknown_handle' });
  });

  test('task_cancel on settled handle yields already_settled', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
    });
    const ctx = makeCtx({ subagentHandleStore: store });
    const spawn = await taskAsyncTool.execute({ subagent: 'fast', prompt: 'p' }, ctx);
    if (isToolError(spawn)) throw new Error('spawn failed');
    await taskAwaitTool.execute({ handle_id: spawn.handle_id }, ctx);
    const cancel = await taskCancelTool.execute({ handle_id: spawn.handle_id }, ctx);
    if (isToolError(cancel)) throw new Error('cancel should not be tool error');
    expect(cancel).toEqual({ cancelled: false, reason: 'already_settled' });
  });

  test('task_await timeout returns retryable tool error; later await without timeout succeeds', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        await sleep(80, signal);
        return okResult(args);
      },
    });
    const ctx = makeCtx({ subagentHandleStore: store });
    const spawn = await taskAsyncTool.execute({ subagent: 'slow', prompt: 'p' }, ctx);
    if (isToolError(spawn)) throw new Error('spawn failed');
    const r1 = await taskAwaitTool.execute({ handle_id: spawn.handle_id, timeout_ms: 20 }, ctx);
    expect(isToolError(r1)).toBe(true);
    if (!isToolError(r1)) return;
    expect(r1.error_code).toBe('subagent.await_timeout');
    expect(r1.retryable).toBe(true);
    const r2 = await taskAwaitTool.execute({ handle_id: spawn.handle_id }, ctx);
    if (isToolError(r2)) throw new Error('expected success on second await');
    expect(r2.status).toBe('done');
  });

  test('task_await on unknown handle returns unknown_handle error', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
    });
    const ctx = makeCtx({ subagentHandleStore: store });
    const r = await taskAwaitTool.execute({ handle_id: 'unknown' }, ctx);
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('subagent.unknown_handle');
  });

  test('all three tools surface subagent.unavailable when store is missing', async () => {
    const ctx = makeCtx({});
    const a = await taskAsyncTool.execute({ subagent: 'x', prompt: 'p' }, ctx);
    const b = await taskAwaitTool.execute({ handle_id: 'h' }, ctx);
    const c = await taskCancelTool.execute({ handle_id: 'h' }, ctx);
    for (const r of [a, b, c]) {
      expect(isToolError(r)).toBe(true);
      if (isToolError(r)) expect(r.error_code).toBe('subagent.unavailable');
    }
  });

  test('task_async surfaces store.spawn() throw as subagent.spawn_failed (no uncaught exception)', async () => {
    // Construct a store whose spawn() throws synchronously.
    // Production storage failure modes (FK violation, schema
    // CHECK constraint, corrupted DB) all surface as throws
    // from the persistTo INSERT. Without the wrap in
    // task_async.execute, that throw propagates through the
    // tool dispatch path as an uncaught exception.
    const throwingStore = {
      ...createSubagentHandleStore({
        cap: 3,
        spawnFn: async (args) => okResult(args),
      }),
      spawn: () => {
        throw new Error('FOREIGN KEY constraint failed');
      },
    };
    const ctx = makeCtx({ subagentHandleStore: throwingStore });
    const r = await taskAsyncTool.execute({ subagent: 'explore', prompt: 'p' }, ctx);
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('subagent.spawn_failed');
    expect(r.error_message).toContain('FOREIGN KEY constraint failed');
  });

  test('task_async refuses spawn when projected cost would exceed cap (D184 budget shared)', async () => {
    // Three concurrent task_async calls each estimating $2; cap
    // = $5. The third spawn must refuse: spent ($0 parent +
    // $0 settled + $4 reserved for two in-flight) + $2 estimate
    // = $6 > $5.
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args, signal) => {
        await sleep(50, signal);
        return okResult(args);
      },
    });
    const ctx = makeCtx({
      subagentHandleStore: store,
      getCostBudget: () => ({
        spent:
          0 + // priorCostUsd
          0 + // totalCostUsd
          store.getSettledChildCostUsd() +
          store.getReservedChildCostUsd(),
        cap: 5,
      }),
      getSubagentBudgetEstimate: () => 2,
    });
    const r1 = await taskAsyncTool.execute({ subagent: 'explore', prompt: 'p' }, ctx);
    const r2 = await taskAsyncTool.execute({ subagent: 'explore', prompt: 'q' }, ctx);
    const r3 = await taskAsyncTool.execute({ subagent: 'explore', prompt: 'r' }, ctx);
    expect(isToolError(r1)).toBe(false);
    expect(isToolError(r2)).toBe(false);
    expect(isToolError(r3)).toBe(true);
    if (!isToolError(r3)) return;
    expect(r3.error_code).toBe('subagent.budget_exhausted');
    expect(r3.details?.cap).toBe(5);
    // After the in-flight settle, the reservation drops and
    // the budget is freed up. Without that drop, repeated
    // resolution attempts would never recover.
    if (!isToolError(r1) && !isToolError(r2)) {
      await taskAwaitTool.execute({ handle_id: r1.handle_id }, ctx);
      await taskAwaitTool.execute({ handle_id: r2.handle_id }, ctx);
    }
    expect(store.getReservedChildCostUsd()).toBe(0);
  });

  test('task_async passes when no cap is configured', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
    });
    const ctx = makeCtx({
      subagentHandleStore: store,
      getCostBudget: () => ({ spent: 1_000_000, cap: undefined }),
      getSubagentBudgetEstimate: () => 1_000_000,
    });
    const r = await taskAsyncTool.execute({ subagent: 'explore', prompt: 'p' }, ctx);
    expect(isToolError(r)).toBe(false);
  });

  test('task_cancel immediately frees the cost reservation (review fix #4)', async () => {
    // Spawn with a $2 estimate, then cancel. The reservation
    // must drop to 0 BEFORE the spawn body's IIFE wakes (which
    // may be queued). Backs the hint string on
    // subagent.budget_exhausted that promises cancel frees the
    // reservation.
    const store = createSubagentHandleStore({
      cap: 1,
      spawnFn: async (args, signal) => {
        await sleep(200, signal);
        return okResult(args);
      },
    });
    const ctx = makeCtx({ subagentHandleStore: store });
    const r1 = await taskAsyncTool.execute({ subagent: 'explore', prompt: 'a' }, ctx);
    if (isToolError(r1)) throw new Error('first spawn should succeed');
    // Spawn a second handle that's queued behind the first
    // (cap=1). Use the explicit estimate path on the store
    // since we can't rely on the tool's estimate getter here.
    const h2 = store.spawn({ name: 'queued', prompt: 'b' }, { estimateCostUsd: 2 });
    expect(store.getReservedChildCostUsd()).toBeGreaterThanOrEqual(2);
    const cancelOutcome = store.cancel(h2.id, 'model');
    expect(cancelOutcome.cancelled).toBe(true);
    // Reservation drops IMMEDIATELY for the cancelled handle.
    // The spawn body for h2 is still queued (h1 is still
    // running), but the reservation is released regardless of
    // whether the IIFE has woken up.
    const reservedAfterCancel = store.getReservedChildCostUsd();
    // h1 may or may not have completed by now (depends on
    // whether its spawnFn settled). Lower bound: cancelling h2
    // dropped at least h2's full $2 reservation.
    expect(reservedAfterCancel).toBeLessThan(2);
    await store.awaitHandle(r1.handle_id);
    await store.awaitHandle(h2.id);
  });

  test('task_async refuses unknown subagent name BEFORE issuing handle (review fix)', async () => {
    // Pre-fix: estimate getter returned null on unknown name;
    // task_async coalesced to 0, called store.spawn, returned
    // a handle. The eventual task_await would fail with
    // unknown_subagent — but the model already burned a turn
    // and the store accumulated a phantom row. Sync `task`
    // fails fast; async should match.
    let dispatched = 0;
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => {
        dispatched += 1;
        return okResult(args);
      },
    });
    const ctx = makeCtx({
      subagentHandleStore: store,
      // Production wiring returns `null` from the estimate
      // getter when the name isn't in the registry.
      getSubagentBudgetEstimate: (name: string): number | null =>
        name === 'explore' || name === 'review' ? 0.5 : null,
      getKnownSubagentNames: (): string[] => ['explore', 'review'],
    });
    const r = await taskAsyncTool.execute({ subagent: 'explroe', prompt: 'p' }, ctx);
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('subagent.unknown');
    expect(r.error_message).toContain("'explroe'");
    expect(r.details?.available).toEqual(['explore', 'review']);
    // No handle issued, no dispatch attempted.
    expect(store.list()).toHaveLength(0);
    expect(dispatched).toBe(0);
  });

  test('task_async empty registry produces helpful hint', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
    });
    const ctx = makeCtx({
      subagentHandleStore: store,
      getSubagentBudgetEstimate: (): number | null => null,
      getKnownSubagentNames: (): string[] => [],
    });
    const r = await taskAsyncTool.execute({ subagent: 'anything', prompt: 'p' }, ctx);
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('subagent.unknown');
    expect(r.hint).toContain('No subagents are defined');
    expect(r.details?.available).toEqual([]);
  });

  test('task_async pre-checks subagent depth and refuses without spawning', async () => {
    // Importing MAX_SUBAGENT_DEPTH from runtime keeps the test
    // pinned to the runtime cap; if a future slice loosens or
    // tightens the gate the test fails loudly rather than
    // silently passing on a stale literal.
    const { MAX_SUBAGENT_DEPTH } = await import('../../src/subagents/runtime.ts');
    let dispatched = 0;
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => {
        dispatched += 1;
        return okResult(args);
      },
    });
    // ctx.subagentDepth = MAX_SUBAGENT_DEPTH means the next
    // `task_async` would land at MAX + 1 — must refuse.
    const ctx = makeCtx({
      subagentHandleStore: store,
      subagentDepth: MAX_SUBAGENT_DEPTH,
    });
    const r = await taskAsyncTool.execute({ subagent: 'explore', prompt: 'p' }, ctx);
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('subagent.depth_exceeded');
    expect(r.details?.depth).toBe(MAX_SUBAGENT_DEPTH + 1);
    // No spawn dispatched — the round trip the legacy `task`
    // tool saved is preserved.
    expect(dispatched).toBe(0);
    expect(store.list()).toHaveLength(0);
  });

  test('task_async rejects empty subagent name and oversized prompt', async () => {
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
    });
    const ctx = makeCtx({ subagentHandleStore: store });
    const r1 = await taskAsyncTool.execute({ subagent: '', prompt: 'p' }, ctx);
    expect(isToolError(r1)).toBe(true);
    const huge = 'x'.repeat(33 * 1024);
    const r2 = await taskAsyncTool.execute({ subagent: 'explore', prompt: huge }, ctx);
    expect(isToolError(r2)).toBe(true);
    if (!isToolError(r2)) return;
    expect(r2.error_code).toBe('tool.invalid_arg');
  });

  test('task_async records gate decisions for all three refusal kinds (audit fix #3)', async () => {
    // Each pre-flight refusal site (depth_exceeded,
    // unknown_subagent, budget_exhausted) must invoke the
    // recorder before returning the tool error. The recorder
    // is fail-soft in production; here we capture calls into
    // an array to verify shape + invocation count.
    type Decision = {
      decisionType: 'budget_exhausted' | 'unknown_subagent' | 'depth_exceeded';
      toolName: 'task' | 'task_sync' | 'task_async';
      requestedName: string;
      details: Record<string, unknown>;
    };
    const recorded: Decision[] = [];
    const store = createSubagentHandleStore({
      cap: 3,
      spawnFn: async (args) => okResult(args),
    });

    // Path 1: depth_exceeded (depth pre-check before name resolve).
    const ctxDepth = makeCtx({
      subagentHandleStore: store,
      subagentDepth: 4, // MAX_SUBAGENT_DEPTH = 4 so child = 5 trips
      recordGateDecision: (d) => recorded.push(d),
    });
    const rDepth = await taskAsyncTool.execute({ subagent: 'explore', prompt: 'p' }, ctxDepth);
    expect(isToolError(rDepth)).toBe(true);
    if (isToolError(rDepth)) expect(rDepth.error_code).toBe('subagent.depth_exceeded');

    // Path 2: unknown_subagent.
    const ctxUnknown = makeCtx({
      subagentHandleStore: store,
      getSubagentBudgetEstimate: () => null,
      getKnownSubagentNames: () => ['explore', 'review'],
      recordGateDecision: (d) => recorded.push(d),
    });
    const rUnknown = await taskAsyncTool.execute({ subagent: 'typo', prompt: 'p' }, ctxUnknown);
    expect(isToolError(rUnknown)).toBe(true);
    if (isToolError(rUnknown)) expect(rUnknown.error_code).toBe('subagent.unknown');

    // Path 3: budget_exhausted.
    const ctxBudget = makeCtx({
      subagentHandleStore: store,
      getCostBudget: () => ({ spent: 4.5, cap: 5.0 }),
      getSubagentBudgetEstimate: () => 1.0,
      recordGateDecision: (d) => recorded.push(d),
    });
    const rBudget = await taskAsyncTool.execute({ subagent: 'explore', prompt: 'p' }, ctxBudget);
    expect(isToolError(rBudget)).toBe(true);
    if (isToolError(rBudget)) expect(rBudget.error_code).toBe('subagent.budget_exhausted');

    // All three decisions captured with the right shape.
    expect(recorded).toHaveLength(3);
    expect(recorded[0]?.decisionType).toBe('depth_exceeded');
    expect(recorded[0]?.toolName).toBe('task_async');
    expect(recorded[0]?.requestedName).toBe('explore');
    expect(recorded[1]?.decisionType).toBe('unknown_subagent');
    expect(recorded[1]?.requestedName).toBe('typo');
    expect(recorded[1]?.details.available).toEqual(['explore', 'review']);
    expect(recorded[2]?.decisionType).toBe('budget_exhausted');
    expect(recorded[2]?.details.spent).toBe(4.5);
    expect(recorded[2]?.details.cap).toBe(5.0);
  });

  test('task_await records gate decisions when dispatcher revalidates and refuses (audit fix #3 review)', async () => {
    // Race scenario: pre-flight in task_async passed (the
    // model didn't see a refusal at spawn time), but the
    // dispatcher revalidated when the slot freed and refused
    // — the refusal kind reaches the model only when
    // `task_await` resolves the handle.
    //
    // Without this branch logging, the JSON-scan-based
    // forensic gap that migration 023 closes for the pre-
    // flight paths would still be open for dispatcher-revalid
    // refusals. Three sub-cases mirror the three refusal
    // kinds; each builds a store whose `spawnFn` returns the
    // refusal envelope (simulating the dispatcher's response).
    type Decision = {
      decisionType: 'budget_exhausted' | 'unknown_subagent' | 'depth_exceeded';
      toolName: 'task' | 'task_sync' | 'task_async';
      requestedName: string;
      details: Record<string, unknown>;
    };
    const buildStore = (refusal: SpawnSubagentResult) =>
      createSubagentHandleStore({
        cap: 3,
        spawnFn: async () => refusal,
      });

    // Path 1: budget_exhausted from dispatcher.
    const recorded1: Decision[] = [];
    const s1 = buildStore({
      kind: 'budget_exhausted',
      requested: 'explore',
      spent: 4.0,
      estimate: 1.5,
      projected: 5.5,
      cap: 5.0,
    });
    const ctx1 = makeCtx({
      subagentHandleStore: s1,
      recordGateDecision: (d) => recorded1.push(d),
    });
    const spawn1 = await taskAsyncTool.execute({ subagent: 'explore', prompt: 'p' }, ctx1);
    if (isToolError(spawn1)) throw new Error('spawn should succeed');
    const await1 = await taskAwaitTool.execute({ handle_id: spawn1.handle_id }, ctx1);
    expect(isToolError(await1)).toBe(true);
    if (isToolError(await1)) expect(await1.error_code).toBe('subagent.budget_exhausted');
    expect(recorded1).toHaveLength(1);
    expect(recorded1[0]).toMatchObject({
      decisionType: 'budget_exhausted',
      toolName: 'task_async',
      requestedName: 'explore',
    });

    // Path 2: unknown_subagent from dispatcher.
    const recorded2: Decision[] = [];
    const s2 = buildStore({
      kind: 'unknown_subagent',
      requested: 'mistyped',
      available: ['explore', 'review'],
    });
    const ctx2 = makeCtx({
      subagentHandleStore: s2,
      recordGateDecision: (d) => recorded2.push(d),
    });
    const spawn2 = await taskAsyncTool.execute({ subagent: 'mistyped', prompt: 'p' }, ctx2);
    if (isToolError(spawn2)) throw new Error('spawn should succeed');
    const await2 = await taskAwaitTool.execute({ handle_id: spawn2.handle_id }, ctx2);
    expect(isToolError(await2)).toBe(true);
    expect(recorded2).toHaveLength(1);
    expect(recorded2[0]?.decisionType).toBe('unknown_subagent');
    expect(recorded2[0]?.toolName).toBe('task_async');

    // Path 3: depth_exceeded from dispatcher.
    const recorded3: Decision[] = [];
    const s3 = buildStore({
      kind: 'depth_exceeded',
      requested: 'explore',
      depth: 5,
      maxDepth: 4,
    });
    const ctx3 = makeCtx({
      subagentHandleStore: s3,
      recordGateDecision: (d) => recorded3.push(d),
    });
    const spawn3 = await taskAsyncTool.execute({ subagent: 'explore', prompt: 'p' }, ctx3);
    if (isToolError(spawn3)) throw new Error('spawn should succeed');
    const await3 = await taskAwaitTool.execute({ handle_id: spawn3.handle_id }, ctx3);
    expect(isToolError(await3)).toBe(true);
    expect(recorded3).toHaveLength(1);
    expect(recorded3[0]?.decisionType).toBe('depth_exceeded');
    expect(recorded3[0]?.details).toEqual({ depth: 5, max_depth: 4 });
  });
});
