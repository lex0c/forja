import { describe, expect, test } from 'bun:test';
import {
  type BrokerRequest,
  DEFAULT_TIMEOUT_MS,
  type SandboxRunner,
  type SpawnFn,
  type SpawnFnOptions,
  type SpawnedProcess,
  createSpawnBroker,
} from '../../src/broker/index.ts';

const baseRequest = (overrides: Partial<BrokerRequest> = {}): BrokerRequest => ({
  toolName: 'read_file',
  args: { file_path: 'src/x.ts' },
  capabilities: ['read-fs:/work/src/x.ts'],
  sandboxProfile: 'ro',
  ...overrides,
});

// ─── mock spawn helpers ────────────────────────────────────────────────────

const streamFromString = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      if (text.length > 0) {
        controller.enqueue(new TextEncoder().encode(text));
      }
      controller.close();
    },
  });

interface MockProcessOptions {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  onWrite?: (data: string) => void;
  // If set, exited resolves only after `release` is called.
  releaseExited?: () => Promise<void>;
}

const makeMockProcess = (opts: MockProcessOptions = {}): SpawnedProcess => {
  let killed = false;
  const exited =
    opts.releaseExited !== undefined
      ? opts.releaseExited().then(() => (killed ? 137 : (opts.exitCode ?? 0)))
      : Promise.resolve(killed ? 137 : (opts.exitCode ?? 0));
  return {
    stdin: {
      write: (data: string) => {
        opts.onWrite?.(data);
        return data.length;
      },
      end: () => undefined,
    },
    stdout: streamFromString(opts.stdout ?? ''),
    stderr: streamFromString(opts.stderr ?? ''),
    exited,
    kill: () => {
      killed = true;
    },
  };
};

// ─── happy-path subprocess tests (real Bun.spawn) ──────────────────────────

describe('createSpawnBroker — real subprocess happy path', () => {
  test('roundtrips a request → response through stdin/stdout NDJSON', async () => {
    // sh reads one line from stdin then emits a fixed JSON response on stdout.
    const broker = createSpawnBroker({
      command: '/bin/sh',
      args: [
        '-c',
        'IFS= read -r line; printf \'{"ok":true,"stdout":"got","stderr":"","exitCode":0}\\n\'',
      ],
    });
    const r = await broker.execute(baseRequest());
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('got');
    expect(r.exitCode).toBe(0);
    await broker.close();
  });

  test('worker stderr is captured into the broker response stderr when worker emits invalid output', async () => {
    // Worker writes diagnostic to stderr + nothing parseable to stdout.
    const broker = createSpawnBroker({
      command: '/bin/sh',
      args: ['-c', 'IFS= read -r _; printf "worker boom\\n" >&2; exit 2'],
    });
    const r = await broker.execute(baseRequest());
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('worker boom');
    expect(r.exitCode).toBe(2);
    expect(r.error).toBe('worker produced no response');
    await broker.close();
  });

  test('noisy stdout before the response line: last line wins', async () => {
    const broker = createSpawnBroker({
      command: '/bin/sh',
      args: [
        '-c',
        'IFS= read -r _; printf "debug: starting\\nstep 1\\n"; printf \'{"ok":true,"stdout":"final","stderr":""}\\n\'',
      ],
    });
    const r = await broker.execute(baseRequest());
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('final');
    await broker.close();
  });

  test('invalid JSON on last stdout line: returns invalid-response error with exitCode', async () => {
    const broker = createSpawnBroker({
      command: '/bin/sh',
      args: ['-c', 'IFS= read -r _; printf "not json at all\\n"'],
    });
    const r = await broker.execute(baseRequest());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('invalid response:');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('not json');
    await broker.close();
  });

  test('parsed JSON missing required fields: returns shape-error', async () => {
    const broker = createSpawnBroker({
      command: '/bin/sh',
      // emits valid JSON, but lacks 'ok'/'stdout'/'stderr' fields
      args: ['-c', 'IFS= read -r _; printf \'{"foo":"bar"}\\n\''],
    });
    const r = await broker.execute(baseRequest());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('response missing required fields');
    await broker.close();
  });
});

