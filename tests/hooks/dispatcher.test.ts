import { describe, expect, test } from 'bun:test';
import { dispatchChain, dispatchOne, filterMatchingHooks } from '../../src/hooks/dispatcher.ts';
import type { DispatchedProcess, SpawnFn, SpawnOpts } from '../../src/hooks/dispatcher.ts';
import type { HookEventPayload, HookSpec } from '../../src/hooks/types.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listHookRunsBySession } from '../../src/storage/repos/hook-runs.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

// ─── fake spawn ──────────────────────────────────────────────────────
//
// Simulates a subprocess driven step-by-step from the test. The
// dispatcher writes stdin, awaits exit, drains stdout/stderr;
// the fake feeds those streams + lets the test choose exit code
// + delay + whether the process honors `kill`.
//
// Each scenario constructs a `FakeSpec` and `makeFakeSpawn`
// returns a SpawnFn that hands out one DispatchedProcess per
// invocation.

interface FakeSpec {
  // Exit code the fake process resolves with (or null when the
  // process must be killed before it exits naturally).
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  // Delay (ms) before the process resolves naturally. The
  // dispatcher's timeout fires before this when timeoutMs <
  // delay; the fake then waits for kill.
  delayMs?: number;
  // When true, kill() resolves immediately with code 137
  // (SIGKILL); when false (default), kill is a no-op (process
  // ignores SIGTERM, the dispatcher's 1s timer must fire to
  // SIGKILL).
  killImmediate?: boolean;
}

const makeFakeSpawn = (
  spec: FakeSpec,
  capture?: { calls: { cmd: string[]; opts: SpawnOpts; stdin: string }[] },
): SpawnFn => {
  return (cmd, opts): DispatchedProcess => {
    let stdinBuf = '';
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (spec.exitCode !== null) {
      timer = setTimeout(() => resolveExit(spec.exitCode as number), spec.delayMs ?? 0);
    }
    const stdoutStream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (spec.stdout !== undefined && spec.stdout.length > 0) {
          controller.enqueue(new TextEncoder().encode(spec.stdout));
        }
        controller.close();
      },
    });
    const stderrStream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (spec.stderr !== undefined && spec.stderr.length > 0) {
          controller.enqueue(new TextEncoder().encode(spec.stderr));
        }
        controller.close();
      },
    });
    const dp: DispatchedProcess = {
      stdin: {
        write: (chunk) => {
          stdinBuf += chunk;
        },
        end: () => {
          capture?.calls.push({ cmd, opts, stdin: stdinBuf });
        },
      },
      stdout: stdoutStream,
      stderr: stderrStream,
      exited,
      kill: (signal) => {
        if (signal === 'SIGKILL' || spec.killImmediate === true) {
          if (timer !== undefined) clearTimeout(timer);
          resolveExit(137);
        }
        // SIGTERM with killImmediate=false → no-op, dispatcher's
        // 1s timer must escalate.
      },
    };
    return dp;
  };
};

// ─── helpers ─────────────────────────────────────────────────────────

const makeSpec = (overrides: Partial<HookSpec> = {}): HookSpec => ({
  layer: 'project',
  sourcePath: '/repo/.agent/hooks.toml',
  event: 'PostToolUse',
  matcher: {},
  entryIndex: 0,
  command: 'echo {{event}}',
  timeoutMs: 5000,
  failClosed: false,
  locked: false,
  ...overrides,
});

const makePayload = (overrides: Partial<HookEventPayload> = {}): HookEventPayload =>
  ({
    schema: 'v1',
    event: 'PostToolUse',
    sessionId: 'sess-1',
    data: {
      tool: { name: 'write_file', input: { path: '/repo/x.ts' }, output: 'ok', failed: false },
    },
    ...overrides,
  }) as HookEventPayload;

// ─── filterMatchingHooks ─────────────────────────────────────────────

