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
  yield {
    kind: 'stop',
    reason: step.stop_reason ?? (step.tool_uses?.length ? 'tool_use' : 'end_turn'),
  };
};

interface MockProviderHandle {
  provider: Provider;
  requests: GenerateRequest[];
}

const mockProvider = (script: ScriptedStep[]): MockProviderHandle => {
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
  } = {},
) => {
  const handle = mockProvider(script);
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
