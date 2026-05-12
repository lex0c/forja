import { describe, expect, test } from 'bun:test';
import {
  type BrokerRequest,
  type BrokerResponse,
  createInProcessBroker,
} from '../../src/broker/index.ts';

const baseRequest = (overrides: Partial<BrokerRequest> = {}): BrokerRequest => ({
  toolName: 'bash',
  args: { command: 'ls' },
  capabilities: ['exec:shell'],
  sandboxProfile: 'cwd-rw',
  ...overrides,
});

const okResponse = (overrides: Partial<BrokerResponse> = {}): BrokerResponse => ({
  ok: true,
  stdout: 'hello\n',
  stderr: '',
  exitCode: 0,
  ...overrides,
});

describe('createInProcessBroker — execute', () => {
  test('delegates to the configured exec function and returns its response', async () => {
    const broker = createInProcessBroker({
      exec: async () => okResponse({ stdout: 'output' }),
    });
    const r = await broker.execute(baseRequest());
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('output');
    await broker.close();
  });

  test('forwards the request verbatim to exec', async () => {
    const captured: { value: BrokerRequest | null } = { value: null };
    const broker = createInProcessBroker({
      exec: async (request) => {
        captured.value = request;
        return okResponse();
      },
    });
    const req = baseRequest({
      toolName: 'read_file',
      args: { file_path: 'src/x.ts' },
      capabilities: ['read-fs:/work/src/x.ts'],
      sandboxProfile: 'ro',
      approvalId: 42,
    });
    await broker.execute(req);
    expect(captured.value).toEqual(req);
    await broker.close();
  });

  test('non-ok responses pass through unchanged', async () => {
    const broker = createInProcessBroker({
      exec: async () => ({
        ok: false,
        stdout: '',
        stderr: 'error from tool',
        exitCode: 1,
      }),
    });
    const r = await broker.execute(baseRequest());
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe('error from tool');
    await broker.close();
  });
});

describe('createInProcessBroker — error handling', () => {
  test('exec throwing is mapped to ok:false with "exec threw: ..." error', async () => {
    const broker = createInProcessBroker({
      exec: async () => {
        throw new Error('synthetic failure');
      },
    });
    const r = await broker.execute(baseRequest());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('exec threw: synthetic failure');
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBeUndefined();
    await broker.close();
  });

  test('non-Error throws (string, undefined) get mapped to their String() form', async () => {
    const broker = createInProcessBroker({
      exec: async () => {
        throw 'plain-string-error';
      },
    });
    const r = await broker.execute(baseRequest());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('exec threw: plain-string-error');
    await broker.close();
  });

  test('next call after a thrown exec still works (broker recovers)', async () => {
    let throwOnce = true;
    const broker = createInProcessBroker({
      exec: async () => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('first call fails');
        }
        return okResponse({ stdout: 'second-ok' });
      },
    });
    const r1 = await broker.execute(baseRequest());
    expect(r1.ok).toBe(false);
    const r2 = await broker.execute(baseRequest());
    expect(r2.ok).toBe(true);
    expect(r2.stdout).toBe('second-ok');
    await broker.close();
  });
});

describe('createInProcessBroker — FIFO serialization', () => {
  test('concurrent execute calls serialize (one in-flight at a time)', async () => {
    // Track concurrent in-flight count. If serialization works,
    // max concurrent = 1 even though 5 promises are awaiting.
    let inFlight = 0;
    let maxInFlight = 0;
    const broker = createInProcessBroker({
      exec: async (request) => {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        // Yield to event loop so OTHER calls have a chance to
        // interleave if serialization were broken.
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return okResponse({ stdout: String(request.approvalId) });
      },
    });
    const results = await Promise.all([
      broker.execute(baseRequest({ approvalId: 1 })),
      broker.execute(baseRequest({ approvalId: 2 })),
      broker.execute(baseRequest({ approvalId: 3 })),
      broker.execute(baseRequest({ approvalId: 4 })),
      broker.execute(baseRequest({ approvalId: 5 })),
    ]);
    expect(maxInFlight).toBe(1);
    // FIFO preserved.
    expect(results.map((r) => r.stdout)).toEqual(['1', '2', '3', '4', '5']);
    await broker.close();
  });

  test('throwing exec does NOT block subsequent calls', async () => {
    // Same shape as the recovery test, but explicitly verifies
    // queued calls drain after a thrown exec rather than getting
    // wedged.
    let callCount = 0;
    const broker = createInProcessBroker({
      exec: async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('call 2 fails');
        }
        return okResponse({ stdout: `call-${callCount}` });
      },
    });
    const [r1, r2, r3] = await Promise.all([
      broker.execute(baseRequest()),
      broker.execute(baseRequest()),
      broker.execute(baseRequest()),
    ]);
    expect(r1.ok).toBe(true);
    expect(r1.stdout).toBe('call-1');
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('call 2 fails');
    expect(r3.ok).toBe(true);
    expect(r3.stdout).toBe('call-3');
    await broker.close();
  });
});