describe('filterMatchingHooks', () => {
  test('event match, no matcher: passes', () => {
    const stopHook = makeSpec({ event: 'Stop' });
    const otherHook = makeSpec({ event: 'PostToolUse' });
    const hooks = [stopHook, otherHook];
    expect(filterMatchingHooks(hooks, 'Stop')).toEqual([stopHook]);
  });

  test('tool matcher exact match', () => {
    const bashHook = makeSpec({ event: 'PreToolUse', matcher: { tool: 'bash' } });
    const writeHook = makeSpec({ event: 'PreToolUse', matcher: { tool: 'write_file' } });
    const hooks = [bashHook, writeHook];
    expect(filterMatchingHooks(hooks, 'PreToolUse', 'bash')).toEqual([bashHook]);
  });

  test('tool matcher with `*` suffix is prefix-match', () => {
    const hooks = [makeSpec({ event: 'PreToolUse', matcher: { tool: 'bash*' } })];
    expect(filterMatchingHooks(hooks, 'PreToolUse', 'bash')).toEqual(hooks);
    expect(filterMatchingHooks(hooks, 'PreToolUse', 'bash_background')).toEqual(hooks);
    expect(filterMatchingHooks(hooks, 'PreToolUse', 'grep')).toEqual([]);
  });

  test('tool matcher requires toolName to be supplied', () => {
    const hooks = [makeSpec({ event: 'PreToolUse', matcher: { tool: 'bash' } })];
    expect(filterMatchingHooks(hooks, 'PreToolUse')).toEqual([]);
  });
});

// ─── dispatchOne ─────────────────────────────────────────────────────

