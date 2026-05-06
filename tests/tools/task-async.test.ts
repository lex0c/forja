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
});
