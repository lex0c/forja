import { beforeEach, describe, expect, test } from 'bun:test';
import type { CollectedStep } from '../../src/harness/collect.ts';
import { runAgent } from '../../src/harness/loop.ts';
import type { HarnessEvent } from '../../src/harness/types.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { Policy } from '../../src/permissions/index.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { todoWriteTool } from '../../src/tools/builtin/todo-write.ts';
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

  test('todo_write run emits todo_updated between tool_invoking and tool_finished', async () => {
    const events: HarnessEvent[] = [];
    const r = createToolRegistry();
    r.register(todoWriteTool as unknown as Tool);
    const items = [
      {
        content: 'Implement payment flow',
        status: 'in_progress',
        active_form: 'Implementing payment flow',
      },
      { content: 'Add regression test', status: 'pending', active_form: 'Adding regression test' },
    ];
    await runAgent({
      provider: mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'todo_write', input: { items } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: r,
      // todo_write is category 'misc' — engine allows it by default
      // (no per-category gate). No policy override needed.
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
      onEvent: (e) => events.push(e),
    });
    const toolInvokingIdx = events.findIndex(
      (e) => e.type === 'tool_invoking' && e.toolUseId === 'tu1',
    );
    const toolFinishedIdx = events.findIndex(
      (e) => e.type === 'tool_finished' && e.toolUseId === 'tu1',
    );
    const todoUpdatedIdx = events.findIndex((e) => e.type === 'todo_updated');
    expect(toolInvokingIdx).toBeGreaterThanOrEqual(0);
    expect(toolFinishedIdx).toBeGreaterThanOrEqual(0);
    expect(todoUpdatedIdx).toBeGreaterThanOrEqual(0);
    // todo_updated fires DURING tool execution: the tool calls
    // ctx.todoStore.set(), the wrapped set persists then emits, the
    // tool then returns and the harness emits tool_finished. This is
    // the natural flow for the renderer — the operator sees the list
    // materialize while the chip is still in its "Updating todos..."
    // form, then the chip resolves to "Updated N items".
    expect(todoUpdatedIdx).toBeGreaterThan(toolInvokingIdx);
    expect(todoUpdatedIdx).toBeLessThan(toolFinishedIdx);
    const updated = events[todoUpdatedIdx] as Extract<HarnessEvent, { type: 'todo_updated' }>;
    expect(updated.items).toHaveLength(2);
    expect(updated.items[0]?.content).toBe('Implement payment flow');
    expect(updated.items[0]?.status).toBe('in_progress');
    expect(updated.items[0]?.activeForm).toBe('Implementing payment flow');
  });

  test('todo_write under planMode still emits todo_updated (planSafe path)', async () => {
    // todo_write declares metadata.planSafe = true (todo-write.ts:122)
    // so the harness's plan-mode write-tool gate must let it through.
    // Regression: a future change that flips planSafe to false (or
    // removes the flag) would silently break TodoList observability
    // for plan-mode sessions, which are a primary use of the planning
    // signal in the first place.
    const events: HarnessEvent[] = [];
    const r = createToolRegistry();
    r.register(todoWriteTool as unknown as Tool);
    await runAgent({
      provider: mockProvider([
        {
          tool_uses: [
            {
              id: 'tu1',
              name: 'todo_write',
              input: {
                items: [{ content: 'plan it', status: 'pending', active_form: 'Planning it' }],
              },
            },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: r,
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
      planMode: true,
      onEvent: (e) => events.push(e),
    });
    const updated = events.find((e) => e.type === 'todo_updated');
    expect(updated).toBeDefined();
    if (updated === undefined || updated.type !== 'todo_updated') return;
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0]?.content).toBe('plan it');
  });

  test('observer mutating todo_updated.items does not corrupt the next emission', async () => {
    // Asserts the wrap reads back through baseStore.get() (deep
    // clone) instead of forwarding the input array directly. Without
    // this, an observer mutation would poison the store and the next
    // todo_write would surface the corrupted state. Regression cover
    // for a future "optimization" that swaps the get() back to raw
    // items.
    const events: HarnessEvent[] = [];
    const r = createToolRegistry();
    r.register(todoWriteTool as unknown as Tool);
    await runAgent({
      provider: mockProvider([
        {
          tool_uses: [
            {
              id: 'tu1',
              name: 'todo_write',
              input: {
                items: [{ content: 'first', status: 'pending', active_form: 'Doing first' }],
              },
            },
          ],
          stop_reason: 'tool_use',
        },
        {
          tool_uses: [
            {
              id: 'tu2',
              name: 'todo_write',
              input: {
                items: [{ content: 'second', status: 'pending', active_form: 'Doing second' }],
              },
            },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: r,
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
      onEvent: (e) => {
        // Mutate the FIRST event's items to try to poison whatever
        // the store holds. The wrap's get()-readthrough means this
        // mutation hits a deep clone and dies in the observer's
        // local array.
        if (e.type === 'todo_updated' && e.items[0]?.content === 'first') {
          e.items[0].content = 'POISONED';
          e.items.push({ content: 'INJECTED', status: 'done', activeForm: 'evil' });
        }
        events.push(e);
      },
    });
    const updates = events.filter(
      (e): e is Extract<HarnessEvent, { type: 'todo_updated' }> => e.type === 'todo_updated',
    );
    expect(updates).toHaveLength(2);
    // Second emission reflects only the second tool's payload — no
    // trace of the first observer's mutation.
    expect(updates[1]?.items).toHaveLength(1);
    expect(updates[1]?.items[0]?.content).toBe('second');
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