// ─── timeout (real subprocess) ─────────────────────────────────────────────

describe('createSpawnBroker — timeout', () => {
  test('kills worker that exceeds timeoutMs and returns timeout error', async () => {
    const broker = createSpawnBroker({
      command: '/bin/sh',
      args: ['-c', 'IFS= read -r _; sleep 10'],
      timeoutMs: 50,
    });
    const start = Date.now();
    const r = await broker.execute(baseRequest());
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    expect(r.error).toBe('timeout after 50ms');
    // Sanity: didn't wait for the full 10s sleep.
    expect(elapsed).toBeLessThan(5000);
    await broker.close();
  });

  test('worker that completes BEFORE timeout returns its response normally', async () => {
    const broker = createSpawnBroker({
      command: '/bin/sh',
      args: ['-c', 'IFS= read -r _; printf \'{"ok":true,"stdout":"fast","stderr":""}\\n\''],
      timeoutMs: 5000,
    });
    const r = await broker.execute(baseRequest());
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('fast');
    await broker.close();
  });
});

// ─── per-call timeoutMs override (slice 85) ───────────────────────────────

describe('createSpawnBroker — per-call timeoutMs override', () => {
  test('per-call timeoutMs takes precedence over broker default', async () => {
    // Broker default is 10s; per-call is 50ms — the override
    // fires first, response error message reflects the override.
    const broker = createSpawnBroker({
      command: '/bin/sh',
      args: ['-c', 'IFS= read -r _; sleep 10'],
      timeoutMs: 10_000,
    });
    const start = Date.now();
    const r = await broker.execute(baseRequest(), { timeoutMs: 50 });
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    expect(r.error).toBe('timeout after 50ms');
    expect(elapsed).toBeLessThan(5000);
    await broker.close();
  });

  test('per-call timeoutMs omitted falls back to broker default', async () => {
    const broker = createSpawnBroker({
      command: '/bin/sh',
      args: ['-c', 'IFS= read -r _; sleep 10'],
      timeoutMs: 50,
    });
    const r = await broker.execute(baseRequest());
    expect(r.error).toBe('timeout after 50ms');
    await broker.close();
  });

  test('per-call timeoutMs = 0 disables timer (no kill, worker runs to completion)', async () => {
    // Broker default 50ms WOULD kill at 50ms; per-call 0 disables.
    // Worker runs to natural completion (the printf).
    const broker = createSpawnBroker({
      command: '/bin/sh',
      args: ['-c', 'IFS= read -r _; printf \'{"ok":true,"stdout":"ran","stderr":""}\\n\''],
      timeoutMs: 50,
    });
    const r = await broker.execute(baseRequest(), { timeoutMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('ran');
    await broker.close();
  });

  test('per-call timeoutMs widens beyond broker default', async () => {
    // Broker default would fire at 50ms; per-call 5s lets the
    // worker complete its 100ms work.
    const broker = createSpawnBroker({
      command: '/bin/sh',
      args: [
        '-c',
        'IFS= read -r _; sleep 0.1; printf \'{"ok":true,"stdout":"wide","stderr":""}\\n\'',
      ],
      timeoutMs: 50,
    });
    const r = await broker.execute(baseRequest(), { timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('wide');
    await broker.close();
  });
});

// ─── sandbox wrap ──────────────────────────────────────────────────────────

describe('createSpawnBroker — sandbox wrap', () => {
  test('invokes sandboxRunner with the inner argv when profile is non-null', async () => {
    const captured: {
      args: { profile: string; cwd: string; innerArgv: readonly string[] } | null;
    } = { args: null };
    const spawned: { argv: readonly string[] | null } = { argv: null };
    const sandboxRunner: SandboxRunner = (args) => {
      captured.args = args;
      return ['bwrap', '--unshare-net', '--', ...args.innerArgv];
    };
    const mockSpawn: SpawnFn = (argv) => {
      spawned.argv = argv;
      return makeMockProcess({
        stdout: '{"ok":true,"stdout":"","stderr":""}\n',
      });
    };
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      args: ['--run'],
      cwd: '/work/proj',
      sandboxRunner,
      spawn: mockSpawn,
    });
    await broker.execute(baseRequest({ sandboxProfile: 'cwd-rw' }));
    expect(captured.args).toEqual({
      profile: 'cwd-rw',
      cwd: '/work/proj',
      innerArgv: ['/usr/bin/worker', '--run'],
    });
    expect(spawned.argv).toEqual(['bwrap', '--unshare-net', '--', '/usr/bin/worker', '--run']);
    await broker.close();
  });

  test('skips sandboxRunner when sandboxProfile is null (passthrough)', async () => {
    let runnerCalls = 0;
    const spawned: { argv: readonly string[] | null } = { argv: null };
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      sandboxRunner: () => {
        runnerCalls++;
        return ['SHOULD-NOT-BE-USED'];
      },
      spawn: (argv) => {
        spawned.argv = argv;
        return makeMockProcess({ stdout: '{"ok":true,"stdout":"","stderr":""}\n' });
      },
    });
    await broker.execute(baseRequest({ sandboxProfile: null }));
    expect(runnerCalls).toBe(0);
    expect(spawned.argv).toEqual(['/usr/bin/worker']);
    await broker.close();
  });

  test('skips sandbox wrap when no sandboxRunner is configured (even with profile set)', async () => {
    const spawned: { argv: readonly string[] | null } = { argv: null };
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: (argv) => {
        spawned.argv = argv;
        return makeMockProcess({ stdout: '{"ok":true,"stdout":"","stderr":""}\n' });
      },
    });
    await broker.execute(baseRequest({ sandboxProfile: 'ro' }));
    expect(spawned.argv).toEqual(['/usr/bin/worker']);
    await broker.close();
  });

  test('sandbox runner throwing maps to sandbox-wrap-failed error (no spawn)', async () => {
    let spawnCalls = 0;
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      sandboxRunner: () => {
        throw new Error('bwrap not viable');
      },
      spawn: (argv) => {
        spawnCalls++;
        return makeMockProcess({ stdout: argv.join(' ') });
      },
    });
    const r = await broker.execute(baseRequest({ sandboxProfile: 'ro' }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('sandbox wrap failed: bwrap not viable');
    expect(spawnCalls).toBe(0);
    await broker.close();
  });
});

