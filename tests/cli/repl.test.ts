import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedArgs } from '../../src/cli/args.ts';
import type { BootstrapResult } from '../../src/cli/bootstrap.ts';
import {
  type RunReplOptions,
  SUBAGENT_DISPLAY_MAX,
  runRepl,
  sanitizeForSubagentDisplay,
} from '../../src/cli/repl.ts';
import type { HarnessConfig, HarnessEvent, HarnessResult } from '../../src/harness/index.ts';
import { DEFAULT_BUDGET } from '../../src/harness/types.ts';
import { type PermissionEngine, createPermissionEngine } from '../../src/permissions/index.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import { listRecentRecapRuns } from '../../src/storage/repos/recap-runs.ts';
import { completeSession, createSession } from '../../src/storage/repos/sessions.ts';
import {
  getSubagentHandle,
  insertSubagentHandle,
} from '../../src/storage/repos/subagent-handles.ts';
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
  listSessions: false,
  includeSubagents: false,
  explainPermissions: false,
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
// the boot banner. `db` is a real migrated in-memory SQLite handle so
// boot-time loadHistory and submit-time appendHistory work; the
// harness override means runAgent never touches messages/tool_calls,
// so the rest of the config object can stay hollow.
// Minimal stub registry — exposes only the surface the REPL boot
// path consumes (count for the banner env entry; list/peek for
// the memory section assembly which is also called at boot via
// bootstrap, but bootstrapOverride bypasses bootstrap so this
// stub is invoked only via baseConfig.memoryRegistry.count()).
// Returns 0 by default; tests asserting the banner's memory entry
// override the count.
const makeStubRegistry = (count = 0): unknown => ({
  count: ({ deduplicateByName }: { deduplicateByName?: boolean } = {}) =>
    deduplicateByName === true ? count : count,
  list: () => [],
  lookup: () => null,
  read: () => ({ kind: 'unknown' as const }),
  peek: () => ({ kind: 'unknown' as const }),
  search: () => [],
  reload: () => {
    /* no-op */
  },
  write: () => {
    throw new Error('stub registry: write not used');
  },
  recordEvent: () => {
    /* no-op */
  },
});

interface MakeBootstrapStubOptions {
  cwd?: string;
  // Memory entry count surfaced by `MemoryRegistry.count`. Drives
  // both the boot banner env entry and the footer's `mem N` token.
  // Omit (default 0) to test the omit-on-zero paths.
  memoryCount?: number;
  // Resolved skill-catalog count surfaced by `SkillCatalog.count`;
  // drives the boot banner's skills env entry. Omit (default 0) to
  // test the omit-on-zero path.
  skillCount?: number;
  // Optional broker stub. When set, it's attached to the bootstrap
  // config so teardown paths that call `baseConfig.broker.close()`
  // can be exercised. Production brokers own handles/timers; tests
  // pass a `close` spy to assert the drain actually happens.
  broker?: { close: () => Promise<void> };
  // Permission engine attached to the stub config. Production bootstrap
  // always wires one (HarnessConfig.permissionEngine is required); the
  // stub historically omitted it because the TTY/exit tests never
  // touched it. Tests exercising the Shift+Tab posture toggle inject an
  // inspectable engine here; otherwise a default supervised engine is
  // created so `baseConfig.permissionEngine` is never undefined.
  permissionEngine?: PermissionEngine;
}

