import { beforeEach, describe, expect, test } from 'bun:test';
import type { CollectedStep } from '../../src/harness/collect.ts';
import { type AssistantUsage, type HarnessEvent, SessionContext } from '../../src/harness/index.ts';
import { runAgent } from '../../src/harness/loop.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { Policy } from '../../src/permissions/index.ts';
import type { GenerateRequest, Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createPin } from '../../src/storage/repos/context-pins.ts';
import { listProvenanceForMemory } from '../../src/storage/repos/memory-provenance.ts';
import { appendMessage, sumMessageUsage } from '../../src/storage/repos/messages.ts';
import { createSession, getSession, listSessions } from '../../src/storage/repos/sessions.ts';
import type { SubagentSet } from '../../src/subagents/load.ts';
import type { SubagentDefinition } from '../../src/subagents/types.ts';
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

// Small input, BIG output — so the elidable weight lands in the tool_result
// (which the relevance pre-pass can pointer) rather than the tool_use input
// (an assistant-message block the pre-pass never touches). Used to build a
// context the relevance pass alone can drop under the threshold.
const bigOutputTool: Tool = {
  name: 'big',
  description: 'returns a large result regardless of input size',
  inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
  metadata: { category: 'misc', writes: false, idempotent: true },
  async execute(args: unknown) {
    const { n } = args as { n: number };
    return { chunk: n, data: 'y '.repeat(2000) };
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
    softStopSignal?: AbortSignal;
    budget?: Partial<{
      maxSteps: number;
      maxToolErrors: number;
      maxRepeatedToolHash: number;
      compactionThreshold: number;
      compactionPreserveTail: number;
      compactionRelevance: boolean;
      maxCostUsd: number;
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
      ...(options.softStopSignal !== undefined ? { softStopSignal: options.softStopSignal } : {}),
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

  test('aborted signal: exits as interrupted with abortCause=hard', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { config } = buildConfig([{ text: 'x' }], { signal: ctrl.signal });
    const result = await runAgent(config);
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('aborted');
    expect(result.steps).toBe(0);
    // Hard signal → abortCause discriminator carries 'hard' so audit
    // / telemetry can distinguish from cooperative soft (1.g.2).
    expect(result.abortCause).toBe('hard');
  });

  test('non-abort exits do NOT set abortCause (undefined for done/maxSteps/etc.)', async () => {
    // Sanity: the discriminator is only meaningful for reason==='aborted'.
    // A done turn shouldn't carry a hard/soft label.
    const { config } = buildConfig([{ text: 'hi', stop_reason: 'end_turn' }]);
    const result = await runAgent(config);
    expect(result.reason).toBe('done');
    expect(result.abortCause).toBeUndefined();
  });

  test('softStopSignal pre-aborted exits aborted at step boundary, no provider call', async () => {
    // Spec UI.md §3 cooperative-stop: soft signal already fired before
    // the loop starts → the first step boundary check exits cleanly
    // without burning a provider call. Status mirrors hard abort.
    const soft = new AbortController();
    soft.abort();
    const { config, handle } = buildConfig([{ text: 'should not run' }], {
      softStopSignal: soft.signal,
    });
    const result = await runAgent(config);
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('aborted');
    expect(result.steps).toBe(0);
    // Soft signal → abortCause='soft' (1.g.2 discriminator).
    expect(result.abortCause).toBe('soft');
    // Critical contract: provider was never called.
    expect(handle.requests).toHaveLength(0);
  });

  test('softStopSignal mid-tool: tool completes, loop exits at next boundary', async () => {
    // The cooperative semantic: soft signal fires WHILE a tool is
    // running. The current step's tool execution finishes (in-flight
    // work not preempted), result lands in the message log, then the
    // top-of-loop check exits with reason='aborted' without issuing
    // the next provider request. Distinguishes from hard abort, which
    // would kill the tool mid-execution.
    //
    // Verifiable contract: the tool blocks on a Promise that ONLY
    // resolves when the test (outside the harness) explicitly
    // releases it. If the harness preempted the tool on soft, the
    // tool would never reach `toolFinished = true` because the
    // Promise stays pending — `expect(toolFinished).toBe(true)`
    // would fail. Stronger than `setTimeout(10)` which only
    // measured time, not actual non-preemption.
    const soft = new AbortController();
    let toolStarted = false;
    let toolFinished = false;
    let releaseTool: () => void = () => {};
    const toolGate = new Promise<void>((r) => {
      releaseTool = r;
    });
    const slowTool: Tool = {
      name: 'slow_tool',
      description: 'fires soft mid-flight, blocks until released',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, idempotent: false },
      execute: async () => {
        toolStarted = true;
        soft.abort();
        // Block until the test verifies that the harness has NOT
        // preempted us, then releases the gate. A preemptive harness
        // would leave us hanging forever (test would time out).
        await toolGate;
        toolFinished = true;
        return { ok: true };
      },
    };
    const { config, handle } = buildConfig(
      [
        {
          tool_uses: [{ id: 'tu1', name: 'slow_tool', input: {} }],
          stop_reason: 'tool_use',
        },
        // Second step would run if soft didn't trip; soft must short-circuit.
        { text: 'should not reach here', stop_reason: 'end_turn' },
      ],
      { extraTools: [slowTool], softStopSignal: soft.signal },
    );
    // Run + release gate concurrently. The release fires after one
    // tick so we observe that the tool was started AND blocked AND
    // soft fired AND no preemption happened — if any of those broke,
    // the gate-blocking shape would surface it.
    const runPromise = runAgent(config);
    await new Promise((r) => setTimeout(r, 5));
    expect(toolStarted).toBe(true);
    expect(toolFinished).toBe(false);
    expect(soft.signal.aborted).toBe(true);
    releaseTool();
    const result = await runPromise;
    expect(toolFinished).toBe(true);
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('aborted');
    expect(result.abortCause).toBe('soft');
    // Exactly one provider request fired (the first step that
    // produced the tool_use); the second step's provider call was
    // skipped by the soft check.
    expect(handle.requests).toHaveLength(1);
    expect(result.steps).toBe(1);
  });

  test('softStopSignal between tool_uses of the same step short-circuits remaining tools', async () => {
    // Spec UI.md §3 + D158: the model returned multiple tool_uses
    // in one step. Soft fires after the FIRST tool runs. The second
    // tool must NOT execute — operator already cancelled. Without
    // this check (the inner-loop soft guard), the bash tool 2 would
    // run, side effects would land, wall-clock burned. Asserts the
    // post-D158 contract.
    const soft = new AbortController();
    let firstRan = false;
    let secondRan = false;
    const firstTool: Tool = {
      name: 'first_tool',
      description: 'fires soft after running',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, idempotent: false },
      execute: async () => {
        firstRan = true;
        soft.abort();
        return { ok: true };
      },
    };
    const secondTool: Tool = {
      name: 'second_tool',
      description: 'should NOT run because soft fired between tools',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, idempotent: false },
      execute: async () => {
        secondRan = true;
        return { ok: true };
      },
    };
    const { config, handle } = buildConfig(
      [
        {
          tool_uses: [
            { id: 'tu1', name: 'first_tool', input: {} },
            { id: 'tu2', name: 'second_tool', input: {} },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'unreached', stop_reason: 'end_turn' },
      ],
      { extraTools: [firstTool, secondTool], softStopSignal: soft.signal },
    );
    const result = await runAgent(config);
    expect(firstRan).toBe(true);
    expect(secondRan).toBe(false);
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('aborted');
    expect(result.abortCause).toBe('soft');
    // No second provider call — soft short-circuited inside step 1.
    expect(handle.requests).toHaveLength(1);
  });

  test('hard abort still preempts in-flight tool (regression cover)', async () => {
    // Make sure the soft path additions didn't regress the existing
    // hard-preemption behavior. Hard signal fires mid-tool → tool's
    // ctx.signal.aborted is true while it's still running.
    const hard = new AbortController();
    let observedAbort = false;
    const slowTool: Tool = {
      name: 'slow_tool_hard',
      description: 'fires hard mid-execution',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, idempotent: false },
      execute: async (_args, ctx) => {
        hard.abort();
        // One microtask tick: the abort propagates through ctx.signal.
        await new Promise((r) => setTimeout(r, 5));
        observedAbort = ctx.signal.aborted;
        return { ok: true };
      },
    };
    const { config } = buildConfig(
      [
        {
          tool_uses: [{ id: 'tu1', name: 'slow_tool_hard', input: {} }],
          stop_reason: 'tool_use',
        },
        { text: 'unreached', stop_reason: 'end_turn' },
      ],
      { extraTools: [slowTool], signal: hard.signal },
    );
    const result = await runAgent(config);
    expect(observedAbort).toBe(true);
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('aborted');
    expect(result.abortCause).toBe('hard');
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

  test('serial maxToolErrors bail answers every tool_use — no orphan persisted', async () => {
    // Three failing tool_uses in ONE assistant turn. failingTool has no
    // `parallel_safe`, so the step runs the serial path; maxToolErrors
    // is 2 → the bail fires on tu2, before tu3 is reached. The persisted
    // user message must still answer all three, or the history is
    // invalid (the provider 400s on the next request).
    const { config } = buildConfig(
      [
        {
          tool_uses: [
            { id: 'tu1', name: 'always_fails', input: { n: 1 } },
            { id: 'tu2', name: 'always_fails', input: { n: 2 } },
            { id: 'tu3', name: 'always_fails', input: { n: 3 } },
          ],
          stop_reason: 'tool_use',
        },
      ],
      { extraTools: [failingTool], budget: { maxToolErrors: 2 } },
    );
    const result = await runAgent(config);
    expect(result.reason).toBe('maxToolErrors');

    const { listMessagesBySession } = await import('../../src/storage/repos/messages.ts');
    const msgs = listMessagesBySession(db, result.sessionId);
    const toolResultMsg = msgs.find((m) => m.role === 'user' && Array.isArray(m.content));
    expect(toolResultMsg).toBeDefined();
    const blocks = toolResultMsg?.content as { tool_use_id: string; is_error?: boolean }[];
    // tu3 was never reached by the loop — the bail synthesizes its result.
    expect(blocks.map((b) => b.tool_use_id).sort()).toEqual(['tu1', 'tu2', 'tu3']);
    expect(blocks.every((b) => b.is_error === true)).toBe(true);
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
    // Rates are dollars-per-million tokens.
    // Turn 1: 100×3 + 20×15 + 50×3.75 = 300 + 300 + 187.5 = 787.5 → /1e6 = 0.0007875
    // Turn 2: 200×3 + 40×15 = 600 + 600 = 1200 → /1e6 = 0.0012
    // Total: 0.0019875
    expect(result.costUsd).toBeCloseTo(0.0019875, 9);

    const session = getSession(db, result.sessionId);
    expect(session?.totalCostUsd).toBeCloseTo(0.0019875, 9);
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
    // 50×3 + 10×15 = 300 → /1e6 = 0.0003
    expect(assistant?.costUsd).toBeCloseTo(0.0003, 9);
  });

  test('budget.maxCostUsd: aborts after a turn pushes cumulative cost over the cap', async () => {
    // Each turn costs (50×3 + 10×15) / 1e6 = $0.0003. Cap at
    // $0.0004 → first turn lands cleanly (total 0.0003 ≤ cap),
    // second turn pushes total to 0.0006 (> cap) and the loop
    // exits with maxCostUsd. The exhausted status maps to exit
    // code 2 (same shape as maxSteps).
    const { config } = buildConfig(
      [
        {
          tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'hi' } }],
          stop_reason: 'tool_use',
          usage: { input: 50, output: 10 },
        },
        { text: 'done', stop_reason: 'end_turn', usage: { input: 50, output: 10 } },
      ],
      {
        capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 },
        budget: { maxCostUsd: 0.0004 },
      },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('exhausted');
    expect(result.reason).toBe('maxCostUsd');
    expect(result.detail).toContain('exceeded cap');
    // Cumulative reflects both turns' spend at the moment the
    // cap tripped, not just the cap value.
    expect(result.costUsd).toBeCloseTo(0.0006, 9);
  });

  test('budget.maxCostUsd: undefined (default) keeps the cap off', async () => {
    // Sanity guard: an absent maxCostUsd must not silently
    // introduce a cap of 0 (which would abort every paid run).
    const { config } = buildConfig(
      [{ text: 'done', stop_reason: 'end_turn', usage: { input: 1000, output: 500 } }],
      {
        capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 },
        // No budget.maxCostUsd.
      },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
  });

  test('budget.maxCostUsd: resumed session already over cap exits BEFORE any provider call', async () => {
    // Regression: the cap was only checked after a turn / compaction
    // landed cost on the totals. A resumed session whose row already
    // had totalCostUsd > cap would still issue one billed provider
    // call before the post-turn check fired. The pre-call gate at
    // the top of the loop closes that — `script: []` means the mock
    // throws on any call, so the test would fail loudly if a call
    // sneaked through.
    //
    // Run #1 — leaves the session with $0.0006 of cumulative spend.
    const first = buildConfig(
      [{ text: 'A', stop_reason: 'end_turn', usage: { input: 100, output: 20 } }],
      { capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 } },
    );
    const r1 = await runAgent(first.config);
    expect(r1.status).toBe('done');
    expect(r1.costUsd).toBeCloseTo(0.0006, 9);

    // Run #2 (resume) — cap is $0.0001, prior is already $0.0006.
    // The mock script is EMPTY: any provider call throws "mock
    // script exhausted" and the test would fail with a different
    // status/reason. The pre-call gate must short-circuit before
    // generate() is invoked.
    const second = buildConfig([], {
      capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 },
      budget: { maxCostUsd: 0.0001 },
    });
    const r2 = await runAgent({ ...second.config, resumeFromSessionId: r1.sessionId });
    expect(r2.status).toBe('exhausted');
    expect(r2.reason).toBe('maxCostUsd');
    expect(r2.steps).toBe(0); // no step started, no provider call
    expect(r2.costUsd).toBe(0); // per-run is empty
    expect(second.handle.requests).toHaveLength(0);
    // Persisted row reflects unchanged cumulative ($0.0006 from run #1).
    const session = getSession(db, r1.sessionId);
    expect(session?.totalCostUsd).toBeCloseTo(0.0006, 9);
  });

  test('resume over threshold compacts BEFORE the first turn (top-of-loop trigger)', async () => {
    // Run #1 builds an 8-message history (userPrompt + 3 tool turns + a text
    // turn). Run #2 resumes it with a tiny window + low threshold, so the
    // RESTORED history is already over threshold: maybeCompact must fire at the
    // top of the loop, before the first turn's provider call. The old
    // post-tool-result-only trigger missed this — the first call shipped the
    // full restored history and would 400 on a real provider.
    const first = buildConfig([
      { tool_uses: [{ id: 't1', name: 'echo', input: { msg: 'a' } }], stop_reason: 'tool_use' },
      { tool_uses: [{ id: 't2', name: 'echo', input: { msg: 'b' } }], stop_reason: 'tool_use' },
      { tool_uses: [{ id: 't3', name: 'echo', input: { msg: 'c' } }], stop_reason: 'tool_use' },
      { text: 'done', stop_reason: 'end_turn' },
    ]);
    const r1 = await runAgent(first.config);
    expect(r1.status).toBe('done');

    const events: string[] = [];
    const second = buildConfig(
      [
        { text: 'GOAL: x\nDECISIONS: y', stop_reason: 'end_turn' }, // consumed by the summary call
        { text: 'ok', stop_reason: 'end_turn' }, // the actual turn
      ],
      // preserveTail pinned so the shrink assertion below is deterministic
      // regardless of the default K (a large default would collapse the middle
      // and make compactMessages 'skip', leaving the history un-shrunk).
      {
        capsOverride: { context_window: 100 },
        budget: { compactionThreshold: 0.01, compactionPreserveTail: 2 },
      },
    );
    const r2 = await runAgent({
      ...second.config,
      resumeFromSessionId: r1.sessionId,
      onEvent: (e) => {
        events.push(e.type);
      },
    });
    expect(r2.status).toBe('done');
    const startedAt = events.indexOf('compaction_started');
    const firstStepAt = events.indexOf('step_start');
    expect(startedAt).toBeGreaterThanOrEqual(0); // compaction happened on resume
    expect(startedAt).toBeLessThan(firstStepAt); // and BEFORE the first turn
    // Correctness, not just ordering: the compaction actually shrank the
    // history the first real turn sees — the post-compaction request carries
    // far fewer messages than the ~9 restored (8 persisted + the new prompt).
    // This is also the "first call has no prior tool_result this run" case the
    // old post-tool-result-only trigger could never reach.
    const turnReq = second.handle.requests.at(-1);
    if (turnReq === undefined) throw new Error('expected a post-compaction request');
    expect(turnReq.messages.length).toBeLessThan(8);
  });

  // Build a resumable session whose restored history is big and over a
  // crossable threshold, with elidable low-relevance tool_results — so the
  // relevance pre-pass alone can drop it under the threshold.
  const PIN_TEXT = 'CONSTRAINT: never change the public API of module X';
  const buildBigPinnableSession = async (): Promise<string> => {
    // Distinct `n` per call avoids the maxRepeatedToolHash degenerate-loop
    // backstop; each `big` result is large + low-relevance to the goal.
    const first = buildConfig(
      [
        { tool_uses: [{ id: 't1', name: 'big', input: { n: 1 } }], stop_reason: 'tool_use' },
        { tool_uses: [{ id: 't2', name: 'big', input: { n: 2 } }], stop_reason: 'tool_use' },
        { tool_uses: [{ id: 't3', name: 'big', input: { n: 3 } }], stop_reason: 'tool_use' },
        { text: 'done', stop_reason: 'end_turn' },
      ],
      // Huge window so r1 just BUILDS the big context without compacting; r2's
      // tiny window is what trips the threshold on resume.
      { capsOverride: { context_window: 1_000_000 }, extraTools: [bigOutputTool] },
    );
    const r1 = await runAgent(first.config);
    expect(r1.status).toBe('done');
    return r1.sessionId;
  };

  // Minimal memoryRegistry so the relevance pre-pass's availability gate passes
  // — the harness wires retrieve_context (the elided body's recovery path) only
  // when memoryRegistry is present. The pre-pass never calls the registry; only
  // its presence matters, so empty roots suffice.
  const makeMemoryRegistry = async () => {
    const { mkdirSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createMemoryRegistry } = await import('../../src/memory/registry.ts');
    const repo = mkdtempSync(join(tmpdir(), 'forja-relevance-mem-'));
    const roots = {
      user: join(repo, 'u'),
      projectShared: join(repo, 's'),
      projectLocal: join(repo, 'l'),
    };
    for (const d of Object.values(roots)) mkdirSync(d, { recursive: true });
    return createMemoryRegistry({ roots });
  };

  test('relevance pre-pass short-circuits a pin-free compaction (baseline for the pin guard)', async () => {
    const sessionId = await buildBigPinnableSession();
    const events: import('../../src/harness/types.ts').HarnessEvent[] = [];
    const second = buildConfig([{ text: 'turn done', stop_reason: 'end_turn' }], {
      capsOverride: { context_window: 8000 },
      budget: { compactionThreshold: 0.3, compactionPreserveTail: 1, compactionRelevance: true },
    });
    const memoryRegistry = await makeMemoryRegistry();
    await runAgent({
      ...second.config,
      resumeFromSessionId: sessionId,
      memoryRegistry,
      onEvent: (e) => events.push(e),
    });
    const fin = events.find((e) => e.type === 'compaction_finished');
    if (fin?.type !== 'compaction_finished') throw new Error('expected compaction_finished');
    // No pins → relevance alone drops under the threshold → no billed LLM fold.
    expect(fin.strategy).toBe('relevance');
  });

  test('relevance compaction with an active pin falls through to the LLM fold so the pin survives', async () => {
    const sessionId = await buildBigPinnableSession();
    // The pin contract is "survives compaction" — re-injected into the goal
    // only by ctx.compact's pinnedBlock path, which the relevance short-circuit
    // would bypass (leaving the pin to vanish once its carrier is elided).
    createPin(db, { sessionId, text: PIN_TEXT, kind: 'constraint', createdBy: 'model' });
    const events: import('../../src/harness/types.ts').HarnessEvent[] = [];
    const second = buildConfig(
      [
        { text: '[compacted_history]\nprior work\n[/compacted_history]', stop_reason: 'end_turn' },
        { text: 'turn done', stop_reason: 'end_turn' },
      ],
      {
        capsOverride: { context_window: 8000 },
        budget: { compactionThreshold: 0.3, compactionPreserveTail: 1, compactionRelevance: true },
      },
    );
    const memoryRegistry = await makeMemoryRegistry();
    await runAgent({
      ...second.config,
      resumeFromSessionId: sessionId,
      memoryRegistry,
      onEvent: (e) => events.push(e),
    });
    const fin = events.find((e) => e.type === 'compaction_finished');
    if (fin?.type !== 'compaction_finished') throw new Error('expected compaction_finished');
    // The pin forced the LLM fold instead of the relevance short-circuit...
    expect(fin.strategy).not.toBe('relevance');
    // ...so it is re-injected and survives into the post-compaction request.
    const turnReq = second.handle.requests.at(-1);
    if (turnReq === undefined) throw new Error('expected a post-compaction request');
    expect(JSON.stringify(turnReq.messages)).toContain(PIN_TEXT);
  });

  test('reuse: sessionContext is mutually exclusive with resumeFromSessionId', async () => {
    const t1 = buildConfig([{ text: 'a', stop_reason: 'end_turn' }]);
    const r1 = await runAgent(t1.config);
    const ctx = r1.sessionContext;
    if (ctx === undefined) throw new Error('expected a context');
    const t2 = buildConfig([{ text: 'b', stop_reason: 'end_turn' }]);
    const r2 = await runAgent({
      ...t2.config,
      sessionContext: ctx,
      resumeFromSessionId: r1.sessionId,
    });
    expect(r2.status).toBe('error');
    expect(r2.detail ?? '').toContain('mutually exclusive');
  });

  test('reuse: turn 2 keeps the SAME context object and appends onto it', async () => {
    // The core of compact-once-reuse: turn 2 with sessionContext reuses the
    // live array in place — it does NOT rebuild a new one from the DB.
    const t1 = buildConfig([{ text: 'a', stop_reason: 'end_turn' }]);
    const r1 = await runAgent(t1.config);
    const ctx = r1.sessionContext;
    expect(ctx).toBeDefined();
    if (ctx === undefined) return;
    const lenAfterT1 = ctx.length; // userPrompt 'hi' + assistant 'a' = 2

    const t2 = buildConfig([{ text: 'b', stop_reason: 'end_turn' }]);
    const r2 = await runAgent({ ...t2.config, sessionContext: ctx });
    expect(r2.sessionContext).toBe(ctx); // same object — reused, not rebuilt
    expect(ctx.length).toBe(lenAfterT1 + 2); // turn 2 appended user + assistant
  });

  test('reuse does NOT re-derive from the DB log', async () => {
    const t1 = buildConfig([{ text: 'a', stop_reason: 'end_turn' }]);
    const r1 = await runAgent(t1.config);
    const ctx = r1.sessionContext;
    if (ctx === undefined) throw new Error('expected a context');
    // Inject a stray row the in-memory ctx cannot see. A resume would
    // re-read it from the log; a reuse must not.
    appendMessage(db, {
      sessionId: r1.sessionId,
      role: 'user',
      content: 'STRAY-FROM-DB',
      parentId: ctx.getLastMessageId(),
    });

    const t2 = buildConfig([{ text: 'b', stop_reason: 'end_turn' }]);
    await runAgent({ ...t2.config, sessionContext: ctx });
    const req2 = t2.handle.requests[0];
    const hasStray = req2?.messages.some(
      (m) => typeof m.content === 'string' && m.content.includes('STRAY-FROM-DB'),
    );
    expect(hasStray).toBe(false); // turn 2 saw the in-memory ctx, not the DB
  });

  test('reuse of a post-abort context (orphaned tool_use) is repaired before the next turn', async () => {
    // The exact state an abort mid-tool leaves: tail is an assistant
    // tool_use with no tool_result (the loop's abort paths exit before
    // appendToolResults). Build that shape, then reuse it — without the
    // repair the next turn's request carries an unanswered tool_use and 400s
    // every turn until restart. End-to-end regression guard.
    const sessionId = createSession(db, { model: 'mock/m', cwd: '/p' }).id;
    const noUsage: AssistantUsage = {
      usageSeen: false,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheCreation: 0,
      costUsd: 0,
    };
    const ctx = SessionContext.createFresh(db, sessionId);
    ctx.appendUser('hi', null);
    ctx.appendAssistant(
      [{ type: 'tool_use', id: 'tu1', name: 'echo', input: { msg: 'a' } }],
      noUsage,
      null,
    );

    const t = buildConfig([{ text: 'ok', stop_reason: 'end_turn' }]);
    const r = await runAgent({ ...t.config, sessionContext: ctx });
    expect(r.status).toBe('done'); // did not wedge

    // The request the provider actually saw answers tu1 (orphan repaired).
    const req = t.handle.requests[0];
    const answered = req?.messages.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'tu1'),
    );
    expect(answered).toBe(true);
  });

  test('budget.maxCostUsd: cumulative across resume (prior cost counts)', async () => {
    // Resume contract: session row stores cumulative cost; cap
    // compares against priorCostUsd + totalCostUsd. A session that
    // already spent $0.0003 with cap $0.0004 has $0.0001 of head-
    // room — a single follow-up turn at $0.0003 trips immediately.
    // Without this behavior, a budget-conscious user resuming a
    // run with a spend cap would silently exceed it.

    // Run #1 — leaves the session with $0.0003 of cumulative spend.
    const first = buildConfig(
      [{ text: 'first', stop_reason: 'end_turn', usage: { input: 50, output: 10 } }],
      { capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 } },
    );
    const r1 = await runAgent(first.config);
    expect(r1.status).toBe('done');
    expect(r1.costUsd).toBeCloseTo(0.0003, 9);

    // Run #2 (resume) — cap is $0.0004; one $0.0003 turn pushes
    // cumulative to $0.0006 and trips the gate. Per-run costUsd
    // is $0.0003 (just this run's spend), not cumulative — cap
    // detail surfaces the cumulative figure.
    const second = buildConfig(
      [{ text: 'second', stop_reason: 'end_turn', usage: { input: 50, output: 10 } }],
      {
        capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 },
        budget: { maxCostUsd: 0.0004 },
      },
    );
    const r2 = await runAgent({ ...second.config, resumeFromSessionId: r1.sessionId });
    expect(r2.status).toBe('exhausted');
    expect(r2.reason).toBe('maxCostUsd');
    // Per-run is current spend only; the persisted row holds
    // cumulative.
    expect(r2.costUsd).toBeCloseTo(0.0003, 9);
    expect(r2.detail).toContain('$0.000600'); // cumulative figure
    const session = getSession(db, r1.sessionId);
    expect(session?.totalCostUsd).toBeCloseTo(0.0006, 9);
  });

  test('rehydrated child cost does NOT inflate sessions.totalCostUsd across resumes (D216)', async () => {
    // Regression for D216 — the rehydrated cost from settled
    // `subagent_handles` rows must enter the budget gate but
    // MUST NOT be folded into the persisted parent-self cost.
    // Folding it via `priorCostUsd += rehydrated` made finish()
    // re-write the same child spend back to
    // `sessions.totalCostUsd` on every resume; after N resumes
    // the row showed `parentSelf + N * childTotal` even when no
    // new work ran, eventually tripping `maxCostUsd`
    // prematurely.
    //
    // The fix splits the two: `priorCostUsd` is parent-self
    // only (round-tripped through the column); a separate
    // `rehydratedChildCostUsd` is added to gate cumulatives but
    // not to the persisted total.
    const definition: SubagentDefinition = {
      name: 'explore',
      description: 'fixture',
      tools: [],
      budget: { maxSteps: 5, maxCostUsd: 0.05 },
      systemPrompt: 'fixture',
      scope: 'project',
      isolation: 'none',
      sourcePath: '/fake/explore.md',
      sourceSha256: 'a'.repeat(64),
      meta: {},
    };
    const subagentRegistry: SubagentSet = {
      byName: new Map([['explore', definition]]),
      shadows: [],
    };
    // Run #1 — parent-self spend $0.0006. No subagent calls;
    // we'll seed the settled handle directly to keep the test
    // small.
    const first = buildConfig(
      [{ text: 'one', stop_reason: 'end_turn', usage: { input: 100, output: 20 } }],
      { capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 } },
    );
    const r1 = await runAgent({ ...first.config, subagentRegistry });
    expect(r1.status).toBe('done');
    expect(r1.costUsd).toBeCloseTo(0.0006, 9);
    const sessionAfterRun1 = getSession(db, r1.sessionId);
    expect(sessionAfterRun1?.totalCostUsd).toBeCloseTo(0.0006, 9);

    // Seed a settled subagent_handles row tied to the run #1
    // session, with a non-zero child cost ($0.04). Mirrors the
    // shape `runSubagent` settles via task_async →
    // settleSubagentHandle.
    db.query(
      `INSERT INTO subagent_handles
         (handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at)
       VALUES (?, ?, ?, ?, ?, 'settled', ?, ?)`,
    ).run(
      'h-prior',
      r1.sessionId,
      'child-prior',
      'explore',
      Date.now() - 10_000,
      JSON.stringify({
        kind: 'ran',
        output: 'prior',
        sessionId: 'child-prior',
        status: 'done',
        reason: 'done',
        costUsd: 0.04,
        steps: 1,
        durationMs: 50,
      }),
      Date.now() - 10_000,
    );

    // Run #2 (resume) — single text turn, $0.0003 cost. With
    // the bug, finish() would persist (priorCostUsd + child) +
    // turn = (0.0006 + 0.04) + 0.0003 = $0.0409 to
    // sessions.totalCostUsd. With the fix, persistence is
    // priorCostUsd-only: 0.0006 + 0.0003 = $0.0009. The
    // rehydrated $0.04 stays out of the column.
    const second = buildConfig(
      [{ text: 'two', stop_reason: 'end_turn', usage: { input: 50, output: 10 } }],
      { capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 } },
    );
    const r2 = await runAgent({
      ...second.config,
      resumeFromSessionId: r1.sessionId,
      subagentRegistry,
    });
    expect(r2.status).toBe('done');
    expect(r2.costUsd).toBeCloseTo(0.0003, 9);
    const sessionAfterRun2 = getSession(db, r1.sessionId);
    expect(sessionAfterRun2?.totalCostUsd).toBeCloseTo(0.0009, 9);

    // Run #3 (resume again) — same shape, $0.0003 cost. With
    // the bug, the row would now hold (0.0006 + 0.04 + 0.0003)
    // + 0.04 + 0.0003 = $0.0812 — child cost compounding once
    // per resume. With the fix, it's still parent-self only:
    // 0.0009 + 0.0003 = $0.0012.
    const third = buildConfig(
      [{ text: 'three', stop_reason: 'end_turn', usage: { input: 50, output: 10 } }],
      { capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 } },
    );
    const r3 = await runAgent({
      ...third.config,
      resumeFromSessionId: r1.sessionId,
      subagentRegistry,
    });
    expect(r3.status).toBe('done');
    const sessionAfterRun3 = getSession(db, r1.sessionId);
    expect(sessionAfterRun3?.totalCostUsd).toBeCloseTo(0.0012, 9);
  });

  test('rehydrated child cost still enters the budget gate on resume (D216)', async () => {
    // Counterpart to D216 — the fix must not regress the gate.
    // Even though the rehydrated child cost is no longer
    // persisted into `sessions.totalCostUsd`, the cap check
    // must still see it. Otherwise a resumed run could burn
    // through the cap a second time on a fresh subagent_handles
    // row that the previous run left settled.
    const definition: SubagentDefinition = {
      name: 'explore',
      description: 'fixture',
      tools: [],
      budget: { maxSteps: 5, maxCostUsd: 0.05 },
      systemPrompt: 'fixture',
      scope: 'project',
      isolation: 'none',
      sourcePath: '/fake/explore.md',
      sourceSha256: 'a'.repeat(64),
      meta: {},
    };
    const subagentRegistry: SubagentSet = {
      byName: new Map([['explore', definition]]),
      shadows: [],
    };
    // Run #1 — parent-self $0.0006.
    const first = buildConfig(
      [{ text: 'one', stop_reason: 'end_turn', usage: { input: 100, output: 20 } }],
      { capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 } },
    );
    const r1 = await runAgent({ ...first.config, subagentRegistry });
    expect(r1.status).toBe('done');
    // Seed prior child cost = $0.04. Combined with the
    // parent-self $0.0006, total cumulative = $0.0406. A cap of
    // $0.001 must trip at the pre-call gate.
    db.query(
      `INSERT INTO subagent_handles
         (handle_id, parent_session_id, child_session_id, name, spawned_at, status, settled_payload, created_at)
       VALUES (?, ?, ?, ?, ?, 'settled', ?, ?)`,
    ).run(
      'h-prior',
      r1.sessionId,
      'child-prior',
      'explore',
      Date.now() - 10_000,
      JSON.stringify({
        kind: 'ran',
        output: 'prior',
        sessionId: 'child-prior',
        status: 'done',
        reason: 'done',
        costUsd: 0.04,
        steps: 1,
        durationMs: 50,
      }),
      Date.now() - 10_000,
    );

    // Run #2 (resume) — empty mock script, cap $0.001. The
    // rehydrated $0.04 alone exceeds the cap, so the pre-call
    // gate must short-circuit BEFORE any provider call.
    const second = buildConfig([], {
      capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 },
      budget: { maxCostUsd: 0.001 },
    });
    const r2 = await runAgent({
      ...second.config,
      resumeFromSessionId: r1.sessionId,
      subagentRegistry,
    });
    expect(r2.status).toBe('exhausted');
    expect(r2.reason).toBe('maxCostUsd');
    expect(r2.steps).toBe(0);
    expect(second.handle.requests).toHaveLength(0);
  });

  test('budget.maxCostUsd=0 trips on the first paid turn', async () => {
    // Zero is a literal cap, not "no cap". The first turn that
    // costs anything pushes total above zero and the gate fires.
    // Useful for free-runs-only configs (eval against a mocked
    // provider, hard refusal of accidental spend).
    const { config } = buildConfig(
      [{ text: 'done', stop_reason: 'end_turn', usage: { input: 1, output: 1 } }],
      {
        capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 },
        budget: { maxCostUsd: 0 },
      },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('exhausted');
    expect(result.reason).toBe('maxCostUsd');
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

  test('softCostUsd emits cost_soft_cap_warn ONCE when cumulative crosses the threshold', async () => {
    // Spec ORCHESTRATION.md §3.5.0. Two turns; first turn pushes
    // cumulative below threshold, second turn pushes it above.
    // The warn event must fire exactly once, even though the
    // emitCostUpdate callback runs every turn.
    const events: import('../../src/harness/types.ts').HarnessEvent[] = [];
    // Cost formula divides token*rate by 1M, so usage * 1000 here keeps
    // the per-turn cost in human-readable cents (~$0.06 per turn).
    const { config } = buildConfig(
      [
        // Turn 1: ~$0.06 cumulative (below 0.10 threshold)
        {
          tool_uses: [{ id: 't1', name: 'echo', input: { msg: 'a' } }],
          stop_reason: 'tool_use',
          usage: { input: 10_000, output: 2_000 },
        },
        // Turn 2: ~$0.12 cumulative (CROSSES 0.10 threshold)
        {
          tool_uses: [{ id: 't2', name: 'echo', input: { msg: 'b' } }],
          stop_reason: 'tool_use',
          usage: { input: 10_000, output: 2_000 },
        },
        // Turn 3: ~$0.18 cumulative (already warned — must NOT re-emit)
        { text: 'done', stop_reason: 'end_turn', usage: { input: 10_000, output: 2_000 } },
      ],
      {
        capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 },
      },
    );
    const softThreshold = 0.1;
    const result = await runAgent({
      ...config,
      budget: { softCostUsd: softThreshold },
      onEvent: (e) => events.push(e),
    });
    const warns = events.filter((e) => e.type === 'cost_soft_cap_warn');
    expect(warns.length).toBe(1);
    if (warns[0]?.type === 'cost_soft_cap_warn') {
      expect(warns[0].threshold).toBe(softThreshold);
      expect(warns[0].cumulative).toBeGreaterThan(softThreshold);
    }
    // Run completed normally — soft cap does NOT terminate.
    expect(result.status).toBe('done');
  });

  test('softCostUsd does NOT emit when cumulative stays below the threshold', async () => {
    const events: import('../../src/harness/types.ts').HarnessEvent[] = [];
    const { config } = buildConfig(
      [{ text: 'hi', stop_reason: 'end_turn', usage: { input: 10, output: 2 } }],
      { capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 } },
    );
    await runAgent({
      ...config,
      // Threshold above the entire run's cost.
      budget: { softCostUsd: 100.0 },
      onEvent: (e) => events.push(e),
    });
    expect(events.find((e) => e.type === 'cost_soft_cap_warn')).toBeUndefined();
  });

  test('softCostUsd absent (or 0) suppresses the warn entirely', async () => {
    const events: import('../../src/harness/types.ts').HarnessEvent[] = [];
    const { config } = buildConfig(
      [{ text: 'hi', stop_reason: 'end_turn', usage: { input: 10, output: 2 } }],
      { capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 } },
    );
    await runAgent({
      ...config,
      // No softCostUsd → no warn, ever.
      onEvent: (e) => events.push(e),
    });
    expect(events.find((e) => e.type === 'cost_soft_cap_warn')).toBeUndefined();
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

  test('model_context_window_exceeded exits as exhausted/maxContextTokens (not done)', async () => {
    // Provider stopped because input + output exhausted the context window.
    // Like max_tokens this is a truncated turn, but a distinct exit reason:
    // the fix is to shrink input / compact, not raise the output cap.
    const { config } = buildConfig([
      { text: 'partial answer', stop_reason: 'model_context_window_exceeded' },
    ]);
    const result = await runAgent(config);
    expect(result.status).toBe('exhausted');
    expect(result.reason).toBe('maxContextTokens');
    expect(result.detail).toContain('model_context_window_exceeded');
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
    // Hard signal aborted mid-provider-stream: cause is 'hard' even
    // though the abort was caught from inside the provider SDK error.
    expect(result.abortCause).toBe('hard');
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
    // Rates are $/1M. 300 × 1.0 + 50 × 2.0 = 400 → /1e6 = 0.0004
    expect(finished.costUsd).toBeCloseTo(0.0004, 9);
    expect(finished.usage.input).toBe(300);
    expect(finished.usage.output).toBe(50);

    // Session totals must include compaction + every agent turn
    // that reported usage. Pricing: input=$1/M, output=$2/M.
    // turn 1 (echo): 50+5×2 = 60 → 0.000060
    // turn 2 (fat):  50+5×2 = 60 → 0.000060
    // compaction:    300+50×2 = 400 → 0.000400
    // post-comp:     100+5×2  = 110 → 0.000110
    // total: 0.000630
    expect(result.usage.input).toBe(50 * 2 + 300 + 100);
    expect(result.usage.output).toBe(5 * 2 + 50 + 5);
    expect(result.costUsd).toBeCloseTo(0.00063, 9);
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

  test('partial usage emitted before stream throw is folded into session totals', async () => {
    // Regression: when the provider stream throws after a usage
    // event was already emitted (adapters yield from finally on
    // disconnect), the harness used to discard the partial. The
    // turn was billed but cost tracking missed it. Now
    // CollectStepError carries the partial and we fold it.
    const partialProvider: Provider = {
      id: 'mock/partial',
      family: 'anthropic',
      capabilities: {
        tools: 'native',
        cache: false,
        vision: false,
        streaming: true,
        constrained: 'tools',
        context_window: 100_000,
        output_max_tokens: 4096,
        cost_per_1k_input: 1.0,
        cost_per_1k_output: 2.0,
        notes: [],
      },
      async *generate() {
        yield { kind: 'start', message_id: 'm' };
        yield {
          kind: 'usage',
          usage: { input: 200, output: 30, cache_read: 0, cache_creation: 0 },
        };
        throw new Error('connection reset');
      },
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };
    const result = await runAgent({
      provider: partialProvider,
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
    });
    expect(result.reason).toBe('providerError');
    // Rates are $/1M. 200 × 1 + 30 × 2 = 260 → /1e6 = 0.00026
    expect(result.usage.input).toBe(200);
    expect(result.usage.output).toBe(30);
    expect(result.costUsd).toBeCloseTo(0.00026, 9);
    // Still incomplete because the turn errored.
    expect(result.usageComplete).toBe(false);
  });

  test('stream throw without prior usage event leaves totals empty', async () => {
    // Symmetric guard: if the stream throws BEFORE emitting any
    // usage event, the partial is empty and totals stay zero.
    // No phantom charge; usageComplete still false.
    const noUsageProvider: Provider = {
      id: 'mock/no-usage',
      family: 'anthropic',
      capabilities: {
        tools: 'native',
        cache: false,
        vision: false,
        streaming: true,
        constrained: 'tools',
        context_window: 100_000,
        output_max_tokens: 4096,
        cost_per_1k_input: 1.0,
        cost_per_1k_output: 2.0,
        notes: [],
      },
      async *generate() {
        yield { kind: 'start', message_id: 'm' };
        throw new Error('upstream gone');
      },
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };
    const result = await runAgent({
      provider: noUsageProvider,
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
    });
    expect(result.reason).toBe('providerError');
    expect(result.usage).toEqual({ input: 0, output: 0, cache_read: 0, cache_creation: 0 });
    expect(result.costUsd).toBe(0);
    expect(result.usageComplete).toBe(false);
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

  test('guardedFinish remaps aborted exceptions to reason=aborted with cause=hard (1.g.2)', async () => {
    // Pre-1.g.2 behavior: a SQLite write failing because signal.aborted
    // mid-flight was caught and reported as `internalError` — looked
    // like a harness bug instead of operator-initiated termination.
    // Now: guardedFinish detects signal.aborted at throw time and
    // routes to finish('aborted', ..., 'hard'). Forces this path by
    // closing the DB AND pre-aborting the signal so the init throw
    // lands while signal is aborted.
    const ctrl = new AbortController();
    ctrl.abort();
    db.close();
    const { config } = buildConfig([{ text: 'never reached', stop_reason: 'end_turn' }], {
      signal: ctrl.signal,
    });
    const result = await runAgent(config);
    expect(result.reason).toBe('aborted');
    expect(result.abortCause).toBe('hard');
  });

  describe('preassignedSessionId', () => {
    test('happy path: caller-created row is used directly, sessionId matches', async () => {
      // The 4.2b.ii subprocess flow needs the harness to run
      // against a session row the caller created upfront — the
      // FK targets in subagent_runs / subagent_worktrees can only
      // resolve when the row exists at spawn time, not after
      // runAgent returns. The harness must skip its own
      // createSession on this path.
      const pre = await import('../../src/storage/repos/sessions.ts');
      const seeded = pre.createSession(db, { model: 'mock/m', cwd: '/p' });
      const { config } = buildConfig([{ text: 'used preassigned', stop_reason: 'end_turn' }]);
      const result = await runAgent({ ...config, preassignedSessionId: seeded.id });
      expect(result.status).toBe('done');
      expect(result.sessionId).toBe(seeded.id);
      // No new session was created; the count stays at 1.
      expect(listSessions(db, {}).length).toBe(1);
    });

    test('rejects when no row exists for the preassigned id', async () => {
      const { config } = buildConfig([{ text: 'never', stop_reason: 'end_turn' }]);
      const result = await runAgent({
        ...config,
        preassignedSessionId: 'nonexistent-id',
      });
      // Init failure routes through guardedFinish; the surface
      // is internalError.
      expect(result.status).toBe('error');
      expect(result.reason).toBe('internalError');
    });

    test('rejects when row cwd diverges from config cwd', async () => {
      // Mirrors the resume-path cwd check. Relative paths in
      // messages must resolve consistently between row and runtime.
      const pre = await import('../../src/storage/repos/sessions.ts');
      const seeded = pre.createSession(db, { model: 'mock/m', cwd: '/different' });
      const { config } = buildConfig([{ text: 'never', stop_reason: 'end_turn' }]);
      const result = await runAgent({ ...config, preassignedSessionId: seeded.id });
      expect(result.status).toBe('error');
      expect(result.reason).toBe('internalError');
    });

    test('rejects when row is already finalized (status != running)', async () => {
      // Defense: reusing a finalized row would silently overwrite
      // its terminal status and append messages past the
      // completed turn. Caller must always preassign a fresh row.
      const pre = await import('../../src/storage/repos/sessions.ts');
      const seeded = pre.createSession(db, { model: 'mock/m', cwd: '/p' });
      pre.completeSession(db, seeded.id, 'done', 0, true);
      const { config } = buildConfig([{ text: 'never', stop_reason: 'end_turn' }]);
      const result = await runAgent({ ...config, preassignedSessionId: seeded.id });
      expect(result.status).toBe('error');
      expect(result.reason).toBe('internalError');
    });

    test('rejects when both resumeFromSessionId and preassignedSessionId are set', async () => {
      // Mutually exclusive contract — setting both is a
      // programmer bug; failing loud is better than guessing
      // intent.
      const pre = await import('../../src/storage/repos/sessions.ts');
      const seeded = pre.createSession(db, { model: 'mock/m', cwd: '/p' });
      const { config } = buildConfig([{ text: 'never', stop_reason: 'end_turn' }]);
      const result = await runAgent({
        ...config,
        resumeFromSessionId: seeded.id,
        preassignedSessionId: seeded.id,
      });
      expect(result.status).toBe('error');
      expect(result.reason).toBe('internalError');
    });
  });

  describe('sampling forwarded to provider request', () => {
    test('temperature is forwarded when set', async () => {
      const { config, handle } = buildConfig([{ text: 'ok', stop_reason: 'end_turn' }]);
      await runAgent({ ...config, temperature: 0.2 });
      expect(handle.requests[0]?.temperature).toBe(0.2);
    });

    test('temperature absent leaves the field off the request', async () => {
      const { config, handle } = buildConfig([{ text: 'ok', stop_reason: 'end_turn' }]);
      await runAgent(config);
      expect(handle.requests[0]?.temperature).toBeUndefined();
    });

    test('topP is forwarded as top_p', async () => {
      // The harness's HarnessConfig field is camelCase (`topP`)
      // matching TS convention; the GenerateRequest field is
      // snake_case (`top_p`) matching the provider wire format.
      // The mapping happens in `loop.ts`; this test pins it.
      const { config, handle } = buildConfig([{ text: 'ok', stop_reason: 'end_turn' }]);
      await runAgent({ ...config, topP: 0.9 });
      expect(handle.requests[0]?.top_p).toBe(0.9);
    });

    test('thinkingBudget is forwarded as thinking_budget', async () => {
      // Mirror of topP: the per-call extended-thinking budget
      // travels from `HarnessConfig.thinkingBudget` to
      // `GenerateRequest.thinking_budget`. Adapter-level
      // mapping (e.g. Anthropic's `thinking: { type:'enabled',
      // budget_tokens }`) is the provider's concern; this test
      // covers only the harness-side wire.
      const { config, handle } = buildConfig([{ text: 'ok', stop_reason: 'end_turn' }]);
      await runAgent({ ...config, thinkingBudget: 4000 });
      expect(handle.requests[0]?.thinking_budget).toBe(4000);
    });

    test('all three sampling fields compose on a single request', async () => {
      const { config, handle } = buildConfig([{ text: 'ok', stop_reason: 'end_turn' }]);
      await runAgent({
        ...config,
        temperature: 0.1,
        topP: 0.95,
        thinkingBudget: 2048,
      });
      const req = handle.requests[0];
      expect(req).toBeDefined();
      if (req === undefined) return;
      expect(req.temperature).toBe(0.1);
      expect(req.top_p).toBe(0.95);
      expect(req.thinking_budget).toBe(2048);
    });
  });

  // Slice 111 — R10 #48: SandboxDegradedActiveEvent was declared
  // and scrubbing handler existed (slice 92), but the harness
  // loop only emitted to config.onEvent — the §18 telemetry pipe
  // was unwired. Slice 111 adds `telemetry?: TelemetrySink` to
  // HarnessConfig and threads it through the degraded-banner
  // onFire callback.
  describe('telemetry sink — sandbox.degraded_active emission (slice 111, R10 #48)', () => {
    test('emits to telemetry sink when engine is degraded and a tool call fires', async () => {
      // Setup: a degraded engine + a recording telemetry sink.
      // The script triggers a tool call (echo); the harness's
      // pre-call degradedBannerEmitter fires; onFire wires both
      // config.onEvent and config.telemetry.emit.
      const { createRecordingTelemetrySink } = await import('../../src/telemetry/index.ts');
      const sink = createRecordingTelemetrySink();
      const engine = createPermissionEngine(policy({ tools: { bash: { allow: ['*'] } } }), {
        cwd: '/p',
        initialState: 'degraded',
      });

      const handle = mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'hi' } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]);
      const registry = createToolRegistry();
      registry.register(echoTool);
      await runAgent({
        provider: handle.provider,
        toolRegistry: registry,
        permissionEngine: engine,
        db,
        cwd: '/p',
        userPrompt: 'hi',
        telemetry: sink,
      });

      // The recording sink received at least one degraded_active
      // event. The banner emitter fires on the first tool call
      // after entering degraded; subsequent calls fire every Nth
      // (default 10). One tool call → one emission.
      const degradedEvents = sink.events().filter((e) => e.kind === 'sandbox.degraded_active');
      expect(degradedEvents.length).toBeGreaterThanOrEqual(1);
      const first = degradedEvents[0];
      if (first === undefined) return;
      expect(first.firstEmission).toBe(true);
      // sessionId is engine-generated UUID; just verify it's a
      // non-empty string (no fixed value to assert).
      expect(typeof first.sessionId).toBe('string');
      expect((first.sessionId as string).length).toBeGreaterThan(0);
    });

    test('does NOT emit when telemetry sink is undefined (no-op default)', async () => {
      // Pre-slice this was the EVERY case — telemetry was always
      // unwired. Post-slice operators who don't pass a sink still
      // see banner events via config.onEvent (the existing path)
      // but no telemetry events fire. Defensive coverage: omitting
      // telemetry must not throw or break the run.
      const engine = createPermissionEngine(policy({ tools: { bash: { allow: ['*'] } } }), {
        cwd: '/p',
        initialState: 'degraded',
      });
      const events: { type: string }[] = [];
      const handle = mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'hi' } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]);
      const registry = createToolRegistry();
      registry.register(echoTool);
      await runAgent({
        provider: handle.provider,
        toolRegistry: registry,
        permissionEngine: engine,
        db,
        cwd: '/p',
        userPrompt: 'hi',
        // No telemetry — verify no throw + banner still fires
        // through onEvent path.
        onEvent: (e) => events.push(e),
      });
      // The harness observer still received the banner.
      const banners = events.filter((e) => e.type === 'sandbox_degraded_active');
      expect(banners.length).toBeGreaterThanOrEqual(1);
    });

    test('sink throw does NOT break the harness loop (defensive try/catch)', async () => {
      // Slice 70's contract: sinks MUST NOT throw. But bugs happen.
      // The harness wraps every emit in try/catch defensively so a
      // broken telemetry sink can't crash the agent session.
      let sinkCalls = 0;
      const throwingSink = {
        emit: () => {
          sinkCalls++;
          throw new Error('synthetic sink throw');
        },
      };
      const engine = createPermissionEngine(policy({ tools: { bash: { allow: ['*'] } } }), {
        cwd: '/p',
        initialState: 'degraded',
      });
      const handle = mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'hi' } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]);
      const registry = createToolRegistry();
      registry.register(echoTool);
      // The run completes despite the throwing sink — no
      // unhandled rejection, no crash.
      const result = await runAgent({
        provider: handle.provider,
        toolRegistry: registry,
        permissionEngine: engine,
        db,
        cwd: '/p',
        userPrompt: 'hi',
        telemetry: throwingSink,
      });
      expect(result.status).toBe('done');
      expect(sinkCalls).toBeGreaterThanOrEqual(1);
    });
  });

  describe('eager-load provenance (S1/T1.4)', () => {
    test('emits one provenance row per eagerExposure after createSession', async () => {
      const handle = mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]);
      const registry = createToolRegistry();
      registry.register(echoTool);
      const result = await runAgent({
        provider: handle.provider,
        toolRegistry: registry,
        permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
        db,
        cwd: '/p',
        userPrompt: 'hi',
        eagerExposures: [
          {
            scope: 'user',
            name: 'role',
            memoryContentHash: 'a'.repeat(64),
            memoryStateAtExposure: 'active',
          },
          {
            scope: 'project_local',
            name: 'commit-style',
            memoryContentHash: 'b'.repeat(64),
            memoryStateAtExposure: 'quarantined',
          },
        ],
      });
      expect(result.status).toBe('done');
      const sessions = listSessions(db);
      const sid = sessions[0]?.id;
      expect(sid).toBeDefined();
      if (sid === undefined) return;
      const roleRows = listProvenanceForMemory(db, sid, 'user', 'role');
      expect(roleRows).toHaveLength(1);
      expect(roleRows[0]?.surface).toBe('eager');
      expect(roleRows[0]?.toolCallId).toBeNull();
      expect(roleRows[0]?.memoryContentHash).toBe('a'.repeat(64));
      expect(roleRows[0]?.memoryStateAtExposure).toBe('active');
      const commitRows = listProvenanceForMemory(db, sid, 'project_local', 'commit-style');
      expect(commitRows).toHaveLength(1);
      expect(commitRows[0]?.memoryStateAtExposure).toBe('quarantined');
    });

    test('empty eagerExposures array emits NO rows', async () => {
      const handle = mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]);
      const registry = createToolRegistry();
      registry.register(echoTool);
      const result = await runAgent({
        provider: handle.provider,
        toolRegistry: registry,
        permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
        db,
        cwd: '/p',
        userPrompt: 'hi',
        eagerExposures: [],
      });
      expect(result.status).toBe('done');
      const sid = listSessions(db)[0]?.id;
      if (sid === undefined) throw new Error('expected a session');
      // No rows for any conceivable (scope, name) pair — sample-check
      // a plausible one to guard against accidental fall-through.
      expect(listProvenanceForMemory(db, sid, 'user', 'whatever')).toEqual([]);
    });

    test('omitted eagerExposures emits NO rows (default path)', async () => {
      const handle = mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]);
      const registry = createToolRegistry();
      registry.register(echoTool);
      const result = await runAgent({
        provider: handle.provider,
        toolRegistry: registry,
        permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
        db,
        cwd: '/p',
        userPrompt: 'hi',
      });
      expect(result.status).toBe('done');
      const sid = listSessions(db)[0]?.id;
      if (sid === undefined) throw new Error('expected a session');
      expect(listProvenanceForMemory(db, sid, 'user', 'role')).toEqual([]);
    });

    test('eager emit is per-key idempotent across resume: pre-existing (scope, name) skips, no duplicate', async () => {
      // Resume path (preassignedSessionId) reuses an existing session
      // row. The eager-emit block in the loop would otherwise re-emit
      // the same (session, memory, eager) rows every restart —
      // schema has no UNIQUE constraint so duplicates pile up. The
      // getEagerProvenanceKeys lookup gates per-key: an exposure
      // whose (scope, name) is already present is skipped; missing
      // ones backfill (see the partial-write test below).
      const { recordProvenance } = await import('../../src/storage/repos/memory-provenance.ts');
      // Pre-create a session and seed an eager row to simulate the
      // "prior boot already emitted" state.
      const session = createSession(db, { model: 'mock/m', cwd: '/p' });
      recordProvenance(db, {
        sessionId: session.id,
        toolCallId: null,
        memoryScope: 'user',
        memoryName: 'role',
        surface: 'eager',
        memoryContentHash: 'pre-existing',
        memoryStateAtExposure: 'active',
      });

      const handle = mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]);
      const registry = createToolRegistry();
      registry.register(echoTool);
      const result = await runAgent({
        provider: handle.provider,
        toolRegistry: registry,
        permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
        db,
        cwd: '/p',
        userPrompt: 'hi',
        preassignedSessionId: session.id,
        eagerExposures: [
          {
            scope: 'user',
            name: 'role',
            memoryContentHash: 'fresh-hash',
            memoryStateAtExposure: 'active',
          },
        ],
      });
      expect(result.status).toBe('done');
      const rows = listProvenanceForMemory(db, session.id, 'user', 'role');
      // Exactly one row remains — the pre-existing one. The resume
      // emit MUST have skipped this (scope, name), so fresh-hash
      // never landed.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.memoryContentHash).toBe('pre-existing');
    });

    test('eager emit resumes partial writes: missing inventory rows backfill on the next run', async () => {
      // Review regression. Pre-fix the loop asked "does ANY eager row
      // exist for this session?" If yes, skip the entire emit. So a
      // previous boot that landed ONE exposure before hitting a
      // transient SQLITE_BUSY trapped the session: the next resume
      // saw the single row, declared "already done", and the missing
      // inventory entries stayed missing forever — even after the DB
      // recovered. Provenance accuracy this feature exists to add
      // gets silently broken.
      //
      // Post-fix the loop reads the SET of recorded (scope, name)
      // keys and emits only the missing ones, so a partial first
      // write recovers on the next resume.
      const { recordProvenance } = await import('../../src/storage/repos/memory-provenance.ts');
      const session = createSession(db, { model: 'mock/m', cwd: '/p' });
      // Simulate the partial-write state: `user/role` landed, but
      // `user/style` did NOT. The next resume's inventory still
      // contains both.
      recordProvenance(db, {
        sessionId: session.id,
        toolCallId: null,
        memoryScope: 'user',
        memoryName: 'role',
        surface: 'eager',
        memoryContentHash: 'role-hash',
        memoryStateAtExposure: 'active',
      });

      const handle = mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]);
      const registry = createToolRegistry();
      registry.register(echoTool);
      const result = await runAgent({
        provider: handle.provider,
        toolRegistry: registry,
        permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
        db,
        cwd: '/p',
        userPrompt: 'hi',
        preassignedSessionId: session.id,
        eagerExposures: [
          {
            scope: 'user',
            name: 'role',
            memoryContentHash: 'role-hash',
            memoryStateAtExposure: 'active',
          },
          {
            scope: 'user',
            name: 'style',
            memoryContentHash: 'style-hash',
            memoryStateAtExposure: 'active',
          },
        ],
      });
      expect(result.status).toBe('done');

      // role: still one row (pre-existing); resume MUST NOT have
      // duplicated it.
      const roleRows = listProvenanceForMemory(db, session.id, 'user', 'role');
      expect(roleRows).toHaveLength(1);
      expect(roleRows[0]?.memoryContentHash).toBe('role-hash');

      // style: previously missing, now backfilled by the resume. The
      // bug this fix addresses surfaces if this assertion fails —
      // pre-fix it would be 0.
      const styleRows = listProvenanceForMemory(db, session.id, 'user', 'style');
      expect(styleRows).toHaveLength(1);
      expect(styleRows[0]?.memoryContentHash).toBe('style-hash');
    });

    test('invalid memoryScope on one exposure does NOT abort run (audit drift)', async () => {
      // The repo guard throws for bogus scopes; the loop must
      // swallow + log to stderr so a bad inventory row doesn't
      // crash session bring-up. Following rows still emit.
      const original = process.stderr.write.bind(process.stderr);
      const captured: string[] = [];
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      }) as typeof process.stderr.write;

      const handle = mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]);
      const registry = createToolRegistry();
      registry.register(echoTool);
      try {
        const result = await runAgent({
          provider: handle.provider,
          toolRegistry: registry,
          permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
          db,
          cwd: '/p',
          userPrompt: 'hi',
          eagerExposures: [
            {
              scope: 'bogus' as never,
              name: 'broken',
              memoryContentHash: null,
              memoryStateAtExposure: 'active',
            },
            {
              scope: 'user',
              name: 'good',
              memoryContentHash: null,
              memoryStateAtExposure: 'active',
            },
          ],
        });
        expect(result.status).toBe('done');
      } finally {
        process.stderr.write = original;
      }
      expect(captured.join('')).toMatch(/AUDIT DRIFT.*eager exposure.*broken/);
      const sid = listSessions(db)[0]?.id;
      if (sid === undefined) throw new Error('expected a session');
      // The good entry's row landed even though the bad entry threw.
      expect(listProvenanceForMemory(db, sid, 'user', 'good')).toHaveLength(1);
    });

    test('R5: exposure throw mid-loop does NOT abort following rows (per-row independence)', async () => {
      // Pre-fix the per-row try/catch was the only thing keeping a
      // bad row from cascading; an existing test confirmed ONE bad
      // entry doesn't crash the run, but not that subsequent good
      // entries still land. This pins the loop-continues-after-throw
      // invariant: bad sandwiched between two goods → both goods
      // land, AUDIT DRIFT line emitted for the bad one only.
      const original = process.stderr.write.bind(process.stderr);
      const captured: string[] = [];
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      }) as typeof process.stderr.write;

      const handle = mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]);
      const registry = createToolRegistry();
      registry.register(echoTool);
      try {
        const result = await runAgent({
          provider: handle.provider,
          toolRegistry: registry,
          permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
          db,
          cwd: '/p',
          userPrompt: 'hi',
          eagerExposures: [
            {
              scope: 'user',
              name: 'first',
              memoryContentHash: null,
              memoryStateAtExposure: 'active',
            },
            {
              scope: 'bogus' as never,
              name: 'middle-bad',
              memoryContentHash: null,
              memoryStateAtExposure: 'active',
            },
            {
              scope: 'user',
              name: 'after-bad',
              memoryContentHash: null,
              memoryStateAtExposure: 'active',
            },
          ],
        });
        expect(result.status).toBe('done');
      } finally {
        process.stderr.write = original;
      }
      const sid = listSessions(db)[0]?.id;
      if (sid === undefined) throw new Error('expected a session');
      // First good landed (proved before the throw).
      expect(listProvenanceForMemory(db, sid, 'user', 'first')).toHaveLength(1);
      // After-bad good landed (the throw didn't cascade).
      expect(listProvenanceForMemory(db, sid, 'user', 'after-bad')).toHaveLength(1);
      // AUDIT DRIFT line for the bad one only.
      const drift = captured
        .join('')
        .split('\n')
        .filter((l) => l.includes('AUDIT DRIFT') && l.includes('eager exposure'));
      expect(drift).toHaveLength(1);
      expect(drift[0]).toContain('middle-bad');
    });
  });

  describe('memoryExcludeScopes wraps the tool-facing registry (S5 review)', () => {
    // Review regression: when memoryExcludeScopes is non-empty
    // (shared trust probe returned verify_failed / deferred /
    // revoked), the harness wired retrieve_context against an
    // excluded registry but exposed the UNFILTERED registry to
    // memory_list / memory_read / memory_search via
    // ctx.memoryRegistry. The model could call those tools and
    // enumerate / read project_shared bodies the operator marked
    // offline — direct bypass of the trust gate eager-load and
    // retrieval surfaces already respect.
    //
    // Coverage strategy: inject a synthetic tool that captures
    // ctx.memoryRegistry on its first call, then prove every
    // read-side method honors the exclusion. Avoids wiring the
    // full memory_* tool tree into the loop test while still
    // pinning the harness-level wrapping decision.

    test('ctx.memoryRegistry sees only allowed scopes when memoryExcludeScopes is set', async () => {
      const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createMemoryRegistry } = await import('../../src/memory/registry.ts');

      // Seed both scopes with the same name so the precedence
      // fallback assertion below has something to land on.
      const repo = mkdtempSync(join(tmpdir(), 'forja-loop-mem-exclude-'));
      const roots = {
        user: join(repo, 'user'),
        projectShared: join(repo, 'shared'),
        projectLocal: join(repo, 'local'),
      };
      const writeIdx = (dir: string, body: string) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'MEMORY.md'), body);
      };
      const writeBody = (dir: string, name: string, body: string) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, `${name}.md`),
          `---\nname: ${name}\ndescription: hook for ${name}\ntype: feedback\nsource: user_explicit\n---\n\n${body}\n`,
        );
      };
      writeIdx(roots.projectShared, '- [Secret](secret.md) — shared\n');
      writeBody(roots.projectShared, 'secret', 'ATTACKER_PAYLOAD');
      writeIdx(roots.user, '- [Secret](secret.md) — user\n');
      writeBody(roots.user, 'secret', 'benign user body');
      const memoryRegistry = createMemoryRegistry({ roots });

      // Synthetic tool that captures the ctx-exposed registry on
      // first invocation. Returning a clean tool result lets the
      // run finish normally.
      let captured: typeof memoryRegistry | undefined;
      const captureTool: Tool<{ x: number }, { ok: true }> = {
        name: 'capture_registry',
        description: 'capture ctx.memoryRegistry',
        inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
        metadata: { category: 'misc', writes: false, idempotent: true },
        async execute(_args, ctx) {
          captured = ctx.memoryRegistry;
          return { ok: true };
        },
      };

      const provider = mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'capture_registry', input: { x: 1 } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]);
      const tools = createToolRegistry();
      tools.register(captureTool);

      const result = await runAgent({
        provider: provider.provider,
        toolRegistry: tools,
        permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
        db,
        cwd: '/p',
        userPrompt: 'hi',
        memoryRegistry,
        memoryExcludeScopes: ['project_shared'],
      });
      expect(result.status).toBe('done');
      if (captured === undefined) throw new Error('expected ctx.memoryRegistry to be captured');

      // 1. list({}) excludes project_shared bodies entirely.
      const listed = captured.list({});
      expect(listed.map((l) => l.scope)).not.toContain('project_shared');

      // 2. Precedence fallback: dedup-by-name lands user/secret (NOT
      //    project_shared/secret which would normally win precedence
      //    local > shared > user).
      const deduped = captured.list({ deduplicateByName: true });
      const dedupedScopes = deduped.filter((l) => l.name === 'secret').map((l) => l.scope);
      expect(dedupedScopes).toEqual(['user']);

      // 3. read(name) falls through to user when project_shared is
      //    excluded. The shared body containing ATTACKER_PAYLOAD
      //    MUST NOT leak through.
      const readResult = captured.read('secret');
      expect(readResult.kind).toBe('present');
      if (readResult.kind === 'present') {
        expect(readResult.scope).toBe('user');
        expect(readResult.file.body).not.toContain('ATTACKER_PAYLOAD');
      }

      // 4. Pinned excluded scope is closed at every read-side
      //    surface. Pre-fix the same calls would have returned the
      //    project_shared entry.
      expect(captured.list({ scope: 'project_shared' })).toEqual([]);
      expect(captured.read('secret', { scope: 'project_shared' }).kind).toBe('unknown');
      expect(captured.peek('secret', { scope: 'project_shared' }).kind).toBe('unknown');
      expect(captured.search('ATTACKER', { scope: 'project_shared' })).toEqual([]);

      // 5. Default-scope search filters out hits in excluded scope.
      //    deep:true would read body bytes — even then, the shared
      //    hit must NOT surface.
      const deepHits = captured.search('ATTACKER', { deep: true });
      expect(deepHits.map((h) => h.scope)).not.toContain('project_shared');
    });

    test('memoryExcludeScopes undefined → ctx.memoryRegistry is the unwrapped base', async () => {
      // Sanity: the wrapping is conditional. Without exclusion the
      // tool ctx must see the unmodified registry. Without this
      // test, a future regression that wraps unconditionally would
      // pay the closure cost on every read of every session.
      const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createMemoryRegistry } = await import('../../src/memory/registry.ts');

      const repo = mkdtempSync(join(tmpdir(), 'forja-loop-mem-noexclude-'));
      const roots = {
        user: join(repo, 'user'),
        projectShared: join(repo, 'shared'),
        projectLocal: join(repo, 'local'),
      };
      mkdirSync(roots.projectShared, { recursive: true });
      writeFileSync(join(roots.projectShared, 'MEMORY.md'), '- [S](s.md) — shared\n');
      writeFileSync(
        join(roots.projectShared, 's.md'),
        '---\nname: s\ndescription: h\ntype: feedback\nsource: user_explicit\n---\n\nbody\n',
      );
      const memoryRegistry = createMemoryRegistry({ roots });

      let captured: typeof memoryRegistry | undefined;
      const captureTool: Tool<{ x: number }, { ok: true }> = {
        name: 'capture_registry',
        description: 'capture ctx.memoryRegistry',
        inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
        metadata: { category: 'misc', writes: false, idempotent: true },
        async execute(_args, ctx) {
          captured = ctx.memoryRegistry;
          return { ok: true };
        },
      };
      const provider = mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'capture_registry', input: { x: 1 } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]);
      const tools = createToolRegistry();
      tools.register(captureTool);

      await runAgent({
        provider: provider.provider,
        toolRegistry: tools,
        permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
        db,
        cwd: '/p',
        userPrompt: 'hi',
        memoryRegistry,
      });
      // Reference equality: no wrapping when exclusion is omitted.
      expect(captured).toBe(memoryRegistry);
    });
  });
});