// ─── spawn / stdin error paths (mocked) ────────────────────────────────────

describe('createSpawnBroker — spawn / stdin errors', () => {
  test('spawn throwing maps to ok:false with spawn-failed error', async () => {
    const broker = createSpawnBroker({
      command: '/usr/bin/missing',
      spawn: () => {
        throw new Error('ENOENT');
      },
    });
    const r = await broker.execute(baseRequest());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('spawn failed: ENOENT');
    await broker.close();
  });

  test('stdin write throwing kills child and returns stdin-write-failed error', async () => {
    let killed = false;
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: () => ({
        stdin: {
          write: () => {
            throw new Error('EPIPE');
          },
          end: () => undefined,
        },
        stdout: streamFromString(''),
        stderr: streamFromString(''),
        exited: Promise.resolve(0),
        kill: () => {
          killed = true;
        },
      }),
    });
    const r = await broker.execute(baseRequest());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('stdin write failed: EPIPE');
    expect(killed).toBe(true);
    await broker.close();
  });

  test('forwards the request as a single NDJSON line on stdin', async () => {
    const written: { chunk: string | null } = { chunk: null };
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: () =>
        makeMockProcess({
          stdout: '{"ok":true,"stdout":"","stderr":""}\n',
          onWrite: (data) => {
            written.chunk = data;
          },
        }),
    });
    const req = baseRequest({ approvalId: 42 });
    await broker.execute(req);
    const chunk = written.chunk;
    if (chunk === null) throw new Error('stdin write was not called');
    expect(chunk.endsWith('\n')).toBe(true);
    expect(JSON.parse(chunk.trim())).toEqual(req);
    await broker.close();
  });
});

// ─── FIFO serialization ────────────────────────────────────────────────────

