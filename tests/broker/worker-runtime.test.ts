import { describe, expect, test } from 'bun:test';
import {
  type BrokerRequest,
  type BrokerResponse,
  runWorker,
  type WorkerToolHandler,
} from '../../src/broker/index.ts';

const baseRequest = (overrides: Partial<BrokerRequest> = {}): BrokerRequest => ({
  toolName: '__echo__',
  args: { value: 'hi' },
  capabilities: ['read-fs:/work/src'],
  sandboxProfile: 'ro',
  ...overrides,
});

const okHandler = (name: string, response: Partial<BrokerResponse> = {}): WorkerToolHandler => ({
  name,
  execute: async () => ({
    ok: true,
    stdout: 'out',
    stderr: '',
    exitCode: 0,
    ...response,
  }),
});

const collectOutput = (): { out: string[]; sink: (line: string) => void } => {
  const out: string[] = [];
  return { out, sink: (line) => out.push(line) };
};

const parseResponse = (lines: readonly string[]): BrokerResponse => {
  expect(lines.length).toBe(1);
  const line = lines[0] as string;
  expect(line.endsWith('\n')).toBe(true);
  return JSON.parse(line.trim());
};

// ─── happy-path dispatch ──────────────────────────────────────────────────

describe('runWorker — dispatch', () => {
  test('drains input, looks up handler by name, emits handler response', async () => {
    const { out, sink } = collectOutput();
    await runWorker({
      handlers: [okHandler('__echo__', { stdout: 'echoed' })],
      input: () => Promise.resolve(`${JSON.stringify(baseRequest())}\n`),
      output: sink,
    });
    const r = parseResponse(out);
    expect(r).toEqual({ ok: true, stdout: 'echoed', stderr: '', exitCode: 0 });
  });

  test('forwards the parsed request verbatim to the handler', async () => {
    const captured: { request: BrokerRequest | null } = { request: null };
    const handler: WorkerToolHandler = {
      name: '__echo__',
      execute: async (req) => {
        captured.request = req;
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
    };
    const { out, sink } = collectOutput();
    const req = baseRequest({ approvalId: 42, args: { k: 'v', n: 1 } });
    await runWorker({
      handlers: [handler],
      input: () => Promise.resolve(`${JSON.stringify(req)}\n`),
      output: sink,
    });
    expect(captured.request).toEqual(req);
    expect(out.length).toBe(1);
  });

  test('dispatches by toolName when multiple handlers are registered', async () => {
    const { out, sink } = collectOutput();
    await runWorker({
      handlers: [
        okHandler('bash', { stdout: 'bash-output' }),
        okHandler('read_file', { stdout: 'read-output' }),
        okHandler('__echo__', { stdout: 'echo-output' }),
      ],
      input: () => Promise.resolve(`${JSON.stringify(baseRequest({ toolName: 'read_file' }))}\n`),
      output: sink,
    });
    const r = parseResponse(out);
    expect(r.stdout).toBe('read-output');
  });

  test('emits the handler response verbatim — does NOT re-validate response shape', async () => {
    const { out, sink } = collectOutput();
    // Handler returns a response missing required fields. The
    // runtime forwards it; broker side validates.
    const handler: WorkerToolHandler = {
      name: '__echo__',
      execute: async () => ({ ok: true }) as unknown as BrokerResponse,
    };
    await runWorker({
      handlers: [handler],
      input: () => Promise.resolve(`${JSON.stringify(baseRequest())}\n`),
      output: sink,
    });
    expect(out.length).toBe(1);
    const line = out[0] as string;
    expect(JSON.parse(line.trim())).toEqual({ ok: true });
  });
});

// ─── handler errors ───────────────────────────────────────────────────────

describe('runWorker — handler errors', () => {
  test('handler throwing Error → ok:false with worker-handler-threw prefix', async () => {
    const { out, sink } = collectOutput();
    const handler: WorkerToolHandler = {
      name: '__echo__',
      execute: async () => {
        throw new Error('boom');
      },
    };
    await runWorker({
      handlers: [handler],
      input: () => Promise.resolve(`${JSON.stringify(baseRequest())}\n`),
      output: sink,
    });
    const r = parseResponse(out);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('worker handler threw: boom');
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  test('handler throwing non-Error gets String()-ified', async () => {
    const { out, sink } = collectOutput();
    const handler: WorkerToolHandler = {
      name: '__echo__',
      execute: async () => {
        throw 'plain-string-error';
      },
    };
    await runWorker({
      handlers: [handler],
      input: () => Promise.resolve(`${JSON.stringify(baseRequest())}\n`),
      output: sink,
    });
    const r = parseResponse(out);
    expect(r.error).toBe('worker handler threw: plain-string-error');
  });
});

// ─── unknown handler / registry errors ────────────────────────────────────

describe('runWorker — handler registry', () => {
  test('unknown toolName → handler-not-found error with the name', async () => {
    const { out, sink } = collectOutput();
    await runWorker({
      handlers: [okHandler('bash')],
      input: () => Promise.resolve(`${JSON.stringify(baseRequest({ toolName: 'mystery' }))}\n`),
      output: sink,
    });
    const r = parseResponse(out);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('worker handler not found: mystery');
  });

  test('empty handler registry → handler-not-found error', async () => {
    const { out, sink } = collectOutput();
    await runWorker({
      handlers: [],
      input: () => Promise.resolve(`${JSON.stringify(baseRequest())}\n`),
      output: sink,
    });
    const r = parseResponse(out);
    expect(r.error).toBe('worker handler not found: __echo__');
  });

  test('duplicate handler names → registration error, input is NOT read', async () => {
    const { out, sink } = collectOutput();
    let inputCalls = 0;
    await runWorker({
      handlers: [okHandler('bash'), okHandler('bash')],
      input: async () => {
        inputCalls++;
        return JSON.stringify(baseRequest());
      },
      output: sink,
    });
    const r = parseResponse(out);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('worker handler duplicate: bash');
    expect(inputCalls).toBe(0);
  });
});

// ─── input parse failures ─────────────────────────────────────────────────

describe('runWorker — input parse failures', () => {
  test('empty input → empty-input error', async () => {
    const { out, sink } = collectOutput();
    await runWorker({
      handlers: [okHandler('__echo__')],
      input: () => Promise.resolve(''),
      output: sink,
    });
    expect(parseResponse(out).error).toBe('worker received empty input');
  });

  test('whitespace-only input → empty-input error', async () => {
    const { out, sink } = collectOutput();
    await runWorker({
      handlers: [okHandler('__echo__')],
      input: () => Promise.resolve('   \n\t  \n'),
      output: sink,
    });
    expect(parseResponse(out).error).toBe('worker received empty input');
  });

  test('invalid JSON → parse-failed error', async () => {
    const { out, sink } = collectOutput();
    await runWorker({
      handlers: [okHandler('__echo__')],
      input: () => Promise.resolve('not json at all\n'),
      output: sink,
    });
    const r = parseResponse(out);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('worker request parse failed:');
  });

  test('valid JSON missing required fields → missing-fields error', async () => {
    const { out, sink } = collectOutput();
    await runWorker({
      handlers: [okHandler('__echo__')],
      input: () => Promise.resolve(`${JSON.stringify({ toolName: 'bash' })}\n`),
      output: sink,
    });
    expect(parseResponse(out).error).toBe('worker request missing required fields');
  });

  test('JSON with non-string capability element → missing-fields error', async () => {
    const { out, sink } = collectOutput();
    const malformed = { ...baseRequest(), capabilities: ['ok', 42] };
    await runWorker({
      handlers: [okHandler('__echo__')],
      input: () => Promise.resolve(`${JSON.stringify(malformed)}\n`),
      output: sink,
    });
    expect(parseResponse(out).error).toBe('worker request missing required fields');
  });

  test('JSON with wrong sandboxProfile type (number) → missing-fields error', async () => {
    const { out, sink } = collectOutput();
    const malformed = { ...baseRequest(), sandboxProfile: 42 };
    await runWorker({
      handlers: [okHandler('__echo__')],
      input: () => Promise.resolve(`${JSON.stringify(malformed)}\n`),
      output: sink,
    });
    expect(parseResponse(out).error).toBe('worker request missing required fields');
  });

  test('JSON with sandboxProfile: null is accepted (legacy / host)', async () => {
    const { out, sink } = collectOutput();
    await runWorker({
      handlers: [okHandler('__echo__', { stdout: 'ran' })],
      input: () => Promise.resolve(`${JSON.stringify(baseRequest({ sandboxProfile: null }))}\n`),
      output: sink,
    });
    expect(parseResponse(out)).toEqual({
      ok: true,
      stdout: 'ran',
      stderr: '',
      exitCode: 0,
    });
  });

  // Slice 103 (R6 #9): pre-slice the validator only checked
  // typeof === 'string' — any string passed. An attacker
  // crafting a request with `sandboxProfile: 'attacker'` could
  // pivot through the runner's platform fallback. The runtime
  // now validates against the SandboxProfile enum.
  test('JSON with unknown sandboxProfile string → missing-fields error', async () => {
    const { out, sink } = collectOutput();
    const malformed = { ...baseRequest(), sandboxProfile: 'attacker' };
    await runWorker({
      handlers: [okHandler('__echo__')],
      input: () => Promise.resolve(`${JSON.stringify(malformed)}\n`),
      output: sink,
    });
    expect(parseResponse(out).error).toBe('worker request missing required fields');
  });

  test('every valid SandboxProfile enum member is accepted', async () => {
    for (const profile of ['ro', 'cwd-rw', 'cwd-rw-net', 'home-rw', 'host']) {
      const { out, sink } = collectOutput();
      await runWorker({
        handlers: [okHandler('__echo__', { stdout: profile })],
        input: () =>
          Promise.resolve(`${JSON.stringify(baseRequest({ sandboxProfile: profile }))}\n`),
        output: sink,
      });
      const res = parseResponse(out);
      expect(res.ok).toBe(true);
      expect(res.stdout).toBe(profile);
    }
  });

  // Slice 104 (R6 #42): request line with proto-pollution payload
  // gets the dangerous keys stripped via the reviver before
  // isBrokerRequest validation runs. The remaining fields pass
  // validation and the handler dispatches normally — no
  // `__proto__` slips through to corrupt the global prototype
  // chain via downstream spread/merge.
  test('JSON with __proto__ key gets stripped before handler dispatch (proto-pollution defense)', async () => {
    const { out, sink } = collectOutput();
    // Inline raw JSON so we can include __proto__ verbatim; the
    // base request helper would normalize the shape.
    const raw =
      '{"toolName":"__echo__","args":{"__proto__":{"polluted":true},"real":"value"},"capabilities":[],"sandboxProfile":null}\n';
    await runWorker({
      handlers: [okHandler('__echo__', { stdout: 'received' })],
      input: () => Promise.resolve(raw),
      output: sink,
    });
    const res = parseResponse(out);
    expect(res.ok).toBe(true);
    // Sanity: the global Object prototype was NOT polluted.
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  test('trailing whitespace + newlines on input get trimmed before parse', async () => {
    const { out, sink } = collectOutput();
    await runWorker({
      handlers: [okHandler('__echo__', { stdout: 'ok' })],
      input: () => Promise.resolve(`\n\n  ${JSON.stringify(baseRequest())}  \n\n`),
      output: sink,
    });
    expect(parseResponse(out).stdout).toBe('ok');
  });
});

// ─── input read failures ──────────────────────────────────────────────────

describe('runWorker — input read failures', () => {
  test('input function throwing Error → input-read-failed response', async () => {
    const { out, sink } = collectOutput();
    await runWorker({
      handlers: [okHandler('__echo__')],
      input: async () => {
        throw new Error('stdin closed');
      },
      output: sink,
    });
    const r = parseResponse(out);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('worker input read failed: stdin closed');
  });

  test('input function throwing non-Error gets String()-ified', async () => {
    const { out, sink } = collectOutput();
    await runWorker({
      handlers: [okHandler('__echo__')],
      input: async () => {
        throw 42;
      },
      output: sink,
    });
    expect(parseResponse(out).error).toBe('worker input read failed: 42');
  });
});

// ─── statelessness ────────────────────────────────────────────────────────

describe('runWorker — statelessness', () => {
  test('two sequential invocations work independently', async () => {
    const { out: out1, sink: sink1 } = collectOutput();
    await runWorker({
      handlers: [okHandler('__echo__', { stdout: 'first' })],
      input: () => Promise.resolve(`${JSON.stringify(baseRequest())}\n`),
      output: sink1,
    });
    const { out: out2, sink: sink2 } = collectOutput();
    await runWorker({
      handlers: [okHandler('bash', { stdout: 'second' })],
      input: () => Promise.resolve(`${JSON.stringify(baseRequest({ toolName: 'bash' }))}\n`),
      output: sink2,
    });
    expect(parseResponse(out1).stdout).toBe('first');
    expect(parseResponse(out2).stdout).toBe('second');
  });

  test('emits exactly one output line per invocation', async () => {
    const { out, sink } = collectOutput();
    await runWorker({
      handlers: [okHandler('__echo__')],
      input: () => Promise.resolve(`${JSON.stringify(baseRequest())}\n`),
      output: sink,
    });
    expect(out.length).toBe(1);
  });

  test('emits exactly one output line even on every error path', async () => {
    for (const scenario of [
      { input: () => Promise.resolve(''), label: 'empty' },
      { input: () => Promise.resolve('not json'), label: 'invalid-json' },
      { input: () => Promise.resolve('{}'), label: 'missing-fields' },
      {
        input: async () => {
          throw new Error('x');
        },
        label: 'input-throw',
      },
    ]) {
      const { out, sink } = collectOutput();
      await runWorker({
        handlers: [okHandler('__echo__')],
        input: scenario.input,
        output: sink,
      });
      expect(out.length).toBe(1);
    }
  });
});

// ─── integration: spawn broker → real worker.ts subprocess ────────────────

describe('runWorker — production worker.ts integration via spawn broker', () => {
  // These tests spawn the actual `src/broker/worker.ts` entry as
  // a subprocess via the spawn broker. They validate the full
  // pipe: spawn broker → bun → worker.ts → runWorker → __echo__
  // handler → response → broker parse. If any seam between the
  // pieces is wrong, these tests fail; the unit tests above
  // wouldn't catch (e.g.) a `Bun.stdin.stream()` consumer that
  // doesn't drain correctly.
  //
  // Imported lazily so unit-only test runs don't load the broker.
  test('echo handler roundtrips toolName + args through full pipeline', async () => {
    const { createSpawnBroker } = await import('../../src/broker/index.ts');
    const broker = createSpawnBroker({
      command: process.execPath,
      args: ['run', 'src/broker/worker.ts'],
      timeoutMs: 10_000,
    });
    const r = await broker.execute(
      baseRequest({ toolName: '__echo__', args: { hello: 'world', n: 7 } }),
    );
    await broker.close();
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.toolName).toBe('__echo__');
    expect(payload.args).toEqual({ hello: 'world', n: 7 });
  });

  test('unknown tool through pipeline reports handler-not-found', async () => {
    const { createSpawnBroker } = await import('../../src/broker/index.ts');
    const broker = createSpawnBroker({
      command: process.execPath,
      args: ['run', 'src/broker/worker.ts'],
      timeoutMs: 10_000,
    });
    const r = await broker.execute(baseRequest({ toolName: 'nonexistent_tool' }));
    await broker.close();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('worker handler not found: nonexistent_tool');
  });
});