describe('post-persist contract (per-response footer refresh)', () => {
  // The REPL refreshes the footer's DB-derived usage chips on every
  // `usage_persisted` (the harness's display cue), so both it and the
  // billing event `cost_update` carry an ordering contract (see
  // emitCostUpdate in loop.ts): when they fire, the DB must already
  // hold the rows the charge came from — the assistant message row
  // (token side) and the session's total_cost_usd rollup (cost side).
  // Pre-fix the emit happened BEFORE appendAssistant, so a DB read
  // triggered by the event ran one response behind for the whole turn.
  const SCRIPT: ScriptedStep[] = [
    {
      tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'a' } }],
      stop_reason: 'tool_use',
      usage: { input: 100, output: 10 },
    },
    { text: 'done', stop_reason: 'end_turn', usage: { input: 100, output: 10 } },
  ];

  test('billed run: both events fire after the row and rollup are persisted, once per response', async () => {
    const { config } = buildConfig(SCRIPT, {
      capsOverride: { cost_per_1k_input: 1, cost_per_1k_output: 1 },
    });
    let sessionId = '';
    const costObserved: { cumulative: number; rolledUpCost: number; tokensOut: number }[] = [];
    const cueObserved: { rolledUpCost: number; tokensOut: number }[] = [];
    const result = await runAgent({
      ...config,
      onEvent: (e: HarnessEvent) => {
        if (e.type === 'session_start') sessionId = e.sessionId;
        // Read the DB the way the REPL's footer refresh does — at the
        // moment each event is delivered (the bus is synchronous).
        if (e.type === 'cost_update') {
          costObserved.push({
            cumulative: e.cumulative,
            rolledUpCost: getSession(db, sessionId)?.totalCostUsd ?? -1,
            tokensOut: sumMessageUsage(db, sessionId).tokensOut,
          });
        }
        if (e.type === 'usage_persisted') {
          cueObserved.push({
            rolledUpCost: getSession(db, sessionId)?.totalCostUsd ?? -1,
            tokensOut: sumMessageUsage(db, sessionId).tokensOut,
          });
        }
      },
    });
    expect(result.status).toBe('done');
    // One of each per model response — that's the footer cadence.
    expect(costObserved.length).toBe(2);
    expect(cueObserved.length).toBe(2);
    // First response: its own tokens are already queryable at emit time.
    expect(costObserved[0]?.tokensOut).toBe(10);
    expect(cueObserved[0]?.tokensOut).toBe(10);
    expect(costObserved[0]?.rolledUpCost).toBeCloseTo(costObserved[0]?.cumulative ?? -1, 10);
    // Second response: both rows visible, rollup tracks cumulative.
    expect(costObserved[1]?.tokensOut).toBe(20);
    expect(cueObserved[1]?.tokensOut).toBe(20);
    expect(costObserved[1]?.rolledUpCost).toBeCloseTo(costObserved[1]?.cumulative ?? -1, 10);
    // The mid-run rollup converged on the same figure finish() persists.
    const final = getSession(db, sessionId);
    expect(final?.totalCostUsd).toBeCloseTo(costObserved[1]?.cumulative ?? -1, 10);
  });

  test('zero-priced provider: cost_update stays silent but the display cue still fires per response', async () => {
    // Local/free models have cost_per_1k_* = 0, so every delta is 0 and
    // the billing event is (deliberately) skipped. The footer must not
    // fall back to turn cadence for that provider class — that's the
    // point of the separate usage_persisted cue.
    const { config } = buildConfig(SCRIPT); // default caps: zero pricing
    let sessionId = '';
    let costUpdates = 0;
    const cueObserved: number[] = [];
    const result = await runAgent({
      ...config,
      onEvent: (e: HarnessEvent) => {
        if (e.type === 'session_start') sessionId = e.sessionId;
        if (e.type === 'cost_update') costUpdates += 1;
        if (e.type === 'usage_persisted') {
          cueObserved.push(sumMessageUsage(db, sessionId).tokensOut);
        }
      },
    });
    expect(result.status).toBe('done');
    expect(costUpdates).toBe(0);
    // Still one cue per response, with the response's row queryable.
    expect(cueObserved).toEqual([10, 20]);
  });
});