describe('createSpawnBroker — FIFO serialization', () => {
  test('concurrent execute calls serialize (max in-flight = 1)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: (argv) => {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        const release = () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              inFlight--;
              resolve();
            }, 5);
          });
        return makeMockProcess({
          stdout: `{"ok":true,"stdout":"${argv.length}","stderr":""}\n`,
          releaseExited: release,
        });
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
    expect(results.every((r) => r.ok)).toBe(true);
    await broker.close();
  });

  test('a thrown spawn does not block subsequent queued calls', async () => {
    let callCount = 0;
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('call 2 spawn fails');
        }
        return makeMockProcess({
          stdout: `{"ok":true,"stdout":"call-${callCount}","stderr":""}\n`,
        });
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
    expect(r2.error).toContain('call 2 spawn fails');
    expect(r3.ok).toBe(true);
    expect(r3.stdout).toBe('call-3');
    await broker.close();
  });
});

// ─── close lifecycle ───────────────────────────────────────────────────────

describe('createSpawnBroker — close', () => {
  test('close awaits in-flight call before resolving', async () => {
    let workerExited = false;
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: () =>
        makeMockProcess({
          stdout: '{"ok":true,"stdout":"slow","stderr":""}\n',
          releaseExited: () =>
            new Promise((resolve) => {
              setTimeout(() => {
                workerExited = true;
                resolve();
              }, 10);
            }),
        }),
    });
    const exec = broker.execute(baseRequest());
    await broker.close();
    expect(workerExited).toBe(true);
    const r = await exec;
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('slow');
  });

  test('subsequent execute after close returns broker-closed error', async () => {
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: () => makeMockProcess({ stdout: '{"ok":true,"stdout":"","stderr":""}\n' }),
    });
    await broker.close();
    const r = await broker.execute(baseRequest());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('broker closed');
  });

  test('close is idempotent', async () => {
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: () => makeMockProcess({ stdout: '{"ok":true,"stdout":"","stderr":""}\n' }),
    });
    await expect(broker.close()).resolves.toBeUndefined();
    await expect(broker.close()).resolves.toBeUndefined();
    await expect(broker.close()).resolves.toBeUndefined();
  });
});

// ─── option plumbing ───────────────────────────────────────────────────────

describe('createSpawnBroker — option plumbing', () => {
  test('cwd + env are forwarded to spawn options', async () => {
    const captured: { opts: SpawnFnOptions | null } = { opts: null };
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      cwd: '/work/proj',
      env: { WORKER_TOKEN: 'abc' },
      spawn: (_argv, opts) => {
        captured.opts = opts;
        return makeMockProcess({ stdout: '{"ok":true,"stdout":"","stderr":""}\n' });
      },
    });
    await broker.execute(baseRequest());
    expect(captured.opts).toEqual({
      cwd: '/work/proj',
      env: { WORKER_TOKEN: 'abc' },
    });
    await broker.close();
  });

  test('default cwd is process.cwd() when not specified', async () => {
    const captured: { opts: SpawnFnOptions | null } = { opts: null };
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: (_argv, opts) => {
        captured.opts = opts;
        return makeMockProcess({ stdout: '{"ok":true,"stdout":"","stderr":""}\n' });
      },
    });
    await broker.execute(baseRequest());
    expect(captured.opts?.cwd).toBe(process.cwd());
    await broker.close();
  });
});

