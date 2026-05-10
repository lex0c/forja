import { beforeEach, describe, expect, test } from 'bun:test';
import { recapCommand } from '../../../../src/cli/slash/commands/recap.ts';
import type { SlashContext } from '../../../../src/cli/slash/types.ts';
import type { HarnessConfig } from '../../../../src/harness/index.ts';
import { DEFAULT_BUDGET } from '../../../../src/harness/types.ts';
import { createRegistry as createModelRegistry } from '../../../../src/providers/registry.ts';
import type {
  ConstrainedRequest,
  ConstrainedResult,
  Provider,
  ProviderCapabilities,
  StreamEvent,
} from '../../../../src/providers/types.ts';
import { projectPrDeterministic } from '../../../../src/recap/pr/deterministic.ts';
import { PR_SCHEMA_VERSION } from '../../../../src/recap/pr/schema.ts';
import { projectRecap } from '../../../../src/recap/projection.ts';
import { type DB, openMemoryDb } from '../../../../src/storage/db.ts';
import { migrate } from '../../../../src/storage/migrate.ts';
import { appendMessage } from '../../../../src/storage/repos/messages.ts';
import { readRecapCache } from '../../../../src/storage/repos/recap-cache.ts';
import { listRecentRecapRuns } from '../../../../src/storage/repos/recap-runs.ts';
import { completeSession, createSession } from '../../../../src/storage/repos/sessions.ts';
import { createBus } from '../../../../src/tui/bus.ts';
import { createFocusStack } from '../../../../src/tui/focus-stack.ts';
import { createModalManager } from '../../../../src/tui/modal-manager.ts';

let db: DB;
let currentSessionId: string | null;

const stubCaps = (
  constrained: ProviderCapabilities['constrained'] = false,
): ProviderCapabilities => ({
  tools: 'native',
  cache: 'server_5min',
  vision: false,
  streaming: true,
  constrained,
  context_window: 200_000,
  output_max_tokens: 4_096,
  cost_per_1k_input: 1.0,
  cost_per_1k_output: 5.0,
  cost_per_1k_cached_input: 0.1,
  cost_per_1k_cache_write: 1.25,
  notes: [],
});

interface StubProviderHandle {
  provider: Provider;
  calls: ConstrainedRequest[];
}

// Provider stub. The default returns whatever JSON the test passes
// in via `outputJson`; tests that do not need the constrained call
// (or tests that simulate provider failure) override `generateConstrained`.
const stubProvider = (
  outputJson: string,
  options: {
    capabilities?: ProviderCapabilities;
    generateConstrained?: (req: ConstrainedRequest) => Promise<ConstrainedResult>;
  } = {},
): StubProviderHandle => {
  const calls: ConstrainedRequest[] = [];
  const provider: Provider = {
    id: 'anthropic/claude-haiku-4-5',
    family: 'anthropic',
    capabilities: options.capabilities ?? stubCaps('tools'),
    generate: async function* (): AsyncIterable<StreamEvent> {},
    generateConstrained:
      options.generateConstrained ??
      (async (req): Promise<ConstrainedResult> => {
        calls.push(req);
        return {
          output: outputJson,
          usage: { input: 100, output: 50, cache_read: 0, cache_creation: 0 },
        };
      }),
    countTokens: async () => 0,
  };
  return { provider, calls };
};

const baseConfig = {
  cwd: '/test/cwd',
  enableCheckpoints: false,
  planMode: false,
  budget: { ...DEFAULT_BUDGET },
  // Default test provider has constrained=false, so /recap pr in
  // tests that don't override defaults stays on the deterministic
  // path (matching the M4.1-era expectation of those tests).
  provider: {
    id: 'test/m',
    capabilities: stubCaps(false),
    generate: async function* () {},
    generateConstrained: () => Promise.reject(new Error('test stub')),
    countTokens: async () => 0,
    family: 'anthropic',
  },
} as unknown as HarnessConfig;

// Build a HarnessConfig that uses a different provider — the LLM
// path tests below need this so generateConstrained is callable.
const cfgWithProvider = (provider: Provider): HarnessConfig =>
  ({ ...baseConfig, provider }) as unknown as HarnessConfig;

const makeCtx = (overrides: Partial<SlashContext> = {}): SlashContext => {
  const bus = createBus();
  const fs = createFocusStack();
  const modalManager = createModalManager({ bus, focusStack: fs, now: () => 1 });
  return {
    baseConfig,
    db,
    bus,
    modalManager,
    cumulative: { costUsd: 0, steps: 0, turns: 0, critiqueCostUsd: 0, critiqueRuns: 0 },
    now: () => 5_000,
    requestShutdown: () => undefined,
    isRunning: () => false,
    currentSessionId: () => currentSessionId,
    replSessionIds: () => (currentSessionId !== null ? [currentSessionId] : []),
    modelRegistry: createModelRegistry(),
    ...overrides,
  };
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  currentSessionId = null;
});

