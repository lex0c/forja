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
  thinking?: string;
  tool_uses?: { id: string; name: string; input: Record<string, unknown> }[];
  stop_reason?: CollectedStep['stop_reason'];
  message_id?: string;
  usage?: { input?: number; output?: number; cache_read?: number; cache_creation?: number };
}

const replayStep = function* (step: ScriptedStep): Iterable<StreamEvent> {
  yield { kind: 'start', message_id: step.message_id ?? `mock_${crypto.randomUUID()}` };
  if (step.thinking !== undefined && step.thinking.length > 0) {
    yield { kind: 'thinking_delta', text: step.thinking };
  }
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
    budget?: Partial<{
      maxSteps: number;
      maxToolErrors: number;
      maxRepeatedToolHash: number;
      compactionThreshold: number;
      compactionPreserveTail: number;
    }>;
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

  test('usageComplete flips false when an output-producing turn lacked a usage event', async () => {
    // Two turns: first produces text + tool_use WITH usage, second is
    // an assistant text turn WITHOUT usage. Flag must end false so the
    // renderer marks aggregate cost as a lower bound.
    const { config } = buildConfig(
      [
        {
          tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'hi' } }],
          stop_reason: 'tool_use',
          usage: { input: 100, output: 20 },
        },
        // No `usage:` field → replayStep doesn't yield kind:'usage'.
        { text: 'done', stop_reason: 'end_turn' },
      ],
      { capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 } },
    );
    const result = await runAgent(config);
    expect(result.usageComplete).toBe(false);
    // Aggregate sums only the measured turn — verify it didn't fold in
    // a phantom zero from the unmeasured one.
    expect(result.usage.input).toBe(100);
  });

  test('partial run persists usage_complete=false on the sessions row', async () => {
    // The runtime flag must reach the DB so audit queries can mark the
    // total as a lower bound. Without persistence, any future
    // `agent audit costs` lookup would silently underreport.
    const { config } = buildConfig(
      [
        { tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'hi' } }], stop_reason: 'tool_use' },
        { text: 'done', stop_reason: 'end_turn' },
      ],
      { capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 } },
    );
    const result = await runAgent(config);
    expect(result.usageComplete).toBe(false);
    const session = getSession(db, result.sessionId);
    expect(session?.usageComplete).toBe(false);
  });

  test('usageComplete stays true when every output-producing turn reported usage', async () => {
    const { config } = buildConfig(
      [
        {
          tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'hi' } }],
          stop_reason: 'tool_use',
          usage: { input: 50, output: 10 },
        },
        { text: 'done', stop_reason: 'end_turn', usage: { input: 60, output: 5 } },
      ],
      { capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 } },
    );
    const result = await runAgent(config);
    expect(result.usageComplete).toBe(true);
  });

  test('usageComplete flips false on a thinking-only turn without usage', async () => {
    // Anthropic's extended thinking emits thinking_delta events that
    // are charged as output tokens even when the model produces no
    // text or tool_use that turn. Missing usage on such a turn IS
    // underreporting and must surface in the aggregate flag.
    const { config } = buildConfig(
      [{ thinking: 'reasoning silently...', stop_reason: 'end_turn' }],
      { capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 } },
    );
    const result = await runAgent(config);
    expect(result.usageComplete).toBe(false);
  });

  test('usageComplete flips false even on an empty assistant turn without usage', async () => {
    // The prompt was sent and input tokens were billed regardless of
    // whether the model emitted text/tool_use/thinking. An assistant
    // turn that completes cleanly (the provider accepted the request
    // and returned a stream) without usage telemetry IS underreporting
    // cost — the renderer must mark aggregate as a lower bound.
    const { config } = buildConfig([{ stop_reason: 'end_turn' }]);
    const result = await runAgent(config);
    expect(result.usageComplete).toBe(false);
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
    // Mid-stream abort means the request went out (likely billed for
    // input tokens) without a usage event reaching us. Aggregate must
    // be marked as a lower bound.
    expect(result.usageComplete).toBe(false);
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
    // Provider error mid-call: input tokens may have been billed
    // before the throw. No usage event reached us — aggregate is a
    // lower bound, flag must be false.
    expect(result.usageComplete).toBe(false);
  });

  test('compaction triggers when message-array estimate crosses the threshold', async () => {
    // The trigger estimates over the messages we're ABOUT to send
    // (post-tool_result-push), not the prior turn's billed input.
    // Tail alignment requires non-empty middle; we run several
    // turns of moderate-size tool calls so the trigger fires AFTER
    // a few turns have accumulated, ensuring the middle has
    // something to fold.
    const events: import('../../src/harness/types.ts').HarnessEvent[] = [];
    const fatTool: Tool = {
      name: 'fat',
      description: 'returns a sizable string',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, idempotent: true },
      async execute() {
        return 'x'.repeat(3000); // pushes the post-turn-2 estimate over 700
      },
    };
    const { config, handle } = buildConfig(
      [
        // Turn 1: small echo — keeps estimate below threshold so
        // the trigger doesn't fire yet (would skip on empty middle).
        {
          tool_uses: [{ id: 't1', name: 'echo', input: { msg: 'hi' } }],
          stop_reason: 'tool_use',
          usage: { input: 50, output: 5 },
        },
        // Turn 2: fat tool. Estimate now crosses 70% × 1000 = 700.
        // Trigger fires; middle has turn 1 to fold.
        {
          tool_uses: [{ id: 't2', name: 'fat', input: {} }],
          stop_reason: 'tool_use',
          usage: { input: 50, output: 5 },
        },
        // Turn 3 is consumed by the COMPACTION call.
        {
          text: '[compacted_history]\nGOAL: test\n[/compacted_history]',
          stop_reason: 'end_turn',
        },
        // Turn 4: post-compaction agent step.
        { text: 'done', stop_reason: 'end_turn', usage: { input: 50, output: 3 } },
      ],
      {
        extraTools: [fatTool],
        capsOverride: { context_window: 1000, cost_per_1k_input: 0, cost_per_1k_output: 0 },
        budget: { compactionThreshold: 0.7, compactionPreserveTail: 1, maxToolErrors: 99 },
      },
    );
    const result = await runAgent({ ...config, onEvent: (e) => events.push(e) });
    expect(result.status).toBe('done');
    const finished = events.find((e) => e.type === 'compaction_finished');
    expect(finished).toBeDefined();
    if (finished?.type === 'compaction_finished') {
      expect(finished.strategy).toBe('llm');
      expect(finished.foldedCount).toBeGreaterThan(0);
    }
    // Post-compaction request shorter than pre-compaction (length 5).
    const postCompactReq = handle.requests[handle.requests.length - 1];
    expect(postCompactReq).toBeDefined();
    if (postCompactReq !== undefined) {
      expect(postCompactReq.messages.length).toBeLessThan(5);
    }
  });

  test('compaction trigger counts system prompt and tool schemas (not just messages)', async () => {
    // Regression: the prior trigger estimated only the messages
    // array. A long system prompt or large tool schemas (2-4k tokens
    // each per CONTEXT_TUNING.md §2.1) push the real prompt over the
    // cap while messages alone stays comfortably below — leading to
    // skipped compaction and a context-length 400 on the next call.
    const events: import('../../src/harness/types.ts').HarnessEvent[] = [];
    // Tools are pulled from the registry; use the real `echo` tool
    // registered by buildConfig but inflate its description so the
    // schema cost is large.
    const heavyTool: Tool = {
      name: 'heavy',
      description: 'x'.repeat(2000), // ~500 token description
      inputSchema: { type: 'object', properties: {} },
      metadata: { category: 'misc', writes: false, idempotent: true },
      async execute() {
        return { ok: true };
      },
    };
    const longSystem = 'y'.repeat(800); // ~200 tokens
    const { config } = buildConfig(
      [
        // Two small turns so the middle has something to fold; the
        // big-overhead trigger is what we're proving here, not the
        // alignment math.
        {
          tool_uses: [{ id: 't1', name: 'echo', input: { msg: 'a' } }],
          stop_reason: 'tool_use',
          usage: { input: 50, output: 5 },
        },
        {
          tool_uses: [{ id: 't2', name: 'heavy', input: {} }],
          stop_reason: 'tool_use',
          usage: { input: 50, output: 5 },
        },
        // Compaction summary call.
        {
          text: '[compacted_history]\nGOAL: x\n[/compacted_history]',
          stop_reason: 'end_turn',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
      {
        extraTools: [heavyTool],
        capsOverride: { context_window: 1000, cost_per_1k_input: 0, cost_per_1k_output: 0 },
        budget: { compactionThreshold: 0.7, compactionPreserveTail: 1, maxToolErrors: 99 },
      },
    );
    const result = await runAgent({
      ...config,
      systemPrompt: longSystem,
      onEvent: (e) => events.push(e),
    });
    expect(result.status).toBe('done');
    // System (~200) + tool schema (~500) + tiny messages = > 700
    // (= 70% of 1000). Trigger must fire.
    expect(events.find((e) => e.type === 'compaction_started')).toBeDefined();
  });

  test('compaction triggers on the SAME turn a big tool_result pushes prompt over', async () => {
    // Regression: prior trigger used last turn's billed input. A
    // single tool that returns a huge payload (read_file on a 200KB
    // file, grep with thousands of hits) could push the next prompt
    // over the cap WITHOUT the prior turn ever crossing threshold,
    // and the trigger would skip — letting the next provider call
    // 400 with context-length-exceeded. The fix reads the actual
    // post-push messages array via heuristic estimate.
    const events: import('../../src/harness/types.ts').HarnessEvent[] = [];
    const hugeTool: Tool = {
      name: 'huge',
      description: 'returns a wall of text',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, idempotent: true },
      async execute() {
        // ~4000 chars → ~1000 tokens estimated. The prior turn's
        // billed input is only 50 — well under the 0.7×1000=700
        // threshold under the OLD trigger. Under the NEW trigger,
        // post-push messages estimate well over 700.
        return 'a'.repeat(4000);
      },
    };
    const { config } = buildConfig(
      [
        // Turn 1: small echo so the middle has content to fold
        // when the alignment-shift kicks in.
        {
          tool_uses: [{ id: 't1', name: 'echo', input: { msg: 'a' } }],
          stop_reason: 'tool_use',
          usage: { input: 50, output: 5 },
        },
        // Turn 2: huge tool — its tool_result alone pushes the next
        // prompt over the cap.
        {
          tool_uses: [{ id: 't2', name: 'huge', input: {} }],
          stop_reason: 'tool_use',
          usage: { input: 50, output: 5 },
        },
        // Compaction summary call.
        {
          text: '[compacted_history]\nGOAL: x\n[/compacted_history]',
          stop_reason: 'end_turn',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
      {
        extraTools: [hugeTool],
        capsOverride: { context_window: 1000, cost_per_1k_input: 0, cost_per_1k_output: 0 },
        budget: { compactionThreshold: 0.7, compactionPreserveTail: 1, maxToolErrors: 99 },
      },
    );
    const result = await runAgent({ ...config, onEvent: (e) => events.push(e) });
    expect(result.status).toBe('done');
    expect(events.find((e) => e.type === 'compaction_started')).toBeDefined();
  });

  test('compaction does NOT trigger when prompt tokens stay below threshold', async () => {
    const events: import('../../src/harness/types.ts').HarnessEvent[] = [];
    const { config } = buildConfig(
      [
        {
          tool_uses: [{ id: 't1', name: 'echo', input: { msg: 'hi' } }],
          stop_reason: 'tool_use',
          usage: { input: 100, output: 5 },
        },
        { text: 'done', stop_reason: 'end_turn', usage: { input: 110, output: 3 } },
      ],
      {
        capsOverride: { context_window: 100_000 },
      },
    );
    const result = await runAgent({ ...config, onEvent: (e) => events.push(e) });
    expect(result.status).toBe('done');
    expect(events.find((e) => e.type === 'compaction_started')).toBeUndefined();
  });

  test('compaction usage and cost fold into session totals', async () => {
    // Compaction call is a billed provider request — its usage must
    // contribute to result.usage and result.costUsd. Without the
    // fold, sessions that compact systematically underreport spend.
    // The trigger is now size-driven, so we use a fat tool whose
    // result pushes the estimate over threshold.
    const events: import('../../src/harness/types.ts').HarnessEvent[] = [];
    const fatTool: Tool = {
      name: 'fat',
      description: 'returns sizable text',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, idempotent: true },
      async execute() {
        return 'z'.repeat(3000); // pushes the post-turn-2 estimate over 700
      },
    };
    const { config } = buildConfig(
      [
        // Turn 1: small echo — keeps estimate below threshold so
        // the trigger doesn't fire on a still-empty middle.
        {
          tool_uses: [{ id: 't1', name: 'echo', input: { msg: 'hi' } }],
          stop_reason: 'tool_use',
          usage: { input: 50, output: 5 },
        },
        // Turn 2: fat tool. Trigger fires here.
        {
          tool_uses: [{ id: 't2', name: 'fat', input: {} }],
          stop_reason: 'tool_use',
          usage: { input: 50, output: 5 },
        },
        // COMPACTION call (consumed by compactMessages).
        {
          text: '[compacted_history]\nGOAL: x\n[/compacted_history]',
          stop_reason: 'end_turn',
          usage: { input: 300, output: 50 },
        },
        // Post-compaction agent step.
        { text: 'done', stop_reason: 'end_turn', usage: { input: 100, output: 5 } },
      ],
      {
        extraTools: [fatTool],
        capsOverride: {
          context_window: 1000,
          cost_per_1k_input: 1.0,
          cost_per_1k_output: 2.0,
        },
        budget: { compactionThreshold: 0.7, compactionPreserveTail: 1, maxToolErrors: 99 },
      },
    );
    const result = await runAgent({ ...config, onEvent: (e) => events.push(e) });
    expect(result.status).toBe('done');

    const finished = events.find((e) => e.type === 'compaction_finished');
    if (finished?.type !== 'compaction_finished') throw new Error('expected event');
    expect(finished.strategy).toBe('llm');
    // 300 × 1.0 + 50 × 2.0 = 400 → /1000 = 0.4
    expect(finished.costUsd).toBeCloseTo(0.4, 6);
    expect(finished.usage.input).toBe(300);
    expect(finished.usage.output).toBe(50);

    // Session totals must include compaction + every agent turn
    // that reported usage. Pricing: input=1.0/1k, output=2.0/1k.
    // turn 1 (echo): 50+5×2 = 60 → 0.060
    // turn 2 (fat):  50+5×2 = 60 → 0.060
    // compaction:    300+50×2 = 400 → 0.400
    // post-comp:     100+5×2  = 110 → 0.110
    // total: 0.630
    expect(result.usage.input).toBe(50 * 2 + 300 + 100);
    expect(result.usage.output).toBe(5 * 2 + 50 + 5);
    expect(result.costUsd).toBeCloseTo(0.63, 6);
  });

  test('compaction without usage telemetry downgrades usageComplete', async () => {
    // The compaction LLM call is a billed request — if it doesn't
    // report usage (compat endpoint, mid-stream failure), the
    // aggregate flag must flip false even when every other turn
    // reported. Otherwise renderers present partial totals as
    // authoritative.
    const events: import('../../src/harness/types.ts').HarnessEvent[] = [];
    const fatTool: Tool = {
      name: 'fat',
      description: 'returns sizable text',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, idempotent: true },
      async execute() {
        return 'q'.repeat(4000);
      },
    };
    const { config } = buildConfig(
      [
        {
          tool_uses: [{ id: 't1', name: 'fat', input: {} }],
          stop_reason: 'tool_use',
          usage: { input: 50, output: 5 },
        },
        // Compaction call — text but NO usage block. ScriptedStep
        // omits `usage:` so replayStep skips the kind:'usage' event.
        {
          text: '[compacted_history]\nGOAL: x\n[/compacted_history]',
          stop_reason: 'end_turn',
        },
        { text: 'done', stop_reason: 'end_turn', usage: { input: 100, output: 5 } },
      ],
      {
        extraTools: [fatTool],
        capsOverride: { context_window: 1000 },
        budget: { compactionThreshold: 0.7, compactionPreserveTail: 1, maxToolErrors: 99 },
      },
    );
    const result = await runAgent({ ...config, onEvent: (e) => events.push(e) });
    expect(result.usageComplete).toBe(false);
  });

  test('compaction does NOT trigger on the final allowed step (maxSteps reached)', async () => {
    // Regression: compaction runs at the END of a step body, but
    // the loop's maxSteps check is at the TOP of the next
    // iteration. With budget.maxSteps=2 and the trigger firing at
    // the bottom of step 2, we'd burn an extra billed summary call
    // right before the next top-check exits as maxSteps. Skip
    // when no further step is allowed.
    const events: import('../../src/harness/types.ts').HarnessEvent[] = [];
    const fatTool: Tool = {
      name: 'fat',
      description: 'returns sizable text',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, idempotent: true },
      async execute() {
        return 'x'.repeat(3000);
      },
    };
    const { config } = buildConfig(
      [
        // Two fat-tool turns: estimate crosses threshold after
        // turn 2. With maxSteps=2 the loop must NOT compact.
        {
          tool_uses: [{ id: 't1', name: 'echo', input: { msg: 'a' } }],
          stop_reason: 'tool_use',
          usage: { input: 50, output: 5 },
        },
        {
          tool_uses: [{ id: 't2', name: 'fat', input: {} }],
          stop_reason: 'tool_use',
          usage: { input: 50, output: 5 },
        },
      ],
      {
        extraTools: [fatTool],
        capsOverride: { context_window: 1000, cost_per_1k_input: 0, cost_per_1k_output: 0 },
        budget: {
          compactionThreshold: 0.7,
          compactionPreserveTail: 1,
          maxToolErrors: 99,
          maxSteps: 2,
        },
      },
    );
    const result = await runAgent({ ...config, onEvent: (e) => events.push(e) });
    expect(result.reason).toBe('maxSteps');
    expect(events.find((e) => e.type === 'compaction_started')).toBeUndefined();
  });

  test('compaction does NOT trigger after the run is aborted', async () => {
    // If the user aborts between the tool_results push and the
    // trigger check, the harness should skip compaction — the next
    // iteration is about to exit anyway. Without the guard we'd
    // burn an extra LLM call that immediately falls back.
    const events: import('../../src/harness/types.ts').HarnessEvent[] = [];
    const ctrl = new AbortController();
    // The mock aborts during turn 1's tool execution (echo is
    // synchronous, but we abort right before the trigger by aborting
    // inside the tool — abort runs before the next signal check).
    const abortingTool: Tool = {
      name: 'aborter',
      description: 'aborts the signal mid-call and returns a sizable payload',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, idempotent: true },
      async execute() {
        ctrl.abort();
        // Big enough that the post-push estimate would normally
        // trigger compaction (context 1000 × 0.7 = 700; 4000 chars
        // → 1000 estimated tokens). The abort guard must skip it.
        return 'x'.repeat(4000);
      },
    };
    const { config } = buildConfig(
      [
        {
          tool_uses: [{ id: 't1', name: 'aborter', input: {} }],
          stop_reason: 'tool_use',
          usage: { input: 50, output: 5 },
        },
      ],
      {
        capsOverride: { context_window: 1000 },
        budget: { compactionThreshold: 0.7, compactionPreserveTail: 1 },
        signal: ctrl.signal,
        extraTools: [abortingTool],
      },
    );
    await runAgent({ ...config, onEvent: (e) => events.push(e) });
    expect(events.find((e) => e.type === 'compaction_started')).toBeUndefined();
  });

  test('compaction trigger works without any usage telemetry (size-based)', async () => {
    // Reverse of the old "no telemetry → skip" behavior. The new
    // trigger is size-driven (chars/4 over messages) and doesn't
    // depend on `usageSeen` at all — a session running against a
    // compat endpoint that drops stream_options must still get its
    // history compacted when message size demands it.
    const events: import('../../src/harness/types.ts').HarnessEvent[] = [];
    const fatTool: Tool = {
      name: 'fat',
      description: 'returns sizable text',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, idempotent: true },
      async execute() {
        return 'y'.repeat(2000);
      },
    };
    const { config } = buildConfig(
      // Note: NO `usage:` field on any scripted step — usageSeen
      // stays false throughout. Two turns so the middle has
      // something to fold (alignment-to-assistant requires a
      // non-empty middle).
      [
        { tool_uses: [{ id: 't1', name: 'echo', input: { msg: 'a' } }], stop_reason: 'tool_use' },
        { tool_uses: [{ id: 't2', name: 'fat', input: {} }], stop_reason: 'tool_use' },
        // Compaction summary call.
        {
          text: '[compacted_history]\nGOAL: x\n[/compacted_history]',
          stop_reason: 'end_turn',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
      {
        extraTools: [fatTool],
        capsOverride: { context_window: 400, cost_per_1k_input: 0, cost_per_1k_output: 0 },
        budget: { compactionThreshold: 0.7, compactionPreserveTail: 1, maxToolErrors: 99 },
      },
    );
    await runAgent({ ...config, onEvent: (e) => events.push(e) });
    expect(events.find((e) => e.type === 'compaction_started')).toBeDefined();
  });

  test('init failure surfaces with usageComplete=false', async () => {
    // guardedFinish path: any uncaught throw in the harness body has
    // ambiguous billing state. Safer to mark partial than to claim
    // authoritative totals when we don't know.
    db.close();
    const { config } = buildConfig([{ text: 'never reached', stop_reason: 'end_turn' }]);
    const result = await runAgent(config);
    expect(result.reason).toBe('internalError');
    expect(result.usageComplete).toBe(false);
  });
});