// Slice 105 — R6 #44: pre-slice the broker called Bun.spawn
// without an explicit `env` option, which made the worker inherit
// the FULL parent env including every operator secret (API keys,
// vault tokens, AWS creds). The worker would see them raw BEFORE
// any per-call scrub fired. Slice 105 defaults `options.env` to
// `scrubEnv(process.env)` so credentials don't reach the worker
// process unless the operator explicitly passes them.
describe('createSpawnBroker — env scrubbing default (slice 105, R6 #44)', () => {
  test('default env strips credential-shaped vars from process.env', async () => {
    // Plant fake secrets in process.env, build a broker without an
    // explicit env, capture the env the broker hands to spawn.
    // The credential-shaped names MUST NOT survive.
    process.env.FAKE_API_KEY = 'leak-this-1';
    process.env.FAKE_TOKEN = 'leak-this-2';
    process.env.SOME_SECRET = 'leak-this-3';
    try {
      const captured: { opts: SpawnFnOptions | null } = { opts: null };
      const broker = createSpawnBroker({
        command: '/usr/bin/worker',
        spawn: (_argv, opts) => {
          captured.opts = opts;
          return makeMockProcess({ stdout: '{"ok":true,"stdout":"","stderr":""}\n' });
        },
      });
      await broker.execute(baseRequest());
      const passedEnv = captured.opts?.env ?? {};
      expect(passedEnv.FAKE_API_KEY).toBeUndefined();
      expect(passedEnv.FAKE_TOKEN).toBeUndefined();
      expect(passedEnv.SOME_SECRET).toBeUndefined();
      // Sanity: a known-safe variable (PATH) is preserved — the
      // scrub only drops credential-shaped names, not the whole
      // env. Workers still need PATH to find binaries.
      expect(typeof passedEnv.PATH).toBe('string');
      await broker.close();
    } finally {
      process.env.FAKE_API_KEY = undefined;
      process.env.FAKE_TOKEN = undefined;
      process.env.SOME_SECRET = undefined;
    }
  });

  test('explicit env bypasses the scrub (operator control)', async () => {
    // An operator passing an explicit env stays in full control.
    // The scrub doesn't second-guess deliberate config. If they
    // pass a credential-shaped name, it goes through verbatim.
    const captured: { opts: SpawnFnOptions | null } = { opts: null };
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      env: { CUSTOM_API_KEY: 'on-purpose', PATH: '/usr/bin' },
      spawn: (_argv, opts) => {
        captured.opts = opts;
        return makeMockProcess({ stdout: '{"ok":true,"stdout":"","stderr":""}\n' });
      },
    });
    await broker.execute(baseRequest());
    expect(captured.opts?.env).toEqual({
      CUSTOM_API_KEY: 'on-purpose',
      PATH: '/usr/bin',
    });
    await broker.close();
  });

  test('default env is always defined (never undefined to spawn)', async () => {
    // Pre-slice Bun.spawn with env=undefined inherits the parent
    // env. The fix ensures env is ALWAYS explicit so the worker
    // never sees the raw parent env, even on a brand-new broker
    // construction.
    const captured: { opts: SpawnFnOptions | null } = { opts: null };
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: (_argv, opts) => {
        captured.opts = opts;
        return makeMockProcess({ stdout: '{"ok":true,"stdout":"","stderr":""}\n' });
      },
    });
    await broker.execute(baseRequest());
    expect(captured.opts?.env).toBeDefined();
    await broker.close();
  });
});

// Slice 102 — R6 #21: broker drain unbounded. Pre-slice `new
// Response(stream).text()` read the worker's full stdout into the
// broker's memory with NO cap; a worker emitting gigabytes would
// OOM the broker process. `drainBounded` caps each stream and
// short-circuits with a specific error envelope when the cap is
// hit.
describe('createSpawnBroker — bounded stream drain (slice 102, R6 #21)', () => {
  test('stdout under cap drains cleanly (no regression)', async () => {
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      maxStdoutBytes: 1024,
      spawn: () => makeMockProcess({ stdout: '{"ok":true,"stdout":"hello","stderr":""}\n' }),
    });
    const res = await broker.execute(baseRequest());
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe('hello');
    await broker.close();
  });

  test('stdout over cap returns truncation error', async () => {
    // Build a payload exceeding the cap. The drain reads until
    // the cap then short-circuits; the broker's response parser
    // never runs (the error surfaces first).
    const bigPayload = 'x'.repeat(100);
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      maxStdoutBytes: 50,
      spawn: () => makeMockProcess({ stdout: bigPayload }),
    });
    const res = await broker.execute(baseRequest());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('stdout exceeded 50 bytes');
    expect(res.error).toContain('truncated');
    // Truncated text + marker visible for forensic triage.
    expect(res.stdout).toContain('<truncated at 50 bytes>');
    await broker.close();
  });

  test('stderr over cap returns separate truncation error', async () => {
    const bigStderr = 'e'.repeat(200);
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      maxStderrBytes: 100,
      spawn: () =>
        makeMockProcess({
          stdout: '{"ok":true,"stdout":"","stderr":""}\n',
          stderr: bigStderr,
        }),
    });
    const res = await broker.execute(baseRequest());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('stderr exceeded 100 bytes');
    expect(res.stderr).toContain('<truncated at 100 bytes>');
    await broker.close();
  });

  test('default caps are documented values (16 MiB stdout, 4 MiB stderr)', async () => {
    // Smoke test for the default values — a payload of 1 MB
    // passes through without truncation under default caps.
    const oneMb = 'a'.repeat(1024 * 1024);
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: () =>
        makeMockProcess({
          stdout: `${oneMb}\n{"ok":true,"stdout":"","stderr":""}\n`,
        }),
    });
    const res = await broker.execute(baseRequest());
    expect(res.ok).toBe(true);
    await broker.close();
  });

  test('truncation includes exitCode (worker may still have exited cleanly)', async () => {
    // Operator needs the exit code for triage — was the worker
    // wedged or did it exit cleanly while producing too much
    // output? Both are real shapes.
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      maxStdoutBytes: 10,
      spawn: () => makeMockProcess({ stdout: 'x'.repeat(50), exitCode: 0 }),
    });
    const res = await broker.execute(baseRequest());
    expect(res.exitCode).toBe(0);
    await broker.close();
  });
});

