import { beforeEach, describe, expect, test } from 'bun:test';
import type { CollectedStep } from '../../src/harness/collect.ts';
import { runAgent } from '../../src/harness/loop.ts';
import type { HarnessEvent } from '../../src/harness/types.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { Policy } from '../../src/permissions/index.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';
import type { Tool } from '../../src/tools/types.ts';

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
  yield { kind: 'start', message_id: step.message_id ?? 'mock-msg' };
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

const mockProvider = (script: ScriptedStep[]): Provider => {
  let i = 0;
  return {
    id: 'mock/m',
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
      const step = script[i++];
      if (step === undefined) throw new Error('script exhausted');
      for (const ev of replayStep(step)) yield ev;
    },
    generateConstrained: () => Promise.reject(new Error('n/a')),
    countTokens: () => Promise.resolve(0),
  };
};

const echoTool: Tool = {
  name: 'echo',
  description: 'echo',
  inputSchema: {
    type: 'object',
    properties: { msg: { type: 'string' } },
    required: ['msg'],
  },
  metadata: { category: 'misc', writes: false, idempotent: true },
  async execute(args: unknown) {
    return { echoed: (args as { msg: string }).msg };
  },
};

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

describe('runAgent onEvent', () => {
  test('emits session_start and session_finished bracketing the run', async () => {
    const events: HarnessEvent[] = [];
    await runAgent({
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
      onEvent: (e) => events.push(e),
    });
    expect(events[0]?.type).toBe('session_start');
    expect(events[events.length - 1]?.type).toBe('session_finished');
  });

  test('emits step_start per iteration', async () => {
    const events: HarnessEvent[] = [];
    await runAgent({
      provider: mockProvider([
        {
          text: '',
          tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'a' } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: (() => {
        const r = createToolRegistry();
        r.register(echoTool);
        return r;
      })(),
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
      onEvent: (e) => events.push(e),
    });
    const stepStarts = events.filter((e) => e.type === 'step_start');
    expect(stepStarts).toHaveLength(2);
  });

  test('forwards each provider stream event', async () => {
    const events: HarnessEvent[] = [];
    await runAgent({
      provider: mockProvider([{ text: 'hi there', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
      onEvent: (e) => events.push(e),
    });
    const providerEvents = events.filter((e) => e.type === 'provider_event');
    // start, text_delta, stop = 3 events
    expect(providerEvents.length).toBeGreaterThanOrEqual(3);
    const kinds = providerEvents
      .map((e) => (e.type === 'provider_event' ? e.event.kind : ''))
      .filter((k) => k !== '');
    expect(kinds).toContain('text_delta');
    expect(kinds).toContain('stop');
  });

  test('emits tool_invoking → tool_decided → tool_finished for an executed tool', async () => {
    const events: HarnessEvent[] = [];
    const r = createToolRegistry();
    r.register(echoTool);
    await runAgent({
      provider: mockProvider([
        { tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'a' } }], stop_reason: 'tool_use' },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: r,
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
      onEvent: (e) => events.push(e),
    });
    const toolEvents = events.filter(
      (e) => e.type === 'tool_invoking' || e.type === 'tool_decided' || e.type === 'tool_finished',
    );
    expect(toolEvents.map((e) => e.type)).toEqual([
      'tool_invoking',
      'tool_decided',
      'tool_finished',
    ]);
  });

  test('skips tool_decided for unknown tools (no decision was made)', async () => {
    const events: HarnessEvent[] = [];
    await runAgent({
      provider: mockProvider([
        { tool_uses: [{ id: 'tu1', name: 'unknown', input: {} }], stop_reason: 'tool_use' },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
      onEvent: (e) => events.push(e),
    });
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_invoking');
    expect(types).not.toContain('tool_decided');
    expect(types).toContain('tool_finished');
  });

  test('a throwing onEvent does not derail the loop', async () => {
    let calls = 0;
    const result = await runAgent({
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
      onEvent: () => {
        calls++;
        throw new Error('renderer crashed');
      },
    });
    expect(calls).toBeGreaterThan(0);
    expect(result.status).toBe('done');
  });
});