describe('createInProcessBroker — close', () => {
  test('close awaits in-flight calls before resolving', async () => {
    let execComplete = false;
    const broker = createInProcessBroker({
      exec: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        execComplete = true;
        return okResponse();
      },
    });
    const execPromise = broker.execute(baseRequest());
    await broker.close();
    // close() resolved → exec must have completed.
    expect(execComplete).toBe(true);
    // The in-flight execute still resolves with its real response.
    const r = await execPromise;
    expect(r.ok).toBe(true);
  });

  test('subsequent execute after close returns broker-closed error', async () => {
    const broker = createInProcessBroker({
      exec: async () => okResponse(),
    });
    await broker.close();
    const r = await broker.execute(baseRequest());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('broker closed');
  });

  test('close is idempotent (multiple calls do not throw)', async () => {
    const broker = createInProcessBroker({
      exec: async () => okResponse(),
    });
    await expect(broker.close()).resolves.toBeUndefined();
    await expect(broker.close()).resolves.toBeUndefined();
    await expect(broker.close()).resolves.toBeUndefined();
  });
});

// Slice 121 — R5 hardenings (in-process broker contract).
describe('createInProcessBroker — exec snapshot (slice 121, R5 P0)', () => {
  test('post-construction mutation of options.exec does NOT swap behavior', async () => {
    // The caller-owned options reference stays in their scope.
    // If the broker held `options` instead of snapshotting `exec`,
    // a subsequent `options.exec = evil` could redirect every
    // future call. Snapshot at construction defends against this.
    const original = async (): Promise<BrokerResponse> => okResponse({ stdout: 'original' });
    const evil = async (): Promise<BrokerResponse> => okResponse({ stdout: 'evil' });
    const options = { exec: original };
    const broker = createInProcessBroker(options);
    // Mutate the caller's reference AFTER construction.
    options.exec = evil;
    const r = await broker.execute(baseRequest());
    expect(r.stdout).toBe('original');
    await broker.close();
  });
});

describe('createInProcessBroker — close aborts in-flight (slice 121, R5 P0)', () => {
  test('close() aborts the master signal so signal-honoring exec winds down', async () => {
    let observedSignal: AbortSignal | undefined;
    let aborted = false;
    const broker = createInProcessBroker({
      exec: async (_req, opts) => {
        observedSignal = opts?.signal;
        opts?.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        // Wait until aborted OR a hard timeout (test fails on hard timeout).
        await new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) {
            resolve();
            return;
          }
          opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
          setTimeout(resolve, 1000); // safety net
        });
        return okResponse({ stdout: aborted ? 'aborted' : 'natural' });
      },
    });
    const execPromise = broker.execute(baseRequest());
    // Let exec start.
    await new Promise((r) => setTimeout(r, 10));
    await broker.close();
    const r = await execPromise;
    expect(observedSignal).toBeDefined();
    expect(aborted).toBe(true);
    expect(r.stdout).toBe('aborted');
  });

  test('caller signal still composes with master (caller abort fires too)', async () => {
    let aborted = false;
    const broker = createInProcessBroker({
      exec: async (_req, opts) => {
        opts?.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        await new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) {
            resolve();
            return;
          }
          opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
          setTimeout(resolve, 1000);
        });
        return okResponse();
      },
    });
    const ctrl = new AbortController();
    const execPromise = broker.execute(baseRequest(), { signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    await execPromise;
    expect(aborted).toBe(true);
    await broker.close();
  });

  test('pre-aborted caller signal still surfaces to exec', async () => {
    // linkSignals fast-paths when one source is already aborted —
    // exec must still see an already-aborted signal.
    let seenAborted: boolean | undefined;
    const broker = createInProcessBroker({
      exec: async (_req, opts) => {
        seenAborted = opts?.signal?.aborted;
        return okResponse();
      },
    });
    const ctrl = new AbortController();
    ctrl.abort();
    await broker.execute(baseRequest(), { signal: ctrl.signal });
    expect(seenAborted).toBe(true);
    await broker.close();
  });
});