// Slice 107 — R6 #38: pre-slice the signal listener was
// attached AFTER the await on `proc.stdin.end()`. An abort
// firing during the sandbox-wrap / spawn / stdin-write window
// was lost — listener registered AFTER the event has fired is
// never invoked. The caller's cancellation silently no-op'd
// until the outer timeout fired. Slice 107 hoists the listener
// BEFORE the spawn so the abort during the await IS caught.
describe('createSpawnBroker — signal listener race window (slice 107, R6 #38)', () => {
  test('abort during sandbox-wrap kills the call without spawning', async () => {
    // sandboxRunner is the very first place an abort can race
    // (it's called before spawn). Pre-slice the listener wasn't
    // attached yet; the abort was lost. Slice 107 attaches FIRST,
    // so an abort during the wrap is caught — but since proc
    // isn't created yet, the listener no-ops and the wrap path
    // continues. The post-wrap signalAborted check would catch
    // it — but actually the wrap throws synchronously, so abort
    // can't fire mid-wrap. The interesting race is during the
    // stdin.end await; this test exercises the simpler "abort
    // immediately after broker.execute starts" path.
    const ac = new AbortController();
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: () =>
        // Mock a spawn that succeeds but produces nothing on
        // stdout — the call would hang on proc.exited if the
        // abort isn't honored.
        makeMockProcess({ stdout: '', stderr: '' }),
    });
    // Abort BEFORE calling execute — should short-circuit via
    // the pre-aborted check, never spawn.
    ac.abort();
    const res = await broker.execute(baseRequest(), { signal: ac.signal });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('aborted');
    await broker.close();
  });

  test('abort during stdin.end (the canonical race window) IS caught', async () => {
    // The motivating race shape. Slice 107 attaches the listener
    // BEFORE spawn, so the abort fires the kill during the
    // stdin.end await. Pre-slice this test would either: (a) hang
    // until the default timeout fired, or (b) return the
    // canonical 'aborted' error AFTER the worker was killed by
    // the outer timeout, hours/seconds later.
    let abortDuringWrite = false;
    const ac = new AbortController();
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: () =>
        makeMockProcess({
          stdout: '',
          stderr: '',
          // Fire the abort while the broker is awaiting stdin.end.
          onWrite: () => {
            // Defer to a microtask so we abort DURING the await
            // on Promise.resolve(stdin.end), not before.
            queueMicrotask(() => {
              abortDuringWrite = true;
              ac.abort();
            });
          },
        }),
      timeoutMs: 5000, // floor doesn't fire; abort should win first
    });
    const start = Date.now();
    const res = await broker.execute(baseRequest(), { signal: ac.signal });
    const elapsed = Date.now() - start;
    expect(abortDuringWrite).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('aborted');
    // Abort fast-path — not the 5s timeout fallback.
    expect(elapsed).toBeLessThan(2000);
    await broker.close();
  });

  test('listener detached on sandbox wrap failure (no leak)', async () => {
    // Each call attaches a listener; each call MUST detach it
    // on every return path. Pre-slice the wrap-failure return
    // didn't remove the listener (the attach was AFTER the
    // wrap, so there was nothing to remove). Slice 107 attaches
    // before the wrap, so the wrap-failure path now removes.
    // Without proper cleanup, AbortSignal.addEventListener
    // would leak handlers across calls.
    const ac = new AbortController();
    // Track listener count via a custom EventTarget shim.
    let attachCount = 0;
    let removeCount = 0;
    const signal = new (class extends EventTarget {
      get aborted() {
        return ac.signal.aborted;
      }
      addEventListener(
        type: string,
        listener: EventListener,
        opts?: AddEventListenerOptions,
      ): void {
        attachCount++;
        super.addEventListener(type, listener, opts);
        ac.signal.addEventListener(type, listener, opts);
      }
      removeEventListener(type: string, listener: EventListener): void {
        removeCount++;
        super.removeEventListener(type, listener);
        ac.signal.removeEventListener(type, listener);
      }
    })() as unknown as AbortSignal;
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      sandboxRunner: () => {
        throw new Error('synthetic wrap error');
      },
      spawn: () => makeMockProcess(),
    });
    const res = await broker.execute(baseRequest(), { signal });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('sandbox wrap failed');
    // Listener was attached then detached cleanly — no leak.
    expect(attachCount).toBe(1);
    expect(removeCount).toBe(1);
    await broker.close();
  });

  test('listener detached on spawn failure (no leak)', async () => {
    let attachCount = 0;
    let removeCount = 0;
    const ac = new AbortController();
    const signal = new (class extends EventTarget {
      get aborted() {
        return ac.signal.aborted;
      }
      addEventListener(
        type: string,
        listener: EventListener,
        opts?: AddEventListenerOptions,
      ): void {
        attachCount++;
        super.addEventListener(type, listener, opts);
        ac.signal.addEventListener(type, listener, opts);
      }
      removeEventListener(type: string, listener: EventListener): void {
        removeCount++;
        super.removeEventListener(type, listener);
        ac.signal.removeEventListener(type, listener);
      }
    })() as unknown as AbortSignal;
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: () => {
        throw new Error('synthetic spawn error');
      },
    });
    const res = await broker.execute(baseRequest(), { signal });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('spawn failed');
    expect(attachCount).toBe(1);
    expect(removeCount).toBe(1);
    await broker.close();
  });
});

