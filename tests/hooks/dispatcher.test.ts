import { describe, expect, test } from 'bun:test';
import {
  STREAM_READ_CAP_BYTES,
  _readStreamForTests,
  dispatchChain,
  dispatchOne,
  filterMatchingHooks,
  resolveHookShell,
} from '../../src/hooks/dispatcher.ts';
import type {
  DispatchedProcess,
  HookShellResolution,
  SpawnFn,
  SpawnOpts,
} from '../../src/hooks/dispatcher.ts';
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
    // Inject a shell so the test doesn't depend on the
    // module-level cached resolution (which probes the real
    // PATH and returns absolute paths).
    const shell: HookShellResolution = {
      kind: 'posix',
      argv: ['sh', '-c'],
      sourcePath: 'sh',
    };
    await dispatchOne(makeSpec({ command: 'echo {{event}}' }), 0, makePayload(), '/cwd', {
      spawn: fake,
      shell,
    });
    expect(capture.calls[0]?.cmd).toEqual(['sh', '-c', "echo 'PostToolUse'"]);
  });

  test('cmd.exe shell wraps with /c and the expanded command', async () => {
    // Verifies the Windows fallback path threads through
    // dispatchOne. The fake spawn captures the argv shape so
    // we can assert without actually running cmd.exe (test
    // runs on Linux).
    const capture = { calls: [] as { cmd: string[]; opts: SpawnOpts; stdin: string }[] };
    const fake = makeFakeSpawn({ exitCode: 0 }, capture);
    const shell: HookShellResolution = {
      kind: 'cmd',
      argv: ['C:\\Windows\\System32\\cmd.exe', '/c'],
      sourcePath: 'C:\\Windows\\System32\\cmd.exe',
    };
    await dispatchOne(makeSpec({ command: 'echo hello' }), 0, makePayload(), '/cwd', {
      spawn: fake,
      shell,
    });
    expect(capture.calls[0]?.cmd).toEqual(['C:\\Windows\\System32\\cmd.exe', '/c', 'echo hello']);
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

  test('per-hook timeout clamped to remaining chain budget', async () => {
    // Sanity-revert: pre-fix, the chain checked `elapsed > 15s`
    // before launching each hook but never bounded that hook's
    // own timeout against the remaining budget. A hook starting
    // at t=14.9s with `timeout_ms=30000` would run to t=44.9s,
    // 30s past the advertised wall-clock cap.
    //
    // Inject a clock that lies about elapsed time so we can
    // verify the clamp without sleeping 14.9s in the test:
    //   - chainStarted: 0
    //   - iter 0 elapsed check: 0     (h1 starts)
    //   - h1 dispatchOne now ×2: 0, 0 (instant exit)
    //   - iter 1 elapsed check: 14900 (under cap, but remaining=100ms)
    //   - h2 dispatchOne now ×2: 14900, 14900 (timeout fires)
    let callIdx = 0;
    const clockValues = [0, 0, 0, 0, 14_900, 14_900, 14_900];
    const now = (): number => clockValues[callIdx++] ?? 14_900;

    // h1: returns immediately. h2: would never exit naturally
    // (delayMs huge); killImmediate=true means our SIGTERM kill
    // resolves the fake. WITHOUT the clamp, h2's
    // spec.timeoutMs=30000 timer would fire 30s real-time later.
    // WITH the clamp, h2's effectiveTimeoutMs=100ms fires fast.
    const fakeH1 = makeFakeSpawn({ exitCode: 0, delayMs: 0 });
    const fakeH2 = makeFakeSpawn({ exitCode: 0, delayMs: 60_000, killImmediate: true });
    let spawnCount = 0;
    const fake: SpawnFn = (cmd, opts) => {
      spawnCount += 1;
      return spawnCount === 1 ? fakeH1(cmd, opts) : fakeH2(cmd, opts);
    };

    const hooks = [
      makeSpec({ event: 'PreToolUse', command: 'h1', timeoutMs: 5_000 }),
      makeSpec({ event: 'PreToolUse', command: 'h2', timeoutMs: 30_000, failClosed: true }),
    ];
    const payload = {
      schema: 'v1',
      event: 'PreToolUse',
      sessionId: 'sess',
      data: { tool: { name: 'bash', input: {} } },
    } as HookEventPayload;

    const start = Date.now();
    const result = await dispatchChain(hooks, payload, '/cwd', { spawn: fake, now });
    const realElapsed = Date.now() - start;

    expect(result.runs).toHaveLength(2);
    const h2 = result.runs[1]?.result;
    expect(h2?.kind).toBe('timeout');
    if (h2?.kind === 'timeout') {
      // Clamped to remaining = 15000 - 14900 = 100ms (NOT 30000).
      expect(h2.timeoutMs).toBe(100);
    }
    // Real wall-clock should be around the clamped timeout +
    // dispatcher overhead — orders of magnitude under
    // spec.timeoutMs=30000. Generous bound (3s) so a slow CI
    // doesn't flake.
    expect(realElapsed).toBeLessThan(3_000);
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

describe('resolveHookShell', () => {
  // Tests inject `which` and `platform` so a Linux runner can
  // verify the Windows-fallback path without actually being on
  // Windows.

  test('POSIX host with sh on PATH → posix kind, sh -c', () => {
    const r = resolveHookShell({
      platform: 'linux',
      which: (b) => (b === 'sh' ? '/bin/sh' : null),
      env: {},
    });
    expect(r.kind).toBe('posix');
    if (r.kind === 'posix') {
      expect(r.argv).toEqual(['/bin/sh', '-c']);
    }
  });

  test('POSIX host without sh, falls back to bash', () => {
    const r = resolveHookShell({
      platform: 'linux',
      which: (b) => (b === 'bash' ? '/usr/bin/bash' : null),
      env: {},
    });
    expect(r.kind).toBe('posix');
    if (r.kind === 'posix') {
      expect(r.argv).toEqual(['/usr/bin/bash', '-c']);
    }
  });

  test('POSIX host without sh OR bash → unavailable', () => {
    const r = resolveHookShell({
      platform: 'linux',
      which: () => null,
      env: {},
    });
    expect(r.kind).toBe('unavailable');
  });

  test('Windows host with Git Bash sh on PATH → posix kind', () => {
    const r = resolveHookShell({
      platform: 'win32',
      which: (b) => (b === 'sh' ? 'C:\\Program Files\\Git\\bin\\sh.exe' : null),
      env: {},
    });
    expect(r.kind).toBe('posix');
  });

  test('Windows host without sh/bash → cmd.exe fallback', () => {
    const r = resolveHookShell({
      platform: 'win32',
      which: (b) => (b === 'cmd.exe' ? 'C:\\Windows\\System32\\cmd.exe' : null),
      env: {},
    });
    expect(r.kind).toBe('cmd');
    if (r.kind === 'cmd') {
      expect(r.argv).toEqual(['C:\\Windows\\System32\\cmd.exe', '/c']);
    }
  });

  test('FORJA_HOOK_SHELL override wins (custom binary on PATH)', () => {
    const r = resolveHookShell({
      platform: 'linux',
      which: (b) => (b === '/opt/dash' ? '/opt/dash' : b === 'sh' ? '/bin/sh' : null),
      env: { FORJA_HOOK_SHELL: '/opt/dash -c' },
    });
    // Auto-detect would have picked /bin/sh; override forces dash.
    expect(r.kind).toBe('posix');
    if (r.kind === 'posix') {
      expect(r.argv).toEqual(['/opt/dash', '-c']);
    }
  });

  test('FORJA_HOOK_SHELL override pointing at missing binary → unavailable', () => {
    const r = resolveHookShell({
      platform: 'linux',
      which: () => null,
      env: { FORJA_HOOK_SHELL: '/nope' },
    });
    expect(r.kind).toBe('unavailable');
    if (r.kind === 'unavailable') {
      expect(r.reason).toContain('FORJA_HOOK_SHELL');
    }
  });

  test('FORJA_HOOK_SHELL pointing at cmd → cmd kind regardless of platform', () => {
    const r = resolveHookShell({
      platform: 'linux',
      which: (b) => (b === 'cmd.exe' ? '/wine/cmd.exe' : null),
      env: { FORJA_HOOK_SHELL: 'cmd.exe /c' },
    });
    expect(r.kind).toBe('cmd');
  });

  test('FORJA_HOOK_SHELL preserves multi-arg flags (powershell case)', () => {
    // PowerShell needs `-NoProfile -Command` BEFORE the command
    // string for the next arg to be evaluated as code instead
    // of a script-file path. An earlier cut split on
    // whitespace and only kept parts[0] + parts[1] — the
    // `-Command` flag would silently disappear, breaking
    // PowerShell-as-shell entirely.
    const r = resolveHookShell({
      platform: 'win32',
      which: (b) => (b === 'powershell' ? 'C:\\Windows\\System32\\powershell.exe' : null),
      env: { FORJA_HOOK_SHELL: 'powershell -NoProfile -Command' },
    });
    expect(r.kind).toBe('posix');
    if (r.kind === 'posix') {
      expect(r.argv).toEqual(['C:\\Windows\\System32\\powershell.exe', '-NoProfile', '-Command']);
    }
  });

  test('FORJA_HOOK_SHELL with double-quoted path-with-spaces (Windows)', () => {
    // Sanity-revert: pre-fix, raw whitespace split shredded the
    // quoted Windows path `"C:\Program Files\Git\bin\bash.exe"`
    // into 3 tokens (`"C:\Program`, `Files\Git\bin\bash.exe"`,
    // `-lc`). `which` lookup against the first token failed and
    // hooks degraded to "shell unavailable" silently. Fix
    // honors POSIX shell quoting in the env override.
    const fullPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const r = resolveHookShell({
      platform: 'win32',
      which: (b) => (b === fullPath ? fullPath : null),
      env: { FORJA_HOOK_SHELL: `"${fullPath}" -lc` },
    });
    expect(r.kind).toBe('posix');
    if (r.kind === 'posix') {
      expect(r.argv).toEqual([fullPath, '-lc']);
    }
  });

  test('FORJA_HOOK_SHELL with single-quoted path-with-spaces', () => {
    const fullPath = '/Library/Application Support/agent/bin/sh';
    const r = resolveHookShell({
      platform: 'darwin',
      which: (b) => (b === fullPath ? fullPath : null),
      env: { FORJA_HOOK_SHELL: `'${fullPath}' -c` },
    });
    expect(r.kind).toBe('posix');
    if (r.kind === 'posix') {
      expect(r.argv).toEqual([fullPath, '-c']);
    }
  });

  test('FORJA_HOOK_SHELL quoted args alongside unquoted bin', () => {
    // Operator may quote a single arg (e.g. one with embedded
    // spaces) while leaving others bare. Splitter must keep
    // each quoted span as a single token regardless of
    // position.
    const r = resolveHookShell({
      platform: 'linux',
      which: (b) => (b === 'sh' ? '/bin/sh' : null),
      env: { FORJA_HOOK_SHELL: 'sh -c "echo hello"' },
    });
    expect(r.kind).toBe('posix');
    if (r.kind === 'posix') {
      expect(r.argv).toEqual(['/bin/sh', '-c', 'echo hello']);
    }
  });

  test('FORJA_HOOK_SHELL unterminated quote consumes to end (lenient)', () => {
    // Operator typo: closing quote omitted. Strict POSIX would
    // error; we'd rather recover gracefully — accumulate the
    // remainder as the open token and let `which` decide if
    // the binary exists.
    const r = resolveHookShell({
      platform: 'linux',
      which: (b) => (b === '/bad path with no close' ? null : null),
      env: { FORJA_HOOK_SHELL: '"/bad path with no close' },
    });
    expect(r.kind).toBe('unavailable');
    if (r.kind === 'unavailable') {
      // Reason mentions the bin name (the recovered token), not
      // a parse-error message — this is operator-friendly.
      expect(r.reason).toContain('/bad path with no close');
    }
  });
});

describe('readStream — OOM cap', () => {
  // Sanity-revert: pre-fix, the loop pushed the FULL chunk
  // before checking total. A single 1MB chunk arriving from a
  // chatty hook would be fully buffered in memory before the
  // post-push check broke the loop — defeating the OOM guard.
  // Fix slices each chunk to the remaining budget BEFORE
  // pushing.

  test('single chunk larger than cap is sliced; final string respects cap', async () => {
    // 64 KB chunk vs 16 KB cap → final string must be 16 KB.
    const big = new Uint8Array(64 * 1024).fill(65); // 'A' × 64KB
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    const result = await _readStreamForTests(stream);
    // UTF-8 'A' is 1 byte each, so byteLength === string length.
    expect(result.length).toBe(STREAM_READ_CAP_BYTES);
    expect(new TextEncoder().encode(result).byteLength).toBe(STREAM_READ_CAP_BYTES);
  });

  test('many small chunks summing past cap stop at the budget', async () => {
    // 100 chunks × 1KB = 100KB, cap 16KB → result is exactly
    // 16KB, no overrun.
    const chunkSize = 1024;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 100; i += 1) {
          controller.enqueue(new Uint8Array(chunkSize).fill(66));
        }
        controller.close();
      },
    });
    const result = await _readStreamForTests(stream);
    expect(result.length).toBe(STREAM_READ_CAP_BYTES);
  });

  test('chunks summing under cap are read fully (no early break)', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello '));
        controller.enqueue(new TextEncoder().encode('world'));
        controller.close();
      },
    });
    const result = await _readStreamForTests(stream);
    expect(result).toBe('hello world');
  });

  test('empty stream returns empty string', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const result = await _readStreamForTests(stream);
    expect(result).toBe('');
  });
});

