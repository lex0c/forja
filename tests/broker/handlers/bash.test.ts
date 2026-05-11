import { describe, expect, test } from 'bun:test';
import {
  type BashSpawnFn,
  type BashSpawnFnOptions,
  type BashSpawnedProcess,
  type BrokerRequest,
  createBashHandler,
} from '../../../src/broker/index.ts';

const baseRequest = (overrides: Partial<BrokerRequest> = {}): BrokerRequest => ({
  toolName: 'bash',
  args: { command: 'echo hi' },
  capabilities: ['exec:shell'],
  sandboxProfile: 'cwd-rw',
  ...overrides,
});

// ─── mock spawn helpers ────────────────────────────────────────────────────

const streamFrom = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      if (text.length > 0) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

interface MockProcOpts {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  // When set, exited resolves only after the returned promise resolves.
  delay?: () => Promise<void>;
  onKill?: (signal: number | string | undefined) => void;
}

const makeMockProc = (opts: MockProcOpts = {}): BashSpawnedProcess => {
  let killed = false;
  let killSignal: number | string | undefined;
  const exitedFn = async (): Promise<number> => {
    if (opts.delay !== undefined) await opts.delay();
    if (killed) return killSignal === 'SIGKILL' ? 137 : 143;
    return opts.exitCode ?? 0;
  };
  return {
    stdout: streamFrom(opts.stdout ?? ''),
    stderr: streamFrom(opts.stderr ?? ''),
    exited: exitedFn(),
    kill: (signal) => {
      killed = true;
      killSignal = signal;
      opts.onKill?.(signal);
    },
  };
};

// ─── happy-path tests (real Bun.spawn — fast bash commands) ───────────────

describe('createBashHandler — real bash subprocess', () => {
  test('runs a simple echo, returns stdout + exitCode 0 + ok:true', async () => {
    const handler = createBashHandler({});
    const r = await handler.execute(baseRequest({ args: { command: 'echo hello' } }));
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('hello\n');
    expect(r.stderr).toBe('');
    expect(r.error).toBeUndefined();
  });

  test('non-zero exit: ok:false, exitCode set, but no error (command ran)', async () => {
    const handler = createBashHandler({});
    const r = await handler.execute(baseRequest({ args: { command: 'exit 7' } }));
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(7);
    expect(r.error).toBeUndefined();
  });

  test('captures stderr separately from stdout', async () => {
    const handler = createBashHandler({});
    const r = await handler.execute(
      baseRequest({ args: { command: 'echo on-out; echo on-err >&2' } }),
    );
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('on-out\n');
    expect(r.stderr).toBe('on-err\n');
  });

  test('cwd: absolute path takes effect', async () => {
    const handler = createBashHandler({ baseCwd: '/' });
    const r = await handler.execute(baseRequest({ args: { command: 'pwd', cwd: '/tmp' } }));
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe('/tmp');
  });

  test('cwd: relative path resolved against baseCwd', async () => {
    const handler = createBashHandler({ baseCwd: '/tmp' });
    const r = await handler.execute(baseRequest({ args: { command: 'pwd', cwd: '.' } }));
    expect(r.stdout.trim()).toBe('/tmp');
  });

  test('cwd: omitted uses baseCwd', async () => {
    const handler = createBashHandler({ baseCwd: '/tmp' });
    const r = await handler.execute(baseRequest({ args: { command: 'pwd' } }));
    expect(r.stdout.trim()).toBe('/tmp');
  });
});

// ─── argument validation ───────────────────────────────────────────────────