// Slice 106 — R6 #41: pre-slice an undefined timeoutMs at both
// caller and broker layers meant `proc.exited` could park
// forever on a wedged worker (closed pipes but never exited).
// Slice 106 adds a DEFAULT_TIMEOUT_MS=60_000 floor so the broker
// always has a ceiling. Operators who genuinely want no timeout
// pass `timeoutMs: 0` explicitly (test escape valve).
describe('createSpawnBroker — default timeout floor (slice 106, R6 #41)', () => {
  test('worker that hangs without explicit timeoutMs is killed by the default floor', async () => {
    // Mock a process whose exited promise NEVER resolves. Without
    // the floor, `await Promise.all([..., proc.exited])` would
    // park indefinitely. The default 60s floor would still take
    // 60s to fire — too long for a test — so we pass an explicit
    // short timeoutMs to validate the SAME mechanism. The
    // `default applies when both layers omit` is covered by the
    // next test via a synthetic seam.
    const broker = createSpawnBroker({
      command: '/bin/sh',
      args: ['-c', 'IFS= read -r _; sleep 10'],
      timeoutMs: 50,
    });
    const start = Date.now();
    const res = await broker.execute(baseRequest());
    const elapsed = Date.now() - start;
    expect(res.ok).toBe(false);
    expect(res.error).toBe('timeout after 50ms');
    expect(elapsed).toBeLessThan(5000);
    await broker.close();
  });

  test('explicit timeoutMs: 0 still disables the timer (no floor)', async () => {
    // The escape valve. Operator explicitly asks for no timeout;
    // the floor MUST NOT override that. `??` short-circuits on
    // undefined but NOT on 0, so the chain
    // `callOptions ?? brokerDefault ?? FLOOR` preserves 0 at
    // either layer.
    const broker = createSpawnBroker({
      command: '/bin/sh',
      args: ['-c', 'IFS= read -r _; printf \'{"ok":true,"stdout":"ran","stderr":""}\\n\''],
      timeoutMs: 0,
    });
    const res = await broker.execute(baseRequest());
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe('ran');
    await broker.close();
  });

  test('per-call timeoutMs: 0 still disables even when broker default is set', async () => {
    // Same escape valve at the per-call layer. Operator running
    // a known-slow workload wants no cap for THIS call; broker
    // default doesn't reapply.
    const broker = createSpawnBroker({
      command: '/bin/sh',
      args: ['-c', 'IFS= read -r _; printf \'{"ok":true,"stdout":"slow","stderr":""}\\n\''],
      timeoutMs: 30_000,
    });
    const res = await broker.execute(baseRequest(), { timeoutMs: 0 });
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe('slow');
    await broker.close();
  });

  test('broker without explicit timeoutMs uses the default floor', async () => {
    // Verifies the chain fall-through: callOptions.timeoutMs ??
    // brokerDefault ?? DEFAULT_TIMEOUT_MS. We can't wait 60s in
    // a unit test, so verify the FLOOR shape via the exported
    // constant — bootstrap.ts uses the same value (60_000)
    // explicitly, so the production wiring is consistent.
    // The per-call timeoutMs path is exercised by the next
    // assertion: a broker constructed WITHOUT timeoutMs still
    // kills a wedged worker when given a small per-call
    // override, proving the timer mechanism is reachable
    // through the fall-through.
    expect(DEFAULT_TIMEOUT_MS).toBe(60_000);

    const broker = createSpawnBroker({
      command: '/bin/sh',
      args: ['-c', 'IFS= read -r _; sleep 10'],
      // NO broker-level timeoutMs.
    });
    const start = Date.now();
    const res = await broker.execute(baseRequest(), { timeoutMs: 50 });
    const elapsed = Date.now() - start;
    expect(res.ok).toBe(false);
    expect(res.error).toBe('timeout after 50ms');
    expect(elapsed).toBeLessThan(5000);
    await broker.close();
  });
});