describe('createInProcessBroker — timeoutMs enforcement (slice 121, R5 P1)', () => {
  test('positive timeoutMs aborts the signal after the deadline', async () => {
    // Pre-slice the in-process broker passed timeoutMs to exec but
    // didn't enforce: an exec that ignores both signal and timeoutMs
    // would hang. Now the broker sets a setTimeout that aborts the
    // composed signal regardless of exec compliance.
    let aborted = false;
    const broker = createInProcessBroker({
      exec: async (_req, opts) => {
        opts?.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        await new Promise<void>((resolve) => {
          opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
          setTimeout(resolve, 1000); // safety net
        });
        return okResponse();
      },
    });
    const start = Date.now();
    await broker.execute(baseRequest(), { timeoutMs: 50 });
    const elapsed = Date.now() - start;
    expect(aborted).toBe(true);
    // Should fire near 50ms, well under the 1s safety net.
    expect(elapsed).toBeLessThan(500);
    await broker.close();
  });

  test('timeoutMs=0 disables the timer (per BrokerCallOptions docs)', async () => {
    let timedOut = false;
    const broker = createInProcessBroker({
      exec: async (_req, opts) => {
        opts?.signal?.addEventListener('abort', () => {
          timedOut = true;
        });
        await new Promise((r) => setTimeout(r, 30));
        return okResponse();
      },
    });
    await broker.execute(baseRequest(), { timeoutMs: 0 });
    expect(timedOut).toBe(false);
    await broker.close();
  });

  test('timeoutMs=undefined does not set a timer', async () => {
    let timedOut = false;
    const broker = createInProcessBroker({
      exec: async (_req, opts) => {
        opts?.signal?.addEventListener('abort', () => {
          timedOut = true;
        });
        await new Promise((r) => setTimeout(r, 20));
        return okResponse();
      },
    });
    await broker.execute(baseRequest());
    expect(timedOut).toBe(false);
    await broker.close();
  });

  test('NaN / Infinity timeoutMs are rejected without setting a timer', async () => {
    let timedOut = false;
    const broker = createInProcessBroker({
      exec: async (_req, opts) => {
        opts?.signal?.addEventListener('abort', () => {
          timedOut = true;
        });
        return okResponse();
      },
    });
    await broker.execute(baseRequest(), { timeoutMs: Number.NaN });
    await broker.execute(baseRequest(), { timeoutMs: Number.POSITIVE_INFINITY });
    await broker.execute(baseRequest(), { timeoutMs: -100 });
    expect(timedOut).toBe(false);
    await broker.close();
  });

  test('timeoutMs timer is cleared on natural completion (no late spurious abort)', async () => {
    // If the timer wasn't cleared, an exec that finishes fast would
    // still fire the timer after completion. The composed signal
    // would abort post-return, but the caller's signal listeners
    // would receive a phantom abort — unlikely to hurt anything
    // observable in this test, but a leak. Pin behavior by running
    // a quick exec with a long timeout and verifying no abort within
    // the timeout window.
    let aborted = false;
    const broker = createInProcessBroker({
      exec: async (_req, opts) => {
        opts?.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        return okResponse();
      },
    });
    await broker.execute(baseRequest(), { timeoutMs: 100 });
    // Wait past the 100ms window — if the timer wasn't cleared
    // it'd fire here.
    await new Promise((r) => setTimeout(r, 150));
    expect(aborted).toBe(false);
    await broker.close();
  });
});

describe('createInProcessBroker — error message safety (slice 121, R5 P1)', () => {
  test('exec throws an Error with a throwing .message getter → fallback message', async () => {
    class WeirdError extends Error {
      override get message(): string {
        throw new Error('getter throws');
      }
    }
    const broker = createInProcessBroker({
      exec: async () => {
        throw new WeirdError();
      },
    });
    const r = await broker.execute(baseRequest());
    // Must not propagate the secondary throw; must produce SOME
    // descriptive error string (the String() fallback covers it).
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(r.error?.length).toBeGreaterThan(0);
    await broker.close();
  });

  test('exec throws an object with throwing toString → still mapped safely', async () => {
    const evil = {
      toString(): string {
        throw new Error('toString throws');
      },
    };
    const broker = createInProcessBroker({
      exec: async () => {
        throw evil;
      },
    });
    const r = await broker.execute(baseRequest());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('<unrepresentable>');
    await broker.close();
  });
});

describe('createInProcessBroker — proto-pollution defense (slice 121, R5 P1)', () => {
  test('args with __proto__ key arrives at exec without it', async () => {
    let observed: Record<string, unknown> | undefined;
    const broker = createInProcessBroker({
      exec: async (req) => {
        observed = req.args;
        return okResponse();
      },
    });
    // Build args via JSON.parse so __proto__ is a real own key.
    const rawArgs = JSON.parse('{"__proto__":{"polluted":"yes"},"command":"ls"}');
    await broker.execute(baseRequest({ args: rawArgs }));
    expect(observed).toBeDefined();
    expect(Object.keys(observed ?? {})).not.toContain('__proto__');
    expect(observed?.command).toBe('ls');
    // Sanity: the global Object.prototype was NOT polluted by the
    // payload reaching the handler.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await broker.close();
  });

  test('args with nested __proto__ key is also scrubbed', async () => {
    let observed: Record<string, unknown> | undefined;
    const broker = createInProcessBroker({
      exec: async (req) => {
        observed = req.args;
        return okResponse();
      },
    });
    const rawArgs = JSON.parse('{"config":{"__proto__":{"x":1},"keep":"this"}}');
    await broker.execute(baseRequest({ args: rawArgs }));
    const config = observed?.config as Record<string, unknown> | undefined;
    expect(config).toBeDefined();
    expect(Object.keys(config ?? {})).not.toContain('__proto__');
    expect(config?.keep).toBe('this');
    await broker.close();
  });

  test('args without dangerous keys passes through by reference (no clone overhead)', async () => {
    // Common case: clean args. scrubProtoPollution should return
    // the SAME reference so the broker doesn't deep-clone on every
    // call.
    let observed: unknown;
    const broker = createInProcessBroker({
      exec: async (req) => {
        observed = req.args;
        return okResponse();
      },
    });
    const args = { command: 'ls', cwd: '/work' };
    await broker.execute(baseRequest({ args }));
    expect(observed).toBe(args); // strict reference equality
    await broker.close();
  });
});