const makeBootstrapStub = (
  cwdOrOpts: string | MakeBootstrapStubOptions = '/tmp/forja-repl-test',
): BootstrapResult => {
  const opts: MakeBootstrapStubOptions =
    typeof cwdOrOpts === 'string' ? { cwd: cwdOrOpts } : cwdOrOpts;
  const cwd = opts.cwd ?? '/tmp/forja-repl-test';
  const memoryCount = opts.memoryCount ?? 0;
  const skillCount = opts.skillCount ?? 0;
  const realDb = openMemoryDb();
  migrate(realDb);
  const config = {
    cwd,
    userPrompt: '',
    budget: { ...DEFAULT_BUDGET },
    enableCheckpoints: false,
    provider: {
      id: 'mock/m',
      capabilities: { context_window: 200000, output_max_tokens: 4096 },
    },
    memoryRegistry: makeStubRegistry(memoryCount),
    skillCatalog: { count: () => skillCount },
    permissionEngine:
      opts.permissionEngine ??
      createPermissionEngine({ defaults: { mode: 'strict' }, tools: {} }, { cwd }),
    ...(opts.broker !== undefined ? { broker: opts.broker } : {}),
  } as unknown as HarnessConfig;
  return {
    config,
    db: realDb,
    modelId: 'mock/m',
    policyLayers: [],
    lockConflicts: [],
    subagents: { byName: new Map(), shadows: [] } as unknown as BootstrapResult['subagents'],
    hookWarnings: [],
    memoryConfigWarnings: [] as readonly string[],
    providersConfigWarnings: [] as readonly string[],
    budgetConfigWarnings: [] as readonly string[],
    effortConfigWarnings: [] as readonly string[],
    auditConfigWarnings: [] as readonly string[],
    permissionState: 'ready',
    permissionChain: { ok: true, rows: 0, current_rotation_id: 0, quarantined: false },
    installIdentity: { install_id: 'test-fixture', created_at_ms: 0 },
    sandboxEnforcement: {
      active: false,
      tool: null,
      reason: 'no-tool' as const,
    },
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
  // Reject the pending runAgent promise WITHOUT emitting session_finished
  // — simulates a provider crash before any boundary event.
  reject: (idx: number, err?: Error) => void;
} => {
  const captured: CapturedRun[] = [];
  let nextN = 1;
  const pendingResolves: Array<(override: Partial<HarnessResult>) => void> = [];
  const pendingRejects: Array<(err: Error) => void> = [];

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
      return new Promise<HarnessResult>((resolve, reject) => {
        pendingResolves.push((override) => resolve(buildResult(sessionId, override)));
        pendingRejects.push(reject);
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
    reject: (idx, err) => {
      const r = pendingRejects[idx];
      if (r === undefined) throw new Error(`no pending run at ${idx}`);
      r(err ?? new Error('runAgent rejected'));
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

describe('sanitizeForSubagentDisplay (anti-spoof for proxied modal text)', () => {
  // Spec docs/spec/IPC.md §7. The child's permission:ask wire
  // payload reaches the operator's modal as title / option label /
  // preview rows. The IPC parser only validates non-empty string
  // for toolName/cwd/prompt — bytes inside are arbitrary. Without
  // this transform, a hostile child could pack ANSI escapes,
  // newlines, or kilobytes into any displayed field and either
  // mimic friendly UI elements or push real content offscreen.

  test('strips ANSI escape sequences', () => {
    const dirty = '\x1b[31mrm -rf /\x1b[0m';
    expect(sanitizeForSubagentDisplay(dirty)).toBe('rm -rf /');
  });

  test('replaces newline / CR / tab with single space (collapse runs)', () => {
    // stripAnsi does not cover \x0a (LF) — operator must not see
    // multi-row payloads pretending to be modal separators.
    expect(sanitizeForSubagentDisplay('a\nb')).toBe('a b');
    expect(sanitizeForSubagentDisplay('a\r\nb')).toBe('a b');
    expect(sanitizeForSubagentDisplay('a\tb')).toBe('a b');
    expect(sanitizeForSubagentDisplay('a\n\n\nb')).toBe('a b');
    // Literal spaces interleaved with controls aren't merged: the
    // regex only matches RUNS of \r\n\t, so the space breaks the
    // run. Resulting double-space is cosmetic, not a spoof vector.
    expect(sanitizeForSubagentDisplay('a\t \nb')).toBe('a   b');
  });

  test('caps length and appends ellipsis past SUBAGENT_DISPLAY_MAX', () => {
    const long = 'x'.repeat(SUBAGENT_DISPLAY_MAX + 50);
    const out = sanitizeForSubagentDisplay(long);
    expect(out.length).toBe(SUBAGENT_DISPLAY_MAX);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('x'.repeat(SUBAGENT_DISPLAY_MAX - 1))).toBe(true);
  });

  test('passes legitimate strings through unchanged', () => {
    expect(sanitizeForSubagentDisplay('bash')).toBe('bash');
    expect(sanitizeForSubagentDisplay('mcp:server:tool')).toBe('mcp:server:tool');
    expect(sanitizeForSubagentDisplay('/tmp/safe.txt')).toBe('/tmp/safe.txt');
    expect(sanitizeForSubagentDisplay('Run bash: rm -rf /tmp/foo')).toBe(
      'Run bash: rm -rf /tmp/foo',
    );
  });

  test('combines ANSI strip + newline collapse + length cap', () => {
    // Worst-case payload: ANSI prefix, embedded newline, very long.
    const dirty = `\x1b[31m${'a'.repeat(50)}\n${'b'.repeat(SUBAGENT_DISPLAY_MAX)}\x1b[0m`;
    const out = sanitizeForSubagentDisplay(dirty);
    expect(out.length).toBe(SUBAGENT_DISPLAY_MAX);
    expect(out.includes('\x1b')).toBe(false);
    expect(out.includes('\n')).toBe(false);
    expect(out.endsWith('…')).toBe(true);
  });

  test('empty string is safe (no transform, no overflow)', () => {
    expect(sanitizeForSubagentDisplay('')).toBe('');
  });
});

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

  test('surfaces [effort]/[providers]/[budget] config warnings at REPL boot (matches run.ts)', async () => {
    // Regression: BootstrapResult is consumed by BOTH run.ts (one-shot)
    // and runRepl; these config warnings were only surfaced in run.ts,
    // so an invalid [effort].level / [providers] / [budget] in an
    // interactive session silently fell back to defaults with no
    // diagnostic. runRepl now mirrors run.ts's warning block.
    const stub = makeBootstrapStub();
    (stub as { effortConfigWarnings: readonly string[] }).effortConfigWarnings = [
      'bad effort level',
    ];
    (stub as { providersConfigWarnings: readonly string[] }).providersConfigWarnings = [
      'bad provider route',
    ];
    (stub as { budgetConfigWarnings: readonly string[] }).budgetConfigWarnings = [
      'bad budget value',
    ];
    let stderr = '';
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      errSink: (s) => {
        stderr += s;
      },
    });
    await tick();
    stdin.feed('\x04'); // EOF → quit after boot
    await promise;
    expect(stderr).toContain('forja: effort config: bad effort level');
    expect(stderr).toContain('forja: providers config: bad provider route');
    expect(stderr).toContain('forja: budget config: bad budget value');
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

  test('Shift+Tab toggles the approval posture (Supervised ↔ Autonomous)', async () => {
    // The editor handler maps Shift+Tab (ESC[Z) to
    // engine.setApprovalPosture. The engine is the source of truth, so
    // we assert on it directly — the footer cue is covered by the
    // render tests and the mode:change reducer test.
    const engine = createPermissionEngine(
      { defaults: { mode: 'strict' }, tools: {} },
      { cwd: '/tmp/forja-repl-test' },
    );
    expect(engine.approvalPosture()).toBe('supervised');
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub({ permissionEngine: engine }),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
    });
    await tick();
    stdin.feed('\x1b[Z'); // Shift+Tab
    await tick();
    expect(engine.approvalPosture()).toBe('autonomous');
    stdin.feed('\x1b[Z'); // Shift+Tab again — back to supervised
    await tick();
    expect(engine.approvalPosture()).toBe('supervised');
    // Both transitions recorded for introspection / audit.
    expect(engine.postureLog()).toHaveLength(2);
    // Exit cleanly (Ctrl+D / EOF on an empty buffer).
    stdin.feed('\x04');
    expect(await promise).toBe(130);
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

  test('`!cmd` runs an operator shell command and lands its output in scrollback', async () => {
    const stdin = makeStdin();
    const writes: string[] = [];
    const calls: string[] = [];
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      rendererWrite: (s) => {
        writes.push(s);
      },
      // Inject the executor so the test never spawns a real shell.
      execBash: async (command) => {
        calls.push(command);
        return { output: `RAN:${command}\n`, exitCode: 0 };
      },
    });
    await tick();
    stdin.feed('!ls -la\r');
    await flushFrame();
    // Ran the operator's own shell with the leading `!` stripped — NOT
    // routed to the agent.
    expect(calls).toEqual(['ls -la']);
    const out = writes.join('');
    expect(out).toContain('! ls -la'); // card head
    expect(out).toContain('RAN:ls -la'); // captured output landed in scrollback
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('a bare `!` runs nothing', async () => {
    const stdin = makeStdin();
    const calls: string[] = [];
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      execBash: async (command) => {
        calls.push(command);
        return { output: '', exitCode: 0 };
      },
    });
    await tick();
    stdin.feed('!\r');
    await flushFrame();
    expect(calls).toEqual([]);
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('a synchronously-throwing execBash does not wedge the REPL (error card still lands)', async () => {
    // Regression: runOperatorBash defers execBash into a
    // `Promise.resolve().then(...)`, so a sync throw becomes a rejection
    // the `.catch` handles — instead of escaping past the `.finally` and
    // leaving operatorBashRunning stuck true (wedging isBusy forever).
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
      // Throws synchronously (not a rejected promise).
      execBash: (() => {
        throw new Error('boom-sync');
      }) as NonNullable<RunReplOptions['execBash']>,
    });
    await tick();
    stdin.feed('!x\r');
    await flushFrame();
    const out = writes.join('');
    expect(out).toContain('! x'); // card head rendered
    expect(out).toContain('boom-sync'); // sync throw captured as output
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('a hung `!cmd` is killed by the timeout instead of wedging the REPL (real spawn)', async () => {
    // Regression: the default execBash spawns `detached` and SIGKILLs the
    // process GROUP on timeout, so a long command can't hold the stdout
    // pipe open and stall `Response().text()` forever. Uses a real shell
    // with a tiny timeout to prove termination without a 120s wait.
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
      operatorBashTimeoutMs: 100, // kill well before sleep finishes
    });
    await tick();
    stdin.feed('!sleep 5\r');
    // Wait past the timeout + kill + emit + render — but far short of 5s.
    await new Promise((r) => setTimeout(r, 700));
    // The card landed → operator-bash:done fired → the command did NOT
    // hang the REPL. (If it had wedged, this line would never appear.)
    expect(writes.join('')).toContain('! sleep 5');
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('Ctrl+C interrupts a running `!cmd` (kills its process group, does not wait the timeout)', async () => {
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
      // Hangs until the interrupt path invokes the kill switch.
      execBash: ((_cmd, _cwd, onKillable) =>
        new Promise((resolve) => {
          onKillable?.((sig) => resolve({ output: `killed:${sig}`, exitCode: 130 }));
        })) as NonNullable<RunReplOptions['execBash']>,
    });
    await tick();
    stdin.feed('!sleep\r'); // buffer clears, command "runs" (hangs)
    await tick();
    stdin.feed('\x03'); // Ctrl+C → triggerInterrupt → SIGINT the command
    await flushFrame();
    expect(writes.join('')).toContain('killed:SIGINT');
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('a `!cmd` ignoring SIGINT is SIGKILLed on the second Ctrl+C (interrupt ladder)', async () => {
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
      // Only SIGKILL resolves it (mimics a SIGINT-ignoring command).
      execBash: ((_cmd, _cwd, onKillable) =>
        new Promise((resolve) => {
          onKillable?.((sig) => {
            if (sig === 'SIGKILL') resolve({ output: `killed:${sig}`, exitCode: 137 });
          });
        })) as NonNullable<RunReplOptions['execBash']>,
    });
    await tick();
    stdin.feed('!hang\r');
    await tick();
    stdin.feed('\x03'); // first tap → SIGINT (ignored)
    await tick();
    stdin.feed('\x03'); // second tap → SIGKILL
    await flushFrame();
    expect(writes.join('')).toContain('killed:SIGKILL');
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('shell output preserves stdout/stderr interleave order (real spawn)', async () => {
    // `exec 2>&1` merges the streams on one pipe so a diagnostic emitted
    // between two normal writes stays between them — not shoved after all
    // stdout by a separate-pipe concat.
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
    stdin.feed('!printf OUTA; printf ERRB 1>&2; printf OUTC\r');
    await new Promise((r) => setTimeout(r, 400));
    const out = writes.join('');
    const a = out.indexOf('OUTA');
    const b = out.indexOf('ERRB');
    const c = out.indexOf('OUTC');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a); // stderr stayed between the stdout writes
    expect(c).toBeGreaterThan(b);
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('shell-mode visuals stay off while another `!cmd` is running (busy gate)', async () => {
    // Regression for the busy-gate finding: `isTurnRunning` can't see
    // `operatorBashRunning`, so without `state.busy` (busy:change) the
    // second `!` would flip to yellow shell mode for a command Enter
    // refuses. Type a `!` while a first `!cmd` hangs; the footer must
    // NOT show the shell indicator.
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
      // First command hangs until killed → stays "running" (busy).
      execBash: ((_cmd, _cwd, onKillable) =>
        new Promise((resolve) => {
          onKillable?.((sig) => resolve({ output: `killed:${sig}`, exitCode: 130 }));
        })) as NonNullable<RunReplOptions['execBash']>,
    });
    await tick();
    stdin.feed('!sleep\r'); // runs → busy:change(true); buffer clears
    await tick();
    writes.length = 0; // only inspect frames after we start typing the 2nd `!`
    stdin.feed('!x'); // type a new `!` command while the first runs (no Enter)
    await flushFrame();
    expect(writes.join('')).not.toContain('! for shell mode');
    // Cleanup: kill the running command, then EOF.
    stdin.feed('\x03');
    await flushFrame();
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

  test('boot banner does NOT render memory env entry (env block removed)', async () => {
    const stdin = makeStdin();
    const writes: string[] = [];
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub({ memoryCount: 3 }),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    await tick();
    const all = writes.join('');
    // env block was removed from the boot banner — registry count
    // still flows through to the PermanentItem for NDJSON / audit
    // consumers, but the TUI no longer renders it.
    expect(all).not.toContain('memory: 3');
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('boot banner omits memory env entry when registry is empty', async () => {
    const stdin = makeStdin();
    const writes: string[] = [];
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub({ memoryCount: 0 }),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    await tick();
    const all = writes.join('');
    // Zero memories → no env entry; the "memory:" key never appears.
    expect(all).not.toContain('memory:');
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('boot banner does NOT render skills env entry (env block removed)', async () => {
    const stdin = makeStdin();
    const writes: string[] = [];
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub({ skillCount: 5 }),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    await tick();
    const all = writes.join('');
    expect(all).not.toContain('skills: 5');
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('boot banner omits skills env entry when the catalog is empty', async () => {
    const stdin = makeStdin();
    const writes: string[] = [];
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub({ skillCount: 0 }),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    await tick();
    const all = writes.join('');
    expect(all).not.toContain('skills:');
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('boot emits welcome banner with correct content (title + cwd only)', async () => {
    // Banner was trimmed to two lines: title (`Forja v0.0.0`) + cwd.
    // Identity line (model / ctx / max-output) moved to footer chips;
    // env block (subagents, skills, checkpoints, memory) was dropped.
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
    await tick();
    await tick();
    const all = writes.join('');
    // App name and version are painted with DIFFERENT SGR wraps
    // (bold for app, secondary for version), so a color-enabled
    // terminal places an ANSI reset between them — substring
    // 'Forja v0.0.0' wouldn't match. Check each segment present.
    expect(all).toContain('Forja');
    expect(all).toContain('v0.0.0');
    expect(all).toContain('/path/to/repo');
    // Removed surfaces.
    expect(all).not.toContain('200k ctx');
    expect(all).not.toContain('max 4096 out');
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

  test('Enter while a turn is in flight queues the input, drained at the boundary (INBOX)', async () => {
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
    // Enter while running no longer drops the input (the old behavior) —
    // it queues. No 2nd run starts yet: the queue drains at the turn
    // boundary, not mid-turn (INBOX §2.2).
    stdin.feed('b\r');
    await tick();
    expect(ra.captured).toHaveLength(1);
    // Boundary reached (session_finished): the queued 'b' drains as the
    // next turn on its own — no manual re-submit needed.
    ra.finish(0);
    await tick();
    expect(ra.captured).toHaveLength(2);
    expect(ra.captured[1]?.configs[0]?.userPrompt).toBe('b');
    // The drained turn threads resume like any follow-up turn.
    expect(ra.captured[1]?.configs[0]?.resumeFromSessionId).toBe('sess-1');
    ra.finish(1);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('multiple messages queued during a turn drain as ONE concatenated turn (INBOX §5.1)', async () => {
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
    stdin.feed('start\r');
    await tick();
    expect(ra.captured).toHaveLength(1);
    // Queue two more while busy — they accumulate, no new run.
    stdin.feed('one\r');
    await tick();
    stdin.feed('two\r');
    await tick();
    expect(ra.captured).toHaveLength(1);
    // Drain: a SINGLE turn whose body is the two queued messages joined
    // by the markdown-rule separator, in FIFO order (not two turns —
    // the provider can't take consecutive user messages, INBOX §5.2).
    ra.finish(0);
    await tick();
    expect(ra.captured).toHaveLength(2);
    expect(ra.captured[1]?.configs[0]?.userPrompt).toBe('one\n\n---\n\ntwo');
    ra.finish(1);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('a draft typed after queueing survives the drain (INBOX — input preserved)', async () => {
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
    // Queue 'b' (Enter clears the buffer), then start typing 'c' WITHOUT
    // Enter — a live draft.
    stdin.feed('b\r');
    await tick();
    stdin.feed('c');
    await tick();
    // Boundary: 'b' drains as turn 2; the 'c' draft must NOT be nuked by
    // the drain (it does not clear the input).
    ra.finish(0);
    await tick();
    expect(ra.captured).toHaveLength(2);
    expect(ra.captured[1]?.configs[0]?.userPrompt).toBe('b');
    // Finish turn 2 (nothing left to drain), then Enter — the preserved
    // 'c' draft submits as turn 3.
    ra.finish(1);
    await tick();
    stdin.feed('\r');
    await tick();
    expect(ra.captured).toHaveLength(3);
    expect(ra.captured[2]?.configs[0]?.userPrompt).toBe('c');
    ra.finish(2);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('↑ lifts the most-recent queued message; Enter re-queues it edited (INBOX §4.2)', async () => {
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
    // Queue two while busy.
    stdin.feed('one\r');
    await tick();
    stdin.feed('two\r');
    await tick();
    // ↑ lifts 'two' (the tail) into the input, cursor at end.
    stdin.feed('\x1b[A');
    await tick();
    // Edit + commit. No new turn from the commit (still busy).
    stdin.feed(' edited\r');
    await tick();
    expect(ra.captured).toHaveLength(1);
    // Boundary: the queue drains as ONE turn with the edit applied in
    // place, FIFO order preserved.
    ra.finish(0);
    await tick();
    expect(ra.captured).toHaveLength(2);
    expect(ra.captured[1]?.configs[0]?.userPrompt).toBe('one\n\n---\n\ntwo edited');
    ra.finish(1);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('↓ cancels an inbox edit, restoring the queued message unchanged', async () => {
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
    stdin.feed('keep this\r');
    await tick();
    // ↑ lifts it, then mangle the draft...
    stdin.feed('\x1b[A');
    await tick();
    stdin.feed(' MANGLED');
    await tick();
    // ↓ cancels: original re-queued, edit discarded.
    stdin.feed('\x1b[B');
    await tick();
    // Drain carries the ORIGINAL, not the mangled draft.
    ra.finish(0);
    await tick();
    expect(ra.captured).toHaveLength(2);
    expect(ra.captured[1]?.configs[0]?.userPrompt).toBe('keep this');
    ra.finish(1);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('a message being edited is held back from the drain, then commits in place (INBOX §4.2)', async () => {
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
    // Queue two while busy.
    stdin.feed('alpha\r');
    await tick();
    stdin.feed('beta\r');
    await tick();
    // ↑ lifts 'beta' (the tail) into the input to edit it.
    stdin.feed('\x1b[A');
    await tick();
    // Boundary hits WHILE editing beta: only 'alpha' drains; 'beta' (being
    // edited) is held back so the operator isn't cut off mid-edit.
    ra.finish(0);
    await tick();
    expect(ra.captured).toHaveLength(2);
    expect(ra.captured[1]?.configs[0]?.userPrompt).toBe('alpha');
    // Finish editing — commit writes the new text in place, no new turn.
    stdin.feed(' edited\r');
    await tick();
    expect(ra.captured).toHaveLength(2);
    // It drains at the NEXT boundary, carrying the edited text.
    ra.finish(1);
    await tick();
    expect(ra.captured).toHaveLength(3);
    expect(ra.captured[2]?.configs[0]?.userPrompt).toBe('beta edited');
    ra.finish(2);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('committing an edit after the turn already ended drains it (no stuck message)', async () => {
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
    // Queue the ONLY message, then lift it for editing.
    stdin.feed('only one\r');
    await tick();
    stdin.feed('\x1b[A');
    await tick();
    // Turn ends while editing: the boundary holds the edited message back
    // (nothing else to drain), so the REPL goes idle with it still queued.
    ra.finish(0);
    await tick();
    expect(ra.captured).toHaveLength(1);
    // Commit while idle — it must drain as a new turn, not sit stuck.
    stdin.feed(' edited\r');
    await tick();
    expect(ra.captured).toHaveLength(2);
    expect(ra.captured[1]?.configs[0]?.userPrompt).toBe('only one edited');
    ra.finish(1);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('Ctrl+C while editing a queued message cancels the edit (does not strand it)', async () => {
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
    stdin.feed('queued msg\r');
    await tick();
    // Lift it for editing (input now holds 'queued msg').
    stdin.feed('\x1b[A');
    await tick();
    // Ctrl+C on the non-empty buffer clears it (no 'interrupt' surfaced)
    // and must also cancel the edit — otherwise the message stays hidden
    // and held back.
    stdin.feed('\x03');
    await tick();
    // Boundary: the message drains (edit cancelled, so it's not held).
    ra.finish(0);
    await tick();
    expect(ra.captured).toHaveLength(2);
    expect(ra.captured[1]?.configs[0]?.userPrompt).toBe('queued msg');
    ra.finish(1);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('cancelling an edit after the turn ended drains the original (no stuck message)', async () => {
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
    stdin.feed('original msg\r');
    await tick();
    stdin.feed('\x1b[A');
    await tick();
    ra.finish(0);
    await tick();
    expect(ra.captured).toHaveLength(1);
    // Mangle the draft, then ↓ to cancel — the original drains (idle).
    stdin.feed(' MANGLED');
    await tick();
    stdin.feed('\x1b[B');
    await tick();
    expect(ra.captured).toHaveLength(2);
    expect(ra.captured[1]?.configs[0]?.userPrompt).toBe('original msg');
    ra.finish(1);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('a message queued during a turn that REJECTS (no session_finished) still drains', async () => {
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
    expect(ra.captured).toHaveLength(1);
    // Queue a message while turn 1 is in flight.
    stdin.feed('queued during failure\r');
    await tick();
    expect(ra.captured).toHaveLength(1);
    // Turn 1's runAgent rejects BEFORE emitting session_finished (e.g. a
    // provider crash). The finalizer must still drain the queue, not leave
    // the message pending until some later boundary.
    ra.reject(0);
    await tick();
    expect(ra.captured).toHaveLength(2);
    expect(ra.captured[1]?.configs[0]?.userPrompt).toBe('queued during failure');
    ra.finish(1);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('Ctrl+D on an emptied edit buffer cancels the edit (does not strand the message)', async () => {
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
    // Queue "held" and lift it for editing.
    stdin.feed('held\r');
    await tick();
    stdin.feed('\x1b[A');
    await tick();
    // Empty the edit buffer, then Ctrl+D (EOF). While busy this interrupts
    // the turn; it must ALSO cancel the edit, or "held" stays hidden + held
    // and the prompt wedges (no ↑ lift / history recall) until discovered.
    stdin.feed('\x7f'.repeat('held'.length));
    await tick();
    stdin.feed('\x04');
    await tick();
    // Turn ends → the un-held message drains as the next turn.
    ra.finish(0);
    await tick();
    expect(ra.captured).toHaveLength(2);
    expect(ra.captured[1]?.configs[0]?.userPrompt).toBe('held');
    ra.finish(1);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('emptying a lifted edit buffer with Backspace cancels the edit (no strand)', async () => {
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
    stdin.feed('held\r');
    await tick();
    stdin.feed('\x1b[A');
    await tick();
    // Empty the lifted buffer with plain Backspaces (NOT Ctrl+C/Ctrl+D).
    // The edit must cancel so "held" un-hides and drains — not strand
    // (hidden + held, empty prompt, Enter a no-op).
    stdin.feed('\x7f'.repeat('held'.length));
    await tick();
    ra.finish(0);
    await tick();
    expect(ra.captured).toHaveLength(2);
    expect(ra.captured[1]?.configs[0]?.userPrompt).toBe('held');
    ra.finish(1);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('Ctrl+U emptying a lifted edit buffer also cancels the edit', async () => {
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
    stdin.feed('held\r');
    await tick();
    stdin.feed('\x1b[A');
    await tick();
    // Ctrl+U kills the whole line → empty buffer → edit cancels.
    stdin.feed('\x15');
    await tick();
    ra.finish(0);
    await tick();
    expect(ra.captured).toHaveLength(2);
    expect(ra.captured[1]?.configs[0]?.userPrompt).toBe('held');
    ra.finish(1);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('Esc while editing a queued message cancels the edit (restores it, no interrupt)', async () => {
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
    stdin.feed('keep me\r');
    await tick();
    stdin.feed('\x1b[A');
    await tick();
    // Edit in progress — non-empty buffer, so the empty-buffer cancel
    // does NOT apply; Esc must be handled as a cancel key in its own right.
    stdin.feed(' MANGLE');
    await tick();
    // Esc cancels the edit and restores "keep me" unchanged; it does NOT
    // interrupt the running turn. (A lone Esc resolves after the parser's
    // idle-drain timeout, hence flushFrame.)
    stdin.feed('\x1b');
    await flushFrame();
    ra.finish(0);
    await tick();
    expect(ra.captured).toHaveLength(2);
    expect(ra.captured[1]?.configs[0]?.userPrompt).toBe('keep me');
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

  test('confirmPermission with subagent attribution survives ANSI-tainted args end-to-end', async () => {
    // Spec docs/spec/IPC.md §7. The child's tool args originate
    // inside the subagent — a hostile agent definition could
    // inject ANSI escape sequences into args that, rendered raw,
    // would mislead the operator (fake "✓ trusted" labels around
    // `rm -rf /`). The bridge applies stripAnsi to command,
    // cwd, and prompt before handing them to the modal manager;
    // strip behavior itself is unit-tested in sanitize tests.
    // This test guards the integration path: bridge + tainted
    // input + subagent attribution must round-trip the modal
    // without crashing or losing the operator's verdict.
    // Smoke: drive the bridge with tainted strings + subagent
    // attribution, hit '1' to allow, assert the answer is true
    // (sanitization didn't crash the path) and that no escape
    // bytes survived in the captured `permission:ask` event the
    // bus carried — the modal manager keeps fields verbatim.
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
    const tainted = '[31mrm -rf /[0m';
    const askPromise = cfg?.confirmPermission?.({
      toolName: 'bash',
      args: { command: tainted },
      cwd: '[32m/safe[0m',
      prompt: '[33mLooks fine[0m',
      subagent: { sessionId: 'sess-childA', name: 'explore' },
    });
    await tick();
    // Hotkey '1' resolves the modal as 'yes' — bridge maps to true.
    stdin.feed('1');
    await tick();
    const answer = await askPromise;
    expect(answer).toBe(true);
    // Wrap up.
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('confirmPermission bridge forwards source.rule + source.layer into the modal', async () => {
    // Pins the engine → REPL bridge → modal seam. Without this,
    // a regression where the bridge forgot to spread `rule` or
    // `layer` into the modal manager call would silently
    // degrade the operator UX (modal renders without the rule
    // attribution) and only typecheck-pass because both fields
    // are optional. Capturing rendered writes via rendererWrite
    // is the only way to assert the rendered string contains
    // the expected layer hint, since modalManager is internal
    // to the REPL.
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
    const cfg = ra.captured[0]?.configs[0];
    expect(cfg?.confirmPermission).toBeDefined();
    // Drive the bridge with a Decision-shaped source. The exact
    // wording the modal prints comes from the reducer
    // (modal-integration test pins the format string); we just
    // check the bridge forwarded both fields end-to-end.
    const askPromise = cfg?.confirmPermission?.({
      toolName: 'bash',
      args: { command: 'rm -rf /tmp/cache/*' },
      cwd: '/r',
      prompt: 'matched confirm rule: rm -rf *',
      source: {
        layer: 'project',
        rule: 'rm -rf *',
        section: 'bash',
      },
    });
    await flushFrame();
    const rendered = writes.join('');
    // Rule + layer round-tripped: bridge → modalManager →
    // event → reducer → renderer.
    expect(rendered).toContain('matched rule: rm -rf * (project policy)');
    // Resolve the modal so the test cleans up.
    stdin.feed('\x1b\x1b');
    await tick();
    expect(await askPromise).toBe(false);
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

  test('AGENTS.md presence in cwd is surfaced in the trust modal preview', async () => {
    // Spec AGENTIC_CLI.md line 75: AGENTS.md is untrusted input
    // until proven otherwise. The reducer adds an explicit
    // "AGENTS.md present — its instructions will be loaded on
    // first use" preview line when the flag is set; the producer
    // (this REPL flow) has to detect the file and forward the
    // flag. Pre-fix we always passed agentsMd=false, hiding the
    // safety cue from the operator.
    //
    // Cwd is a real temp dir (NOT the synthetic
    // `/tmp/forja-repl-test`) because the AGENTS.md probe runs a
    // real `existsSync`. The bootstrap stub is configured to
    // match.
    const cwdWithAgents = mkdtempSync(join(tmpdir(), 'forja-agentsmd-'));
    writeFileSync(join(cwdWithAgents, 'AGENTS.md'), 'project context\n');
    try {
      const stdin = makeStdin();
      const captured: string[] = [];
      const ra = makeRunAgent((n) => `sess-${n}`);
      const promise = runRepl({
        args: makeArgs(),
        bootstrapOverride: makeBootstrapStub(cwdWithAgents),
        stdin,
        skipTtyCheck: true,
        runAgentOverride: ra.runAgent,
        trustListPathOverride: trustPath,
        rendererWrite: (s) => {
          captured.push(s);
        },
      });
      // Wait for the frame scheduler to draw the modal — the
      // renderer's onAny subscription accumulates events but the
      // first paint goes through scheduler.request which fires on
      // the next ~33ms tick. flushFrame's 50ms is enough.
      await flushFrame();
      const rendered = captured.join('');
      expect(rendered).toContain('AGENTS.md present');
      // Decline so we exit cleanly without a runAgent invocation.
      stdin.feed('2');
      expect(await promise).toBe(0);
    } finally {
      rmSync(cwdWithAgents, { recursive: true, force: true });
    }
  });

  test('AGENTS.md absent in cwd suppresses the preview line', async () => {
    // Inverse of the test above: when no AGENTS.md exists the
    // reducer must NOT push the notice. Guards against a regression
    // where the producer always forwards true.
    const cwdNoAgents = mkdtempSync(join(tmpdir(), 'forja-noagents-'));
    try {
      const stdin = makeStdin();
      const captured: string[] = [];
      const ra = makeRunAgent((n) => `sess-${n}`);
      const promise = runRepl({
        args: makeArgs(),
        bootstrapOverride: makeBootstrapStub(cwdNoAgents),
        stdin,
        skipTtyCheck: true,
        runAgentOverride: ra.runAgent,
        trustListPathOverride: trustPath,
        rendererWrite: (s) => {
          captured.push(s);
        },
      });
      await flushFrame();
      const rendered = captured.join('');
      expect(rendered).not.toContain('AGENTS.md present');
      stdin.feed('2');
      expect(await promise).toBe(0);
    } finally {
      rmSync(cwdNoAgents, { recursive: true, force: true });
    }
  });

  test('stdin subscription is deferred until a focus handler exists', async () => {
    // Regression: pre-fix runRepl subscribed to stdin during the
    // pre-bootstrap stack setup, BEFORE any focus handler was
    // pushed. In the already-trusted path the modal never opens,
    // so the focus stack stays empty until the editor is registered
    // post-bootstrap. Any keystroke that hit the wire in that
    // window was parsed and dispatched into an empty stack, then
    // silently dropped. Fix subscribes lazily — only after
    // `modalManager.askTrust` queues its handler (trust path) or
    // `focusStack.push(editorHandler)` runs (post-bootstrap).
    //
    // We pin the contract via the `data` listener count: it must
    // be 0 immediately after `stdin` is set up by the test, then
    // jump to 1 only once a handler is on the focus stack. The
    // shape we exercise here is the already-trusted path (no modal
    // → only the editor push triggers subscribe).
    const stdin = makeStdin();
    addTrustedDir(trustPath, '/tmp/forja-repl-test'); // bypass modal
    const ra = makeRunAgent((n) => `sess-${n}`);
    expect(stdin.listenerCount('data')).toBe(0);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      runAgentOverride: ra.runAgent,
      trustListPathOverride: trustPath,
    });
    await tick();
    // Editor is registered now → onData attached → listener count 1.
    expect(stdin.listenerCount('data')).toBe(1);
    // Submit a turn to verify input still flows after the deferred
    // subscribe (no regression on the happy path).
    stdin.feed('hi\r');
    await tick();
    expect(ra.captured).toHaveLength(1);
    expect(ra.captured[0]?.configs[0]?.userPrompt).toBe('hi');
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
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

  test('prefix /q + Enter (no Tab) executes the highlighted /quit (regression)', async () => {
    // Without the fix, Enter dispatches the raw buffer (`q`), the
    // registry lookup fails, and the operator sees "unknown command"
    // while `quit` sat visibly selected in the popover. The
    // operator's intent — "run the highlighted item" — wins.
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
    });
    await tick();
    stdin.feed('/q');
    await flushFrame();
    // Popover open with `quit` highlighted (only `q*` match). Enter
    // commits the selection — exit code 0 proves /quit ran.
    stdin.feed('\r');
    expect(await promise).toBe(0);
  });

  test('exit hint: prints "Resume this session with: forja --resume <id>" after a turn ran', async () => {
    // Operator-visible cue printed during shutdown so the next boot
    // can pick up where the previous one left off. Goes through
    // errSink (operator diagnostics, not program output). Gated on
    // lastSessionId being non-null — see the next test.
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const errs: string[] = [];
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      errSink: (s) => {
        errs.push(s);
      },
    });
    await tick();
    // One turn so lastSessionId gets populated (`sess-1`).
    stdin.feed('hi\r');
    await tick();
    ra.finish(0);
    await tick();
    // Quit. Shutdown path runs and the hint should land on errSink.
    stdin.feed('/quit\r');
    expect(await promise).toBe(0);
    const all = errs.join('');
    expect(all).toContain('Resume this session with:');
    expect(all).toContain('forja --resume sess-1');
  });

  test('exit hint: silent when no turn ever ran (lastSessionId stays null)', async () => {
    // Operator opens the REPL and quits without prompting anything —
    // there is no session to resume to, so the hint must NOT print.
    // Printing `forja --resume undefined` would actively mislead.
    const stdin = makeStdin();
    const errs: string[] = [];
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      errSink: (s) => {
        errs.push(s);
      },
    });
    await tick();
    stdin.feed('/quit\r');
    expect(await promise).toBe(0);
    const all = errs.join('');
    expect(all).not.toContain('Resume this session with:');
    expect(all).not.toContain('--resume');
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

  test('bare / + Enter dispatches the default-highlighted command (does NOT send "/" to the LLM)', async () => {
    // `/` opens the popover with selectedIdx=0 (the first registry
    // entry, currently `/help`). Enter commits that selection — same
    // contract as any other prefix. The critical invariant: '/' must
    // NEVER reach the LLM as a user message, regardless of whether
    // the dispatcher runs the highlight or no-ops.
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const writes: string[] = [];
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
    stdin.feed('/');
    await flushFrame();
    stdin.feed('\r');
    await flushFrame();
    // No turn started — runAgent override never called.
    expect(ra.captured).toHaveLength(0);
    // The default highlight (help) executed — its scrollback output
    // is the proof.
    expect(writes.join('')).toContain('Slash commands:');
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('bare / + Down + Enter executes the navigated selection (regression)', async () => {
    // Operator opens the popover with bare `/`, navigates one row
    // down (off `help`, onto `quit` — registration order), and hits
    // Enter. Without the fix, the bare-slash early-return branch
    // ignored the popover selection entirely; the operator saw the
    // highlighted row but Enter did nothing user-visible.
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStub(),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
    });
    await tick();
    stdin.feed('/');
    await flushFrame();
    stdin.feed('\x1b[B'); // Down — move highlight from /help to /quit.
    await flushFrame();
    stdin.feed('\r'); // Enter — should dispatch /quit, not no-op.
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
    // Turn 1: drive session_start with boot-time maxSteps (200 from
    // DEFAULT_BUDGET). The footer chip for steps was removed, so
    // verify the contract directly: the HarnessConfig the stub
    // received carries the correct cap.
    stdin.feed('go\r');
    await tick();
    expect(ra.captured[0]?.configs[0]?.budget?.maxSteps).toBe(200);
    ra.emitInto(0, { type: 'session_start', sessionId: 'sess-1' });
    await flushFrame();
    ra.finish(0);
    await tick();
    // Mutate via slash command, then turn 2 — runAgent must be
    // called with the post-mutation maxSteps.
    stdin.feed('/budget steps 99\r');
    await flushFrame();
    stdin.feed('next\r');
    await tick();
    expect(ra.captured[1]?.configs[0]?.budget?.maxSteps).toBe(99);
    ra.emitInto(1, { type: 'session_start', sessionId: 'sess-2' });
    await flushFrame();
    ra.finish(1);
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

  test('runPlaybook forwards onPermissionAsk through confirmPermission (subagent confirm gating)', async () => {
    // Regression: `runPlaybook` previously called `runSubagent`
    // without `onPermissionAsk`, so the subagent runtime would
    // auto-deny every child `permission:ask`. A playbook hitting a
    // confirm-gated tool would silently fail under the operator
    // instead of prompting them. Now the dispatcher mirrors the
    // harness's `spawnSubagentImpl` wiring (loop.ts) — adapting
    // the parent's `confirmPermission` (boolean) into the runtime's
    // PermissionDecision shape.
    const stub = makeBootstrapStub();
    // Inject one fake playbook with `slash: 'fake'`. The bootstrap
    // stub default has `subagents: { byName: new Map() }`; we cast
    // through unknown because the real SubagentDefinition has many
    // optional fields the dispatcher does not read on this path.
    const fakeDef = {
      name: 'fake',
      description: 'fake subagent for tests',
      tools: [],
      budget: { maxSteps: 1, maxCostUsd: 0.01 },
      systemPrompt: 'noop',
      scope: 'project',
      isolation: 'none',
      sourcePath: '/dev/null',
      sourceSha256: '0'.repeat(64),
      slash: 'fake',
    };
    (stub.subagents.byName as Map<string, unknown>).set('fake', fakeDef);

    let captured:
      | {
          onPermissionAsk?: (req: {
            toolName: string;
            args: Record<string, unknown>;
            cwd: string;
            prompt: string;
            subagent: { sessionId: string; name: string };
            signal: AbortSignal;
          }) => Promise<'allow' | 'deny'>;
        }
      | undefined;
    const fakeRunSubagent = async (
      input: Parameters<typeof import('../../src/subagents/index.ts').runSubagent>[0],
    ): ReturnType<typeof import('../../src/subagents/index.ts').runSubagent> => {
      captured = {
        ...(input.onPermissionAsk !== undefined ? { onPermissionAsk: input.onPermissionAsk } : {}),
      };
      return {
        output: '(no-op)',
        sessionId: 'sess-fake-child',
        status: 'done',
        reason: 'done',
        costUsd: 0,
        steps: 0,
        durationMs: 0,
      };
    };

    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      runSubagentOverride: fakeRunSubagent,
    });
    await tick();
    // Drive the slash dispatch.
    stdin.feed('/fake go\r');
    // Dispatcher awaits runPlaybook → runSubagent. Two ticks let the
    // microtask chain settle through the slash exec path.
    await tick();
    await tick();

    expect(captured).toBeDefined();
    expect(captured?.onPermissionAsk).toBeDefined();

    // Drive the callback. It should call confirmPermission, which
    // routes through modalManager. We resolve the modal with Esc
    // (no), the bridge maps to false, runtime adapter maps to
    // 'deny'.
    const decisionPromise = captured?.onPermissionAsk?.({
      toolName: 'bash',
      args: { command: 'echo hi' },
      cwd: '/tmp',
      prompt: 'subagent wants to run a command',
      subagent: { sessionId: 'sess-fake-child', name: 'fake' },
      signal: new AbortController().signal,
    });
    await tick();
    // Esc-Esc rejects the modal (mirrors the existing modal smoke
    // test above; '\x1b\x1b' is the modal-manager's reject hotkey).
    stdin.feed('\x1b\x1b');
    await tick();
    const decision = await decisionPromise;
    expect(decision).toBe('deny');

    // No normal turn was started — slash dispatch goes through the
    // playbook bridge, not runAgent. Skip ra.finish; just close
    // stdin to wind down the REPL.
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('a second slash playbook dispatch is refused while the first is in flight', async () => {
    // Regression: `dispatchSlash` is fire-and-forget (`void
    // dispatchSlash(...)`), and `runPlaybook` doesn't touch the
    // REPL's foreground `running` flag. Without a separate gate,
    // hitting `/fake go\r` twice in a row would race two child
    // runs against shared DB / provider / permission state under
    // the same parent session. The fix: `runPlaybook` flips a
    // dedicated `playbookRunning` flag synchronously (before any
    // await), and `isRunning()` reports either flag, so the
    // second slash exec sees `isRunning() === true` and refuses.
    const stub = makeBootstrapStub();
    const fakeDef = {
      name: 'fake',
      description: 'fake subagent for tests',
      tools: [],
      budget: { maxSteps: 1, maxCostUsd: 0.01 },
      systemPrompt: 'noop',
      scope: 'project',
      isolation: 'none',
      sourcePath: '/dev/null',
      sourceSha256: '0'.repeat(64),
      slash: 'fake',
    };
    (stub.subagents.byName as Map<string, unknown>).set('fake', fakeDef);

    let inflight = 0;
    let maxConcurrent = 0;
    let firstSeen = false;
    let releaseFirst: () => void = () => {};
    const firstParked = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const fakeRunSubagent = async (): ReturnType<
      typeof import('../../src/subagents/index.ts').runSubagent
    > => {
      inflight += 1;
      maxConcurrent = Math.max(maxConcurrent, inflight);
      // First dispatch parks until the test releases it. A second
      // dispatch leaking past the gate would also reach here and
      // bump `maxConcurrent` past 1 — the assertion catches it
      // without hanging the test (the second call returns
      // immediately rather than parking).
      if (!firstSeen) {
        firstSeen = true;
        await firstParked;
      }
      inflight -= 1;
      return {
        output: '(no-op)',
        sessionId: 'sess-fake-child',
        status: 'done',
        reason: 'done',
        costUsd: 0,
        steps: 0,
        durationMs: 0,
      };
    };

    const stdin = makeStdin();
    const writes: string[] = [];
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      runSubagentOverride: fakeRunSubagent,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    // Two dispatches in the same Enter burst — the first sets
    // playbookRunning synchronously inside runPlaybook before the
    // first await; the second sees isRunning() === true and is
    // refused by the slash gate.
    stdin.feed('/fake first\r');
    await tick();
    await tick();
    stdin.feed('/fake second\r');
    await tick();
    await tick();
    await flushFrame();

    // The first dispatch must be parked in the fake; the second
    // must have been refused before reaching the runtime.
    expect(maxConcurrent).toBe(1);
    expect(inflight).toBe(1);
    // The slash gate's error message reaches scrollback.
    expect(writes.join('')).toContain('turn or playbook is in progress');

    // Release the first dispatch and let the REPL settle.
    releaseFirst();
    await tick();
    await flushFrame();
    expect(inflight).toBe(0);

    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('slash playbook forwards baseConfig.hooks as hooksSnapshot', async () => {
    // Regression: runPlaybook called runSubagent without
    // hooksSnapshot, so slash-dispatched playbooks fell back to
    // re-resolving hooks.toml from disk at child startup —
    // reintroducing the parent/child drift the snapshot
    // mechanism (forwarded by harness/loop.ts on the task_*
    // path) was added to prevent. A human edit between parent
    // boot and child startup would land the slash child on a
    // different chain than the operator validated.
    const stub = makeBootstrapStub();
    // Pin a sentinel hook chain on the captured config. The
    // shape comes from `HookSpec` but we only need an
    // identifiable marker for the round-trip assertion.
    const sentinelHooks = [
      {
        event: 'PreToolUse',
        sourcePath: '/test/hooks.toml',
        match: { tool: 'bash' },
        run: 'echo sentinel',
      },
    ];
    (stub.config as { hooks?: unknown }).hooks = sentinelHooks;

    const fakeDef = {
      name: 'fake',
      description: 'fake subagent for tests',
      tools: [],
      budget: { maxSteps: 1, maxCostUsd: 0.01 },
      systemPrompt: 'noop',
      scope: 'project',
      isolation: 'none',
      sourcePath: '/dev/null',
      sourceSha256: '0'.repeat(64),
      slash: 'fake',
    };
    (stub.subagents.byName as Map<string, unknown>).set('fake', fakeDef);

    let capturedSnapshot: unknown;
    const fakeRunSubagent = async (
      input: Parameters<typeof import('../../src/subagents/index.ts').runSubagent>[0],
    ): ReturnType<typeof import('../../src/subagents/index.ts').runSubagent> => {
      capturedSnapshot = input.hooksSnapshot;
      return {
        output: '(no-op)',
        sessionId: 'sess-fake-child',
        status: 'done',
        reason: 'done',
        costUsd: 0,
        steps: 0,
        durationMs: 0,
      };
    };

    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      runSubagentOverride: fakeRunSubagent,
    });
    await tick();

    stdin.feed('/fake go\r');
    await tick();
    await tick();
    await flushFrame();

    // The sentinel chain round-tripped — same array reference
    // (no clone) since the spawn closure forwards verbatim.
    expect(capturedSnapshot).toBe(sentinelHooks);

    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('slash playbook forwards baseConfig.temperature to runSubagent', async () => {
    // Regression: runPlaybook called runSubagent without
    // forwarding baseConfig.temperature, so an eval rig that
    // started the REPL with temperature: 0 would see
    // deterministic task_sync runs (harness/loop.ts forwards
    // config.temperature on the foreground spawn path) but
    // nondeterministic /<playbook> runs. Identical subagent
    // work behaved differently depending on the route the
    // model picked; the bridge now mirrors the loop's wiring.
    const stub = makeBootstrapStub();
    // Pin a session-level temperature on the captured config.
    // makeBootstrapStub returns a partial HarnessConfig; cast
    // through unknown to assign the field test-side without
    // dragging the full type into the stub.
    (stub.config as { temperature?: number }).temperature = 0;

    const fakeDef = {
      name: 'fake',
      description: 'fake subagent for tests',
      tools: [],
      budget: { maxSteps: 1, maxCostUsd: 0.01 },
      systemPrompt: 'noop',
      scope: 'project',
      isolation: 'none',
      sourcePath: '/dev/null',
      sourceSha256: '0'.repeat(64),
      slash: 'fake',
    };
    (stub.subagents.byName as Map<string, unknown>).set('fake', fakeDef);

    let capturedTemperature: number | undefined;
    const fakeRunSubagent = async (
      input: Parameters<typeof import('../../src/subagents/index.ts').runSubagent>[0],
    ): ReturnType<typeof import('../../src/subagents/index.ts').runSubagent> => {
      capturedTemperature = input.temperature;
      return {
        output: '(no-op)',
        sessionId: 'sess-fake-child',
        status: 'done',
        reason: 'done',
        costUsd: 0,
        steps: 0,
        durationMs: 0,
      };
    };

    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      runSubagentOverride: fakeRunSubagent,
    });
    await tick();

    stdin.feed('/fake go\r');
    await tick();
    await tick();
    await flushFrame();

    // The pinned temperature flowed through to the child's
    // runSubagent input, matching what the foreground task_*
    // spawn path does in harness/loop.ts.
    expect(capturedTemperature).toBe(0);

    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('slash playbook forwards the resolved provider-effort to runSubagent', async () => {
    // Companion to the temperature forward: /<playbook> dispatch must
    // honor the operator's /effort (or configured default) like the
    // foreground task_* path. Without it the child runs at the provider
    // default while the footer + /effort confirmation say it is active.
    const stub = makeBootstrapStub();
    (stub.config as { effort?: string }).effort = 'max';

    const fakeDef = {
      name: 'fake',
      description: 'fake subagent for tests',
      tools: [],
      budget: { maxSteps: 1, maxCostUsd: 0.01 },
      systemPrompt: 'noop',
      scope: 'project',
      isolation: 'none',
      sourcePath: '/dev/null',
      sourceSha256: '0'.repeat(64),
      slash: 'fake',
    };
    (stub.subagents.byName as Map<string, unknown>).set('fake', fakeDef);

    let capturedProviderEffort: string | undefined;
    const fakeRunSubagent = async (
      input: Parameters<typeof import('../../src/subagents/index.ts').runSubagent>[0],
    ): ReturnType<typeof import('../../src/subagents/index.ts').runSubagent> => {
      capturedProviderEffort = input.providerEffort;
      return {
        output: '(no-op)',
        sessionId: 'sess-fake-child',
        status: 'done',
        reason: 'done',
        costUsd: 0,
        steps: 0,
        durationMs: 0,
      };
    };

    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      runSubagentOverride: fakeRunSubagent,
    });
    await tick();

    stdin.feed('/fake go\r');
    await tick();
    await tick();
    await flushFrame();

    // effort 'max' on the session config → resolveProviderEffort → 'max'
    // flows to the child, matching the foreground task_* spawn path.
    expect(capturedProviderEffort).toBe('max');

    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('/quit during a slash playbook aborts and waits for the dispatch before db.close', async () => {
    // Regression: runPlaybook started a long-lived runSubagent
    // await that the shutdown path neither aborted nor awaited
    // (only `runningPromise` was tracked). /quit-mid-playbook
    // would close the SQLite handle while the runtime was
    // still flushing the envelope, surfacing as a "database is
    // closed" throw and leaking the child past REPL exit. The
    // shutdown path now (a) aborts playbookAbortController and
    // (b) awaits playbookPromise before calling db.close.
    const stub = makeBootstrapStub();
    const fakeDef = {
      name: 'fake',
      description: 'fake subagent for tests',
      tools: [],
      budget: { maxSteps: 1, maxCostUsd: 0.01 },
      systemPrompt: 'noop',
      scope: 'project',
      isolation: 'none',
      sourcePath: '/dev/null',
      sourceSha256: '0'.repeat(64),
      slash: 'fake',
    };
    (stub.subagents.byName as Map<string, unknown>).set('fake', fakeDef);

    let dispatchSignal: AbortSignal | undefined;
    let dispatchSettled = false;
    const fakeRunSubagent = async (
      input: Parameters<typeof import('../../src/subagents/index.ts').runSubagent>[0],
    ): ReturnType<typeof import('../../src/subagents/index.ts').runSubagent> => {
      dispatchSignal = input.signal;
      // Park until the signal aborts. Once it does, simulate the
      // runtime's "still flushing" window — a brief async tick
      // before settling so any teardown that didn't await would
      // race past us.
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      await new Promise((r) => setTimeout(r, 5));
      dispatchSettled = true;
      return {
        output: '',
        sessionId: 'sess-fake-child',
        status: 'interrupted',
        reason: 'aborted',
        costUsd: 0,
        steps: 0,
        durationMs: 0,
        abortCause: 'hard',
      };
    };

    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      runSubagentOverride: fakeRunSubagent,
    });
    await tick();

    stdin.feed('/fake go\r');
    await tick();
    await tick();
    expect(dispatchSignal).toBeDefined();
    expect(dispatchSignal?.aborted).toBe(false);

    // Operator hits /quit — shutdown must abort the playbook
    // signal AND wait for dispatch to settle before exiting.
    stdin.feed('/quit\r');
    const code = await promise;
    // Shutdown aborted the dispatch.
    expect(dispatchSignal?.aborted).toBe(true);
    // AND awaited the runtime's flush window — without the
    // await in shutdown, dispatchSettled could still be false
    // by the time the REPL exited.
    expect(dispatchSettled).toBe(true);
    expect(code).toBe(0);
  });

  test('Ctrl+C during a slash playbook aborts the dispatch signal', async () => {
    // Regression: runPlaybook used to mint a fresh AbortController
    // and never wire it to the REPL's interrupt machinery
    // (triggerInterrupt aborted only the foreground per-turn
    // controllers). A long-running /<playbook> run could not be
    // preempted until budget / wall-clock fired. The per-dispatch
    // controllers are now stored in module-scope mirror refs
    // (playbookAbortController / playbookSoftStopController) so
    // triggerInterrupt aborts the playbook signal too — and the
    // 4 entry points (modal cancel, reverse-search Ctrl+C/Ctrl+D,
    // editor cancelInput) gate on isBusy() instead of running so
    // the path actually fires during a playbook.
    const stub = makeBootstrapStub();
    const fakeDef = {
      name: 'fake',
      description: 'fake subagent for tests',
      tools: [],
      budget: { maxSteps: 1, maxCostUsd: 0.01 },
      systemPrompt: 'noop',
      scope: 'project',
      isolation: 'none',
      sourcePath: '/dev/null',
      sourceSha256: '0'.repeat(64),
      slash: 'fake',
    };
    (stub.subagents.byName as Map<string, unknown>).set('fake', fakeDef);

    let capturedSignal: AbortSignal | undefined;
    let capturedSoftSignal: AbortSignal | undefined;
    let signalAborted = false;
    const fakeRunSubagent = async (
      input: Parameters<typeof import('../../src/subagents/index.ts').runSubagent>[0],
    ): ReturnType<typeof import('../../src/subagents/index.ts').runSubagent> => {
      capturedSignal = input.signal;
      capturedSoftSignal = input.softStopSignal;
      // Park until the interrupt fires. The controller's abort
      // resolves this race so we can return a result without
      // hanging the test.
      await new Promise<void>((resolve) => {
        capturedSignal?.addEventListener(
          'abort',
          () => {
            signalAborted = true;
            resolve();
          },
          { once: true },
        );
      });
      return {
        output: '',
        sessionId: 'sess-fake-child',
        status: 'interrupted',
        reason: 'aborted',
        costUsd: 0,
        steps: 0,
        durationMs: 0,
        abortCause: 'hard',
      };
    };

    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      runSubagentOverride: fakeRunSubagent,
    });
    await tick();

    stdin.feed('/fake go\r');
    // Two ticks for the slash dispatch microtask chain to land
    // inside fakeRunSubagent and capture the signals.
    await tick();
    await tick();
    expect(capturedSignal).toBeDefined();
    expect(capturedSoftSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    // Ctrl+C twice — first soft, second escalates to hard.
    // The reducer flips softInterrupted on the first emit;
    // triggerInterrupt reads that to decide which controller to
    // abort.
    stdin.feed('\x03');
    await tick();
    await flushFrame();
    // Soft is plumbed through the soft controller; hard signal
    // stays pending until the second tap.
    expect(capturedSoftSignal?.aborted).toBe(true);
    expect(capturedSignal?.aborted).toBe(false);

    stdin.feed('\x03');
    await tick();
    await flushFrame();
    expect(capturedSignal?.aborted).toBe(true);
    expect(signalAborted).toBe(true);

    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('foreground Enter is blocked while a slash playbook is in flight', async () => {
    // Regression: playbookRunning gated the slash dispatcher's
    // own `isRunning()` closure, but the foreground submit paths
    // (Enter in the editor, Enter in reverse-search) checked
    // only `running`. Pressing Enter mid-playbook started a
    // second concurrent run against the same provider / DB /
    // permission engine. The single `isBusy()` predicate now
    // gates every submit surface.
    const stub = makeBootstrapStub();
    const fakeDef = {
      name: 'fake',
      description: 'fake subagent for tests',
      tools: [],
      budget: { maxSteps: 1, maxCostUsd: 0.01 },
      systemPrompt: 'noop',
      scope: 'project',
      isolation: 'none',
      sourcePath: '/dev/null',
      sourceSha256: '0'.repeat(64),
      slash: 'fake',
    };
    (stub.subagents.byName as Map<string, unknown>).set('fake', fakeDef);

    let releaseDispatch: () => void = () => {};
    const dispatchParked = new Promise<void>((r) => {
      releaseDispatch = r;
    });
    const fakeRunSubagent = async (): ReturnType<
      typeof import('../../src/subagents/index.ts').runSubagent
    > => {
      await dispatchParked;
      return {
        output: '(no-op)',
        sessionId: 'sess-fake-child',
        status: 'done',
        reason: 'done',
        costUsd: 0,
        steps: 0,
        durationMs: 0,
      };
    };

    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      runSubagentOverride: fakeRunSubagent,
    });
    await tick();

    // Park a slash playbook in flight (fakeRunSubagent waits
    // on dispatchParked).
    stdin.feed('/fake go\r');
    await tick();
    await tick();

    // Now hit Enter on a normal prompt. The submit gate must
    // refuse — startTurn should NOT call runAgent while the
    // playbook is in flight.
    stdin.feed('a normal prompt\r');
    await tick();
    await tick();
    await flushFrame();

    // No foreground harness call landed.
    expect(ra.captured).toHaveLength(0);

    // The blocked submit kept the typed text in the buffer (per
    // the editor handler's contract — applyKey doesn't clear on
    // a refused submit, the operator can hit Enter again). Now
    // release the playbook and re-press Enter; the same buffer
    // submits and a foreground turn starts. This proves the
    // gate RELEASES correctly when the playbook ends.
    releaseDispatch();
    await tick();
    await flushFrame();

    stdin.feed('\r');
    await tick();
    await tick();
    expect(ra.captured).toHaveLength(1);
    expect(ra.captured[0]?.configs[0]?.userPrompt).toBe('a normal prompt');

    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('slash playbook spend rolls into /cost cumulative tracker', async () => {
    // Regression: cumulative.costUsd / steps / turns are mutated
    // ONLY on session_finished events from the foreground harness.
    // Slash dispatches go through `runSubagent` directly — no
    // session_finished fires for the parent — so /cost reported
    // 0 even after several /<playbook> runs. The bridge now folds
    // result.costUsd / steps into cumulative and bumps turns.
    const stub = makeBootstrapStub();
    const fakeDef = {
      name: 'fake',
      description: 'fake subagent for tests',
      tools: [],
      budget: { maxSteps: 1, maxCostUsd: 0.01 },
      systemPrompt: 'noop',
      scope: 'project',
      isolation: 'none',
      sourcePath: '/dev/null',
      sourceSha256: '0'.repeat(64),
      slash: 'fake',
    };
    (stub.subagents.byName as Map<string, unknown>).set('fake', fakeDef);

    // Resolve immediately with known accounting numbers — the
    // assertion below pins them through the cumulative tracker
    // and into the /cost render.
    const fakeRunSubagent = async (): ReturnType<
      typeof import('../../src/subagents/index.ts').runSubagent
    > => ({
      output: '(no-op)',
      sessionId: 'sess-fake-child',
      status: 'done',
      reason: 'done',
      costUsd: 0.0123,
      steps: 4,
      durationMs: 0,
    });

    const stdin = makeStdin();
    const writes: string[] = [];
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      runSubagentOverride: fakeRunSubagent,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();

    // First dispatch.
    stdin.feed('/fake one\r');
    await tick();
    await tick();
    await flushFrame();

    // Second dispatch — accumulation should compose.
    stdin.feed('/fake two\r');
    await tick();
    await tick();
    await flushFrame();

    // Drive /cost and observe the rendered cumulative line.
    const before = writes.length;
    stdin.feed('/cost\r');
    await tick();
    await flushFrame();
    const newWrites = writes.slice(before).join('');

    // Two playbook dispatches at 0.0123 USD each → 0.0246 total.
    // /cost formats via formatCost; the standard render shows
    // four decimals for sub-cent totals. 4 steps × 2 = 8.
    // Two dispatches → turns = 2.
    expect(newWrites).toContain('cumulative:');
    expect(newWrites).toMatch(/\$0\.0246/);
    expect(newWrites).toContain('8 steps');
    expect(newWrites).toContain('2 turns');

    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });
});

describe('repl — --resume gating + session seed (Phase 1)', () => {
  // `--resume <id|last>` with empty prompt now routes to the REPL
  // (cli/index.ts). repl.ts resolves the id against the DB via
  // resolveResumeIdOnDb and seeds `lastSessionId` so the first turn
  // threads `resumeFromSessionId` to the harness. Visual scrollback
  // replay lands in a follow-up slice.

  test('unknown id aborts boot with exit 1 and a clean diagnostic (no TUI flash)', async () => {
    const stub = makeBootstrapStub();
    const stdin = makeStdin();
    const errs: string[] = [];
    const rendererWrites: string[] = [];
    const promise = runRepl({
      args: makeArgs({ resume: 'does-not-exist' }),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      errSink: (s) => {
        errs.push(s);
      },
      rendererWrite: (s) => {
        rendererWrites.push(s);
      },
    });
    expect(await promise).toBe(1);
    expect(errs.join('')).toContain('session does-not-exist not found');
    // No live region drew — the boot aborts BEFORE the renderer
    // emits any frame. The renderer's pre-bootstrap hook does
    // write the bracketed-paste enable sequence, so we don't assert
    // rendererWrites is empty; we assert no session:banner line
    // (which would only land after the banner emit, well past the
    // resume gate).
    expect(rendererWrites.join('')).not.toContain('forja v');
  });

  test("'last' with no prior sessions aborts boot with cwd-scoped diagnostic", async () => {
    const stub = makeBootstrapStub();
    const errs: string[] = [];
    const promise = runRepl({
      args: makeArgs({ resume: 'last' }),
      bootstrapOverride: stub,
      stdin: makeStdin(),
      skipTtyCheck: true,
      skipTrustPrompt: true,
      errSink: (s) => {
        errs.push(s);
      },
    });
    expect(await promise).toBe(1);
    const all = errs.join('');
    expect(all).toContain("no sessions found to resume (with 'last')");
    // Diagnostic names the cwd so the operator can tell if the
    // resolver looked at the wrong tree (multi-repo gotcha).
    expect(all).toContain('/tmp/forja-repl-test');
  });

  test('subagent session id is refused (parent-only contract)', async () => {
    const stub = makeBootstrapStub();
    // is_subagent=true makes the session unresumable per the O5
    // C-block in resolveResumeIdOnDb.
    createSession(stub.db, {
      id: 'sub-sess-1',
      model: 'mock/m',
      cwd: '/tmp/forja-repl-test',
      isSubagent: true,
    });
    const errs: string[] = [];
    const promise = runRepl({
      args: makeArgs({ resume: 'sub-sess-1' }),
      bootstrapOverride: stub,
      stdin: makeStdin(),
      skipTtyCheck: true,
      skipTrustPrompt: true,
      errSink: (s) => {
        errs.push(s);
      },
    });
    expect(await promise).toBe(1);
    expect(errs.join('')).toContain('cannot --resume a subagent session');
  });

  test('failed resume still drains the broker (no leaked handles on abort)', async () => {
    // The bad-id abort path returns early, bypassing shutdown().
    // It must still drain the broker — a non-default broker mode
    // owns handles/timers that would leak just because the
    // operator mistyped a resume id. Mirror the §13.7 teardown
    // order: broker.close() before db.close().
    let brokerClosed = 0;
    const stub = makeBootstrapStub({
      broker: {
        close: async () => {
          brokerClosed += 1;
        },
      },
    });
    const errs: string[] = [];
    const promise = runRepl({
      args: makeArgs({ resume: 'no-such-id' }),
      bootstrapOverride: stub,
      stdin: makeStdin(),
      skipTtyCheck: true,
      skipTrustPrompt: true,
      errSink: (s) => {
        errs.push(s);
      },
    });
    expect(await promise).toBe(1);
    expect(errs.join('')).toContain('session no-such-id not found');
    // Broker drained exactly once on the abort path.
    expect(brokerClosed).toBe(1);
  });

  test('cross-cwd literal resume is rejected before any replay (no scrollback leak)', async () => {
    // A literal id pointing at a session from a DIFFERENT project
    // must be refused at resolution time. The REPL replays the
    // session's scrollback right after resolving — an unfiltered
    // cross-cwd id would render another project's conversation on
    // screen before runAgent's (much later) cwd guard fires.
    const stub = makeBootstrapStub(); // cwd = /tmp/forja-repl-test
    const foreignId = 'sess-other-project';
    createSession(stub.db, {
      id: foreignId,
      model: 'mock/m',
      cwd: '/some/other/project',
    });
    // Seed the foreign session with a message so a leak would be
    // observable in the renderer writes.
    appendMessage(stub.db, {
      sessionId: foreignId,
      role: 'user',
      content: 'SECRET CONVERSATION FROM ANOTHER REPO',
      createdAt: 1_000_000,
    });
    const errs: string[] = [];
    const writes: string[] = [];
    const promise = runRepl({
      args: makeArgs({ resume: foreignId }),
      bootstrapOverride: stub,
      stdin: makeStdin(),
      skipTtyCheck: true,
      skipTrustPrompt: true,
      errSink: (s) => {
        errs.push(s);
      },
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    expect(await promise).toBe(1);
    expect(errs.join('')).toContain('belongs to a different project');
    expect(errs.join('')).toContain('/some/other/project');
    // The foreign conversation never reached the screen.
    expect(writes.join('')).not.toContain('SECRET CONVERSATION FROM ANOTHER REPO');
  });

  test('failed resume settles stale subagent handles (crash recovery, Slice 129)', async () => {
    // A parent that crashed mid-`task_async` leaves
    // subagent_handles rows stuck in `running`. The headless
    // resume path settles them; the REPL resume path must too, or
    // an interactively-resumed crashed session strands its async
    // subagents (task_await → unknown_handle). Settle runs once the
    // id resolves — even though THIS test resumes a valid session
    // and then quits, the settle pass already fired by then.
    const stub = makeBootstrapStub();
    const resumedId = 'sess-crashed';
    createSession(stub.db, {
      id: resumedId,
      model: 'mock/m',
      cwd: '/tmp/forja-repl-test',
    });
    // Two handles left `running` by the crashed prior run.
    insertSubagentHandle(stub.db, {
      handleId: 'h1',
      parentSessionId: resumedId,
      name: 'explore',
      spawnedAt: 1_000,
    });
    insertSubagentHandle(stub.db, {
      handleId: 'h2',
      parentSessionId: resumedId,
      name: 'audit',
      spawnedAt: 1_001,
    });
    const errs: string[] = [];
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs({ resume: resumedId }),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      errSink: (s) => {
        errs.push(s);
      },
    });
    await tick();
    // Both handles flipped from running → settled.
    expect(getSubagentHandle(stub.db, 'h1')?.status).toBe('settled');
    expect(getSubagentHandle(stub.db, 'h2')?.status).toBe('settled');
    // The settled payload describes the crash-resume interruption
    // so a re-await rehydrates a coherent envelope.
    expect(getSubagentHandle(stub.db, 'h1')?.settledPayload).toMatchObject({
      status: 'interrupted',
      reason: 'parent_session_resumed_after_crash',
    });
    // Operator sees the count.
    expect(errs.join('')).toContain('settled 2 subagent handle(s)');
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('valid id seeds lastSessionId — first turn threads resumeFromSessionId', async () => {
    const stub = makeBootstrapStub();
    const resumedId = 'sess-prior-real';
    createSession(stub.db, {
      id: resumedId,
      model: 'mock/m',
      cwd: '/tmp/forja-repl-test',
    });
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    const promise = runRepl({
      args: makeArgs({ resume: resumedId }),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
    });
    await tick();
    // Fire the first prompt; the harness call should carry the
    // resumed id (not undefined, which is the fresh-session shape).
    stdin.feed('continue\r');
    await tick();
    expect(ra.captured).toHaveLength(1);
    expect(ra.captured[0]?.configs[0]?.resumeFromSessionId).toBe(resumedId);
    // Wrap up cleanly.
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('resume id does NOT leak into the banner env (env block removed)', async () => {
    // The banner used to surface `resumed: <first 8 chars>` as a
    // meta env entry. Env block was dropped from the renderer — the
    // resume id still flows through to the PermanentItem.env list
    // for NDJSON / audit consumers, but the TUI no longer renders it.
    const stub = makeBootstrapStub();
    const resumedId = 'sess-abcdef-the-rest-is-padding';
    createSession(stub.db, {
      id: resumedId,
      model: 'mock/m',
      cwd: '/tmp/forja-repl-test',
    });
    const writes: string[] = [];
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs({ resume: resumedId }),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    const all = writes.join('');
    expect(all).not.toContain('resumed:');
    expect(all).not.toContain(resumedId.slice(0, 8));
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('Phase 2: prior turns render into scrollback in chronological order', async () => {
    // Resume with a pre-populated session — the replay should land
    // each turn's user text + assistant text into the scrollback
    // captured via rendererWrite, in seq order. Ordering matters
    // because the user-text → assistant-text pairing is what makes
    // the historical conversation readable; out-of-order rows
    // would surface as "answer before its question" in scrollback.
    const stub = makeBootstrapStub();
    const resumedId = 'sess-with-history';
    createSession(stub.db, {
      id: resumedId,
      model: 'mock/m',
      cwd: '/tmp/forja-repl-test',
    });
    appendMessage(stub.db, {
      sessionId: resumedId,
      role: 'user',
      content: 'first question',
      createdAt: 1_000_000,
    });
    appendMessage(stub.db, {
      sessionId: resumedId,
      role: 'assistant',
      content: [{ type: 'text', text: 'first answer ABCXYZ' }],
      createdAt: 1_001_000,
    });
    appendMessage(stub.db, {
      sessionId: resumedId,
      role: 'user',
      content: 'second question',
      createdAt: 1_002_000,
    });
    appendMessage(stub.db, {
      sessionId: resumedId,
      role: 'assistant',
      content: [{ type: 'text', text: 'second answer DEFGHI' }],
      createdAt: 1_003_000,
    });
    const writes: string[] = [];
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs({ resume: resumedId }),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    const all = writes.join('');
    // Every text fragment must appear — substring presence first.
    expect(all).toContain('first question');
    expect(all).toContain('first answer ABCXYZ');
    expect(all).toContain('second question');
    expect(all).toContain('second answer DEFGHI');
    // Strict chronology by indexOf: turn 1 user → turn 1 assistant
    // → turn 2 user → turn 2 assistant. A reordered replay (e.g.
    // walking messages by createdAt descending or grouping by
    // role) would pass substring checks but fail here.
    const idxQ1 = all.indexOf('first question');
    const idxA1 = all.indexOf('first answer ABCXYZ');
    const idxQ2 = all.indexOf('second question');
    const idxA2 = all.indexOf('second answer DEFGHI');
    expect(idxQ1).toBeLessThan(idxA1);
    expect(idxA1).toBeLessThan(idxQ2);
    expect(idxQ2).toBeLessThan(idxA2);
    // Wrap up.
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('Phase 2: anchor info line separates history from new turns', async () => {
    // After the replay drops the historical scrollback, the REPL
    // emits one info line bridging "everything above is history"
    // and "everything below is new". Without this anchor, the
    // operator opening a deep history can mistake the last
    // assistant text for something they typed today.
    const stub = makeBootstrapStub();
    const resumedId = 'sess-anchor';
    createSession(stub.db, {
      id: resumedId,
      model: 'mock/m',
      cwd: '/tmp/forja-repl-test',
    });
    appendMessage(stub.db, {
      sessionId: resumedId,
      role: 'user',
      content: 'past prompt',
      createdAt: 1_000_000,
    });
    appendMessage(stub.db, {
      sessionId: resumedId,
      role: 'assistant',
      content: [{ type: 'text', text: 'past reply' }],
      createdAt: 1_001_000,
    });
    const writes: string[] = [];
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs({ resume: resumedId }),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    const all = writes.join('');
    expect(all).toContain('resumed 1 prior turn');
    expect(all).toContain('history above; new turns below');
    // Anchor sits AFTER the last assistant text — guarantees the
    // bridge reads as the closing line of the historical block.
    expect(all.indexOf('past reply')).toBeLessThan(all.indexOf('resumed 1 prior turn'));
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('Phase 2: anchor pluralizes correctly for multi-turn history', async () => {
    const stub = makeBootstrapStub();
    const resumedId = 'sess-multi-anchor';
    createSession(stub.db, {
      id: resumedId,
      model: 'mock/m',
      cwd: '/tmp/forja-repl-test',
    });
    // Two turns → "2 prior turns".
    for (const [u, a, t] of [
      ['q1', 'a1', 1_000_000],
      ['q2', 'a2', 1_010_000],
    ] as const) {
      appendMessage(stub.db, {
        sessionId: resumedId,
        role: 'user',
        content: u,
        createdAt: t,
      });
      appendMessage(stub.db, {
        sessionId: resumedId,
        role: 'assistant',
        content: [{ type: 'text', text: a }],
        createdAt: t + 1000,
      });
    }
    const writes: string[] = [];
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs({ resume: resumedId }),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    expect(writes.join('')).toContain('resumed 2 prior turns');
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('Phase 3: tool card from a resumed session renders into scrollback', async () => {
    // End-to-end: a persisted run with a tool_use + tool_result
    // should replay a tool card visible in the scrollback. Unit
    // tests cover the raw event stream; this one drives the full
    // message-store → bus → reducer → renderer pipeline so a
    // regression in tool-card materialization (batching,
    // PermanentItem shape) trips here, not just in production.
    const stub = makeBootstrapStub();
    const resumedId = 'sess-tool-history';
    createSession(stub.db, {
      id: resumedId,
      model: 'mock/m',
      cwd: '/tmp/forja-repl-test',
    });
    appendMessage(stub.db, {
      sessionId: resumedId,
      role: 'user',
      content: 'read the config',
      createdAt: 1_000_000,
    });
    // Assistant fires a read_file tool_use. The vocab subject
    // extractor pulls `input.path`, so the card subject should be
    // the path string.
    appendMessage(stub.db, {
      sessionId: resumedId,
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me read that.' },
        {
          type: 'tool_use',
          id: 'tu-cfg',
          name: 'read_file',
          input: { path: 'config/settings.json' },
        },
      ],
      createdAt: 1_001_000,
    });
    appendMessage(stub.db, {
      sessionId: resumedId,
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu-cfg', content: '{json body}' }],
      createdAt: 1_002_000,
    });
    appendMessage(stub.db, {
      sessionId: resumedId,
      role: 'assistant',
      content: [{ type: 'text', text: 'Config looks fine.' }],
      createdAt: 1_003_000,
    });
    const writes: string[] = [];
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs({ resume: resumedId }),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    const all = writes.join('');
    // Assistant text from both turns lands.
    expect(all).toContain('Let me read that.');
    expect(all).toContain('Config looks fine.');
    // The tool card renders — `read_file`'s finalVerb is "Read
    // file" (tool-vocab) and the subject is the path. Either the
    // verb or the path proves the card materialized in scrollback.
    expect(all).toContain('config/settings.json');
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('Phase 2: replay throw is fail-soft (boot survives, errSink warns)', async () => {
    // Inject a corrupt content blob — parseJsonSafe throws when
    // fromRow tries to parse it. Replay catches, errSink gets the
    // diagnostic, and a one-line info anchor explains the missing
    // scrollback. REPL still reaches the prompt; operator can
    // still type and the LLM still has the prior context (the
    // first turn's `resumeFromSessionId` is independent of the
    // visual replay).
    const stub = makeBootstrapStub();
    const resumedId = 'sess-corrupt';
    createSession(stub.db, {
      id: resumedId,
      model: 'mock/m',
      cwd: '/tmp/forja-repl-test',
    });
    // Hand-write a row with invalid JSON content. Bypasses the
    // appendMessage helper because we WANT the malformed shape.
    stub.db
      .query(
        `INSERT INTO messages (id, session_id, parent_id, role, content, created_at, seq)
         VALUES ('m1', ?, NULL, 'user', '{bad json', 1000000, 0)`,
      )
      .run(resumedId);
    const errs: string[] = [];
    const writes: string[] = [];
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs({ resume: resumedId }),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      errSink: (s) => {
        errs.push(s);
      },
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    expect(errs.join('')).toContain('failed to replay resumed session scrollback');
    expect(writes.join('')).toContain('scrollback could not be rendered');
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('Phase 2: replay precedes the input prompt (chronology = boot then history)', async () => {
    // Operator-visible ordering invariant: banner → permission
    // hint (if any) → replayed scrollback → empty `> ` prompt at
    // the bottom. Replay landing AFTER the prompt would push it
    // off-screen during the redraw burst.
    const stub = makeBootstrapStub();
    const resumedId = 'sess-order';
    createSession(stub.db, {
      id: resumedId,
      model: 'mock/m',
      cwd: '/tmp/forja-repl-test',
    });
    appendMessage(stub.db, {
      sessionId: resumedId,
      role: 'user',
      content: 'historical line MARKER',
      createdAt: 1_000_000,
    });
    appendMessage(stub.db, {
      sessionId: resumedId,
      role: 'assistant',
      content: [{ type: 'text', text: 'historical reply MARKER2' }],
      createdAt: 1_001_000,
    });
    const writes: string[] = [];
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs({ resume: resumedId }),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    const all = writes.join('');
    // The banner appears BEFORE the replayed content in the write
    // stream. The reverse order would mean replay ran too early
    // (banner was emitted but not yet drained, or replay raced
    // ahead). Anchor on `Forja` alone — color-enabled output
    // splits `Forja` from `v0.0.0` with an SGR reset between them.
    const bannerIdx = all.indexOf('Forja');
    const historyIdx = all.indexOf('MARKER2');
    expect(bannerIdx).toBeGreaterThanOrEqual(0);
    expect(historyIdx).toBeGreaterThan(bannerIdx);
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('resume hint at exit prints the SAME id (chain continues across boots)', async () => {
    const stub = makeBootstrapStub();
    const resumedId = 'sess-chain-anchor';
    createSession(stub.db, {
      id: resumedId,
      model: 'mock/m',
      cwd: '/tmp/forja-repl-test',
    });
    const errs: string[] = [];
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs({ resume: resumedId }),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      errSink: (s) => {
        errs.push(s);
      },
    });
    await tick();
    stdin.feed('/quit\r');
    expect(await promise).toBe(0);
    // The exit hint reuses lastSessionId — when no turn ran in this
    // boot, the resumed id is still the canonical id to point at.
    const all = errs.join('');
    expect(all).toContain('Resume this session with:');
    expect(all).toContain(`forja --resume ${resumedId}`);
  });
});

describe('repl — Alt+R recap terse (RECAP §3.3)', () => {
  test('Alt+R before any session emits a warn, no info line, no audit row', async () => {
    // Spec gate (`lastSessionId === null`): there's nothing to
    // project before the first turn finishes. Operator gets a
    // single-line warn explaining why; nothing lands in
    // recap_runs because buildAutoTerse never ran.
    const stdin = makeStdin();
    const writes: string[] = [];
    const stub = makeBootstrapStub();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    const before = writes.length;
    // Alt+R = ESC + 'r'. The keys parser maps `ESC <printable>`
    // to a `kind: 'char'` event with `alt: true`.
    stdin.feed('\x1br');
    await flushFrame();
    const after = writes.slice(before).join('');
    expect(after).toContain('no session yet');
    expect(listRecentRecapRuns(stub.db, 10)).toHaveLength(0);
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('Alt+R after a finished session prints terse line + writes audit row', async () => {
    // Pre-seed a real session in the bootstrap's db so
    // buildAutoTerse has something to project. Then drive a
    // synthetic turn through the runAgent override that emits
    // session_finished with the seeded id — that's what flips
    // lastSessionId in the REPL.
    const stub = makeBootstrapStub();
    const seededId = 'sess-altr-seed';
    createSession(stub.db, {
      id: seededId,
      model: 'mock/m',
      cwd: '/tmp/forja-repl-test',
      startedAt: 1_000,
    });
    appendMessage(stub.db, {
      sessionId: seededId,
      role: 'user',
      content: 'fix the bug',
      createdAt: 1_100,
    });
    appendMessage(stub.db, {
      sessionId: seededId,
      role: 'assistant',
      parentId: null,
      content: [{ type: 'text', text: 'fixed it' }],
      tokensIn: 50,
      tokensOut: 20,
      cachedTokens: null,
      cacheCreationTokens: null,
      costUsd: 0.001,
      createdAt: 1_200,
    });
    completeSession(stub.db, seededId, 'done', 0.001, true, 1_300);

    const stdin = makeStdin();
    const writes: string[] = [];
    // runAgent override resolves immediately, emits a
    // session_finished pointing at the SEEDED id so lastSessionId
    // ends up matching the real session in the DB. Without this,
    // Alt+R would resolve to a synthetic sess-N that has no
    // messages and the projection would render an empty terse.
    const ra = makeRunAgent(() => seededId);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    stdin.feed('hi\r');
    await tick();
    ra.finish(0);
    await tick();

    const before = writes.length;
    stdin.feed('\x1br'); // Alt+R
    await flushFrame();
    const after = writes.slice(before).join('');
    // Terse output for this seeded session contains the goal text
    // ("fix the bug") and ends with a period — same shape the
    // session-end terse line uses. Match loosely on goal text so
    // the test isn't brittle against future template tweaks
    // (consistency eval pins the byte-exact format elsewhere).
    expect(after).toContain('fix the bug');

    // Audit row landed: terse, used_llm 0.
    const runs = listRecentRecapRuns(stub.db, 10);
    expect(runs.some((r) => r.renderer === 'terse' && !r.usedLlm)).toBe(true);

    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('Alt+R is gated off while a turn is busy (no projection during run)', async () => {
    // Mid-turn the operator's attention is on the live output
    // and the loop is mutating db rows the projection would
    // race. Spec §3.3 + repl.ts gate: idle-only.
    const stub = makeBootstrapStub();
    const seededId = 'sess-altr-busy-seed';
    createSession(stub.db, {
      id: seededId,
      model: 'mock/m',
      cwd: '/tmp/forja-repl-test',
      startedAt: 1_000,
    });
    appendMessage(stub.db, {
      sessionId: seededId,
      role: 'user',
      content: 'do thing',
      createdAt: 1_100,
    });

    const stdin = makeStdin();
    const writes: string[] = [];
    const ra = makeRunAgent(() => seededId);
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: (s) => {
        writes.push(s);
      },
    });
    await tick();
    // Start a turn but do NOT finish it. While the harness
    // override is pending, isBusy()=true and Alt+R is a no-op
    // (gate exits early without emitting anything).
    stdin.feed('hi\r');
    await tick();
    const before = writes.length;
    stdin.feed('\x1br');
    await flushFrame();
    const after = writes.slice(before).join('');
    // No "do thing"-style terse line, no warn — gate exited
    // before emitting. Crucially: no audit row from a recap
    // projection that should not have happened.
    expect(after).not.toContain('do thing.');
    expect(listRecentRecapRuns(stub.db, 10)).toHaveLength(0);
    // Cleanup: finish the pending turn so the REPL can exit.
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });
});

describe('REPL shared-trust probe stderr summaries (S5 hardening)', () => {
  test('revoked outcome surfaces recovery hint (CRIT/F3)', async () => {
    // Wrap makeBootstrapStub to attach a synthetic
    // sharedTrustProbe result. The REPL's stderr summary runs
    // unconditionally after bootstrap, so we don't need to feed
    // any stdin — just boot + EOF.
    const baseStub = makeBootstrapStub();
    const stub: BootstrapResult = {
      ...baseStub,
      sharedTrustProbe: {
        kind: 'revoked',
        invalidated: [
          { scope: 'project_shared', name: 'a' },
          { scope: 'project_shared', name: 'b' },
        ],
        failed: [],
      },
    };
    let stderr = '';
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      errSink: (s) => {
        stderr += s;
      },
    });
    await tick();
    stdin.feed('\x04'); // EOF closes REPL.
    await promise;
    // Summary line + recovery hint MUST be present.
    expect(stderr).toContain('shared memory trust revoked');
    expect(stderr).toContain('2 shared memories invalidated');
    expect(stderr).toContain('recovery: edit the `.md` frontmatter');
    expect(stderr).toContain('7 days');
  });

  test('deferred outcome surfaces cause-specific stderr line (D1)', async () => {
    // The post-D1 stderr branch distinguishes modal_cancel from
    // tocttou_during_prompt. Both cases get a clear hint about
    // what happens next.
    const baseStub = makeBootstrapStub();
    const stub: BootstrapResult = {
      ...baseStub,
      sharedTrustProbe: { kind: 'deferred', cause: 'tocttou_during_prompt', hash: 'x' },
    };
    let stderr = '';
    const stdin = makeStdin();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      errSink: (s) => {
        stderr += s;
      },
    });
    await tick();
    stdin.feed('\x04');
    await promise;
    expect(stderr).toContain('deferred');
    expect(stderr).toContain('TOCTOU');
    expect(stderr).toContain('investigate concurrent writers');
  });
});

describe('REPL — subagent shadow render uses actual scopes (post-review)', () => {
  // Pre-fix: render hardcoded `(user) ... (project)` labels. With
  // PROTECTED_BUILTIN_NAMES, a user-scope file that shadows an
  // embedded verify-* subagent lands as `shadowed.scope = 'builtin'`
  // + `winning.scope = 'user'`. Hardcoded labels mislabeled the
  // security warning as a generic cross-scope shadow, undermining
  // the protection signal that drove the alert.
  //
  // Post-fix: render interpolates `${shadow.shadowed.scope}` and
  // `${shadow.winning.scope}` directly. This test pins both the
  // happy path (user shadowed by project) and the protected-builtin
  // case (builtin shadowed by user) to exercise the new template.

  test('protected-builtin shadow renders (builtin) + (user) — not hardcoded labels', async () => {
    const stub = makeBootstrapStub();
    // Inject a shadow record matching the shape load.ts emits for
    // a PROTECTED_BUILTIN_NAMES entry replaced by a user-scope
    // file. Both sides need the SubagentDefinition fields the
    // renderer reads (name, sourcePath, scope).
    const builtinDef = {
      name: 'verify-semantic',
      scope: 'builtin',
      sourcePath: '<embedded>/verify-semantic.md',
      description: '',
      tools: [],
      budget: { maxSteps: 1, maxCostUsd: 0.01 },
      systemPrompt: '',
      isolation: 'none',
      sourceSha256: '0'.repeat(64),
    };
    const userDef = {
      ...builtinDef,
      scope: 'user',
      sourcePath: '/home/op/.config/agent/agents/verify-semantic.md',
    };
    (stub.subagents as { shadows: unknown[] }).shadows = [
      { name: 'verify-semantic', shadowed: builtinDef, winning: userDef },
    ];
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    let stderr = '';
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      errSink: (s) => {
        stderr += s;
      },
    });
    await tick();
    stdin.feed('\x04');
    await promise;
    // Message must label the embedded definition as 'builtin' and
    // the override as 'user' — the actual scopes from the records.
    expect(stderr).toContain('<embedded>/verify-semantic.md (builtin)');
    expect(stderr).toContain('verify-semantic.md (user)');
    // Pre-fix would have rendered '(user) is shadowed by ... (project)'.
    expect(stderr).not.toContain('(project)');
  });

  test('cross-scope user-shadowed-by-project still renders the actual scopes', async () => {
    // Negative case: pre-fix hardcoded labels happened to be
    // correct for this scenario. Post-fix the template must still
    // produce the same output via interpolation.
    const stub = makeBootstrapStub();
    const userDef = {
      name: 'helper',
      scope: 'user',
      sourcePath: '/home/op/.config/agent/agents/helper.md',
      description: '',
      tools: [],
      budget: { maxSteps: 1, maxCostUsd: 0.01 },
      systemPrompt: '',
      isolation: 'none',
      sourceSha256: '0'.repeat(64),
    };
    const projectDef = {
      ...userDef,
      scope: 'project',
      sourcePath: '/repo/.agent/agents/helper.md',
    };
    (stub.subagents as { shadows: unknown[] }).shadows = [
      { name: 'helper', shadowed: userDef, winning: projectDef },
    ];
    const stdin = makeStdin();
    const ra = makeRunAgent((n) => `sess-${n}`);
    let stderr = '';
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: stub,
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      errSink: (s) => {
        stderr += s;
      },
    });
    await tick();
    stdin.feed('\x04');
    await promise;
    expect(stderr).toContain('/home/op/.config/agent/agents/helper.md (user)');
    expect(stderr).toContain('/repo/.agent/agents/helper.md (project)');
    expect(stderr).not.toContain('(builtin)');
  });
});