describe('dispatchChain — shell unavailable short-circuits', () => {
  test('hooks present but shell unavailable → empty chain, no audit row, no spawn', async () => {
    // Sanity-revert: pre-fix, sh-not-found on Windows would
    // throw ENOENT mid-dispatch, surface as kind='error', and
    // failClosed=true would wrongly deny normal operations.
    // The chain now detects shell-unavailable and returns an
    // empty result — failClosed has nothing to gate against.
    const db = openMemoryDb();
    migrate(db);
    const sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
    let spawnCalled = 0;
    const fakeSpawn: SpawnFn = (() => {
      spawnCalled += 1;
      throw new Error('spawn must NOT be called when shell is unavailable');
    }) as SpawnFn;
    const unavailable: HookShellResolution = {
      kind: 'unavailable',
      reason: 'no POSIX shell on PATH',
    };
    const hooks = [makeSpec({ event: 'PreToolUse', command: 'rm -rf /', failClosed: true })];
    const payload = {
      schema: 'v1',
      event: 'PreToolUse',
      sessionId,
      data: { tool: { name: 'bash', input: {} } },
    } as HookEventPayload;
    const result = await dispatchChain(hooks, payload, '/p', {
      db,
      sessionId,
      spawn: fakeSpawn,
      shell: unavailable,
    });
    expect(spawnCalled).toBe(0);
    expect(result.runs).toEqual([]);
    // Critically: blockedBy stays null even though the spec had
    // failClosed=true. Operator's failClosed hook does NOT
    // wrongly deny because the hook simply did not run.
    expect(result.blockedBy).toBeNull();
    // No audit row written for skipped hooks.
    expect(listHookRunsBySession(db, sessionId)).toEqual([]);
  });

  test('zero matching hooks → no warning, no spawn (no false alarm)', async () => {
    const db = openMemoryDb();
    migrate(db);
    const sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
    const unavailable: HookShellResolution = {
      kind: 'unavailable',
      reason: 'no shell',
    };
    const hooks: HookSpec[] = [];
    const payload = {
      schema: 'v1',
      event: 'PreToolUse',
      sessionId,
      data: { tool: { name: 'bash', input: {} } },
    } as HookEventPayload;
    const result = await dispatchChain(hooks, payload, '/p', { db, sessionId, shell: unavailable });
    expect(result.runs).toEqual([]);
    expect(result.blockedBy).toBeNull();
  });
});