describe('dispatchOne — exit code classification', () => {
  test('exit 0 → kind=allow, stdout captured', async () => {
    const fake = makeFakeSpawn({ exitCode: 0, stdout: 'OK\n' });
    const result = await dispatchOne(makeSpec(), 0, makePayload(), '/repo', {
      now: () => 1000,
      spawn: fake,
    });
    expect(result.kind).toBe('allow');
    if (result.kind !== 'allow') return;
    expect(result.stdoutTruncated.trim()).toBe('OK');
  });

  test('exit 1 → kind=block_silent', async () => {
    const fake = makeFakeSpawn({ exitCode: 1 });
    const result = await dispatchOne(makeSpec(), 0, makePayload(), '/repo', {
      now: () => 1000,
      spawn: fake,
    });
    expect(result.kind).toBe('block_silent');
  });

  test('exit 2 → kind=block_message with stdout as reason', async () => {
    const fake = makeFakeSpawn({ exitCode: 2, stdout: 'forbidden path\n' });
    const result = await dispatchOne(makeSpec(), 0, makePayload(), '/repo', {
      now: () => 1000,
      spawn: fake,
    });
    expect(result.kind).toBe('block_message');
    if (result.kind !== 'block_message') return;
    expect(result.message).toBe('forbidden path');
  });

  test('exit > 2 → kind=error with shouldBlock=false (failClosed=false)', async () => {
    const fake = makeFakeSpawn({ exitCode: 5 });
    const result = await dispatchOne(makeSpec(), 0, makePayload(), '/repo', {
      now: () => 1000,
      spawn: fake,
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.exitCode).toBe(5);
    expect(result.shouldBlock).toBe(false);
  });

  test('exit > 2 with failClosed=true → shouldBlock=true', async () => {
    const fake = makeFakeSpawn({ exitCode: 5 });
    const result = await dispatchOne(makeSpec({ failClosed: true }), 0, makePayload(), '/repo', {
      now: () => 1000,
      spawn: fake,
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.shouldBlock).toBe(true);
  });
});

describe('dispatchOne — timeout', () => {
  test('process exceeds timeoutMs → kind=timeout', async () => {
    const fake = makeFakeSpawn({ exitCode: 0, delayMs: 200, killImmediate: true });
    const result = await dispatchOne(makeSpec({ timeoutMs: 100 }), 0, makePayload(), '/repo', {
      spawn: fake,
    });
    expect(result.kind).toBe('timeout');
    if (result.kind !== 'timeout') return;
    expect(result.timeoutMs).toBe(100);
    expect(result.shouldBlock).toBe(false);
  });

  test('timeout + failClosed=true → shouldBlock=true', async () => {
    const fake = makeFakeSpawn({ exitCode: 0, delayMs: 200, killImmediate: true });
    const result = await dispatchOne(
      makeSpec({ timeoutMs: 100, failClosed: true }),
      0,
      makePayload(),
      '/repo',
      { spawn: fake },
    );
    expect(result.kind).toBe('timeout');
    if (result.kind !== 'timeout') return;
    expect(result.shouldBlock).toBe(true);
  });
});

describe('dispatchOne — robustness', () => {
  test('stdin write throwing (EPIPE) is swallowed; dispatcher continues to wait', async () => {
    // Hook process closed stdin early — writing throws EPIPE.
    // Earlier behavior: silently catch, proceed to await
    // proc.exited. Test pins this.
    const fake: SpawnFn = (_cmd, _opts) => ({
      stdin: {
        write: () => {
          throw new Error('EPIPE');
        },
        end: () => {},
      },
      stdout: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      exited: Promise.resolve(0),
      kill: () => {},
    });
    const result = await dispatchOne(makeSpec(), 0, makePayload(), '/p', { spawn: fake });
    expect(result.kind).toBe('allow');
  });

  test('payload from a non-tool event does not break dispatch', async () => {
    // Stop event has no `tool` field. Dispatcher must build
    // env / spawn / audit without referencing it.
    const capture = { calls: [] as { cmd: string[]; opts: SpawnOpts; stdin: string }[] };
    const fake = makeFakeSpawn({ exitCode: 0 }, capture);
    const stopPayload = {
      schema: 'v1',
      event: 'Stop',
      sessionId: 'sess',
      data: { durationMs: 100, costUsd: 0.01, steps: 5 },
    } as HookEventPayload;
    const result = await dispatchOne(makeSpec({ event: 'Stop' }), 0, stopPayload, '/cwd', {
      spawn: fake,
    });
    expect(result.kind).toBe('allow');
    // Audit row's matchedTool field is null for non-tool
    // events — covered separately in the audit-emission tests.
  });
});

describe('dispatchOne — env / stdin / cwd contract', () => {
  test('stdin receives JSON event payload + newline', async () => {
    const capture = { calls: [] as { cmd: string[]; opts: SpawnOpts; stdin: string }[] };
    const fake = makeFakeSpawn({ exitCode: 0 }, capture);
    const payload = makePayload();
    await dispatchOne(makeSpec(), 0, payload, '/repo', { spawn: fake });
    expect(capture.calls).toHaveLength(1);
    const stdin = capture.calls[0]?.stdin ?? '';
    expect(stdin.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(stdin.trim());
    expect(parsed.schema).toBe('v1');
    expect(parsed.event).toBe('PostToolUse');
  });

  test('cwd is forwarded to spawn opts', async () => {
    const capture = { calls: [] as { cmd: string[]; opts: SpawnOpts; stdin: string }[] };
    const fake = makeFakeSpawn({ exitCode: 0 }, capture);
    await dispatchOne(makeSpec(), 0, makePayload(), '/special/cwd', { spawn: fake });
    expect(capture.calls[0]?.opts.cwd).toBe('/special/cwd');
  });

  test('env contains only the allow-list', async () => {
    const capture = { calls: [] as { cmd: string[]; opts: SpawnOpts; stdin: string }[] };
    const fake = makeFakeSpawn({ exitCode: 0 }, capture);
    await dispatchOne(makeSpec(), 0, makePayload(), '/cwd', {
      spawn: fake,
      sessionId: 'sess-42',
    });
    const env = capture.calls[0]?.opts.env ?? {};
    expect(Object.keys(env).sort()).toEqual(['AGENT_CWD', 'AGENT_SESSION_ID', 'HOME', 'PATH']);
    expect(env.AGENT_CWD).toBe('/cwd');
    expect(env.AGENT_SESSION_ID).toBe('sess-42');
  });

  test('AGENT_SESSION_ID always present (empty string when absent)', async () => {
    // Earlier cut omitted the key when sessionId was null/
    // undefined; CONTRACTS.md §3 line 707 lists it in the
    // allow-list without "when present" qualifier. Operator
    // hooks can `[ -z "$AGENT_SESSION_ID" ]` to detect the
    // pre-session window (SessionStart hook fires here).
    const capture = { calls: [] as { cmd: string[]; opts: SpawnOpts; stdin: string }[] };
    const fake = makeFakeSpawn({ exitCode: 0 }, capture);
    await dispatchOne(makeSpec(), 0, makePayload(), '/cwd', { spawn: fake });
    // No sessionId in deps → empty string, key still present.
    const env = capture.calls[0]?.opts.env ?? {};
    expect(Object.keys(env).sort()).toEqual(['AGENT_CWD', 'AGENT_SESSION_ID', 'HOME', 'PATH']);
    expect(env.AGENT_SESSION_ID).toBe('');
  });

  test('command is run via sh -c with template-expanded literal', async () => {
    const capture = { calls: [] as { cmd: string[]; opts: SpawnOpts; stdin: string }[] };
    const fake = makeFakeSpawn({ exitCode: 0 }, capture);
    await dispatchOne(makeSpec({ command: 'echo {{event}}' }), 0, makePayload(), '/cwd', {
      spawn: fake,
    });
    expect(capture.calls[0]?.cmd).toEqual(['sh', '-c', "echo 'PostToolUse'"]);
  });
});

describe('dispatchOne — audit emission', () => {
  test('writes a hook_runs row with classified outcome', async () => {
    const db = openMemoryDb();
    migrate(db);
    const sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
    const fake = makeFakeSpawn({ exitCode: 0, stdout: 'OK' });
    await dispatchOne(makeSpec({ command: 'echo hi' }), 3, makePayload(), '/p', {
      db,
      sessionId,
      spawn: fake,
      now: () => 5000,
    });
    const rows = listHookRunsBySession(db, sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toBe('PostToolUse');
    expect(rows[0]?.layer).toBe('project');
    expect(rows[0]?.command).toBe('echo hi');
    expect(rows[0]?.expanded).toBe('echo hi'); // no placeholders
    expect(rows[0]?.outcome).toBe('allow');
    expect(rows[0]?.exitCode).toBe(0);
    expect(rows[0]?.hookIndex).toBe(3);
    expect(rows[0]?.matchedTool).toBe('write_file');
  });

  test('timeout writes outcome=timeout with exit_code=124 (POSIX timeout(1) convention)', async () => {
    // CONTRACTS.md §3 line 725: timeouts record exit_code 124,
    // not the killed-process's signal-derived code (143/137).
    // Earlier cut wrote null here, diverging from spec.
    const db = openMemoryDb();
    migrate(db);
    const sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
    const fake = makeFakeSpawn({ exitCode: 0, delayMs: 200, killImmediate: true });
    await dispatchOne(makeSpec({ timeoutMs: 50 }), 0, makePayload(), '/p', {
      db,
      sessionId,
      spawn: fake,
    });
    const rows = listHookRunsBySession(db, sessionId);
    expect(rows[0]?.outcome).toBe('timeout');
    expect(rows[0]?.exitCode).toBe(124);
  });
});

// ─── dispatchChain ────────────────────────────────────────────────────

describe('dispatchChain — non-blocking events', () => {
  test('runs every matching hook regardless of outcome', async () => {
    const fake = makeFakeSpawn({ exitCode: 1 }); // would block on a blocking event
    const hooks = [
      makeSpec({ event: 'Stop', command: 'h1' }),
      makeSpec({ event: 'Stop', command: 'h2' }),
    ];
    const payload = {
      schema: 'v1',
      event: 'Stop',
      sessionId: 'sess',
      data: { durationMs: 100, costUsd: 0.01, steps: 5 },
    } as HookEventPayload;
    const result = await dispatchChain(hooks, payload, '/cwd', { spawn: fake });
    expect(result.runs).toHaveLength(2);
    expect(result.blockedBy).toBeNull();
  });
});

describe('dispatchChain — blocking events', () => {
  test('first block_silent halts the chain', async () => {
    const fake = makeFakeSpawn({ exitCode: 1 });
    const hooks = [
      makeSpec({ event: 'PreToolUse', command: 'h1' }),
      makeSpec({ event: 'PreToolUse', command: 'h2' }),
    ];
    const payload = {
      schema: 'v1',
      event: 'PreToolUse',
      sessionId: 'sess',
      data: { tool: { name: 'bash', input: {} } },
    } as HookEventPayload;
    const result = await dispatchChain(hooks, payload, '/cwd', { spawn: fake });
    expect(result.runs).toHaveLength(1);
    expect(result.blockedBy?.spec.command).toBe('h1');
    expect(result.blockedBy?.reason).toBe('silent');
  });

  test('first block_message returns the stdout reason', async () => {
    const fake = makeFakeSpawn({ exitCode: 2, stdout: 'forbidden tool' });
    const hooks = [makeSpec({ event: 'PreToolUse', command: 'audit' })];
    const payload = {
      schema: 'v1',
      event: 'PreToolUse',
      sessionId: 'sess',
      data: { tool: { name: 'bash', input: {} } },
    } as HookEventPayload;
    const result = await dispatchChain(hooks, payload, '/cwd', { spawn: fake });
    expect(result.blockedBy?.reason).toBe('message');
    expect(result.blockedBy?.message).toBe('forbidden tool');
  });

  test('failClosed error blocks the chain on a blocking event (silent)', async () => {
    // Per HookRunResult.shouldBlock contract (types.ts:198), a
    // fail-closed error must propagate as `block_silent` — never
    // leak the dispatcher's internal `result.reason` text into
    // the model-facing chain.blockedBy.message. Internal exit
    // codes / crash strings stay in the audit row only.
    const fake = makeFakeSpawn({ exitCode: 5 });
    const hooks = [
      makeSpec({ event: 'PreToolUse', command: 'h1', failClosed: true }),
      makeSpec({ event: 'PreToolUse', command: 'h2' }),
    ];
    const payload = {
      schema: 'v1',
      event: 'PreToolUse',
      sessionId: 'sess',
      data: { tool: { name: 'bash', input: {} } },
    } as HookEventPayload;
    const result = await dispatchChain(hooks, payload, '/cwd', { spawn: fake });
    expect(result.runs).toHaveLength(1);
    expect(result.blockedBy?.spec.command).toBe('h1');
    expect(result.blockedBy?.reason).toBe('silent');
    expect(result.blockedBy?.message).toBeNull();
  });

  test('non-failClosed error continues to next hook', async () => {
    let call = 0;
    const fake: SpawnFn = (cmd, opts) => {
      call++;
      const exitCode = call === 1 ? 5 : 0;
      return makeFakeSpawn({ exitCode })(cmd, opts);
    };
    const hooks = [
      makeSpec({ event: 'PreToolUse', command: 'h1' }), // exit 5, no failClosed
      makeSpec({ event: 'PreToolUse', command: 'h2' }), // exit 0
    ];
    const payload = {
      schema: 'v1',
      event: 'PreToolUse',
      sessionId: 'sess',
      data: { tool: { name: 'bash', input: {} } },
    } as HookEventPayload;
    const result = await dispatchChain(hooks, payload, '/cwd', { spawn: fake });
    expect(result.runs).toHaveLength(2);
    expect(result.blockedBy).toBeNull();
  });

  test('chain timeout (15s wall-clock) skips remaining hooks', async () => {
    // CONTRACTS.md §10 line 1040: blockable-event chain has a
    // wall-clock cap of 15s. Inject a clock that jumps past
    // the cap between hooks to verify the chain breaks.
    const fake = makeFakeSpawn({ exitCode: 0 });
    const hooks = [
      makeSpec({ event: 'PreToolUse', command: 'h1' }),
      makeSpec({ event: 'PreToolUse', command: 'h2' }),
      makeSpec({ event: 'PreToolUse', command: 'h3' }),
    ];
    const payload = {
      schema: 'v1',
      event: 'PreToolUse',
      sessionId: 'sess',
      data: { tool: { name: 'bash', input: {} } },
    } as HookEventPayload;
    // Clock layout matching the dispatcher's `now()` calls.
    // dispatchChain calls now() at start + once per iteration
    // for the cap check; dispatchOne calls now() twice per run
    // (startedAt + durationMs). For 2 hooks to run before the
    // cap fires on iter 3, we need: chainStart (0), iter0
    // check (under), h1 dispatch (×2), iter1 check (under), h2
    // dispatch (×2), iter2 check (OVER).
    let callIdx = 0;
    const clockValues = [0, 100, 200, 300, 400, 500, 600, 16000];
    const now = (): number => clockValues[callIdx++] ?? 16000;
    const errs: string[] = [];
    const writeOrig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array): boolean => {
      if (typeof s === 'string') errs.push(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = await dispatchChain(hooks, payload, '/cwd', { spawn: fake, now });
      // h1 + h2 ran (chainStart=0, after h2 now=16000 → break
      // before h3).
      expect(result.runs).toHaveLength(2);
      expect(result.blockedBy).toBeNull();
      expect(errs.some((e) => e.includes('chain for PreToolUse exceeded'))).toBe(true);
    } finally {
      process.stderr.write = writeOrig;
    }
  });

  test('matcher mismatch skips the hook entirely', async () => {
    const fake = makeFakeSpawn({ exitCode: 1 });
    const hooks = [
      makeSpec({ event: 'PreToolUse', matcher: { tool: 'write_file' }, command: 'h1' }),
      makeSpec({ event: 'PreToolUse', command: 'h2' }),
    ];
    const payload = {
      schema: 'v1',
      event: 'PreToolUse',
      sessionId: 'sess',
      data: { tool: { name: 'bash', input: {} } },
    } as HookEventPayload;
    const result = await dispatchChain(hooks, payload, '/cwd', { spawn: fake });
    // h1 matcher='write_file' mismatches bash → skipped; h2 runs
    // and returns block_silent.
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.spec.command).toBe('h2');
    expect(result.blockedBy?.spec.command).toBe('h2');
  });

  test('hook_index in audit reflects source-file position, not filter index', async () => {
    // Earlier cut passed `i` (the filtered-array index) into
    // dispatchOne. With matcher filtering, the audit row's
    // hook_index would mismatch the operator's source-file
    // position whenever a non-matching hook appeared earlier
    // in the file. Sanity-revert: spec.entryIndex is now the
    // canonical source — must propagate to hook_runs.
    const db = openMemoryDb();
    migrate(db);
    const sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
    const fake = makeFakeSpawn({ exitCode: 0 });

    // Hooks as they appear in hooks.toml:
    //   #0 → write_file matcher (won't match bash)
    //   #1 → no matcher (matches bash)
    // After filter: only #1 runs. Naive iteration would record
    // hook_index=0 (the index in `matching`); correct is 1
    // (entryIndex from the source file).
    const hooks = [
      makeSpec({ event: 'PreToolUse', matcher: { tool: 'write_file' }, entryIndex: 0 }),
      makeSpec({ event: 'PreToolUse', matcher: {}, entryIndex: 1 }),
    ];
    const payload = {
      schema: 'v1',
      event: 'PreToolUse',
      sessionId,
      data: { tool: { name: 'bash', input: {} } },
    } as HookEventPayload;
    await dispatchChain(hooks, payload, '/p', { db, sessionId, spawn: fake });

    const rows = listHookRunsBySession(db, sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hookIndex).toBe(1);
  });
});
