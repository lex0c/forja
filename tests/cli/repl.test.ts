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
      id: 'mock/m',
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

// Wait long enough for the renderer's frame scheduler to fire
// (default 33ms at 30fps). Use this when assertions depend on a
// live-region redraw being observable in `rendererWrite` captures.
const flushFrame = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

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

  test('first Esc during a turn aborts the soft signal (cooperative), NOT the hard one', async () => {
    // Spec UI.md §3 + 1.g.1: first Esc is cooperative — softStopSignal
    // fires so the harness exits at the next step boundary, but the
    // hard signal stays unaborted (in-flight tool / provider stream
    // is not preempted). Second Esc escalates to hard (covered in the
    // sibling test).
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
    const cfg = ra.captured[0]?.configs[0];
    const signal = cfg?.signal;
    const softSignal = cfg?.softStopSignal;
    expect(signal?.aborted).toBe(false);
    expect(softSignal?.aborted).toBe(false);
    // First Esc: only soft fires.
    stdin.feed('\x1b\x1b');
    await tick();
    expect(signal?.aborted).toBe(false);
    expect(softSignal?.aborted).toBe(true);
    // The harness's mock doesn't auto-honor softStopSignal — finish
    // it explicitly so shutdown can resolve.
    ra.finish(0, { status: 'interrupted', reason: 'aborted' });
    await tick();
    stdin.feed('\x03');
    expect(await promise).toBe(0);
  });

  test('second Esc while soft already in flight emits interrupt:hard', async () => {
    // Operator escalates: first Esc → soft (softStopController.abort
    // only), second Esc → hard (abortController.abort, preempts
    // in-flight work). Asserts the post-1.g.1 contract by reading
    // both controllers' signal state directly.
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      runAgentOverride: ra.runAgent,
      // Capture rendered frames just to drive the renderer's frame
      // scheduler — we read signals on cfg directly for assertions.
      rendererWrite: () => undefined,
    });
    await tick();
    stdin.feed('go\r');
    await tick();
    ra.emitInto(0, { type: 'session_start', sessionId: 'sess-1' });
    ra.emitInto(0, {
      type: 'tool_invoking',
      toolUseId: 'tu1',
      toolName: 'bash',
      args: { command: 'sleep 999' },
    });
    await flushFrame();
    const cfg = ra.captured[0]?.configs[0];
    const signal = cfg?.signal;
    const softSignal = cfg?.softStopSignal;
    expect(signal?.aborted).toBe(false);
    expect(softSignal?.aborted).toBe(false);
    // First Esc: soft fires (cooperative), hard signal untouched.
    stdin.feed('\x1b\x1b');
    await flushFrame();
    expect(softSignal?.aborted).toBe(true);
    expect(signal?.aborted).toBe(false);
    // Second Esc: escalates to hard — preempts in-flight work.
    stdin.feed('\x1b\x1b');
    await flushFrame();
    expect(signal?.aborted).toBe(true);
    ra.finish(0, { status: 'interrupted', reason: 'aborted' });
    await tick();
    stdin.feed('\x03');
    expect(await promise).toBe(0);
  });

  test('raw-mode Ctrl+C (\\x03) during a turn aborts via the cancelInput path', async () => {
    // The renderer puts stdin in raw mode → Ctrl+C lands as byte 0x03
    // read from stdin (parsed as ch('c', {ctrl: true}) → editor
    // cancelInput signal) instead of a process SIGINT. Pre-fix the
    // REPL only acted on cancelInput when idle, so a running turn
    // could only be aborted via SIGINT — which raw mode often
    // suppresses. Operator left unable to interrupt.
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
    const cfg = ra.captured[0]?.configs[0];
    const signal = cfg?.signal;
    const softSignal = cfg?.softStopSignal;
    expect(signal?.aborted).toBe(false);
    expect(softSignal?.aborted).toBe(false);
    // First Ctrl+C: soft fires (cooperative), hard untouched.
    stdin.feed('\x03');
    await tick();
    expect(softSignal?.aborted).toBe(true);
    expect(signal?.aborted).toBe(false);
    // Second Ctrl+C: escalates to hard (matches Esc Esc semantics).
    stdin.feed('\x03');
    await tick();
    expect(signal?.aborted).toBe(true);
    ra.finish(0, { status: 'interrupted', reason: 'aborted' });
    await tick();
    stdin.feed('\x03');
    expect(await promise).toBe(0);
  });

  test('Ctrl+C during a turn also flips footer to "esc again to force"', async () => {
    // Spec UI.md §5.4: Ctrl+C and Esc are paired keybindings for the
    // same soft/hard ladder. Without the SIGINT path emitting the
    // interrupt UIEvent too, Ctrl+C aborts silently while Esc gets
    // the visible cue — strictly inconsistent.
    const stdin = makeStdin();
    const writes: string[] = [];
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    stdin.feed('go\r');
    await tick();
    ra.emitInto(0, { type: 'session_start', sessionId: 'sess-1' });
    ra.emitInto(0, {
      type: 'tool_invoking',
      toolUseId: 'tu1',
      toolName: 'bash',
      args: { command: 'sleep 999' },
    });
    await flushFrame();
    expect(writes.join('')).toContain('esc to interrupt');
    const cutoff = writes.length;
    // Trigger SIGINT directly (skipTtyCheck means raw-mode Ctrl+C
    // wouldn't reach the editor anyway in the test env). The handler
    // mirrors the Esc path's emit.
    process.emit('SIGINT');
    await flushFrame();
    expect(writes.slice(cutoff).join('')).toContain('esc again to force');
    ra.finish(0, { status: 'interrupted', reason: 'aborted' });
    await tick();
    stdin.feed('\x03');
    expect(await promise).toBe(0);
  });

  test('Esc during a turn flips footer to "esc again to force"', async () => {
    // Spec UI.md §4.10.6: once the operator hits Esc once mid-turn,
    // the footer cue swaps from "esc to interrupt" to "esc again to
    // force" — signaling the loop has acknowledged and is winding
    // down. The signal is emitted as an `interrupt` UIEvent on the
    // bus; the reducer flips state.softInterrupted; the footer
    // renderer reads it.
    const stdin = makeStdin();
    const writes: string[] = [];
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    stdin.feed('go\r');
    await tick();
    // Drive a session_start so the status line shows + a tool_invoking
    // so the live region has a running tool card (the footer's
    // interrupt cue is gated on isRunning, which checks active tools /
    // thinking / streaming assistant — without any of those, the cue
    // is hidden regardless of session state).
    ra.emitInto(0, { type: 'session_start', sessionId: 'sess-1' });
    ra.emitInto(0, {
      type: 'tool_invoking',
      toolUseId: 'tu1',
      toolName: 'bash',
      args: { command: 'sleep 999' },
    });
    await flushFrame();
    // Pre-Esc: the cue reads "esc to interrupt".
    expect(writes.join('')).toContain('esc to interrupt');
    const cutoff = writes.length;
    // Send Esc Esc so the parser flushes a complete 'escape' key.
    stdin.feed('\x1b\x1b');
    await flushFrame();
    // After Esc, the next frame contains the new cue.
    const post = writes.slice(cutoff).join('');
    expect(post).toContain('esc again to force');
    // Cleanup: resolve the run + exit.
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
    // 1.g.1: SIGINT now follows the soft/hard ladder. First emit
    // is cooperative — the fixture only listens on the hard signal,
    // so the run doesn't resolve. Second emit escalates to hard
    // (softInterrupted flipped true after the first), which fires
    // the fixture's abort listener → microtasks → resolve. Third
    // emit lands with running=false and triggers requestShutdown.
    process.emit('SIGINT');
    await tick();
    process.emit('SIGINT');
    await tick();
    await tick();
    process.emit('SIGINT');
    expect(await promise).toBe(130);
    // Critical ordering: db.close fires AFTER the run resolved.
    const dbCloseIdx = events.indexOf('db.close');
    const runResolveIdx = events.indexOf('run.resolve');
    expect(runResolveIdx).toBeGreaterThan(-1);
    expect(dbCloseIdx).toBeGreaterThan(runResolveIdx);
  });

  test('confirmPermission bridge translates args via vocab into modalManager.askPermission', async () => {
    // Drive a confirmPermission call through the REPL's bridge and
    // capture whatever the harness saw. Since modalManager is internal
    // to the REPL, we exercise the bridge by calling cfg.confirmPermission
    // directly and asserting it returns a boolean (resolved via the
    // bus → reducer → manager loop). The modal-manager test covers the
    // queue / hotkey behavior; this covers the seam.
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
    const cfg = ra.captured[0]?.configs[0];
    expect(cfg?.confirmPermission).toBeDefined();
    // Fire the bridge with read_file args — vocab extracts `path` as
    // the subject. Then immediately resolve "no" by feeding Esc to the
    // modal handler so the promise settles.
    const askPromise = cfg?.confirmPermission?.({
      toolName: 'read_file',
      args: { path: '/x.ts' },
      cwd: '/tmp',
      prompt: 'access outside workspace?',
    });
    await tick();
    // Modal up — Esc rejects (false).
    stdin.feed('\x1b\x1b');
    await tick();
    const answer = await askPromise;
    expect(answer).toBe(false);
    // Wrap up.
    ra.finish(0);
    await tick();
    stdin.feed('\x03');
    expect(await promise).toBe(0);
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

describe('repl — slash commands integration', () => {
  // Same SIGINT cleanup as the smoke describe above.
  afterEach(() => {
    process.removeAllListeners('SIGINT');
  });

  test('typing /he opens the popover; Tab completes to /help; Enter dispatches', async () => {
    const stdin = makeStdin();
    const writes: string[] = [];
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    stdin.feed('/he');
    await flushFrame();
    // Popover should show /help row; output captured includes the
    // popover line.
    expect(writes.some((w) => w.includes('/help'))).toBe(true);
    // Tab completes the highlighted suggestion.
    stdin.feed('\t');
    await flushFrame();
    // Enter dispatches /help. Help renders 9 info lines (header +
    // 8 commands) into scrollback.
    stdin.feed('\r');
    await flushFrame();
    const all = writes.join('');
    expect(all).toContain('Slash commands:');
    expect(all).toContain('/quit');
    // Wrap up.
    stdin.feed('\x03');
    expect(await promise).toBe(0);
  });

  test('arrow Down navigates between suggestions', async () => {
    const stdin = makeStdin();
    const writes: string[] = [];
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    stdin.feed('/');
    await flushFrame();
    // Default selectedIdx = 0 (highlight on /help). Arrow Down →
    // highlight moves to /quit (registration order).
    stdin.feed('\x1b[B'); // Down arrow
    await flushFrame();
    // Tab completes the new selection — /quit.
    stdin.feed('\t');
    await flushFrame();
    const all = writes.join('');
    expect(all).toContain('/quit');
    // Esc to exit slash mode without dispatching, then quit.
    stdin.feed('\x1b\x1b');
    await tick();
    stdin.feed('\x03');
    expect(await promise).toBe(0);
  });

  test('/quit triggers shutdown and exits cleanly', async () => {
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
    });
    await tick();
    stdin.feed('/quit\r');
    expect(await promise).toBe(0);
  });

  test('/Help (mixed case) resolves to /help via case-insensitive lookup', async () => {
    const stdin = makeStdin();
    const writes: string[] = [];
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    stdin.feed('/Help\r');
    await flushFrame();
    // Should NOT surface "unknown command" — should dispatch /help.
    const all = writes.join('');
    expect(all).not.toContain('unknown command');
    expect(all).toContain('Slash commands:');
    stdin.feed('\x03');
    expect(await promise).toBe(0);
  });

  test('bare / + Enter clears the buffer instead of sending "/" to the LLM', async () => {
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
    stdin.feed('/');
    await tick();
    stdin.feed('\r');
    await tick();
    // No turn started — runAgent override never called.
    expect(ra.captured).toHaveLength(0);
    stdin.feed('\x03');
    expect(await promise).toBe(0);
  });

  test('slash mode is closed after typing a non-slash character at the start', async () => {
    const stdin = makeStdin();
    const writes: string[] = [];
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    stdin.feed('/he');
    await flushFrame();
    expect(writes.some((w) => w.includes('/help'))).toBe(true);
    // Backspace 3 times to clear, then type a normal letter.
    stdin.feed('\x7f\x7f\x7f');
    await flushFrame();
    writes.length = 0;
    stdin.feed('hello');
    await flushFrame();
    // Popover not in the latest writes (would contain /help).
    const recent = writes.join('');
    expect(recent).not.toContain('/help');
    // Buffer is 'hello'; first Ctrl+C clears it, second exits.
    stdin.feed('\x03\x03');
    expect(await promise).toBe(0);
  });

  test('/budget steps N propagates to the next turn adapter ctx (no stale maxSteps)', async () => {
    // Regression: adapterCtxBase used to be built ONCE at REPL boot
    // and reused for every createHarnessAdapter call. /budget mutated
    // baseConfig.budget but the adapter kept emitting step:budget
    // with the boot-time maxSteps — footer/status line diverged from
    // the cap the harness actually enforced. Fix rebuilds the ctx
    // per turn from baseConfig.
    const stdin = makeStdin();
    const writes: string[] = [];
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    // Turn 1: drive session_start, observe boot-time maxSteps (50 from
    // DEFAULT_BUDGET) in the rendered status line.
    stdin.feed('go\r');
    await tick();
    ra.emitInto(0, { type: 'session_start', sessionId: 'sess-1' });
    await flushFrame();
    expect(writes.join('')).toContain('0/50');
    ra.finish(0);
    await tick();
    // Mutate via slash command, then turn 2. The cutoff sits AFTER
    // the new session_start fires, so any lingering "0/50" frames
    // from session 1's idle render are excluded — we only check
    // frames produced once the new turn's adapter ctx has emitted.
    stdin.feed('/budget steps 99\r');
    await flushFrame();
    stdin.feed('next\r');
    await tick();
    const cutoff = writes.length;
    ra.emitInto(1, { type: 'session_start', sessionId: 'sess-2' });
    await flushFrame();
    const post = writes.slice(cutoff).join('');
    // Adapter ctx for turn 2 must carry the post-mutation maxSteps.
    // (A transient `0/50` frame may slip between session:start and the
    // following step:budget — the renderer paints session:start's
    // model/sessionId update before step:budget's maxSteps lands. The
    // contract is that the new value DOES appear; intermediate
    // frames are renderer scheduling, not regression.)
    expect(post).toContain('0/99');
    ra.finish(1);
    await tick();
    stdin.feed('\x03');
    expect(await promise).toBe(0);
  });

  test('/plan on propagates planMode to the next turn adapter ctx', async () => {
    // Same regression class as /budget: pre-fix the planMode flag was
    // captured from baseConfig at boot. /plan on mutated baseConfig
    // but the adapter kept emitting session:start without planMode —
    // footer's `plan` token never appeared. Post-fix the ctx is rebuilt
    // per turn so the next session:start carries the new flag.
    const stdin = makeStdin();
    const writes: string[] = [];
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    // Enable plan mode BEFORE any turn so we exercise the most likely
    // operator flow (toggle + immediately prompt).
    stdin.feed('/plan on\r');
    await flushFrame();
    const cutoff = writes.length;
    stdin.feed('go\r');
    await tick();
    ra.emitInto(0, { type: 'session_start', sessionId: 'sess-1' });
    await flushFrame();
    // Footer renders `· plan ·` between model and steps when planMode
    // landed in session:start. Pre-fix the token was missing.
    const post = writes.slice(cutoff).join('');
    expect(post).toContain('plan');
    ra.finish(0);
    await tick();
    stdin.feed('\x03');
    expect(await promise).toBe(0);
  });

  test('Enter after /quit is suppressed (shutdown gate is synchronous)', async () => {
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
    // Hit /quit AND a follow-up Enter in the same dispatch burst —
    // the second Enter must NOT slip past the shutdown gate and
    // start a turn. requestShutdown sets `exiting=true` synchronously
    // so subsequent keystrokes are swallowed by the editor handler.
    stdin.feed('/quit\rhello\r');
    expect(await promise).toBe(0);
    expect(ra.captured).toHaveLength(0);
  });
});
