import { describe, expect, test } from 'bun:test';
import {
  type BrokerRequest,
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