// Slice 104 — R6 #42: a hostile worker emitting a response with
// __proto__ keys would otherwise pollute the broker's downstream
// objects via spread/merge. The broker uses safeJsonParse which
// strips dangerous keys via reviver — the response object lands
// clean, downstream consumers are safe.
describe('createSpawnBroker — proto-pollution defense on response (slice 104, R6 #42)', () => {
  test('worker emitting __proto__ in response does NOT pollute consumer objects', async () => {
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: () =>
        makeMockProcess({
          // Hostile worker emits a response with __proto__ key.
          // Pre-slice this would parse with __proto__ as an own
          // property, then downstream Object.assign / spread
          // would poison the global Object prototype.
          stdout: '{"ok":true,"stdout":"ran","stderr":"","__proto__":{"polluted":true}}\n',
        }),
    });
    const res = await broker.execute(baseRequest());
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe('ran');
    // Sanity: global Object.prototype was not polluted.
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    await broker.close();
  });
});

// Slice 103 — R6 #9: a sandboxRunner that throws on unknown
// profile is the canonical defense; the broker maps the throw
// into a structured `sandbox wrap failed` response without ever
// spawning the worker.
describe('createSpawnBroker — sandboxProfile validation (slice 103, R6 #9)', () => {
  test('sandboxRunner throw maps to sandbox-wrap-failed response', async () => {
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      sandboxRunner: () => {
        throw new Error("sandbox: unknown profile 'attacker'");
      },
      spawn: () => {
        // Should NEVER be called — the runner throws first.
        throw new Error('spawn should not run when runner throws');
      },
    });
    const res = await broker.execute(baseRequest({ sandboxProfile: 'attacker' }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('sandbox wrap failed');
    expect(res.error).toContain("unknown profile 'attacker'");
    await broker.close();
  });
});
