import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ParsedArgs } from '../../src/cli/args.ts';
import type { BootstrapResult } from '../../src/cli/bootstrap.ts';
import { runRepl } from '../../src/cli/repl.ts';
import type { HarnessConfig, HarnessEvent, HarnessResult } from '../../src/harness/index.ts';
import { DEFAULT_BUDGET } from '../../src/harness/types.ts';

// Build a ParsedArgs shape with all the flags the REPL inspects set
// to safe defaults. The args parser populates the rest with defaults
// of its own; here we only need the fields runRepl reads.
const makeArgs = (overrides: Partial<ParsedArgs> = {}): ParsedArgs => ({
  prompt: '',
  json: false,
  help: false,
  version: false,
  yes: false,
  plan: false,
  listSessions: false,
  includeSubagents: false,
  ...overrides,
});

// Minimal fake stdin: an EventEmitter (reused for `on`/`off`/
// `removeListener`) plus stub pause/resume. `feed` pushes a string
// as a 'data' chunk so we can drive keystrokes. NodeJS.ReadStream is
// a much wider interface but the REPL only touches `on`, `resume`,
// `pause`, `removeListener` — covered by EventEmitter + the two
// stubs.
const makeStdin = (): NodeJS.ReadStream & { feed: (s: string) => void } => {
  const ee = new EventEmitter() as EventEmitter & {
    feed: (s: string) => void;
    resume: () => unknown;
    pause: () => unknown;
  };
  ee.feed = (s: string): void => {
    ee.emit('data', Buffer.from(s, 'utf-8'));
  };
  ee.resume = () => ee;
  ee.pause = () => ee;
  return ee as unknown as NodeJS.ReadStream & { feed: (s: string) => void };
};

// Stub the heavy bits bootstrap normally constructs. The REPL touches
// `config`, `db.close`, `modelId`, `lockConflicts`, `subagents`, plus
// `config.provider.capabilities` and `config.enableCheckpoints` for
// the boot banner. The harness override means runAgent never reads
// anything else, so a hollow config object is enough.
const makeBootstrapStub = (cwd = '/tmp/forja-repl-test'): BootstrapResult => {
  const noop = (): void => undefined;
  const fakeDb = { close: noop } as unknown as BootstrapResult['db'];
  const config = {
    cwd,
    userPrompt: '',
    budget: { ...DEFAULT_BUDGET },
    enableCheckpoints: false,
    provider: {
      capabilities: { context_window: 200000, output_max_tokens: 4096 },
    },
  } as unknown as HarnessConfig;
  return {
    config,
    db: fakeDb,
    modelId: 'mock/m',
    policyLayers: [],
    lockConflicts: [],
    subagents: { byName: new Map(), shadows: [] } as unknown as BootstrapResult['subagents'],
  };
};

// Captured side-effects from the REPL run.
interface CapturedRun {
  configs: HarnessConfig[];
  emit: (event: HarnessEvent) => void;
}

// runAgent override that records the cfg it was called with and
// exposes a hook for the test to drive HarnessEvents into the
// adapter via cfg.onEvent. Each call resolves with a result whose
// sessionId is monotonic so we can assert resume threading.
const makeRunAgent = (
  resolveSession: (n: number) => string,
): {
  runAgent: (cfg: HarnessConfig) => Promise<HarnessResult>;
  captured: CapturedRun[];
  emitInto: (idx: number, event: HarnessEvent) => void;
  finish: (idx: number, override?: Partial<HarnessResult>) => void;
} => {
  const captured: CapturedRun[] = [];
  let nextN = 1;
  const pendingResolves: Array<(override: Partial<HarnessResult>) => void> = [];

  const buildResult = (sessionId: string, override: Partial<HarnessResult>): HarnessResult => {
    const base: HarnessResult = {
      status: 'done',
      reason: 'done',
      sessionId,
      steps: 1,
      durationMs: 1,
      usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
      costUsd: 0,
      usageComplete: true,
    };
    return { ...base, ...override };
  };

  return {
    runAgent: (cfg: HarnessConfig): Promise<HarnessResult> => {
      const n = nextN++;
      const sessionId = resolveSession(n);
      captured.push({ configs: [cfg], emit: (event) => cfg.onEvent?.(event) });
      return new Promise<HarnessResult>((resolve) => {
        pendingResolves.push((override) => resolve(buildResult(sessionId, override)));
      });
    },
    captured,
    emitInto: (idx, event) => captured[idx]?.emit(event),
    finish: (idx, override) => {
      const r = pendingResolves[idx];
      if (r === undefined) throw new Error(`no pending run at ${idx}`);
      r(override ?? {});
    },
  };
};