describe('/recap', () => {
  test('without args, requires an active session', async () => {
    const result = await recapCommand.exec([], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('no active session');
  });

  test('renders human markdown for the current session', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, {
      sessionId: s.id,
      role: 'user',
      content: 'refactor the queue retry logic',
      createdAt: 1_100,
    });
    currentSessionId = s.id;

    const result = await recapCommand.exec([], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.notes).toBeDefined();
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('# Recap —');
    expect(text).toContain('refactor the queue retry logic');
    expect(text).toContain('## Cost');
  });

  test('renders json output for /recap json', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    currentSessionId = s.id;
    const result = await recapCommand.exec(['json'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(() => JSON.parse(text)).not.toThrow();
    const parsed = JSON.parse(text) as { schemaVersion: string; scope: { sessionIds: string[] } };
    expect(parsed.schemaVersion).toBe('v1');
    expect(parsed.scope.sessionIds).toEqual([s.id]);
  });

  test('/recap session <id> targets a specific session', async () => {
    const a = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    const b = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 2_000 });
    appendMessage(db, {
      sessionId: a.id,
      role: 'user',
      content: 'goal of A',
      createdAt: 1_100,
    });
    appendMessage(db, {
      sessionId: b.id,
      role: 'user',
      content: 'goal of B',
      createdAt: 2_100,
    });
    currentSessionId = b.id;
    const result = await recapCommand.exec(['session', a.id], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('goal of A');
    expect(text).not.toContain('goal of B');
  });

  test('/recap json session <id> emits json for a specific session', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    const result = await recapCommand.exec(['json', 'session', s.id], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    const parsed = JSON.parse(text) as { scope: { sessionIds: string[] } };
    expect(parsed.scope.sessionIds).toEqual([s.id]);
  });

  test('/recap last <N> truncates step window', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'first', createdAt: 1_100 });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'second', createdAt: 1_200 });
    currentSessionId = s.id;
    const result = await recapCommand.exec(['last', '1'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('second');
    // 'first' should be truncated out by the limit; goal extraction
    // takes the first user message of the (truncated) window.
    expect(text).not.toContain('**Goal:** first');
  });

  test('records a recap_runs row on every successful invocation', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    currentSessionId = s.id;
    await recapCommand.exec([], makeCtx({ now: () => 5_000 }));
    await recapCommand.exec(['json'], makeCtx({ now: () => 5_001 }));
    const runs = listRecentRecapRuns(db);
    expect(runs).toHaveLength(2);
    // listRecentRecapRuns is created_at DESC; the json call was second.
    expect(runs[0]?.renderer).toBe('json');
    expect(runs[0]?.usedLlm).toBe(false);
    expect(runs[0]?.sessionIds).toEqual([s.id]);
    expect(runs[1]?.renderer).toBe('human');
    expect(runs[1]?.scopeKind).toBe('session_current');
  });

  test('does NOT record a recap_runs row on parse errors', async () => {
    const result = await recapCommand.exec(['mystery'], makeCtx());
    expect(result.kind).toBe('error');
    expect(listRecentRecapRuns(db)).toHaveLength(0);
  });

  test('does NOT record a recap_runs row when projection rejects unknown session', async () => {
    const result = await recapCommand.exec(['session', 'ghost'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('not found');
    expect(listRecentRecapRuns(db)).toHaveLength(0);
  });

  test('rejects /recap last without an argument', async () => {
    currentSessionId = 'unused';
    const result = await recapCommand.exec(['last'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('missing step count');
  });

  test('rejects /recap last with invalid count', async () => {
    currentSessionId = 'unused';
    const result = await recapCommand.exec(['last', 'foo'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('invalid step count');
  });

  test('rejects /recap last 0 (must be positive)', async () => {
    currentSessionId = 'unused';
    const result = await recapCommand.exec(['last', '0'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('invalid step count');
  });

  test('rejects /recap session without an id', async () => {
    const result = await recapCommand.exec(['session'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('missing session id');
  });

  // ─── /recap pre-compact (slice e2) ──────────────────────────

  test('/recap pre-compact renders the current session deterministically', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, {
      sessionId: s.id,
      role: 'user',
      content: 'preview before compaction',
      createdAt: 1_100,
    });
    currentSessionId = s.id;
    const result = await recapCommand.exec(['pre-compact'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('preview before compaction');
    expect(text).toContain('# Recap');
  });

  test('/recap pre-compact errors when no active session', async () => {
    const result = await recapCommand.exec(['pre-compact'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('no active session');
  });

  test('/recap pre-compact rejects extra arguments', async () => {
    const result = await recapCommand.exec(['pre-compact', 'extra'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('takes no arguments');
  });

  test('/recap pre-compact records audit row with scope_kind=pre_compact and used_llm=false', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    currentSessionId = s.id;
    // Provider that would respond to constrained calls — proves
    // the LLM path is force-bypassed (RECAP §10), not just absent.
    const stubHuman = JSON.stringify({
      schemaVersion: 'human-v1',
      summary: ['unused; pre-compact must never call the LLM'],
    });
    const handle = stubProvider(stubHuman);
    const ctx = makeCtx({ baseConfig: cfgWithProvider(handle.provider) });
    await recapCommand.exec(['pre-compact'], ctx);
    expect(handle.calls).toHaveLength(0);
    const runs = listRecentRecapRuns(db);
    expect(runs[0]?.scopeKind).toBe('pre_compact');
    expect(runs[0]?.usedLlm).toBe(false);
    expect(runs[0]?.promptVersion).toBeNull();
  });

  test('/recap pre-compact rejects --all-projects (single-session form)', async () => {
    const result = await recapCommand.exec(['pre-compact', '--all-projects'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('--all-projects only applies');
  });

  test('rejects unknown subcommand with a hint to /recap variants', async () => {
    const result = await recapCommand.exec(['mystery'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('unknown subcommand');
    expect(result.message).toContain('/recap session');
  });

  test('audit INSERT failure does NOT destroy the recap output (warn instead)', async () => {
    // Simulate disk-full / schema-corruption on the audit row by
    // dropping the table after the projection succeeds. The slash
    // must still return the recap notes; the operator gets a warn
    // bracketing the audit gap, not a crash.
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, {
      sessionId: s.id,
      role: 'user',
      content: 'do work',
      createdAt: 1_100,
    });
    currentSessionId = s.id;
    db.query('DROP TABLE recap_runs').run();

    const events: { type: string; message?: string }[] = [];
    const ctx = makeCtx();
    ctx.bus.on('warn', (e) => events.push({ type: 'warn', message: e.message }));
    ctx.bus.on('error', (e) => events.push({ type: 'error', message: e.message }));

    const result = await recapCommand.exec([], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('do work');
    // Exactly one warn, no error.
    const warns = events.filter((e) => e.type === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toContain('audit row not written');
    expect(warns[0]?.message).toContain('output is intact');
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });

  test('rejects extra trailing arguments', async () => {
    const result = await recapCommand.exec(['session', 'sid', 'extra'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('exactly one argument');
  });

  // ─── M4.2 slice (a): pr renderer + flags ─────────────────────

  test('/recap pr renders deterministic PR description', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, {
      sessionId: s.id,
      role: 'user',
      content: 'extract backoff helper',
      createdAt: 1_100,
    });
    currentSessionId = s.id;
    const result = await recapCommand.exec(['pr'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('## Summary');
    expect(text).toContain('extract backoff helper');
  });

  test('/recap pr records used_llm=false and renderer=pr in audit', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    currentSessionId = s.id;
    await recapCommand.exec(['pr'], makeCtx());
    const runs = listRecentRecapRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.renderer).toBe('pr');
    expect(runs[0]?.usedLlm).toBe(false);
    expect(runs[0]?.outputPath).toBeNull();
  });

  test('/recap pr --no-llm-render is accepted (deterministic path)', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    currentSessionId = s.id;
    const result = await recapCommand.exec(['pr', '--no-llm-render'], makeCtx());
    expect(result.kind).toBe('ok');
  });

  test('/recap pr --out <path> writes to file and audits output_path', async () => {
    const tmpdir = `${process.env.TMPDIR ?? '/tmp'}/forja-recap-out-${crypto.randomUUID()}`;
    const outPath = `${tmpdir}/pr.md`;
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, {
      sessionId: s.id,
      role: 'user',
      content: 'do thing',
      createdAt: 1_100,
    });
    currentSessionId = s.id;
    const result = await recapCommand.exec(['pr', '--out', outPath], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.notes?.[0]).toContain(`wrote pr render to ${outPath}`);

    const written = await Bun.file(outPath).text();
    expect(written).toContain('## Summary');

    const runs = listRecentRecapRuns(db);
    expect(runs[0]?.outputPath).toBe(outPath);
  });

  test('/recap pr --out=path (single-token form) also works', async () => {
    const tmpdir = `${process.env.TMPDIR ?? '/tmp'}/forja-recap-out-${crypto.randomUUID()}`;
    const outPath = `${tmpdir}/pr.md`;
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    currentSessionId = s.id;
    const result = await recapCommand.exec(['pr', `--out=${outPath}`], makeCtx());
    expect(result.kind).toBe('ok');
    const runs = listRecentRecapRuns(db);
    expect(runs[0]?.outputPath).toBe(outPath);
  });

  test('/recap --out without a value is a parse error', async () => {
    currentSessionId = 'unused';
    const result = await recapCommand.exec(['--out'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('--out requires a file path');
  });

  test('/recap rejects unknown long flags', async () => {
    const result = await recapCommand.exec(['--bogus'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain("unknown flag '--bogus'");
  });

  // ─── M4.2 slice (a) commit 5: LLM path + cache + audit ───────

  test('/recap pr LLM path: success path writes cache, audits cost+prompt', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, {
      sessionId: s.id,
      role: 'user',
      content: 'do thing',
      createdAt: 1_100,
    });
    currentSessionId = s.id;
    // Build a structured response that the projection produces;
    // guarantees fidelity check passes.
    const intermediate = projectRecap(db, {
      scope: { kind: 'session_current', sessionId: s.id, limit: 10 },
      now: 5_000,
    });
    const structured = projectPrDeterministic(intermediate);
    const handle = stubProvider(JSON.stringify(structured));
    const ctx = makeCtx({ baseConfig: cfgWithProvider(handle.provider) });

    const result = await recapCommand.exec(['pr'], ctx);
    expect(result.kind).toBe('ok');
    expect(handle.calls).toHaveLength(1);

    const runs = listRecentRecapRuns(db);
    expect(runs[0]?.usedLlm).toBe(true);
    expect(runs[0]?.cacheHit).toBe(false);
    expect(runs[0]?.promptVersion).toBe('pr-v1');
    expect(runs[0]?.tokensIn).toBe(100);
    expect(runs[0]?.tokensOut).toBe(50);
    expect(runs[0]?.costUsd).toBeGreaterThan(0);
  });

  test('/recap pr LLM path: cache hit on second call, no second provider call', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, {
      sessionId: s.id,
      role: 'user',
      content: 'do thing',
      createdAt: 1_100,
    });
    // End the session so projection's durationMs is fixed (otherwise
    // it grows with `now` on each call, making the intermediate
    // content-different across calls and cache-missing).
    completeSession(db, s.id, 'done', 0, true, 2_000);
    currentSessionId = s.id;
    const intermediate = projectRecap(db, {
      scope: { kind: 'session_current', sessionId: s.id, limit: 10 },
      now: 5_000,
    });
    const structured = projectPrDeterministic(intermediate);
    const handle = stubProvider(JSON.stringify(structured));

    // Two distinct now() values so the audit rows have distinct
    // created_at timestamps (deterministic listRecentRecapRuns
    // ordering); the cache key strips `generatedAt` and the
    // session is ended so durationMs is stable across calls.
    const ctxFirst = makeCtx({ baseConfig: cfgWithProvider(handle.provider), now: () => 5_000 });
    const ctxSecond = makeCtx({ baseConfig: cfgWithProvider(handle.provider), now: () => 5_500 });

    await recapCommand.exec(['pr'], ctxFirst);
    await recapCommand.exec(['pr'], ctxSecond);
    expect(handle.calls).toHaveLength(1);

    const runs = listRecentRecapRuns(db);
    expect(runs).toHaveLength(2);
    // Most recent first; second call should be the cache hit.
    expect(runs[0]?.cacheHit).toBe(true);
    expect(runs[0]?.usedLlm).toBe(true);
    expect(runs[0]?.costUsd).toBe(0);
    expect(runs[1]?.cacheHit).toBe(false);
    expect(runs[1]?.usedLlm).toBe(true);
  });

  test('/recap pr LLM path: schema-violation falls back to deterministic with a warn', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, {
      sessionId: s.id,
      role: 'user',
      content: 'do thing',
      createdAt: 1_100,
    });
    currentSessionId = s.id;
    // Hand-back a schema-violating structure (extra field).
    const bad = {
      schemaVersion: PR_SCHEMA_VERSION,
      summary: ['x'],
      changes: [],
      testPlan: [],
      notes: [],
      tone: 'cheerful',
    };
    const handle = stubProvider(JSON.stringify(bad));
    const ctx = makeCtx({ baseConfig: cfgWithProvider(handle.provider) });
    const events: { type: string; message?: string }[] = [];
    ctx.bus.on('warn', (e) => events.push({ type: 'warn', message: e.message }));
    ctx.bus.on('error', (e) => events.push({ type: 'error', message: e.message }));

    const result = await recapCommand.exec(['pr'], ctx);
    expect(result.kind).toBe('ok');

    const runs = listRecentRecapRuns(db);
    expect(runs[0]?.usedLlm).toBe(false);
    expect(runs[0]?.cacheHit).toBe(false);
    expect(runs[0]?.costUsd).toBe(0);
    expect(runs[0]?.promptVersion).toBeNull();

    const warns = events.filter((e) => e.type === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toContain('schema-violation');
    expect(warns[0]?.message).toContain('using deterministic fallback');
  });

  test('/recap pr LLM path: fidelity-mismatch (hallucinated path) falls back', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    currentSessionId = s.id;
    const bad = {
      schemaVersion: PR_SCHEMA_VERSION,
      summary: ['x'],
      changes: [{ path: '/never/seen/this.ts', bullets: ['+0 / -0'] }],
      testPlan: [],
      notes: [],
    };
    const handle = stubProvider(JSON.stringify(bad));
    const ctx = makeCtx({ baseConfig: cfgWithProvider(handle.provider) });
    const events: { type: string; message?: string }[] = [];
    ctx.bus.on('warn', (e) => events.push({ type: 'warn', message: e.message }));

    const result = await recapCommand.exec(['pr'], ctx);
    expect(result.kind).toBe('ok');
    const warns = events.filter((e) => e.type === 'warn');
    expect(warns[0]?.message).toContain('fidelity-mismatch');

    const runs = listRecentRecapRuns(db);
    expect(runs[0]?.usedLlm).toBe(false);
  });

  test('/recap pr --no-llm-render bypasses provider entirely', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    currentSessionId = s.id;
    // Use a provider that would throw if called; the test asserts
    // it is NOT called.
    const provider: Provider = {
      id: 'anthropic/claude-haiku-4-5',
      family: 'anthropic',
      capabilities: stubCaps('tools'),
      generate: async function* () {},
      generateConstrained: () => Promise.reject(new Error('must not be called')),
      countTokens: async () => 0,
    };
    const ctx = makeCtx({ baseConfig: cfgWithProvider(provider) });
    const result = await recapCommand.exec(['pr', '--no-llm-render'], ctx);
    expect(result.kind).toBe('ok');

    const runs = listRecentRecapRuns(db);
    expect(runs[0]?.usedLlm).toBe(false);
    expect(runs[0]?.promptVersion).toBeNull();
  });

  test('/recap pr writes recap_cache row on success', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, {
      sessionId: s.id,
      role: 'user',
      content: 'do thing',
      createdAt: 1_100,
    });
    currentSessionId = s.id;
    const intermediate = projectRecap(db, {
      scope: { kind: 'session_current', sessionId: s.id, limit: 10 },
      now: 5_000,
    });
    const structured = projectPrDeterministic(intermediate);
    const handle = stubProvider(JSON.stringify(structured));
    const ctx = makeCtx({ baseConfig: cfgWithProvider(handle.provider) });
    await recapCommand.exec(['pr'], ctx);

    // We don't reconstruct the hash in the test (that's the repo's
    // job); we observe that exactly one cache row exists.
    const rows = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM recap_cache').get();
    expect(rows?.count).toBe(1);
    // And that the row has a positive cost.
    const cost = db
      .query<{ cost_usd: number }, []>('SELECT cost_usd FROM recap_cache LIMIT 1')
      .get();
    expect(cost?.cost_usd).toBeGreaterThan(0);
    // Read by hash to confirm round-trip works.
    const hashRow = db
      .query<{ scope_hash: string }, []>('SELECT scope_hash FROM recap_cache LIMIT 1')
      .get();
    expect(hashRow).not.toBeNull();
    const hit = readRecapCache(db, { scopeHash: hashRow?.scope_hash ?? '', now: 5_500 });
    expect(hit).not.toBeNull();
  });

  // ─── M4.2 slice (b): changelog / slack / terse renderers ─────

  test('/recap changelog renders deterministic Keep a Changelog when --no-llm-render', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, {
      sessionId: s.id,
      role: 'user',
      content: 'extract retry helper',
      createdAt: 1_100,
    });
    currentSessionId = s.id;
    const result = await recapCommand.exec(['changelog', '--no-llm-render'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    // At least one Keep-a-Changelog category header should appear.
    expect(text).toMatch(/### (Added|Changed|Fixed|Removed|Deprecated|Security)/);

    const runs = listRecentRecapRuns(db);
    expect(runs[0]?.renderer).toBe('changelog');
    expect(runs[0]?.usedLlm).toBe(false);
  });

  test('/recap slack renders deterministic ASCII Slack post when --no-llm-render', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, {
      sessionId: s.id,
      role: 'user',
      content: 'refactor queue',
      createdAt: 1_100,
    });
    completeSession(db, s.id, 'done', 0, true, 2_000);
    currentSessionId = s.id;
    const result = await recapCommand.exec(['slack', '--no-llm-render'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    // ASCII bullets, no ✓ / •.
    expect(text).toContain('* ');
    expect(text).not.toContain('✓');
    expect(text).not.toContain('•');
    // Title is bold-marked.
    expect(text).toMatch(/^\*[^*]+\*/);

    const runs = listRecentRecapRuns(db);
    expect(runs[0]?.renderer).toBe('slack');
  });

  test('/recap terse renders deterministic single sentence when --no-llm-render', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, {
      sessionId: s.id,
      role: 'user',
      content: 'do thing',
      createdAt: 1_100,
    });
    completeSession(db, s.id, 'done', 0, true, 2_000);
    currentSessionId = s.id;
    const result = await recapCommand.exec(['terse', '--no-llm-render'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    // Single line, ≤ 200 chars.
    expect(text.split('\n').filter((l) => l.length > 0)).toHaveLength(1);
    expect(text.trim().length).toBeLessThanOrEqual(200);
    expect(text).toContain('do thing');

    const runs = listRecentRecapRuns(db);
    expect(runs[0]?.renderer).toBe('terse');
  });

  test('/recap changelog LLM path: audits with renderer=changelog and prompt_version', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'x', createdAt: 1_100 });
    currentSessionId = s.id;
    // Stub returns a valid ChangelogRenderV1.
    const stubChangelog = JSON.stringify({
      schemaVersion: 'changelog-v1',
      entries: [{ category: 'Changed', bullet: 'Update queue retry logic' }],
    });
    const handle = stubProvider(stubChangelog);
    const ctx = makeCtx({ baseConfig: cfgWithProvider(handle.provider) });
    await recapCommand.exec(['changelog'], ctx);

    expect(handle.calls).toHaveLength(1);
    expect(handle.calls[0]?.output_schema_name).toBe('render_recap_changelog');

    const runs = listRecentRecapRuns(db);
    expect(runs[0]?.renderer).toBe('changelog');
    expect(runs[0]?.usedLlm).toBe(true);
    expect(runs[0]?.promptVersion).toBe('changelog-v1');
  });

  test('/recap slack LLM path: schema-violation falls back to deterministic', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'x', createdAt: 1_100 });
    currentSessionId = s.id;
    // Bad: missing required title.
    const bad = JSON.stringify({
      schemaVersion: 'slack-v1',
      durationLabel: '1s',
      costLabel: '$0',
      achievements: ['x'],
      files: [],
      decisions: [],
    });
    const handle = stubProvider(bad);
    const ctx = makeCtx({ baseConfig: cfgWithProvider(handle.provider) });
    const events: { type: string; message?: string }[] = [];
    ctx.bus.on('warn', (e) => events.push({ type: 'warn', message: e.message }));

    const result = await recapCommand.exec(['slack'], ctx);
    expect(result.kind).toBe('ok');
    const warns = events.filter((e) => e.type === 'warn');
    expect(warns[0]?.message).toContain('schema-violation');
    expect(warns[0]?.message).toContain('using deterministic fallback');

    const runs = listRecentRecapRuns(db);
    expect(runs[0]?.renderer).toBe('slack');
    expect(runs[0]?.usedLlm).toBe(false);
  });

  test('/recap (default human) LLM path: emits ## Resumo and audits used_llm/prompt_version', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'do thing', createdAt: 1_100 });
    currentSessionId = s.id;
    const stubHuman = JSON.stringify({
      schemaVersion: 'human-v1',
      summary: ['Refactored queue', 'Added tests'],
    });
    const handle = stubProvider(stubHuman);
    const ctx = makeCtx({ baseConfig: cfgWithProvider(handle.provider) });
    const result = await recapCommand.exec([], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('## Resumo');
    expect(text).toContain('Refactored queue');
    expect(text).toContain('## Cost');

    const runs = listRecentRecapRuns(db);
    expect(runs[0]?.renderer).toBe('human');
    expect(runs[0]?.usedLlm).toBe(true);
    expect(runs[0]?.promptVersion).toBe('human-v1');
    expect(handle.calls[0]?.output_schema_name).toBe('render_recap_human');
  });

  test('/recap --no-llm-render produces deterministic ## Resumo (no provider call)', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'do thing', createdAt: 1_100 });
    currentSessionId = s.id;
    // Provider that throws if called — asserts the LLM bypass.
    const provider: Provider = {
      id: 'anthropic/claude-haiku-4-5',
      family: 'anthropic',
      capabilities: stubCaps('tools'),
      generate: async function* () {},
      generateConstrained: () => Promise.reject(new Error('must not be called')),
      countTokens: async () => 0,
    };
    const ctx = makeCtx({ baseConfig: cfgWithProvider(provider) });
    const result = await recapCommand.exec(['--no-llm-render'], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('## Resumo');
    expect(text).toContain('do thing');

    const runs = listRecentRecapRuns(db);
    expect(runs[0]?.usedLlm).toBe(false);
    expect(runs[0]?.promptVersion).toBeNull();
  });

  test('/recap on incomplete session shows the callout in pr/changelog/slack/terse/human', async () => {
    // Synthesize an incomplete session: create + leave running.
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'do thing', createdAt: 1_100 });
    // Do NOT call completeSession — session stays in 'running'
    // status, which the projection flags as incomplete.
    currentSessionId = s.id;
    // Marker is `⚠` everywhere except slack, which is ASCII-only
    // by schema contract and emits `!` instead.
    for (const sub of ['pr', 'changelog', 'slack', 'terse']) {
      const r = await recapCommand.exec([sub, '--no-llm-render'], makeCtx());
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') continue;
      const text = r.notes?.join('\n') ?? '';
      const marker = sub === 'slack' ? '> ! Incomplete' : '> ⚠ Incomplete';
      expect(text).toContain(marker);
    }
    // Default human surface also surfaces it.
    const human = await recapCommand.exec(['--no-llm-render'], makeCtx());
    expect(human.kind).toBe('ok');
    if (human.kind !== 'ok') return;
    expect(human.notes?.join('\n')).toContain('> ⚠ Incomplete');
  });

  test('/recap json redacts secret-shaped tokens in free-text fields', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    // Feed a goal containing an Anthropic-shaped key — projection
    // copies it into intermediate.goal.text; renderJson must
    // redact it.
    appendMessage(db, {
      sessionId: s.id,
      role: 'user',
      content: 'use ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890',
      createdAt: 1_100,
    });
    currentSessionId = s.id;
    const result = await recapCommand.exec(['json'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('<redacted:');
    expect(text).not.toContain('sk-ant-api03');
  });

  // ─── /recap list (slice c-mini) ──────────────────────────────

  test('/recap list returns sessions with deterministic recap_mini fields', async () => {
    const s1 = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, { sessionId: s1.id, role: 'user', content: 'first goal', createdAt: 1_100 });
    completeSession(db, s1.id, 'done', 0.04, true, 2_000);
    const s2 = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 3_000 });
    appendMessage(db, { sessionId: s2.id, role: 'user', content: 'second goal', createdAt: 3_100 });
    completeSession(db, s2.id, 'done', 0.1, true, 4_000);
    const result = await recapCommand.exec(['list'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('STARTED');
    expect(text).toContain('first goal');
    expect(text).toContain('second goal');
  });

  test('/recap list --json emits NDJSON of RecapMini objects', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'do thing', createdAt: 1_100 });
    completeSession(db, s.id, 'done', 0.04, true, 2_000);
    const result = await recapCommand.exec(['list', '--json'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const lines = result.notes?.filter((l) => l.length > 0) ?? [];
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '{}') as { schemaVersion: string; sessionId: string };
    expect(parsed.schemaVersion).toBe('mini-v1');
    expect(parsed.sessionId).toBe(s.id);
  });

  test('/recap list --search filters in-memory on goal text', async () => {
    const a = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, {
      sessionId: a.id,
      role: 'user',
      content: 'refactor queue retry',
      createdAt: 1_100,
    });
    completeSession(db, a.id, 'done', 0, true, 2_000);
    const b = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 3_000 });
    appendMessage(db, {
      sessionId: b.id,
      role: 'user',
      content: 'add tests for auth',
      createdAt: 3_100,
    });
    completeSession(db, b.id, 'done', 0, true, 4_000);
    const result = await recapCommand.exec(['list', '--search', 'queue'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('refactor queue retry');
    expect(text).not.toContain('add tests for auth');
  });

  test('/recap list --status filters by session status', async () => {
    const a = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, { sessionId: a.id, role: 'user', content: 'finished', createdAt: 1_100 });
    completeSession(db, a.id, 'done', 0, true, 2_000);
    const b = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 3_000 });
    appendMessage(db, { sessionId: b.id, role: 'user', content: 'errored', createdAt: 3_100 });
    completeSession(db, b.id, 'error', 0, true, 4_000);
    const result = await recapCommand.exec(['list', '--status', 'error'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('errored');
    expect(text).not.toContain('finished');
  });

  test('/recap list --since YYYY-MM-DD filters startedAt >= since', async () => {
    const old = createSession(db, {
      model: 'sonnet',
      cwd: '/test/cwd',
      startedAt: Date.UTC(2026, 0, 1, 0, 0, 0, 0),
    });
    appendMessage(db, {
      sessionId: old.id,
      role: 'user',
      content: 'old',
      createdAt: old.startedAt + 1,
    });
    completeSession(db, old.id, 'done', 0, true, old.startedAt + 100);
    const recent = createSession(db, {
      model: 'sonnet',
      cwd: '/test/cwd',
      startedAt: Date.UTC(2026, 4, 9, 0, 0, 0, 0),
    });
    appendMessage(db, {
      sessionId: recent.id,
      role: 'user',
      content: 'recent',
      createdAt: recent.startedAt + 1,
    });
    completeSession(db, recent.id, 'done', 0, true, recent.startedAt + 100);
    const result = await recapCommand.exec(['list', '--since', '2026-05-01'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('recent');
    expect(text).not.toContain('old');
  });

  test('/recap list --project filters by cwd', async () => {
    const a = createSession(db, { model: 'sonnet', cwd: '/proj/A', startedAt: 1_000 });
    appendMessage(db, { sessionId: a.id, role: 'user', content: 'aaa', createdAt: 1_100 });
    completeSession(db, a.id, 'done', 0, true, 2_000);
    const b = createSession(db, { model: 'sonnet', cwd: '/proj/B', startedAt: 3_000 });
    appendMessage(db, { sessionId: b.id, role: 'user', content: 'bbb', createdAt: 3_100 });
    completeSession(db, b.id, 'done', 0, true, 4_000);
    const result = await recapCommand.exec(['list', '--project', '/proj/A'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('aaa');
    expect(text).not.toContain('bbb');
  });

  test('/recap list rejects --since with invalid date', async () => {
    const result = await recapCommand.exec(['list', '--since', 'tomorrow'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('invalid date');
  });

  test('/recap list rejects --status outside the allowed set', async () => {
    const result = await recapCommand.exec(['list', '--status', 'mystery'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('--status must be one of');
  });

  test('/recap list rejects unknown flags', async () => {
    const result = await recapCommand.exec(['list', '--unknown'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain("unknown flag '--unknown'");
  });

  test('/recap list returns empty result when filters match nothing', async () => {
    const result = await recapCommand.exec(['list', '--status', 'error'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('no sessions');
  });

  test('/recap list anonymizes $HOME paths in cwd/cwdLabel and goal (RECAP §6.2)', async () => {
    const HOME = process.env.HOME ?? '';
    if (HOME.length === 0 || !HOME.startsWith('/')) {
      // Skip when the test runner has no real $HOME; the anon
      // helper falls back to a sentinel that doesn't match the
      // path we'd seed below.
      return;
    }
    const s = createSession(db, { model: 'sonnet', cwd: `${HOME}/proj`, startedAt: 1_000 });
    appendMessage(db, {
      sessionId: s.id,
      role: 'user',
      content: `look at ${HOME}/proj/notes.md`,
      createdAt: 1_100,
    });
    completeSession(db, s.id, 'done', 0, true, 2_000);
    const result = await recapCommand.exec(['list', '--json'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('~/proj');
    expect(text).not.toContain(HOME);
  });

  test('/recap list redacts secret-shaped tokens in goal text (RECAP §6.2)', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, {
      sessionId: s.id,
      role: 'user',
      content: 'use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890',
      createdAt: 1_100,
    });
    completeSession(db, s.id, 'done', 0, true, 2_000);
    const result = await recapCommand.exec(['list', '--json'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('<redacted:');
    expect(text).not.toContain('sk-ant-api03');
  });

  test('/recap list --since applies at SQL boundary (no silent drop after LIMIT)', async () => {
    // Seed: 5 newer sessions (after --since) + 5 older (before).
    // With --limit 3 and --since on a date between, the operator
    // expects 3 newer (not 3 newest then drop those before --since
    // and end up with fewer).
    const may1 = Date.UTC(2026, 4, 1, 0, 0, 0, 0);
    for (let i = 0; i < 5; i++) {
      const s = createSession(db, {
        model: 'sonnet',
        cwd: '/test/cwd',
        startedAt: may1 + 1_000 + i,
      });
      appendMessage(db, {
        sessionId: s.id,
        role: 'user',
        content: `new-${i}`,
        createdAt: s.startedAt + 1,
      });
      completeSession(db, s.id, 'done', 0, true, s.startedAt + 100);
    }
    for (let i = 0; i < 5; i++) {
      const s = createSession(db, {
        model: 'sonnet',
        cwd: '/test/cwd',
        startedAt: may1 - 10_000 - i,
      });
      appendMessage(db, {
        sessionId: s.id,
        role: 'user',
        content: `old-${i}`,
        createdAt: s.startedAt + 1,
      });
      completeSession(db, s.id, 'done', 0, true, s.startedAt + 100);
    }
    const result = await recapCommand.exec(
      ['list', '--limit', '3', '--since', '2026-05-01', '--json'],
      makeCtx(),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const lines = result.notes?.filter((l) => l.length > 0) ?? [];
    // 3 rows, all newer (no `old-` goals leaked through).
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).not.toContain('old-');
    }
  });

  test('/recap list --search caps after in-memory filter, fetch is bumped (no silent drop)', async () => {
    // Seed: 5 sessions whose goals match "queue", interleaved with
    // 10 that don't. With --limit 3 --search queue, operator
    // expects 3 matching (not 3 newest filtered down).
    for (let i = 0; i < 5; i++) {
      const s = createSession(db, {
        model: 'sonnet',
        cwd: '/test/cwd',
        startedAt: 1_000 + i * 2,
      });
      appendMessage(db, {
        sessionId: s.id,
        role: 'user',
        content: `refactor queue retry ${i}`,
        createdAt: s.startedAt + 1,
      });
      completeSession(db, s.id, 'done', 0, true, s.startedAt + 100);
    }
    for (let i = 0; i < 10; i++) {
      const s = createSession(db, {
        model: 'sonnet',
        cwd: '/test/cwd',
        startedAt: 2_000 + i * 2,
      });
      appendMessage(db, {
        sessionId: s.id,
        role: 'user',
        content: `unrelated-${i}`,
        createdAt: s.startedAt + 1,
      });
      completeSession(db, s.id, 'done', 0, true, s.startedAt + 100);
    }
    const result = await recapCommand.exec(
      ['list', '--limit', '3', '--search', 'queue', '--json'],
      makeCtx(),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const lines = result.notes?.filter((l) => l.length > 0) ?? [];
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toContain('queue');
    }
  });

  // ─── /recap day + /recap range (slice e1) ───────────────────

  test('/recap day [YYYY-MM-DD] aggregates same-cwd sessions in the day window', async () => {
    const may1 = Date.UTC(2026, 4, 1, 0, 0, 0, 0);
    const may1noon = may1 + 12 * 60 * 60 * 1000;
    const apr30 = may1 - 60 * 60 * 1000;
    // Two same-day same-cwd sessions, plus one previous-day same-
    // cwd that should NOT show up.
    for (const startedAt of [may1, may1noon]) {
      const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt });
      appendMessage(db, {
        sessionId: s.id,
        role: 'user',
        content: `goal at ${startedAt}`,
        createdAt: startedAt + 1,
      });
      completeSession(db, s.id, 'done', 0, true, startedAt + 100);
    }
    const before = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: apr30 });
    appendMessage(db, {
      sessionId: before.id,
      role: 'user',
      content: 'previous day',
      createdAt: apr30 + 1,
    });
    completeSession(db, before.id, 'done', 0, true, apr30 + 100);
    const result = await recapCommand.exec(['day', '2026-05-01', '--no-llm-render'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    // Day-scope title format from renderHuman: `day 2026-05-01`.
    expect(text).toContain('day 2026-05-01');
    // Previous day should not appear.
    expect(text).not.toContain('previous day');
  });

  test('/recap day defaults to today UTC when no date given', async () => {
    const today = new Date(5_000);
    const yyyy = today.getUTCFullYear().toString().padStart(4, '0');
    const mm = (today.getUTCMonth() + 1).toString().padStart(2, '0');
    const dd = today.getUTCDate().toString().padStart(2, '0');
    const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0);
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: todayMs + 1 });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'today', createdAt: todayMs + 2 });
    completeSession(db, s.id, 'done', 0, true, todayMs + 100);
    const result = await recapCommand.exec(['day', '--no-llm-render'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain(`day ${yyyy}-${mm}-${dd}`);
  });

  test('/recap day rejects an invalid date', async () => {
    const result = await recapCommand.exec(['day', '2026-13-99'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('invalid date');
  });

  test('/recap range <from> <to> aggregates sessions in the inclusive day range', async () => {
    const may1 = Date.UTC(2026, 4, 1, 0, 0, 0, 0);
    const may2 = Date.UTC(2026, 4, 2, 0, 0, 0, 0);
    const may3 = Date.UTC(2026, 4, 3, 0, 0, 0, 0);
    const may4 = Date.UTC(2026, 4, 4, 0, 0, 0, 0);
    for (const startedAt of [may1, may2, may3, may4]) {
      const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt });
      appendMessage(db, {
        sessionId: s.id,
        role: 'user',
        content: `day-${startedAt}`,
        createdAt: startedAt + 1,
      });
      completeSession(db, s.id, 'done', 0, true, startedAt + 100);
    }
    const result = await recapCommand.exec(
      ['range', '2026-05-01', '2026-05-03', '--no-llm-render'],
      makeCtx(),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    // Range header from renderHuman: `range (N sessions)`. Three
    // days inclusive should match three sessions.
    expect(text).toContain('range (3 sessions)');
    // May 4 (outside the range) should not appear.
    expect(text).not.toContain(`day-${may4}`);
  });

  test('/recap range rejects when <to> is before <from>', async () => {
    const result = await recapCommand.exec(['range', '2026-05-10', '2026-05-01'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('on or after');
  });

  test('/recap range rejects with missing arguments', async () => {
    const result = await recapCommand.exec(['range', '2026-05-01'], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('requires <from> <to>');
  });

  test('/recap day filters by current-cwd by default (privacy guard)', async () => {
    const may1 = Date.UTC(2026, 4, 1, 0, 0, 0, 0);
    // Session A: same cwd as the harness. Session B: different cwd.
    const a = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: may1 });
    appendMessage(db, {
      sessionId: a.id,
      role: 'user',
      content: 'in-project',
      createdAt: may1 + 1,
    });
    completeSession(db, a.id, 'done', 0, true, may1 + 100);
    const b = createSession(db, { model: 'sonnet', cwd: '/other/proj', startedAt: may1 + 200 });
    appendMessage(db, {
      sessionId: b.id,
      role: 'user',
      content: 'cross-project',
      createdAt: may1 + 201,
    });
    completeSession(db, b.id, 'done', 0, true, may1 + 300);
    const result = await recapCommand.exec(['day', '2026-05-01', '--no-llm-render'], makeCtx());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    expect(text).toContain('in-project');
    expect(text).not.toContain('cross-project');
  });

  test('/recap day --all-projects fans out across every cwd (visible via audit + json shape)', async () => {
    const may1 = Date.UTC(2026, 4, 1, 0, 0, 0, 0);
    const a = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: may1 });
    appendMessage(db, {
      sessionId: a.id,
      role: 'user',
      content: 'in-project',
      createdAt: may1 + 1,
    });
    completeSession(db, a.id, 'done', 0, true, may1 + 100);
    const b = createSession(db, { model: 'sonnet', cwd: '/other/proj', startedAt: may1 + 200 });
    appendMessage(db, {
      sessionId: b.id,
      role: 'user',
      content: 'cross-project',
      createdAt: may1 + 201,
    });
    completeSession(db, b.id, 'done', 0, true, may1 + 300);
    // Render in JSON to inspect scope.session_ids — the human
    // surface only shows ONE goal text (projectGoal picks the first
    // session-anchored bundle), so we use the structured shape to
    // assert cross-project fan-out actually happened.
    const result = await recapCommand.exec(
      ['json', 'day', '2026-05-01', '--all-projects', '--no-llm-render'],
      makeCtx(),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const text = result.notes?.join('\n') ?? '';
    const parsed = JSON.parse(text) as { scope: { sessionIds: string[] } };
    expect(parsed.scope.sessionIds.sort()).toEqual([a.id, b.id].sort());

    const runs = listRecentRecapRuns(db);
    expect(runs[0]?.scopeKind).toBe('day');
    expect(runs[0]?.sessionIds.sort()).toEqual([a.id, b.id].sort());
  });

  test('/recap rejects --all-projects on single-session scopes (parse error)', async () => {
    for (const args of [
      ['--all-projects'],
      ['pr', '--all-projects'],
      ['session', 'sid', '--all-projects'],
      ['last', '5', '--all-projects'],
    ]) {
      const result = await recapCommand.exec(args, makeCtx());
      expect(result.kind).toBe('error');
      if (result.kind !== 'error') continue;
      expect(result.message).toContain('--all-projects only applies');
    }
  });

  test('/recap day audits with scope_kind=day and the full session id list', async () => {
    const may1 = Date.UTC(2026, 4, 1, 0, 0, 0, 0);
    const a = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: may1 });
    appendMessage(db, { sessionId: a.id, role: 'user', content: 'a', createdAt: may1 + 1 });
    completeSession(db, a.id, 'done', 0, true, may1 + 100);
    const b = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: may1 + 200 });
    appendMessage(db, { sessionId: b.id, role: 'user', content: 'b', createdAt: may1 + 201 });
    completeSession(db, b.id, 'done', 0, true, may1 + 300);
    await recapCommand.exec(['day', '2026-05-01', '--no-llm-render'], makeCtx());
    const runs = listRecentRecapRuns(db);
    expect(runs[0]?.scopeKind).toBe('day');
    // Both same-cwd sessions surface in the audit row.
    expect(runs[0]?.sessionIds.sort()).toEqual([a.id, b.id].sort());
  });

  test('/recap list cache hit on second call (deterministic, no projection re-run)', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'do thing', createdAt: 1_100 });
    completeSession(db, s.id, 'done', 0.04, true, 2_000);
    // First call writes the cache row.
    await recapCommand.exec(['list', '--json'], makeCtx());
    // The cache row should now exist for this session id.
    const rows = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM recap_cache').get();
    expect(rows?.count).toBe(1);
    // Second call hits the cache (correctness assertion: same
    // output bytes regardless of cache state).
    const a = await recapCommand.exec(['list', '--json'], makeCtx());
    const b = await recapCommand.exec(['list', '--json'], makeCtx());
    expect(a.kind).toBe('ok');
    expect(b.kind).toBe('ok');
    if (a.kind !== 'ok' || b.kind !== 'ok') return;
    expect(a.notes).toEqual(b.notes);
  });

  test('/recap terse LLM path: invalid-json falls back', async () => {
    const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
    currentSessionId = s.id;
    const handle = stubProvider('not-json');
    const ctx = makeCtx({ baseConfig: cfgWithProvider(handle.provider) });
    const events: { type: string; message?: string }[] = [];
    ctx.bus.on('warn', (e) => events.push({ type: 'warn', message: e.message }));

    const result = await recapCommand.exec(['terse'], ctx);
    expect(result.kind).toBe('ok');
    const warns = events.filter((e) => e.type === 'warn');
    expect(warns[0]?.message).toContain('invalid-json');

    const runs = listRecentRecapRuns(db);
    expect(runs[0]?.usedLlm).toBe(false);
  });
});
