import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedArgs } from '../../src/cli/args.ts';
import type { BootstrapResult } from '../../src/cli/bootstrap.ts';
import { runRepl } from '../../src/cli/repl.ts';
import type { HarnessConfig, HarnessEvent, HarnessResult } from '../../src/harness/index.ts';
import { DEFAULT_BUDGET } from '../../src/harness/types.ts';
import { addTrustedDir, loadTrustedDirs } from '../../src/trust/index.ts';

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
  // Resolve the pending runAgent promise WITHOUT re-emitting
  // session_finished. Lets a test simulate the overlap window
  // where session_finished was already delivered synchronously
  // (flipping `running=false`), the operator started a follow-up
  // turn, and only THEN the prior runAgent's outer-finally
  // cleanup completes — the moment the .finally() chain in
  // startTurn runs against shared state owned by a newer turn.
  settle: (idx: number, override?: Partial<HarnessResult>) => void;
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
      // Mirror the real harness's emit-then-return order: session_finished
      // fires synchronously BEFORE the runAgent Promise resolves
      // (loop.ts calls `safeEmit` inside `finish()` before returning the
      // result up the stack). The REPL's onHarnessEvent reads
      // `result.sessionId` / costs from the event payload — bookkeeping
      // moved off the runAgent .then() so the operator isn't gated on
      // the harness's outer-finally cleanup (checkpoint purge + bg
      // cleanup, see repl.ts comment). Tests need the same ordering.
      const result = buildResult(resolveSession(idx + 1), override ?? {});
      const cap = captured[idx];
      if (cap !== undefined) cap.emit({ type: 'session_finished', result });
      r(override ?? {});
    },
    settle: (idx, override) => {
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

  test('refuses to start when stdin is non-TTY even if stdout is TTY (regression)', async () => {
    // Pre-fix the gate only checked caps.isTTY (derived from stdout),
    // so a pipe-stdin / TTY-stdout combo (e.g. `echo prompt | agent`
    // run from an interactive shell) would enter REPL mode with no
    // usable keyboard. This test pins stdout.isTTY=true on the live
    // process for the duration of the call so we exercise the
    // new stdin branch in isolation.
    const originalStdoutIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    try {
      let stderr = '';
      // makeStdin returns an EventEmitter without isTTY — exactly the
      // shape a piped stdin presents.
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
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalStdoutIsTTY,
        configurable: true,
      });
    }
  });

  test('accepts when both stdin and stdout report isTTY (positive control)', async () => {
    // Inverse of the above: stdin DOES expose isTTY=true and stdout
    // is forced to TTY. Without skipTtyCheck the gate must let the
    // REPL boot. Confirms the new check isn't over-strict — a real
    // interactive terminal still works.
    const originalStdoutIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    try {
      const stdin = makeStdin();
      Object.defineProperty(stdin, 'isTTY', { value: true, configurable: true });
      const promise = runRepl({
        args: makeArgs(),
        bootstrapOverride: makeBootstrapStub(),
        stdin,
        // skipTtyCheck deliberately omitted — we want the REAL gate
        // to evaluate both checks and return TRUE for both.
        skipTrustPrompt: true,
      });
      // Boot succeeded. Drive Ctrl+C to exit cleanly.
      await tick();
      stdin.feed('\x04');
      expect(await promise).toBe(130);
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalStdoutIsTTY,
        configurable: true,
      });
    }
  });

  test('idle raw-mode Ctrl+C double-tap exits 130 (UI.md §5.4 gate)', async () => {
    // Spec §5.4: first Ctrl+C at idle/empty-buffer arms the gate
    // (footer flips to `Press Ctrl-C again to exit`); a second press inside
    // the 2s window exits 130 (POSIX SIGINT). Pre-spec a single press
    // exited immediately; the gate prevents accidental drops.
    // exitCode=130 (not 0) keeps shells / CI / automation seeing
    // interrupt-driven exits as interrupt.
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
    });
    await tick();
    // First press arms — no exit.
    stdin.feed('\x03');
    await tick();
    // Second press within window exits 130.
    stdin.feed('\x03');
    expect(await promise).toBe(130);
  });

  test('idle raw-mode single Ctrl+C does NOT exit (gate armed, awaits second tap)', async () => {
    // Direct negative control: a single press must NOT trigger
    // shutdown. Confirms the gate isn't a no-op (would silently
    // exit on first tap if the cancelInput → handleIdleInterrupt
    // path skipped the armed check).
    const stdin = makeStdin();
    let resolved = false;
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
    }).then((code) => {
      resolved = true;
      return code;
    });
    await tick();
    stdin.feed('\x03');
    // Tick a few times to give any erroneous shutdown path a chance
    // to fire. The promise should remain pending.
    await tick();
    await tick();
    expect(resolved).toBe(false);
    // Cleanup via EOF (no gate).
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('first Ctrl+C flips footer to "Press Ctrl-C again to exit" cue (e2e producer→render)', async () => {
    // Coverage gap: prior tests verify the gate's exit code AND
    // verify the reducer/footer in isolation, but nothing ties the
    // producer's bus emit to the rendered output. This pins the
    // contract end-to-end — if armExit() ever stops emitting
    // `interrupt:exit-arm`, the footer goes silent and the
    // operator loses the cue, but exit codes still pass.
    const stdin = makeStdin();
    const writes: string[] = [];
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    const beforeArm = writes.length;
    stdin.feed('\x03');
    await flushFrame();
    const afterArm = writes.slice(beforeArm).join('');
    expect(afterArm).toContain('Press Ctrl-C again to exit');
    // Cleanup via EOF.
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('idle Ctrl+D (EOF) exits 130 immediately, no gate (shell convention)', async () => {
    // §5.4: Ctrl+D is the explicit "I'm done" signal at empty buffer
    // and bypasses the double-tap gate. Single press exits.
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
      skipTrustPrompt: true,
    });
    await tick();
    stdin.feed('\x04');
    const code = await promise;
    expect(code).toBe(130);
    expect(closes).toHaveLength(1);
  });

  test('typing between two Ctrl+C disarms the gate (spec §5.4 "qualquer tecla")', async () => {
    // Sequence: C+C arms → 'a' disarms → C+C re-arms → C+C exits.
    // Three C+C in a row would also exit on the second; this tests
    // the cancel-on-other-key path. Without the disarm, the second
    // C+C in `^C a ^C` would exit prematurely.
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
    });
    await tick();
    stdin.feed('\x03'); // arms
    await tick();
    stdin.feed('a'); // disarms (input changed → cancelExitArm)
    await tick();
    stdin.feed('\x03'); // buffer 'a' → clears (no cancelInput)
    await tick();
    stdin.feed('\x03'); // empty buffer → arms fresh
    await tick();
    stdin.feed('\x03'); // empty buffer + armed → exits
    expect(await promise).toBe(130);
  });

  test('SIGINT (process signal) at idle exits immediately, no gate', async () => {
    // The double-tap exit gate (UI.md §5.4) is interactive UX —
    // protects the operator from a stray Ctrl+C keystroke. External
    // SIGINT senders (supervisors, automation, IDE stop buttons,
    // `kill -INT $pid`) expect one signal to stop the process; if
    // SIGINT routed through the gate, a single `kill -INT` would
    // arm + silently disarm 2s later, leaving the process alive.
    // Single SIGINT at idle MUST exit 130 (POSIX SIGINT).
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
    });
    await tick();
    process.emit('SIGINT');
    expect(await promise).toBe(130);
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
      skipTrustPrompt: true,
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
    // Banner now uses the v-prefixed version (UI.md §4.10.9).
    expect(all).toContain('forja v0.0.0');
    expect(all).toContain('mock/m');
    expect(all).toContain('200,000 ctx');
    expect(all).toContain('max 4096 out');
    expect(all).toContain('/path/to/repo');
    // No env block because both subagents and checkpoints were
    // empty/disabled (D68 — omit when nothing to summarize).
    expect(all).not.toContain('subagents');
    expect(all).not.toContain('checkpoints');
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('typed prompt + Enter triggers runAgent with the typed text', async () => {
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
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
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('late finalizer of a prior turn does not clobber the active turn state', async () => {
    // Regression: `running=false` flips on `session_finished` so the
    // operator can submit a follow-up turn without waiting for the
    // harness's outer-finally cleanup (checkpoint purge + bg cleanup
    // can take seconds). But the prior turn's runAgent Promise is
    // still pending — when its .finally() chain eventually runs, it
    // would otherwise reset shared turn state (running, abort
    // controllers, runningPromise) and clobber the newer active
    // turn. Per-turn token gate refuses the mutation when a newer
    // turn has taken over.
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: () => undefined,
    });
    await tick();
    // Turn 1 starts.
    stdin.feed('first\r');
    await tick();
    // Emit session_finished for turn 1 (flips running=false in the
    // REPL) WITHOUT resolving turn 1's runAgent Promise yet — the
    // overlap window where the harness's outer-finally cleanup is
    // still in flight.
    const result1: HarnessResult = {
      status: 'done',
      reason: 'done',
      sessionId: 'sess-1',
      steps: 1,
      durationMs: 1,
      usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
      costUsd: 0,
      usageComplete: true,
    };
    ra.emitInto(0, { type: 'session_finished', result: result1 });
    await tick();
    // Turn 2 starts in the overlap window.
    stdin.feed('second\r');
    await tick();
    expect(ra.captured).toHaveLength(2);
    const turn2Cfg = ra.captured[1]?.configs[0];
    const turn2Signal = turn2Cfg?.signal;
    const turn2SoftSignal = turn2Cfg?.softStopSignal;
    expect(turn2Signal?.aborted).toBe(false);
    expect(turn2SoftSignal?.aborted).toBe(false);
    // NOW turn 1's runAgent Promise settles (late finalizer). Pre-fix
    // the .finally() would clear `running`, `abortController`, and
    // `runningPromise` — for turn 2's state. Post-fix the token gate
    // bails: turn 2 stays the active owner.
    ra.settle(0);
    await tick();
    // Verify turn 2 is still active and its abort controller still
    // works. If the token gate was missing, abortController would be
    // null here and Esc/Ctrl+C would route to idle handlers.
    stdin.feed('\x1b'); // Esc — soft interrupt for the active turn.
    await flushFrame();
    expect(turn2SoftSignal?.aborted).toBe(true);
    // Cleanup.
    ra.finish(1);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('subsequent turns thread the prior sessionId via resumeFromSessionId', async () => {
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
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
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('Enter is ignored while a turn is in flight (no double-run)', async () => {
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
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
    stdin.feed('\x04');
    expect(await promise).toBe(130);
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
      skipTrustPrompt: true,
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
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('second Esc while soft already in flight emits interrupt:hard', async () => {
    // Operator escalates: first Esc → soft (softStopController.abort
    // only), second Esc → hard (abortController.abort, preempts
    // in-flight work). Each physical Esc keypress sends a single
    // `\x1b`; the parser holds it briefly to disambiguate from a CSI
    // leader, then the lone-ESC drain (REPL-side, ~30ms) flushes it
    // as an Escape keypress. flushFrame's 50ms wait covers the drain.
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
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
    // First Esc: lone \x1b → drain emits escape after ~30ms → soft.
    stdin.feed('\x1b');
    await flushFrame();
    expect(softSignal?.aborted).toBe(true);
    expect(signal?.aborted).toBe(false);
    // Second Esc: same path → drain emits second escape → hard.
    stdin.feed('\x1b');
    await flushFrame();
    expect(signal?.aborted).toBe(true);
    ra.finish(0, { status: 'interrupted', reason: 'aborted' });
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
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
      skipTrustPrompt: true,
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
    // Cleanup: Ctrl+D (EOF) is the direct-exit signal at idle. Ctrl+C
    // would arm the new double-tap gate (UI.md §5.4) and stall the
    // test — `\x04` matches the operator's "I'm done" intent.
    stdin.feed('\x04');
    expect(await promise).toBe(130);
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
      skipTrustPrompt: true,
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
    stdin.feed('\x04');
    expect(await promise).toBe(130);
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
      skipTrustPrompt: true,
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
    stdin.feed('\x04');
    expect(await promise).toBe(130);
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
      skipTrustPrompt: true,
      runAgentOverride: fakeRunAgent,
    });
    await tick();
    stdin.feed('go\r');
    await tick();
    // 1.g.1: SIGINT now follows the soft/hard ladder. First emit
    // is cooperative — the fixture only listens on the hard signal,
    // so the run doesn't resolve. Second emit escalates to hard
    // (softInterrupted flipped true after the first), which fires
    // the fixture's abort listener → microtasks → resolve. After
    // resolution, running=false and a third SIGINT would only ARM
    // the new idle double-tap gate (UI.md §5.4) — it wouldn't exit.
    // We use Ctrl+D (EOF) instead for the cleanup shutdown: it
    // bypasses the gate per spec and triggers requestShutdown
    // directly, exiting 130.
    process.emit('SIGINT');
    await tick();
    process.emit('SIGINT');
    await tick();
    await tick();
    stdin.feed('\x04');
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
      skipTrustPrompt: true,
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
    stdin.feed('\x04');
    expect(await promise).toBe(130);
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
      skipTrustPrompt: true,
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
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });
});

describe('repl — trust prompt (AGENTIC_CLI §9.1)', () => {
  // Each test points the trust file at a fresh temp path so the
  // dev machine's real `~/.config/agent/trusted_dirs.json` isn't
  // mutated and tests don't share state across runs.
  let trustDir: string;
  let trustPath: string;
  beforeEach(() => {
    trustDir = mkdtempSync(join(tmpdir(), 'forja-trust-test-'));
    trustPath = join(trustDir, 'trusted_dirs.json');
  });
  afterEach(() => {
    process.removeAllListeners('SIGINT');
    rmSync(trustDir, { recursive: true, force: true });
  });

  test('first-run prompt fires, "yes" answer enters the REPL', async () => {
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      runAgentOverride: ra.runAgent,
      trustListPathOverride: trustPath,
    });
    await tick();
    // '1' is the hotkey for "Yes, I trust this folder".
    stdin.feed('1');
    await tick();
    // REPL is now live. Submit a turn to confirm the normal flow
    // resumes after the modal closes.
    stdin.feed('hi\r');
    await tick();
    expect(ra.captured).toHaveLength(1);
    expect(ra.captured[0]?.configs[0]?.userPrompt).toBe('hi');
    // Cwd was persisted to the trust list — pin via the storage
    // module so the assertion isn't a JSON-shape coincidence.
    expect(loadTrustedDirs(trustPath)).toEqual(['/tmp/forja-repl-test']);
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('"no" answer exits 0 without entering the REPL', async () => {
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      runAgentOverride: ra.runAgent,
      trustListPathOverride: trustPath,
    });
    await tick();
    // '2' is the hotkey for "No, exit". REPL exits without ever
    // calling runAgent.
    stdin.feed('2');
    expect(await promise).toBe(0);
    expect(ra.captured).toHaveLength(0);
    // Trust list NOT mutated.
    expect(loadTrustedDirs(trustPath)).toEqual([]);
  });

  test('bootstrap error after trust acceptance tears down the pre-bootstrap stack', async () => {
    // Regression: pre-fix the bootstrap catch path returned 1
    // immediately, leaving the renderer (raw mode + bracketed
    // paste) and the stdin data listener live. An embedded caller
    // (tests, agent SDK) that kept running after runRepl returned
    // would inherit those handles. The fix routes through
    // tearDownPreBootstrap before returning. We pin the contract
    // by counting the stdin 'data' listeners after runRepl resolves.
    const stdin = makeStdin();
    const before = stdin.listenerCount('data');
    const code = await runRepl({
      args: makeArgs(),
      // No bootstrapOverride — let bootstrapFn run the throwing fn.
      bootstrapFn: () => {
        throw new Error('synthetic bootstrap failure');
      },
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      errSink: () => undefined,
    });
    expect(code).toBe(1);
    // Listener was attached pre-bootstrap; after the catch path's
    // teardown it must be removed (count back at the baseline).
    expect(stdin.listenerCount('data')).toBe(before);
  });

  test('unattended trust modal auto-rejects after the timeout (fail-closed)', async () => {
    // Spec UI.md §5.5 rule 6: trust:ask is the one *:ask flavor with
    // a bounded window. Without the timeout the modal would hold
    // raw-mode stdio open indefinitely on an unattended terminal —
    // a process spawned by automation that hits an unfamiliar cwd
    // would just hang. Tiny `trustPromptTimeoutMs` so the test
    // fires fast.
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      runAgentOverride: ra.runAgent,
      trustListPathOverride: trustPath,
      trustPromptTimeoutMs: 30,
    });
    // No keystroke fed — let the timeout fire.
    expect(await promise).toBe(0);
    expect(ra.captured).toHaveLength(0);
    // Trust list NOT mutated on timeout.
    expect(loadTrustedDirs(trustPath)).toEqual([]);
  });

  test('Esc on the trust modal cancels and exits 0', async () => {
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      runAgentOverride: ra.runAgent,
      trustListPathOverride: trustPath,
    });
    await tick();
    stdin.feed('\x1b\x1b'); // Esc Esc — modal manager treats Esc as cancel.
    await flushFrame();
    expect(await promise).toBe(0);
    expect(ra.captured).toHaveLength(0);
  });

  test('already-trusted cwd skips the prompt entirely', async () => {
    // Pre-populate the trust list so the first-run path is
    // suppressed. Without `skipTrustPrompt`, the modal must NOT
    // fire — the very first keystroke goes straight to the editor.
    addTrustedDir(trustPath, '/tmp/forja-repl-test');
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      runAgentOverride: ra.runAgent,
      trustListPathOverride: trustPath,
    });
    await tick();
    stdin.feed('hi\r'); // No modal answer — straight to editor.
    await tick();
    expect(ra.captured).toHaveLength(1);
    expect(ra.captured[0]?.configs[0]?.userPrompt).toBe('hi');
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('null trustListPath bypasses persistence but still prompts', async () => {
    // Pathological env: HOME / XDG_CONFIG_HOME unset → trustListPath
    // returns null → REPL falls through to per-session trust (prompt
    // still fires for the safety property; approval just doesn't
    // memoize). Verifies the null-path branch.
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      runAgentOverride: ra.runAgent,
      trustListPathOverride: null,
    });
    await tick();
    stdin.feed('1'); // Yes.
    await tick();
    stdin.feed('hi\r');
    await tick();
    expect(ra.captured).toHaveLength(1);
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });
});

