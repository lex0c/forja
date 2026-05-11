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