describe('createBashHandler — argument validation', () => {
  test('missing args.command → error response', async () => {
    const handler = createBashHandler({});
    const r = await handler.execute(baseRequest({ args: {} }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bash handler: args.command must be a non-empty string');
    expect(r.exitCode).toBeUndefined();
  });

  test('args.command not a string → error response', async () => {
    const handler = createBashHandler({});
    const r = await handler.execute(baseRequest({ args: { command: 42 as unknown as string } }));
    expect(r.error).toBe('bash handler: args.command must be a non-empty string');
  });

  test('args.command empty string → error response', async () => {
    const handler = createBashHandler({});
    const r = await handler.execute(baseRequest({ args: { command: '' } }));
    expect(r.error).toBe('bash handler: args.command must be a non-empty string');
  });

  test('args.timeout_ms not a number → error response', async () => {
    const handler = createBashHandler({});
    const r = await handler.execute(
      baseRequest({ args: { command: 'echo', timeout_ms: 'long' as unknown as number } }),
    );
    expect(r.error).toBe('bash handler: timeout_ms must be an integer >= 100');
  });

  test('args.timeout_ms non-integer → error response', async () => {
    const handler = createBashHandler({});
    const r = await handler.execute(baseRequest({ args: { command: 'echo', timeout_ms: 150.5 } }));
    expect(r.error).toBe('bash handler: timeout_ms must be an integer >= 100');
  });

  test('args.timeout_ms below 100 → error response', async () => {
    const handler = createBashHandler({});
    const r = await handler.execute(baseRequest({ args: { command: 'echo', timeout_ms: 99 } }));
    expect(r.error).toBe('bash handler: timeout_ms must be an integer >= 100');
  });

  test('args.timeout_ms NaN → error response', async () => {
    const handler = createBashHandler({});
    const r = await handler.execute(
      baseRequest({ args: { command: 'echo', timeout_ms: Number.NaN } }),
    );
    expect(r.error).toBe('bash handler: timeout_ms must be an integer >= 100');
  });

  test('args.cwd not a string → error response', async () => {
    const handler = createBashHandler({});
    const r = await handler.execute(
      baseRequest({ args: { command: 'echo', cwd: 42 as unknown as string } }),
    );
    expect(r.error).toBe('bash handler: args.cwd must be a string');
  });
});

// ─── spawn failures ────────────────────────────────────────────────────────

describe('createBashHandler — spawn failure mapping', () => {
  test('spawn throwing → error response with bash-handler prefix', async () => {
    const spawn: BashSpawnFn = () => {
      throw new Error('ENOENT bash');
    };
    const handler = createBashHandler({ spawn });
    const r = await handler.execute(baseRequest());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bash handler: failed to spawn bash: ENOENT bash');
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  test('spawn throwing non-Error gets String()-ified', async () => {
    const spawn: BashSpawnFn = () => {
      throw 'plain';
    };
    const handler = createBashHandler({ spawn });
    const r = await handler.execute(baseRequest());
    expect(r.error).toBe('bash handler: failed to spawn bash: plain');
  });
});

// ─── argv shape forwarded to spawn ─────────────────────────────────────────

describe('createBashHandler — spawn invocation shape', () => {
  test('forwards argv as ["bash", "-c", command]', async () => {
    const captured: { argv: readonly string[] | null } = { argv: null };
    const spawn: BashSpawnFn = (argv) => {
      captured.argv = argv;
      return makeMockProc();
    };
    const handler = createBashHandler({ spawn });
    await handler.execute(baseRequest({ args: { command: 'ls -la' } }));
    expect(captured.argv).toEqual(['bash', '-c', 'ls -la']);
  });

  test('forwards cwd + scrubbed env to spawn options', async () => {
    const captured: { opts: BashSpawnFnOptions | null } = { opts: null };
    const spawn: BashSpawnFn = (_argv, opts) => {
      captured.opts = opts;
      return makeMockProc();
    };
    const scrubEnv = (): Record<string, string> => ({ SAFE: 'value' });
    const handler = createBashHandler({ spawn, scrubEnv, baseCwd: '/work/proj' });
    await handler.execute(baseRequest({ args: { command: 'echo' } }));
    expect(captured.opts).toEqual({ cwd: '/work/proj', env: { SAFE: 'value' } });
  });

  test('scrubEnv receives process.env', async () => {
    const captured: { env: NodeJS.ProcessEnv | null } = { env: null };
    const scrubEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
      captured.env = env;
      return {};
    };
    const handler = createBashHandler({
      spawn: () => makeMockProc(),
      scrubEnv,
    });
    await handler.execute(baseRequest());
    expect(captured.env).toBe(process.env);
  });
});

// ─── timeout handling ──────────────────────────────────────────────────────

describe('createBashHandler — timeout', () => {
  test('command exceeding timeout_ms returns timeout error + SIGTERM is sent', async () => {
    let sigtermSent = false;
    const spawn: BashSpawnFn = () =>
      makeMockProc({
        delay: () =>
          // Resolve exited only after we get SIGKILL or 1s passes.
          new Promise((resolve) => {
            setTimeout(resolve, 500);
          }),
        onKill: (signal) => {
          if (signal === 'SIGTERM') sigtermSent = true;
        },
      });
    const handler = createBashHandler({ spawn, timeoutGraceMs: 10 });
    const r = await handler.execute(
      baseRequest({ args: { command: 'sleep 60', timeout_ms: 100 } }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bash handler: timed out after 100ms');
    expect(sigtermSent).toBe(true);
  });

  test('SIGTERM escalates to SIGKILL after grace window when child ignores SIGTERM', async () => {
    const signalsReceived: (number | string | undefined)[] = [];
    const spawn: BashSpawnFn = () =>
      makeMockProc({
        delay: () =>
          new Promise((resolve) => {
            // Wait long enough that BOTH SIGTERM + SIGKILL must fire.
            setTimeout(resolve, 200);
          }),
        onKill: (signal) => {
          signalsReceived.push(signal);
        },
      });
    const handler = createBashHandler({ spawn, timeoutGraceMs: 20 });
    await handler.execute(
      baseRequest({ args: { command: 'trap "" TERM; sleep 60', timeout_ms: 100 } }),
    );
    expect(signalsReceived).toContain('SIGTERM');
    expect(signalsReceived).toContain('SIGKILL');
  });

  test('timeout_ms above MAX_TIMEOUT_MS caps to MAX', async () => {
    // We don't have an easy way to assert the inner Math.min without
    // hooking setTimeout, but we can at least verify the handler
    // accepts a huge timeout_ms without erroring on the validation.
    const handler = createBashHandler({ spawn: () => makeMockProc({ stdout: 'ok\n' }) });
    const r = await handler.execute(
      baseRequest({ args: { command: 'echo', timeout_ms: 999_999_999 } }),
    );
    expect(r.ok).toBe(true);
  });
});

// ─── output capping ────────────────────────────────────────────────────────

describe('createBashHandler — output capping', () => {
  test('stdout exceeding maxOutputBytes gets the truncation footer', async () => {
    const handler = createBashHandler({
      spawn: () => makeMockProc({ stdout: 'AAAAAAAAAAAAAAAAAAAA' }),
      maxOutputBytes: 5,
    });
    const r = await handler.execute(baseRequest());
    expect(r.stdout).toBe('AAAAA\n[... truncated; 15 bytes omitted]');
  });

  test('stderr exceeding maxOutputBytes gets the truncation footer', async () => {
    const handler = createBashHandler({
      spawn: () => makeMockProc({ stderr: 'BBBBBBBBBBBB' }),
      maxOutputBytes: 4,
    });
    const r = await handler.execute(baseRequest());
    expect(r.stderr).toBe('BBBB\n[... truncated; 8 bytes omitted]');
  });

  test('output below cap has no footer', async () => {
    const handler = createBashHandler({
      spawn: () => makeMockProc({ stdout: 'short\n' }),
      maxOutputBytes: 1024,
    });
    const r = await handler.execute(baseRequest());
    expect(r.stdout).toBe('short\n');
  });
});

// ─── option defaults ───────────────────────────────────────────────────────

describe('createBashHandler — defaults', () => {
  test('empty options object: default baseCwd is process.cwd()', async () => {
    const captured: { opts: BashSpawnFnOptions | null } = { opts: null };
    const handler = createBashHandler({
      spawn: (_a, opts) => {
        captured.opts = opts;
        return makeMockProc();
      },
    });
    await handler.execute(baseRequest({ args: { command: 'echo' } }));
    expect(captured.opts?.cwd).toBe(process.cwd());
  });

  test('default scrubEnv is identity (string-valued entries only)', async () => {
    const captured: { opts: BashSpawnFnOptions | null } = { opts: null };
    const handler = createBashHandler({
      spawn: (_a, opts) => {
        captured.opts = opts;
        return makeMockProc();
      },
    });
    await handler.execute(baseRequest());
    // Without a custom scrubEnv, all string-valued process.env keys
    // should land in the env. We can't assert exact equality (env is
    // volatile), but PATH is almost always present.
    expect(typeof captured.opts?.env.PATH).toBe('string');
  });
});

// ─── integration: spawn broker → worker.ts → bash handler ─────────────────

describe('createBashHandler — production worker integration via spawn broker', () => {
  test('roundtrips a real bash command through the full broker → worker pipe', async () => {
    const { createSpawnBroker } = await import('../../../src/broker/index.ts');
    const broker = createSpawnBroker({
      command: process.execPath,
      args: ['run', 'src/broker/worker.ts'],
      timeoutMs: 30_000,
    });
    const r = await broker.execute({
      toolName: 'bash',
      args: { command: 'echo from-worker' },
      capabilities: ['exec:shell'],
      sandboxProfile: null,
    });
    await broker.close();
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('from-worker\n');
  });

  test('non-zero exit code via the full pipe still produces ok:false', async () => {
    const { createSpawnBroker } = await import('../../../src/broker/index.ts');
    const broker = createSpawnBroker({
      command: process.execPath,
      args: ['run', 'src/broker/worker.ts'],
      timeoutMs: 30_000,
    });
    const r = await broker.execute({
      toolName: 'bash',
      args: { command: 'exit 3' },
      capabilities: ['exec:shell'],
      sandboxProfile: null,
    });
    await broker.close();
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.error).toBeUndefined();
  });

  test('argument validation error surfaces through the full pipe', async () => {
    const { createSpawnBroker } = await import('../../../src/broker/index.ts');
    const broker = createSpawnBroker({
      command: process.execPath,
      args: ['run', 'src/broker/worker.ts'],
      timeoutMs: 30_000,
    });
    const r = await broker.execute({
      toolName: 'bash',
      args: { command: 'echo', timeout_ms: 50 },
      capabilities: ['exec:shell'],
      sandboxProfile: null,
    });
    await broker.close();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bash handler: timeout_ms must be an integer >= 100');
  });
});
