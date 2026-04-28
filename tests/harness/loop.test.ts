import { beforeEach, describe, expect, test } from 'bun:test';
import type { CollectedStep } from '../../src/harness/collect.ts';
import { runAgent } from '../../src/harness/loop.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { Policy } from '../../src/permissions/index.ts';
import type { GenerateRequest, Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { getSession, listSessions } from '../../src/storage/repos/sessions.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';
import { type Tool, toolError } from '../../src/tools/types.ts';

const policy = (p: Partial<Policy> = {}): Policy => ({
  defaults: { mode: 'strict' },
  tools: {},
  ...p,
});

interface ScriptedStep {
  text?: string;
  tool_uses?: { id: string; name: string; input: Record<string, unknown> }[];
  stop_reason?: CollectedStep['stop_reason'];
  message_id?: string;
  usage?: { input?: number; output?: number; cache_read?: number; cache_creation?: number };
}

const replayStep = function* (step: ScriptedStep): Iterable<StreamEvent> {
  yield { kind: 'start', message_id: step.message_id ?? `mock_${crypto.randomUUID()}` };
  if (step.text !== undefined && step.text.length > 0) {
    yield { kind: 'text_delta', text: step.text };
  }
  for (const tu of step.tool_uses ?? []) {
    yield { kind: 'tool_use_start', id: tu.id, name: tu.name };
    yield { kind: 'tool_use_stop', id: tu.id, final_args: tu.input };
  }
  if (step.usage !== undefined) {
    yield {
      kind: 'usage',
      usage: {
        input: step.usage.input ?? 0,
        output: step.usage.output ?? 0,
        cache_read: step.usage.cache_read ?? 0,
        cache_creation: step.usage.cache_creation ?? 0,
      },
    };
  }
  yield {
    kind: 'stop',
    reason: step.stop_reason ?? (step.tool_uses?.length ? 'tool_use' : 'end_turn'),
  };
};

interface MockProviderHandle {
  provider: Provider;
  requests: GenerateRequest[];
}

const mockProvider = (
  script: ScriptedStep[],
  capsOverride?: Partial<Provider['capabilities']>,
): MockProviderHandle => {
  const requests: GenerateRequest[] = [];
  let i = 0;
  const provider: Provider = {
    id: 'mock/m',
    family: 'anthropic',
    capabilities: {
      tools: 'native',
      cache: false,
      vision: false,
      streaming: true,
      constrained: 'tools',
      context_window: 200_000,
      output_max_tokens: 4096,
      cost_per_1k_input: 0,
      cost_per_1k_output: 0,
      notes: [],
      ...capsOverride,
    },
    async *generate(req) {
      requests.push(req);
      const step = script[i++];
      if (step === undefined) throw new Error('mock script exhausted');
      for (const ev of replayStep(step)) yield ev;
    },
    generateConstrained: () => Promise.reject(new Error('not implemented')),
    countTokens: () => Promise.resolve(0),
  };
  return { provider, requests };
};

const echoTool: Tool = {
  name: 'echo',
  description: 'echo back',
  inputSchema: {
    type: 'object',
    properties: { msg: { type: 'string' } },
    required: ['msg'],
  },
  metadata: { category: 'misc', writes: false, idempotent: true },
  async execute(args: unknown) {
    const { msg } = args as { msg: string };
    return { echoed: msg };
  },
};

const failingTool: Tool<unknown, unknown> = {
  name: 'always_fails',
  description: 'always fails',
  inputSchema: { type: 'object' },
  metadata: { category: 'misc', writes: false, idempotent: false },
  async execute() {
    return toolError('test.fail', 'failure');
  },
};

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

const buildConfig = (
  script: ScriptedStep[],
  options: {
    extraTools?: Tool[];
    policy?: Partial<Policy>;
    signal?: AbortSignal;
    budget?: Partial<{ maxSteps: number; maxToolErrors: number; maxRepeatedToolHash: number }>;
    capsOverride?: Partial<Provider['capabilities']>;
  } = {},
) => {
  const handle = mockProvider(script, options.capsOverride);
  const registry = createToolRegistry();
  registry.register(echoTool);
  for (const t of options.extraTools ?? []) registry.register(t);
  return {
    handle,
    config: {
      provider: handle.provider,
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(policy(options.policy), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.budget !== undefined ? { budget: options.budget } : {}),
    },
  };
};

describe('runAgent', () => {
  test('happy path: text-only response → done in one step', async () => {
    const { config } = buildConfig([{ text: 'hello there', stop_reason: 'end_turn' }]);
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(result.reason).toBe('done');
    expect(result.steps).toBe(1);
  });

  test('tool call → result → done in two steps', async () => {
    const { config, handle } = buildConfig([
      {
        tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'world' } }],
        stop_reason: 'tool_use',
      },
      { text: 'all done', stop_reason: 'end_turn' },
    ]);
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(result.steps).toBe(2);
    // Second request must include the tool_result the first call produced.
    const second = handle.requests[1];
    expect(second).toBeDefined();
    if (second === undefined) return;
    const lastMsg = second.messages[second.messages.length - 1];
    expect(lastMsg?.role).toBe('user');
    const blocks = lastMsg?.content;
    expect(Array.isArray(blocks)).toBe(true);
    if (Array.isArray(blocks)) {
      expect(blocks[0]?.type).toBe('tool_result');
    }
  });

  test('budget: maxSteps caps the loop', async () => {
    // Mock keeps emitting tool_use forever; harness should bail at maxSteps.
    // Each call uses unique args so degenerate-loop detection doesn't fire first.
    const stepFactory = (i: number): ScriptedStep => ({
      tool_uses: [{ id: `tu${i}`, name: 'echo', input: { msg: `step-${i}` } }],
      stop_reason: 'tool_use',
    });
    const { config } = buildConfig(
      Array.from({ length: 10 }, (_, i) => stepFactory(i)),
      { budget: { maxSteps: 3 } },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('exhausted');
    expect(result.reason).toBe('maxSteps');
    expect(result.steps).toBe(3);
  });

  test('aborted signal: exits as interrupted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { config } = buildConfig([{ text: 'x' }], { signal: ctrl.signal });
    const result = await runAgent(config);
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('aborted');
    expect(result.steps).toBe(0);
  });

  test('unknown tool: error result, loop continues until done', async () => {
    const { config } = buildConfig([
      {
        tool_uses: [{ id: 'tu1', name: 'does_not_exist', input: {} }],
        stop_reason: 'tool_use',
      },
      { text: 'recovered', stop_reason: 'end_turn' },
    ]);
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(result.steps).toBe(2);
  });

  test('tool denied by policy: error result, loop continues', async () => {
    // misc auto-allows; we force deny via a write tool with deny_paths.
    const writeTool: Tool = {
      name: 'write_file',
      description: 'w',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      metadata: { category: 'fs.write', writes: true, idempotent: false },
      async execute() {
        return { ok: true };
      },
    };

    const { config } = buildConfig(
      [
        {
          tool_uses: [{ id: 'tu1', name: 'write_file', input: { path: 'x.ts' } }],
          stop_reason: 'tool_use',
        },
        { text: 'fine', stop_reason: 'end_turn' },
      ],
      {
        extraTools: [writeTool],
        policy: { tools: { write_file: { deny_paths: ['**'] } } },
      },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
  });

  test('maxToolErrors caps consecutive failures', async () => {
    // Vary the args so degenerate-loop detection doesn't trip first.
    const stepFactory = (i: number): ScriptedStep => ({
      tool_uses: [{ id: `tu${i}`, name: 'always_fails', input: { attempt: i } }],
      stop_reason: 'tool_use',
    });
    const { config } = buildConfig(
      Array.from({ length: 10 }, (_, i) => stepFactory(i)),
      { extraTools: [failingTool], budget: { maxToolErrors: 3 } },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('error');
    expect(result.reason).toBe('maxToolErrors');
  });

  test('degenerate loop: identical tool calls are caught', async () => {
    const sameStep = (): ScriptedStep => ({
      tool_uses: [{ id: crypto.randomUUID(), name: 'echo', input: { msg: 'same' } }],
      stop_reason: 'tool_use',
    });
    const { config } = buildConfig(
      Array.from({ length: 10 }, () => sameStep()),
      { budget: { maxRepeatedToolHash: 3 } },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('error');
    expect(result.reason).toBe('degenerateLoop');
    expect(result.detail).toContain('echo');
  });

  test('tool_result blocks sent on the next request carry the function name (Gemini compat)', async () => {
    const { config, handle } = buildConfig([
      {
        tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'hi' } }],
        stop_reason: 'tool_use',
      },
      { text: 'done', stop_reason: 'end_turn' },
    ]);
    await runAgent(config);
    const second = handle.requests[1];
    expect(second).toBeDefined();
    if (second === undefined) return;
    const lastMsg = second.messages[second.messages.length - 1];
    expect(Array.isArray(lastMsg?.content)).toBe(true);
    if (lastMsg !== undefined && Array.isArray(lastMsg.content)) {
      const block = lastMsg.content[0];
      expect(block?.type).toBe('tool_result');
      if (block?.type === 'tool_result') {
        expect(block.name).toBe('echo');
        expect(block.tool_use_id).toBe('tu1');
      }
    }
  });

  test('persists session and messages to SQLite', async () => {
    const { config } = buildConfig([
      {
        tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'hi' } }],
        stop_reason: 'tool_use',
      },
      { text: 'done', stop_reason: 'end_turn' },
    ]);
    const result = await runAgent(config);
    const session = getSession(db, result.sessionId);
    expect(session?.status).toBe('done');
    // 4 messages: user, assistant(tool_use), user(tool_result), assistant(text)
    const sessions = listSessions(db);
    expect(sessions).toHaveLength(1);
  });

  test('aggregates usage across turns and computes session cost', async () => {
    const { config } = buildConfig(
      [
        {
          tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'hi' } }],
          stop_reason: 'tool_use',
          usage: { input: 100, output: 20, cache_read: 0, cache_creation: 50 },
        },
        {
          text: 'done',
          stop_reason: 'end_turn',
          usage: { input: 200, output: 40 },
        },
      ],
      {
        capsOverride: {
          cost_per_1k_input: 3.0,
          cost_per_1k_output: 15.0,
          cost_per_1k_cached_input: 0.3,
          cost_per_1k_cache_write: 3.75,
        },
      },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(result.usage).toEqual({
      input: 300,
      output: 60,
      cache_read: 0,
      cache_creation: 50,
    });
    // Turn 1: 100×3 + 20×15 + 50×3.75 = 300 + 300 + 187.5 = 787.5 → /1000 = 0.7875
    // Turn 2: 200×3 + 40×15 = 600 + 600 = 1200 → /1000 = 1.2
    // Total: 1.9875
    expect(result.costUsd).toBeCloseTo(1.9875, 6);

    const session = getSession(db, result.sessionId);
    expect(session?.totalCostUsd).toBeCloseTo(1.9875, 6);
  });

  test('persists per-message tokens and cost on assistant turns', async () => {
    const { config } = buildConfig(
      [{ text: 'hi', stop_reason: 'end_turn', usage: { input: 50, output: 10 } }],
      { capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 } },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    const { listMessagesBySession } = await import('../../src/storage/repos/messages.ts');
    const msgs = listMessagesBySession(db, result.sessionId);
    const assistant = msgs.find((m) => m.role === 'assistant');
    expect(assistant?.tokensIn).toBe(50);
    expect(assistant?.tokensOut).toBe(10);
    // 50×3 + 10×15 = 300 → /1000 = 0.3
    expect(assistant?.costUsd).toBeCloseTo(0.3, 6);
  });

  test('persists NULL token columns when the adapter never emits a usage event', async () => {
    // No `usage:` on the scripted step → replayStep never yields kind:'usage'.
    // The collector's usageSeen stays false and the harness writes NULL
    // for tokens/cost so analytics can distinguish "no measurement"
    // from "measured zero".
    const { config } = buildConfig([{ text: 'hi', stop_reason: 'end_turn' }], {
      capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 },
    });
    const result = await runAgent(config);
    const { listMessagesBySession } = await import('../../src/storage/repos/messages.ts');
    const msgs = listMessagesBySession(db, result.sessionId);
    const assistant = msgs.find((m) => m.role === 'assistant');
    expect(assistant?.tokensIn).toBeNull();
    expect(assistant?.tokensOut).toBeNull();
    expect(assistant?.costUsd).toBeNull();
  });

  test('session_finished event carries the same usage + cost as the result', async () => {
    const events: import('../../src/harness/types.ts').HarnessEvent[] = [];
    const { config } = buildConfig(
      [{ text: 'hi', stop_reason: 'end_turn', usage: { input: 10, output: 2 } }],
      { capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 } },
    );
    const result = await runAgent({ ...config, onEvent: (e) => events.push(e) });
    const finished = events.find((e) => e.type === 'session_finished');
    if (finished?.type !== 'session_finished') throw new Error('expected session_finished');
    expect(finished.result.usage).toEqual(result.usage);
    expect(finished.result.costUsd).toBe(result.costUsd);
  });

  test('max_tokens stop_reason exits as exhausted/maxOutputTokens (not done)', async () => {
    // Provider returns text and stops with max_tokens — output was
    // truncated by the per-call cap. Reporting `done` (exit 0) would
    // silently hand the user an incomplete answer.
    const { config } = buildConfig([{ text: 'partial answer', stop_reason: 'max_tokens' }]);
    const result = await runAgent(config);
    expect(result.status).toBe('exhausted');
    expect(result.reason).toBe('maxOutputTokens');
    expect(result.detail).toContain('max_tokens');
  });

  test('refusal stop_reason exits as done (the refusal IS the response)', async () => {
    // Model said "no" — that's a valid completion. Should NOT be
    // surfaced as an error; the user gets the refusal text in the
    // assistant message.
    const { config } = buildConfig([{ text: "I can't help with that.", stop_reason: 'refusal' }]);
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(result.reason).toBe('done');
  });

  test('stop_sequence stop_reason exits as done', async () => {
    const { config } = buildConfig([{ text: 'all done', stop_reason: 'stop_sequence' }]);
    const result = await runAgent(config);
    expect(result.status).toBe('done');
  });

  test('wall-clock timeout in the tool loop is reported as maxWallClockMs (not aborted)', async () => {
    // The tool loop checks signal.aborted between invocations. If a
    // wall-clock timeout fires while a tool is running, the next
    // iteration must report `maxWallClockMs`, not `aborted` — otherwise
    // budget exhaustions get misclassified as user cancellations.
    //
    // Setup: a slow tool that takes longer than maxWallClockMs. The
    // wall-clock controller fires mid-execution; on the next loop
    // iteration we hit the abort check.
    const slowTool: Tool = {
      name: 'slow',
      description: 'sleeps',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, idempotent: false },
      async execute() {
        await new Promise((r) => setTimeout(r, 80));
        return { ok: true };
      },
    };
    const provider = mockProvider([
      {
        tool_uses: [
          { id: 'tu1', name: 'slow', input: {} },
          { id: 'tu2', name: 'slow', input: {} },
        ],
        stop_reason: 'tool_use',
      },
    ]);
    const result = await runAgent({
      provider: provider.provider,
      toolRegistry: (() => {
        const r = createToolRegistry();
        r.register(slowTool);
        return r;
      })(),
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
      budget: { maxWallClockMs: 30 },
    });
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('maxWallClockMs');
  });

  test('hung provider stream is interrupted by user abort', async () => {
    // Provider yields one event then hangs forever. Without
    // abortableIterable wrapping the stream, the for-await in
    // collectStep would block indefinitely. With it, the user's
    // abort signal breaks the race and the loop exits as
    // interrupted/aborted.
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    const provider: Provider = {
      id: 'mock/hang',
      family: 'anthropic',
      capabilities: {
        tools: 'native',
        cache: false,
        vision: false,
        streaming: true,
        constrained: 'tools',
        context_window: 1000,
        output_max_tokens: 100,
        cost_per_1k_input: 0,
        cost_per_1k_output: 0,
        notes: [],
      },
      async *generate() {
        yield { kind: 'start', message_id: 'm' };
        await new Promise(() => {
          // never resolves — simulates a stuck HTTP read
        });
        yield { kind: 'stop', reason: 'end_turn' };
      },
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };
    const result = await runAgent({
      provider,
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
      signal: ctrl.signal,
    });
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('aborted');
  });

  test('hung provider stream is interrupted by maxWallClockMs', async () => {
    // Same hung provider, but no user abort — the wall-clock controller
    // inside runAgent fires the combined signal after 30ms. Proves the
    // wall-clock cap actually enforces during a stuck stream, not just
    // between iterations.
    const provider: Provider = {
      id: 'mock/hang2',
      family: 'anthropic',
      capabilities: {
        tools: 'native',
        cache: false,
        vision: false,
        streaming: true,
        constrained: 'tools',
        context_window: 1000,
        output_max_tokens: 100,
        cost_per_1k_input: 0,
        cost_per_1k_output: 0,
        notes: [],
      },
      async *generate() {
        yield { kind: 'start', message_id: 'm' };
        await new Promise(() => {
          // never resolves
        });
        yield { kind: 'stop', reason: 'end_turn' };
      },
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };
    const result = await runAgent({
      provider,
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
      budget: { maxWallClockMs: 30 },
    });
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('maxWallClockMs');
  });

  test('stream errors fail the run (not silently exit done)', async () => {
    // Mock provider emits tool_use_start + malformed args → normalizer
    // produces an error event and drops tool_use_stop. Without the
    // error check, collected.tool_uses is empty and the loop exits
    // as `done` (exit code 0) — masking a real failure where the
    // model's tool call was lost.
    const provider: Provider = {
      id: 'mock/stream-err',
      family: 'anthropic',
      capabilities: {
        tools: 'native',
        cache: false,
        vision: false,
        streaming: true,
        constrained: 'tools',
        context_window: 1000,
        output_max_tokens: 100,
        cost_per_1k_input: 0,
        cost_per_1k_output: 0,
        notes: [],
      },
      async *generate() {
        yield { kind: 'start', message_id: 'm' };
        yield { kind: 'tool_use_start', id: 'tu1', name: 'echo' };
        yield {
          kind: 'error',
          code: 'tool_args_parse_error',
          message: 'failed to parse tool_use args for tu1: bad json',
          retryable: false,
        };
        yield { kind: 'stop', reason: 'tool_use' };
      },
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };
    const result = await runAgent({
      provider,
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
    });
    expect(result.status).toBe('error');
    expect(result.reason).toBe('providerError');
    expect(result.detail).toContain('tool_args_parse_error');
  });

  test('stream errors WITH no tool_uses still fail (not done)', async () => {
    // Edge: error emitted but no tool_use_start either (degenerate
    // normalizer output). Same fail-fast behavior.
    const provider: Provider = {
      id: 'mock/stream-err2',
      family: 'anthropic',
      capabilities: {
        tools: 'native',
        cache: false,
        vision: false,
        streaming: true,
        constrained: 'tools',
        context_window: 1000,
        output_max_tokens: 100,
        cost_per_1k_input: 0,
        cost_per_1k_output: 0,
        notes: [],
      },
      async *generate() {
        yield { kind: 'start', message_id: 'm' };
        yield {
          kind: 'error',
          code: 'normalizer.bug',
          message: 'something went wrong',
          retryable: false,
        };
        yield { kind: 'stop', reason: 'end_turn' };
      },
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };
    const result = await runAgent({
      provider,
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
    });
    expect(result.status).toBe('error');
    expect(result.reason).toBe('providerError');
  });

  test('abort during provider stream returns interrupted/aborted (not providerError)', async () => {
    // Simulate the SDK throwing AbortError when the signal fires mid-call.
    const ctrl = new AbortController();
    const provider: Provider = {
      id: 'mock/abort',
      family: 'anthropic',
      capabilities: {
        tools: 'native',
        cache: false,
        vision: false,
        streaming: true,
        constrained: 'tools',
        context_window: 1000,
        output_max_tokens: 100,
        cost_per_1k_input: 0,
        cost_per_1k_output: 0,
        notes: [],
      },
      // biome-ignore lint/correctness/useYield: throws before yielding
      async *generate() {
        // Abort the moment we're called, then throw the SDK-style AbortError.
        ctrl.abort();
        const e = new Error('aborted by signal') as Error & { code: string };
        e.code = 'ABORT_ERR';
        throw e;
      },
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };
    const registry = createToolRegistry();
    const result = await runAgent({
      provider,
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
      signal: ctrl.signal,
    });
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('aborted');
  });

  test('init failure (createSession throws) clears wall-clock timer', async () => {
    // If SQLite is unavailable when runAgent starts (closed handle, locked
    // file, I/O error), createSession throws *before* the loop's try/catch.
    // Without moving init inside the try, the wall-clock setTimeout leaks
    // and keeps the event loop alive for the full maxWallClockMs (default
    // 10 min). We verify the run returns promptly with internalError.
    db.close();
    const { config } = buildConfig([{ text: 'never reached', stop_reason: 'end_turn' }], {
      // Long wall-clock cap — if the timer leaked, this would dominate
      // duration. We assert duration is well under it.
      budget: { maxSteps: 5 },
    });
    const t0 = Date.now();
    const result = await runAgent(config);
    const elapsed = Date.now() - t0;
    expect(result.status).toBe('error');
    expect(result.reason).toBe('internalError');
    expect(result.sessionId).toBe('');
    expect(result.steps).toBe(0);
    // Sanity: the call returned, not just hung. Guard against a future
    // regression where finish() never gets invoked on early failure.
    expect(elapsed).toBeLessThan(1000);
    // Reopen so afterEach (none here, but next test's beforeEach reopens
    // anyway) doesn't trip — defensive cleanup.
  });

  test('provider crash exits as providerError with detail', async () => {
    const provider: Provider = {
      id: 'mock/crash',
      family: 'anthropic',
      capabilities: {
        tools: 'native',
        cache: false,
        vision: false,
        streaming: true,
        constrained: 'tools',
        context_window: 1000,
        output_max_tokens: 100,
        cost_per_1k_input: 0,
        cost_per_1k_output: 0,
        notes: [],
      },
      // biome-ignore lint/correctness/useYield: intentional throw before any yield
      async *generate() {
        throw new Error('network blew up');
      },
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };
    const registry = createToolRegistry();
    const result = await runAgent({
      provider,
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
    });
    expect(result.status).toBe('error');
    expect(result.reason).toBe('providerError');
    expect(result.detail).toContain('network');
  });
});
