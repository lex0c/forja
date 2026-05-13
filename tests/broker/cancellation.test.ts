// Slice 83 — per-call cancellation across the broker surface.
// Pins signal propagation for each layer:
//   - in-process broker → exec callback receives signal
//   - spawn broker → worker process gets SIGTERM on abort
//   - bash handler → bash subprocess killed on abort
//   - end-to-end pipeline via real `bun run worker.ts`

import { describe, expect, test } from 'bun:test';
import {
  type BashSpawnFn,
  type BrokerRequest,
  createBashHandler,
  createInProcessBroker,
  createSpawnBroker,
} from '../../src/broker/index.ts';

const baseRequest = (overrides: Partial<BrokerRequest> = {}): BrokerRequest => ({
  toolName: 'bash',
  args: { command: 'true' },
  capabilities: [],
  sandboxProfile: null,
  ...overrides,
});

// ─── in-process broker propagation ────────────────────────────────────────

describe('createInProcessBroker — signal propagation', () => {
  // Slice 121 (R5 P0): the in-process broker now COMPOSES the
  // caller's signal with a master signal that close() aborts. So
  // exec no longer receives the caller's signal by identity — it
  // receives a linked signal that fires on first-to-abort (caller
  // OR broker close OR per-call timeoutMs). The contract pre-slice
  // 121 was "exec.signal IS callerSignal"; the post-slice contract
  // is "exec.signal MIRRORS callerSignal AND broker-shutdown".
  test('caller-signal abort during exec fires on the linked signal exec sees', async () => {
    // Slice 125 (R2 P1): linkSignals disposers run in the finally
    // block of `await myTurn`, BEFORE the broker.execute return.
    // So a post-return ac.abort() no longer propagates to the
    // linked signal exec stashed — that's the intentional leak
    // fix. The propagation contract is "during exec only": this
    // test pins the in-flight behavior by aborting WHILE exec is
    // mid-call.
    let observedAbortDuringExec = false;
    const broker = createInProcessBroker({
      exec: async (_req, callOptions) => {
        const sig = callOptions?.signal;
        sig?.addEventListener('abort', () => {
          observedAbortDuringExec = true;
        });
        // Stall until the linked signal aborts (or a 1s safety
        // timer fires, in which case the test fails the
        // expectation below).
        await new Promise<void>((resolve) => {
          if (sig?.aborted) {
            resolve();
            return;
          }
          sig?.addEventListener('abort', () => resolve(), { once: true });
          setTimeout(resolve, 1000);
        });
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const ac = new AbortController();
    const execPromise = broker.execute(baseRequest(), { signal: ac.signal });
    // Let exec start, then abort the caller.
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await execPromise;
    expect(observedAbortDuringExec).toBe(true);
    await broker.close();
  });

  test('omitted callOptions: exec still sees a defined signal (master only)', async () => {
    // Post-slice 121, the broker ALWAYS provides a signal to exec
    // — the master shutdown signal is composed in even when the
    // caller doesn't pass one. exec.signal is always usable for
    // "wait until abort" patterns.
    const captured: { signal: AbortSignal | undefined } = { signal: undefined };
    const broker = createInProcessBroker({
      exec: async (_req, callOptions) => {
        captured.signal = callOptions?.signal;
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
    });
    await broker.execute(baseRequest());
    expect(captured.signal).toBeDefined();
    expect(captured.signal?.aborted).toBe(false);
    // Now closing the broker should abort the signal exec saw.
    await broker.close();
    expect(captured.signal?.aborted).toBe(true);
  });
});

// ─── bash handler cancellation ────────────────────────────────────────────

describe('createBashHandler — cancellation', () => {
  test('pre-aborted signal: never spawns', async () => {
    let spawnCalls = 0;
    const spawn: BashSpawnFn = () => {
      spawnCalls++;
      throw new Error('should not spawn');
    };
    const handler = createBashHandler({ spawn });
    const ac = new AbortController();
    ac.abort();
    const r = await handler.execute(baseRequest({ args: { command: 'echo' } }), {
      signal: ac.signal,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('aborted');
    expect(spawnCalls).toBe(0);
  });

  test('mid-exec abort kills bash subprocess and returns aborted', async () => {
    const handler = createBashHandler({});
    const ac = new AbortController();
    const start = Date.now();
    setTimeout(() => ac.abort(), 30);
    const r = await handler.execute(baseRequest({ args: { command: 'sleep 5; echo nope' } }), {
      signal: ac.signal,
    });
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    expect(r.error).toBe('aborted');
    expect(elapsed).toBeLessThan(2000);
  });

  test('SIGTERM-trapping bash gets SIGKILL-escalated on abort', async () => {
    const handler = createBashHandler({ timeoutGraceMs: 100 });
    const ac = new AbortController();
    const start = Date.now();
    setTimeout(() => ac.abort(), 30);
    // bash traps TERM — must be SIGKILL'd
    const r = await handler.execute(
      baseRequest({ args: { command: 'trap "" TERM; while true; do sleep 0.1; done' } }),
      { signal: ac.signal },
    );
    const elapsed = Date.now() - start;
    expect(r.error).toBe('aborted');
    // Without SIGKILL escalation this would run forever (or timeout
    // at 30s default). Should die within abort + grace + slack.
    expect(elapsed).toBeLessThan(3000);
  });

  test('abort takes precedence over timeout when both fire', async () => {
    const handler = createBashHandler({ timeoutGraceMs: 100 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const r = await handler.execute(
      baseRequest({ args: { command: 'sleep 5', timeout_ms: 100 } }),
      { signal: ac.signal },
    );
    // Abort fired at 30ms; timeout at 100ms. The handler returns
    // 'aborted' because the abort took the kill path first.
    expect(r.error).toBe('aborted');
  });

  test('no signal: handler runs to completion as before', async () => {
    const handler = createBashHandler({});
    const r = await handler.execute(baseRequest({ args: { command: 'echo hi' } }));
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('hi\n');
  });
});

// ─── spawn broker cancellation ────────────────────────────────────────────

describe('createSpawnBroker — signal propagation', () => {
  test('pre-aborted signal: never spawns the worker', async () => {
    let spawnCalls = 0;
    const broker = createSpawnBroker({
      command: '/bin/false',
      spawn: () => {
        spawnCalls++;
        throw new Error('should not spawn');
      },
    });
    const ac = new AbortController();
    ac.abort();
    const r = await broker.execute(baseRequest(), { signal: ac.signal });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('aborted');
    expect(spawnCalls).toBe(0);
    await broker.close();
  });

  test('mid-exec abort sends SIGTERM to the worker and returns aborted', async () => {
    // Long-running worker that ignores stdin (sleeps so abort fires).
    // `exec sleep` replaces the shell with sleep so SIGTERM goes
    // directly to sleep (no orphaned child holding the stdout
    // pipe open). On shells like dash that don't propagate signals
    // to the process group, the orphan would block the broker's
    // drain pump until bun's test timeout.
    const broker = createSpawnBroker({
      command: '/bin/sh',
      args: ['-c', 'exec sleep 10'],
      timeoutMs: 30_000,
    });
    const ac = new AbortController();
    const start = Date.now();
    setTimeout(() => ac.abort(), 30);
    const r = await broker.execute(baseRequest(), { signal: ac.signal });
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    expect(r.error).toBe('aborted');
    // Worker killed quickly; well under the sleep duration.
    expect(elapsed).toBeLessThan(2000);
    await broker.close();
  });
});

// ─── end-to-end pipeline via real worker.ts ───────────────────────────────

describe('end-to-end cancellation: spawn broker → worker.ts → bash handler', () => {
  test('abort kills the bash subprocess inside the spawned worker', async () => {
    const broker = createSpawnBroker({
      command: process.execPath,
      args: ['run', 'src/broker/worker.ts'],
      timeoutMs: 30_000,
    });
    const ac = new AbortController();
    const start = Date.now();
    setTimeout(() => ac.abort(), 100);
    const r = await broker.execute(
      {
        toolName: 'bash',
        args: { command: 'sleep 10; echo nope' },
        capabilities: [],
        sandboxProfile: null,
      },
      { signal: ac.signal },
    );
    const elapsed = Date.now() - start;
    await broker.close();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('aborted');
    expect(elapsed).toBeLessThan(3000);
  });
});