// Allow microtasks to settle. The REPL chains promise handlers off
// runAgent; awaiting `tick` between actions lets those handlers fire.
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('repl — boot + smoke', () => {
  // process.on('SIGINT', ...) leaks across tests if we don't clean
  // up. The REPL removes its handler on shutdown, but a test that
  // doesn't shut down cleanly would leave one behind.
  afterEach(() => {
    process.removeAllListeners('SIGINT');
  });

  test('refuses to start without a TTY when skipTtyCheck is false', async () => {
    let stderr = '';
    const code = await runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin: makeStdin(),
      errSink: (s) => {
        stderr += s;
      },
    });
    expect(code).toBe(1);
    expect(stderr).toContain('TTY');
  });

  test('skipTtyCheck=true lets the REPL boot and exits on empty Ctrl+C', async () => {
    const stdin = makeStdin();
    const closes: number[] = [];
    const stub = makeBootstrapStub();
    (stub.db as unknown as { close: () => void }).close = () => {
      closes.push(1);
    };
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
    });
    // Empty buffer + Ctrl+C → exit with code 0.
    await tick();
    stdin.feed('\x03');
    const code = await promise;
    expect(code).toBe(0);
    expect(closes).toHaveLength(1);
  });

  test('boot emits welcome banner with correct content + omits empty env entries', async () => {
    // Stub has subagents: 0 + enableCheckpoints: false → both env
    // entries should be omitted (banner has 3 lines, no env).
    const stdin = makeStdin();
    const writes: string[] = [];
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub('/path/to/repo'),
      stdin,
      skipTtyCheck: true,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    // Wait for the boot banner emit + initial frame to flush
    // through the renderer's frame scheduler. Two ticks are enough
    // for the bus → reducer → write chain.
    await tick();
    await tick();
    const all = writes.join('');
    expect(all).toContain('forja 0.0.0');
    expect(all).toContain('mock/m');
    expect(all).toContain('200,000 ctx');
    expect(all).toContain('max 4096 out');
    expect(all).toContain('/path/to/repo');
    // No env line because both subagents and checkpoints were
    // empty/disabled (D68 — omit when nothing to summarize).
    expect(all).not.toContain('subagents');
    expect(all).not.toContain('checkpoints');
    stdin.feed('\x03');
    expect(await promise).toBe(0);
  });

  test('typed prompt + Enter triggers runAgent with the typed text', async () => {
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      runAgentOverride: ra.runAgent,
    });
    await tick();
    stdin.feed('hi\r');
    await tick();
    expect(ra.captured).toHaveLength(1);
    expect(ra.captured[0]?.configs[0]?.userPrompt).toBe('hi');
    // First turn has no resumeFromSessionId.
    expect(ra.captured[0]?.configs[0]?.resumeFromSessionId).toBeUndefined();
    // Wrap up.
    ra.finish(0);
    await tick();
    stdin.feed('\x03');
    expect(await promise).toBe(0);
  });

  test('subsequent turns thread the prior sessionId via resumeFromSessionId', async () => {
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      runAgentOverride: ra.runAgent,
    });
    await tick();
    // Turn 1.
    stdin.feed('first\r');
    await tick();
    ra.finish(0);
    await tick();
    // Turn 2.
    stdin.feed('second\r');
    await tick();
    expect(ra.captured).toHaveLength(2);
    expect(ra.captured[1]?.configs[0]?.userPrompt).toBe('second');
    expect(ra.captured[1]?.configs[0]?.resumeFromSessionId).toBe('sess-1');
    ra.finish(1);
    await tick();
    stdin.feed('\x03');
    expect(await promise).toBe(0);
  });

  test('Enter is ignored while a turn is in flight (no double-run)', async () => {
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      runAgentOverride: ra.runAgent,
    });
    await tick();
    stdin.feed('a\r');
    await tick();
    expect(ra.captured).toHaveLength(1);
    // Type more + Enter while still running. Should NOT spawn a 2nd run.
    // The typed character DOES accumulate in the buffer (the editor is
    // still live so the user can compose the next prompt while the
    // current one runs); the in-flight Enter is just ignored.
    stdin.feed('b\r');
    await tick();
    expect(ra.captured).toHaveLength(1);
    // Finish the first run; the next Enter then submits whatever was
    // accumulated. With 'b' typed during the run, the buffer is 'b'.
    ra.finish(0);
    await tick();
    stdin.feed('\r');
    await tick();
    expect(ra.captured).toHaveLength(2);
    expect(ra.captured[1]?.configs[0]?.userPrompt).toBe('b');
    ra.finish(1);
    await tick();
    stdin.feed('\x03');
    expect(await promise).toBe(0);
  });

  test('Esc during a turn aborts via the harness signal', async () => {
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      runAgentOverride: ra.runAgent,
    });
    await tick();
    stdin.feed('go\r');
    await tick();
    const signal = ra.captured[0]?.configs[0]?.signal;
    expect(signal?.aborted).toBe(false);
    // The parser buffers a lone ESC (it could be the start of a CSI
    // sequence). Feed ESC ESC so the first ESC flushes as a complete
    // 'escape' key event — the editor surfaces interruptSoft → REPL
    // calls AbortController.abort().
    stdin.feed('\x1b\x1b');
    await tick();
    expect(signal?.aborted).toBe(true);
    ra.finish(0, { status: 'interrupted', reason: 'aborted' });
    await tick();
    stdin.feed('\x03');
    expect(await promise).toBe(0);
  });

  test('shutdown during a running turn awaits the run before closing the DB', async () => {
    // The REPL must NOT close the DB while runAgent is still
    // running: the harness's async cleanup (final persistence,
    // audit) can write after the abort signal flips. shutdown
    // awaits the in-flight promise before db.close. Test asserts
    // ordering by recording the sequence: abort → run's resolve →
    // db.close.
    const stdin = makeStdin();
    const events: string[] = [];
    const stub = makeBootstrapStub();
    (stub.db as unknown as { close: () => void }).close = () => {
      events.push('db.close');
    };
    const fakeRunAgent = (cfg: HarnessConfig): Promise<HarnessResult> =>
      new Promise<HarnessResult>((resolve) => {
        cfg.signal?.addEventListener('abort', () => {
          events.push('signal.abort');
          // Simulate harness cleanup taking a couple of microtasks
          // before resolving — gives db.close a window to race if
          // shutdown didn't await runningPromise.
          queueMicrotask(() =>
            queueMicrotask(() => {
              events.push('run.resolve');
              resolve({
                status: 'interrupted',
                reason: 'aborted',
                sessionId: 'sess-1',
                steps: 1,
                durationMs: 1,
                usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
                costUsd: 0,
                usageComplete: true,
              });
            }),
          );
        });
      });
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      runAgentOverride: fakeRunAgent,
    });
    await tick();
    stdin.feed('go\r');
    await tick();
    // First SIGINT while running → just aborts the run.
    process.emit('SIGINT');
    await tick();
    await tick();
    // Run has resolved (after the queued microtasks). Second SIGINT
    // exits cleanly. The shutdown path awaits the run promise (which
    // is already resolved at this point but the await is still needed
    // for the race-free shape).
    process.emit('SIGINT');
    expect(await promise).toBe(130);
    // Critical ordering: db.close fires AFTER the run resolved.
    const dbCloseIdx = events.indexOf('db.close');
    const runResolveIdx = events.indexOf('run.resolve');
    expect(runResolveIdx).toBeGreaterThan(-1);
    expect(dbCloseIdx).toBeGreaterThan(runResolveIdx);
  });

  test('error thrown by runAgent surfaces as an error UIEvent and lets the REPL continue', async () => {
    const stdin = makeStdin();
    const resolvers: Array<(r: HarnessResult) => void> = [];
    const captured: HarnessConfig[] = [];
    const fakeRunAgent = (cfg: HarnessConfig): Promise<HarnessResult> => {
      captured.push(cfg);
      // First call rejects; second stays pending until the test resolves it.
      if (captured.length === 1) return Promise.reject(new Error('boom'));
      return new Promise<HarnessResult>((resolve) => {
        resolvers.push(resolve);
      });
    };
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      runAgentOverride: fakeRunAgent,
    });
    await tick();
    stdin.feed('first\r');
    // Allow the rejection to settle through .catch + .finally.
    await tick();
    await tick();
    // After the failure the REPL is no longer running; a new prompt
    // must succeed.
    stdin.feed('second\r');
    await tick();
    expect(captured).toHaveLength(2);
    expect(captured[1]?.userPrompt).toBe('second');
    // Tear down: resolve the pending second-run promise.
    const resolve = resolvers[0];
    if (resolve === undefined) throw new Error('expected a pending resolver');
    resolve({
      status: 'done',
      reason: 'done',
      sessionId: 'sess-2',
      steps: 1,
      durationMs: 1,
      usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
      costUsd: 0,
      usageComplete: true,
    });
    await tick();
    stdin.feed('\x03');
    expect(await promise).toBe(0);
  });
});