describe('repl — slash commands integration', () => {
  // Same SIGINT cleanup as the smoke describe above.
  afterEach(() => {
    process.removeAllListeners('SIGINT');
  });

  test('`?` on empty buffer dispatches /help (footer cue activation)', async () => {
    // The footer's `? for help` hint promised the operator a single
    // keystroke would surface the command list. Pre-fix `?` was a
    // literal char and the hint lied. With an empty buffer, `?`
    // dispatches /help directly; same effect as typing /help+Enter.
    const stdin = makeStdin();
    const writes: string[] = [];
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    stdin.feed('?');
    await flushFrame();
    // Help command rendered the slash command list to scrollback.
    expect(writes.some((w) => w.includes('Slash commands:'))).toBe(true);
    expect(writes.some((w) => w.includes('/quit'))).toBe(true);
    // `?` did NOT land in the input buffer.
    stdin.feed('\x04'); // Ctrl+D EOF cleanup
    expect(await promise).toBe(130);
  });

  test('`?` shortcut disarms the exit gate before dispatching /help', async () => {
    // Regression: the `?` shortcut early-returns before the
    // editor's general disarm path runs. Without an explicit
    // cancelExitArm() in the shortcut branch, this sequence would
    // exit 130 unexpectedly:
    //   1. Ctrl+C (idle) → arms gate, footer flips to "Press Ctrl-C
    //      again to exit".
    //   2. `?` → operator hits a non-interrupt key. UI.md §5.4 says
    //      ANY non-Ctrl+C key disarms; gate must be cancelled.
    //      Pre-fix the shortcut returned with the gate still armed.
    //   3. Ctrl+C inside the 2s window → still detects gate as
    //      armed and exits 130, dropping in-progress context.
    // With the fix, step 2 disarms; step 3 re-arms instead of
    // exiting. The operator's protection holds.
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
    });
    await tick();
    // Arm the exit gate.
    stdin.feed('\x03');
    await tick();
    // Press `?` — should dispatch /help AND disarm the gate.
    stdin.feed('?');
    await tick();
    // A single Ctrl+C now must arm fresh (NOT exit). If the gate
    // had stayed armed across the `?`, this Ctrl+C would have
    // exited 130 immediately.
    stdin.feed('\x03');
    await tick();
    // Cleanup with EOF — proves the REPL is still alive after the
    // sequence (process didn't exit unexpectedly).
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('`?` mid-buffer is a literal char (no /help hijack)', async () => {
    // Operator types a question that begins with `?` mid-thought:
    // the keystroke must NOT trigger /help. Only the EMPTY-buffer
    // case dispatches.
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
    });
    await tick();
    stdin.feed('hi?\r'); // type "hi?" + Enter — submit literal "hi?"
    await tick();
    expect(ra.captured).toHaveLength(1);
    expect(ra.captured[0]?.configs[0]?.userPrompt).toBe('hi?');
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('typing /he opens the popover; Tab completes to /help; Enter dispatches', async () => {
    const stdin = makeStdin();
    const writes: string[] = [];
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
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
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('arrow Down navigates between suggestions', async () => {
    const stdin = makeStdin();
    const writes: string[] = [];
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
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
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('/quit triggers shutdown and exits cleanly', async () => {
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
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
      skipTrustPrompt: true,
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
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('bare / + Enter clears the buffer instead of sending "/" to the LLM', async () => {
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
    });
    await tick();
    stdin.feed('/');
    await tick();
    stdin.feed('\r');
    await tick();
    // No turn started — runAgent override never called.
    expect(ra.captured).toHaveLength(0);
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('slash mode is closed after typing a non-slash character at the start', async () => {
    const stdin = makeStdin();
    const writes: string[] = [];
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
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
    // Cleanup. Buffer is 'hello'; Ctrl+D would forward-delete (buffer
    // non-empty), so we use first Ctrl+C to clear (input-editor.ts
    // empties on non-empty buffer), then Ctrl+D to EOF-exit at idle.
    // Three Ctrl+C in a row would also work (clear → arm → exit) but
    // EOF is more direct and doesn't depend on the gate's window.
    stdin.feed('\x03');
    await flushFrame();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
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
      skipTrustPrompt: true,
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
    stdin.feed('\x04');
    expect(await promise).toBe(130);
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
      skipTrustPrompt: true,
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
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('unknown slash command + Enter does NOT call runAgent (regression)', async () => {
    // Pre-fix the slash mode gate keyed on state.slash !== null. The
    // reducer clears state.slash to null when the popover has zero
    // matches (typing `/doesnotexist` produces no completions), so
    // the Enter branch fell through to the editor's normal submit
    // path. That sent `/doesnotexist` to the provider as a turn —
    // unintended token spend on every typo. The fix gates on the
    // buffer prefix too, so Enter still routes through the slash
    // dispatcher even when the popover collapsed.
    const stdin = makeStdin();
    const writes: string[] = [];
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    stdin.feed('/doesnotexist\r');
    await flushFrame();
    // Critical contract: NO turn was started — runAgent must not see
    // a config from this Enter.
    expect(ra.captured).toHaveLength(0);
    // Dispatcher emits "unknown command" as a bus error → renders
    // as a scrollback `error: ...` line. Surface check.
    expect(writes.join('')).toContain('unknown command');
    expect(writes.join('')).toContain('/doesnotexist');
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('Enter after /quit is suppressed (shutdown gate is synchronous)', async () => {
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
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
