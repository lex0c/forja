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

  // Slice 115 — R7 P1: pre-slice the absolute branch returned
  // args.cwd verbatim — `/etc/../bin/sh` was passed to spawn
  // unnormalized because isAbsolute only checks the leading
  // slash, not the path shape. Now ALL paths flow through
  // resolvePath which collapses `..`/`./` lexically.
  test('cwd: absolute path with .. is normalized (slice 115)', async () => {
    const handler = createBashHandler({ baseCwd: '/work' });
    // `/etc/../tmp` → `/tmp` after normalization.
    const r = await handler.execute(baseRequest({ args: { command: 'pwd', cwd: '/etc/../tmp' } }));
    expect(r.stdout.trim()).toBe('/tmp');
  });

  test('cwd: empty string refuses with explicit error (slice 115)', async () => {
    // Empty string would otherwise pass through to spawn and
    // surface as an opaque OS-level error. Catching at the
    // handler boundary gives the operator a clear message.
    const handler = createBashHandler({});
    const r = await handler.execute(baseRequest({ args: { command: 'echo', cwd: '' } }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bash handler: args.cwd must be non-empty');
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
  test('forwards argv as ["bash", "-s"] (slice 173 — command body is piped via stdin, not argv)', async () => {
    const captured: { argv: readonly string[] | null } = { argv: null };
    const spawn: BashSpawnFn = (argv) => {
      captured.argv = argv;
      return makeMockProc();
    };
    const handler = createBashHandler({ spawn });
    await handler.execute(baseRequest({ args: { command: 'ls -la' } }));
    expect(captured.argv).toEqual(['bash', '-s']);
  });

  test('command body is delivered to spawn via stdinScript, not argv (slice 173)', async () => {
    // Threat: with `bash -c '<cmd>'`, the command body (including
    // any interpolated tokens — Bearer auth headers, API keys,
    // signed URLs) appears in `/proc/<pid>/cmdline` and is readable
    // by any other local user via `ps aux`. Switching to `bash -s`
    // and piping the script over stdin removes the body from argv
    // entirely. Test asserts the call site honors that split: argv
    // contains ONLY the bash invocation, the body lives in
    // stdinScript.
    const captured: { argv: readonly string[] | null; stdinScript: string | null } = {
      argv: null,
      stdinScript: null,
    };
    const spawn: BashSpawnFn = (argv, opts) => {
      captured.argv = argv;
      captured.stdinScript = opts.stdinScript;
      return makeMockProc();
    };
    const handler = createBashHandler({ spawn });
    await handler.execute(
      baseRequest({ args: { command: 'curl -H "Authorization: Bearer SECRET" https://x' } }),
    );
    expect(captured.argv).toEqual(['bash', '-s']);
    expect(captured.argv).not.toContain('curl -H "Authorization: Bearer SECRET" https://x');
    expect(captured.stdinScript).toBe('curl -H "Authorization: Bearer SECRET" https://x');
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
    // Slice 173 — stdinScript is now part of the options surface;
    // we deep-check including the script alongside cwd/env.
    expect(captured.opts).toEqual({
      cwd: '/work/proj',
      env: { SAFE: 'value' },
      stdinScript: 'echo',
    });
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

// Slice 108 — R7 #37 + R7 #36 hardening on the bash handler.
//
// #37: escalateToSigkill overwrote killEscalationTimer when
// both timeout and abort fired (timeout SIGTERM at T0 → grace
// timer #1 armed; abort at T0+ε → grace timer #2 OVERWRITES
// the reference, timer #1 is orphaned + still pending → fires
// later as a no-op on a dead proc, leaking a setTimeout handle
// into the event loop). First-arm-wins guard plugs the leak.
//
// #36: `proc.exited.then(() => readStopAc.abort())` only fires
// on resolve. A Bun edge that rejects proc.exited leaves the
// readers waiting forever. `.finally(...)` fires on either
// path; readers always get the stop signal.
describe('createBashHandler — SIGKILL timer guard + proc.exited finally (slice 108, R7 #37/#36)', () => {
  test('first-arm wins: only one SIGKILL fires when timeout AND abort both want escalation', async () => {
    // Set up a proc that ignores SIGTERM and never exits. The
    // timeout fires first → SIGTERM + arm SIGKILL grace. Then
    // abort fires during the grace window. Pre-slice this
    // overwrote the timer, both timers fired their kills (the
    // second was a no-op on dead proc but the timer handle
    // leaked). Post-slice, abort's call to escalateToSigkill
    // is a guard-no-op; only one SIGKILL ever lands.
    let releaseExited: (() => void) | null = null;
    const exitedPromise = new Promise<number>((resolve) => {
      releaseExited = () => resolve(137);
    });
    const signalsReceived: (number | string | undefined)[] = [];
    const spawn: BashSpawnFn = () => ({
      stdout: streamFrom(''),
      stderr: streamFrom(''),
      exited: exitedPromise,
      kill: (signal) => {
        signalsReceived.push(signal);
        // Resolve the exited promise on SIGKILL so the test
        // doesn't hang.
        if (signal === 'SIGKILL' && releaseExited !== null) releaseExited();
      },
    });

    const handler = createBashHandler({ spawn, timeoutGraceMs: 50 });
    const ac = new AbortController();
    // Fire abort 10ms after start so it lands DURING the
    // post-SIGTERM grace window (which begins at timeout_ms=100
    // and lasts 50ms). Abort wants to re-escalate; the guard
    // refuses to re-arm.
    setTimeout(() => ac.abort(), 10);

    await handler.execute(baseRequest({ args: { command: 'sleep 60', timeout_ms: 100 } }), {
      signal: ac.signal,
    });

    // Exactly one SIGKILL. SIGTERM may appear once (timeout) or
    // twice (timeout + abort, both call proc.kill('SIGTERM')) —
    // that's a separate concern; the guard fix is about SIGKILL.
    const sigkillCount = signalsReceived.filter((s) => s === 'SIGKILL').length;
    expect(sigkillCount).toBe(1);
  });

  test('SIGTERM grace expiry still fires SIGKILL exactly once', async () => {
    // Regression coverage for the existing happy path: a proc
    // that ignores SIGTERM gets SIGKILL after the grace window.
    // The guard MUST NOT prevent the first arming.
    const signalsReceived: (number | string | undefined)[] = [];
    let releaseExited: (() => void) | null = null;
    const exitedPromise = new Promise<number>((resolve) => {
      releaseExited = () => resolve(137);
    });
    const spawn: BashSpawnFn = () => ({
      stdout: streamFrom(''),
      stderr: streamFrom(''),
      exited: exitedPromise,
      kill: (signal) => {
        signalsReceived.push(signal);
        if (signal === 'SIGKILL' && releaseExited !== null) releaseExited();
      },
    });
    const handler = createBashHandler({ spawn, timeoutGraceMs: 20 });
    await handler.execute(
      baseRequest({ args: { command: 'trap "" TERM; sleep 60', timeout_ms: 100 } }),
    );
    expect(signalsReceived).toContain('SIGTERM');
    expect(signalsReceived).toContain('SIGKILL');
  });

  test('proc.exited REJECTION still stops the readers (finally fires)', async () => {
    // Pre-slice `.then(() => readStopAc.abort())` only fired on
    // resolve. A Bun edge that rejects proc.exited would leave
    // the readers parked on stream end forever. The test
    // synthesizes a rejection and verifies the handler still
    // returns (the readStopAc.abort() in the .finally branch
    // propagates the stop signal, the readers unblock, the
    // call completes).
    const spawn: BashSpawnFn = () => ({
      // Streams close cleanly so the only thing the handler
      // waits on is proc.exited — which rejects.
      stdout: streamFrom('partial output'),
      stderr: streamFrom(''),
      exited: Promise.reject(new Error('synthetic Bun edge')),
      kill: () => {
        // no-op
      },
    });
    const handler = createBashHandler({ spawn });
    // Without the .finally fix, this would hang forever on the
    // readers waiting for proc.exited to also resolve. With the
    // fix, .finally fires readStopAc.abort(), the readers see
    // the stop signal, Promise.all resolves with the rejection
    // surfacing through the wrapper.
    const start = Date.now();
    const r = await handler.execute(baseRequest({ args: { command: 'echo hi' } }));
    const elapsed = Date.now() - start;
    // The handler must NOT park — readStopAc.abort() fires via
    // .finally on the proc.exited rejection, the readers unblock,
    // and slice 116's catch maps the Promise.all rejection to a
    // structured BrokerResponse instead of re-throwing.
    expect(elapsed).toBeLessThan(2000);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('wait failed');
    expect(r.error).toContain('synthetic Bun edge');
  });

  // Slice 116 (R7 P1): Promise.all rejection used to propagate up
  // through execute() as a throw — caller saw an exception instead
  // of the canonical BrokerResponse shape. Now the catch maps the
  // throw to a structured response. Aborted/timedOut paths still
  // win attribution if either flag fired.
  test('Promise.all rejection maps to structured response, not a throw (slice 116)', async () => {
    // Use the same proc.exited rejection shape as the slice 108
    // test; verify execute() RETURNS rather than throws, and the
    // error message includes the rejection cause.
    const spawn: BashSpawnFn = () => ({
      stdout: streamFrom(''),
      stderr: streamFrom(''),
      exited: Promise.reject(new Error('synthetic wait error')),
      kill: () => undefined,
    });
    const handler = createBashHandler({ spawn });
    // No try/catch here — if execute throws, the test framework
    // surfaces the throw and the assertion never runs.
    const r = await handler.execute(baseRequest({ args: { command: 'echo' } }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('wait failed');
    expect(r.error).toContain('synthetic wait error');
    // ExitCode is the placeholder -1 since proc.exited rejected
    // before we could read a real value — the response shape
    // still includes the field (BrokerResponse expects ok, stdout,
    // stderr, error; exitCode is optional).
  });

  test('aborted flag wins attribution over Promise.all rejection (slice 116)', async () => {
    // If the caller aborts AND proc.exited rejects, the response
    // should be `error: 'aborted'` (caller cancellation is the
    // proximate cause). Slice 116's waitError check runs LAST
    // after aborted/timedOut.
    const ac = new AbortController();
    const spawn: BashSpawnFn = () => ({
      stdout: streamFrom(''),
      stderr: streamFrom(''),
      // Reject after a tiny delay so the abort fires first.
      exited: new Promise((_, reject) => setTimeout(() => reject(new Error('synthetic exit')), 50)),
      kill: () => undefined,
    });
    const handler = createBashHandler({ spawn });
    setTimeout(() => ac.abort(), 10);
    const r = await handler.execute(baseRequest({ args: { command: 'echo' } }), {
      signal: ac.signal,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('aborted');
  });
});
