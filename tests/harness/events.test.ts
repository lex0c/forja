import { beforeEach, describe, expect, test } from 'bun:test';
import type { CollectedStep } from '../../src/harness/collect.ts';
import { runAgent } from '../../src/harness/loop.ts';
import type { HarnessEvent } from '../../src/harness/types.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { Policy } from '../../src/permissions/index.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createTodoStore } from '../../src/todo/index.ts';
import { todoCreateTool } from '../../src/tools/builtin/todo-create.ts';
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
  usage?: { input: number; output: number; cache_read?: number; cache_creation?: number };
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
  if (step.usage !== undefined) {
    yield {
      kind: 'usage',
      usage: {
        input: step.usage.input,
        output: step.usage.output,
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

  test('emits recap_terse_ready immediately before session_finished (RECAP §3.3)', async () => {
    // Auto-display contract: harness MUST project + render a
    // terse line and emit it as a discrete event so the TUI can
    // surface it above the session:end footer. Skipped silently
    // on failure (tested separately via the helper unit tests);
    // the happy path here pins the ordering — terse comes
    // BEFORE session_finished so the rendered scrollback ordering
    // is `... terse → session:end` (operator reads the summary
    // above the closure).
    const events: HarnessEvent[] = [];
    await runAgent({
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'fix the bug',
      onEvent: (e) => events.push(e),
    });
    const terseIdx = events.findIndex((e) => e.type === 'recap_terse_ready');
    const finishedIdx = events.findIndex((e) => e.type === 'session_finished');
    expect(terseIdx).toBeGreaterThan(-1);
    expect(finishedIdx).toBeGreaterThan(terseIdx);
    const terse = events[terseIdx];
    if (terse?.type !== 'recap_terse_ready') throw new Error('expected recap_terse_ready');
    expect(terse.markdown.length).toBeGreaterThan(0);
    expect(terse.cacheHit).toBe(false); // first emit on this session
    expect(terse.sessionId.length).toBeGreaterThan(0);
  });

  test('rehydrate skips when prior session was done (uses pre-reopen status)', async () => {
    // Regression: the rehydrate gate read `getSession(...).status`
    // AFTER `reopenSession` flipped the row to 'running', so it
    // never observed terminal statuses (`done` / `exhausted` /
    // `error`) and rehydrated sessions that should have been
    // skipped. Pin the contract: a `done` session resumed must
    // NOT emit `resume_rehydrated`, since shouldSkipResumeContext
    // returns true for that status.
    const r1 = await runAgent({
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'first',
    });
    // First run completed normally — status should be 'done'.
    const events: HarnessEvent[] = [];
    await runAgent({
      provider: mockProvider([{ text: 'follow-up', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'follow up',
      resumeFromSessionId: r1.sessionId,
      onEvent: (e) => events.push(e),
    });
    const rehydrateEvents = events.filter((e) => e.type === 'resume_rehydrated');
    expect(rehydrateEvents).toHaveLength(0);
    const failureEvents = events.filter((e) => e.type === 'resume_rehydrate_failed');
    expect(failureEvents).toHaveLength(0);
  });

  test('rehydrate previousStatus reports the pre-reopen status, not running', async () => {
    // Regression sibling: even when rehydrate runs (status was
    // not in the skip list), the emitted `previousStatus` must
    // be the value BEFORE `reopenSession` flipped the row to
    // 'running'. Use 'interrupted' — not in the skip list, so
    // rehydrate proceeds, and we can assert the status string.
    const r1 = await runAgent({
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'first',
    });
    // Mutate the row directly to 'interrupted' (no harness path
    // produces this status without a real abort signal). Manual
    // UPDATE keeps the test fast and intent-clear.
    db.query('UPDATE sessions SET status = ? WHERE id = ?').run('interrupted', r1.sessionId);

    const events: HarnessEvent[] = [];
    await runAgent({
      provider: mockProvider([{ text: 'follow-up', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'follow up',
      resumeFromSessionId: r1.sessionId,
      onEvent: (e) => events.push(e),
    });
    const rehydrate = events.find((e) => e.type === 'resume_rehydrated');
    expect(rehydrate).toBeDefined();
    if (rehydrate?.type !== 'resume_rehydrated') throw new Error('expected resume_rehydrated');
    expect(rehydrate.previousStatus).toBe('interrupted');
  });

  test('skips recap_terse_ready when buildAutoTerse fails — session_finished still emits', async () => {
    // Auto-display surface MUST be best-effort: any failure
    // (DB lock, missing table, malformed projection) collapses
    // to "no emit" and the harness still emits session_finished
    // so the operator's exit footer is unaffected. RECAP §3.3:
    // "Falhas não bloqueiam".
    //
    // Force the helper to fail by dropping the `recap_cache`
    // table before runAgent. `buildAutoTerse` reads cache first;
    // SELECT on a missing table throws, the outer try/catch
    // returns `{ ok: false }`, and the harness skips the emit.
    db.query('DROP TABLE recap_cache').run();

    const events: HarnessEvent[] = [];
    await runAgent({
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'fix the bug',
      onEvent: (e) => events.push(e),
    });
    expect(events.find((e) => e.type === 'recap_terse_ready')).toBeUndefined();
    expect(events.find((e) => e.type === 'session_finished')).toBeDefined();
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

  test('todo_create run emits todo_updated between tool_invoking and tool_finished', async () => {
    const events: HarnessEvent[] = [];
    const r = createToolRegistry();
    r.register(todoCreateTool as unknown as Tool);
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
          tool_uses: [{ id: 'tu1', name: 'todo_create', input: { items } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: r,
      // todo_create is category 'misc' — engine allows it by default
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
    // materialize while the chip is still in its "Adding todos..."
    // form, then the chip resolves to "Added todos".
    expect(todoUpdatedIdx).toBeGreaterThan(toolInvokingIdx);
    expect(todoUpdatedIdx).toBeLessThan(toolFinishedIdx);
    const updated = events[todoUpdatedIdx] as Extract<HarnessEvent, { type: 'todo_updated' }>;
    expect(updated.items).toHaveLength(2);
    expect(updated.items[0]?.content).toBe('Implement payment flow');
    expect(updated.items[0]?.status).toBe('in_progress');
    expect(updated.items[0]?.activeForm).toBe('Implementing payment flow');
  });

  test('observer mutating todo_updated.items does not corrupt the next emission', async () => {
    // Asserts the wrap reads back through baseStore.get() (deep
    // clone) instead of forwarding the input array directly. Without
    // this, an observer mutation would poison the store and the next
    // todo_create would surface the corrupted state. Regression cover
    // for a future "optimization" that swaps the get() back to raw
    // items.
    const events: HarnessEvent[] = [];
    const r = createToolRegistry();
    r.register(todoCreateTool as unknown as Tool);
    await runAgent({
      provider: mockProvider([
        {
          tool_uses: [
            {
              id: 'tu1',
              name: 'todo_create',
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
              name: 'todo_create',
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
        // Try to poison the store by mutating the FIRST emission's items
        // (the only one with a single row). The wrap reads back through
        // baseStore.get() (deep clone), so this mutation dies in the
        // observer's local array and the next emission stays clean. Guard
        // on length 1: todo_create APPENDS, so `first` is still at index 0
        // on the second emission — an unconditional mutation would poison
        // that observed copy too and mask the regression.
        if (e.type === 'todo_updated' && e.items.length === 1) {
          if (e.items[0] !== undefined) e.items[0].content = 'POISONED';
          e.items.push({ id: '99', content: 'INJECTED', status: 'done', activeForm: 'evil' });
        }
        events.push(e);
      },
    });
    const updates = events.filter(
      (e): e is Extract<HarnessEvent, { type: 'todo_updated' }> => e.type === 'todo_updated',
    );
    expect(updates).toHaveLength(2);
    // todo_create appends, so the second emission is [first, second] read
    // back from the store: `first` is intact (not POISONED) and there's
    // no INJECTED row — the observer's mutation never reached the store.
    expect(updates[1]?.items).toHaveLength(2);
    expect(updates[1]?.items[0]?.content).toBe('first');
    expect(updates[1]?.items[1]?.content).toBe('second');
  });

  test('an injected todoStore survives session-end (REPL cross-turn persistence)', async () => {
    // The REPL injects ONE store and re-runs runAgent per turn; the store
    // must survive session-end so a later turn's todo_update finds the ids
    // an earlier turn created. A loop-owned per-run store gets cleared at
    // session-end and the list would vanish between turns (the bug).
    const store = createTodoStore();
    const r = createToolRegistry();
    r.register(todoCreateTool as unknown as Tool);
    const events: HarnessEvent[] = [];
    await runAgent({
      provider: mockProvider([
        {
          tool_uses: [
            {
              id: 'tu1',
              name: 'todo_create',
              input: { items: [{ content: 'plan', status: 'pending', active_form: 'Planning' }] },
            },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: r,
      todoStore: store,
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
      onEvent: (e) => events.push(e),
    });
    const updated = events.find(
      (e): e is Extract<HarnessEvent, { type: 'todo_updated' }> => e.type === 'todo_updated',
    );
    if (updated === undefined) throw new Error('expected a todo_updated event');
    // After runAgent returns, the INJECTED store STILL holds the todo —
    // a loop-owned store would have been cleared at session-end.
    expect(store.get(updated.sessionId)).toHaveLength(1);
    expect(store.get(updated.sessionId)[0]?.content).toBe('plan');
  });

  test('provider usage event surfaces verbatim in onEvent (consumed by adapter)', async () => {
    // The adapter (separate from the harness) translates this into
    // assistant:usage UIEvents — see tests/tui/harness-adapter.test.ts.
    // Here we just verify the harness still forwards the raw provider
    // event so the adapter has something to translate.
    const events: HarnessEvent[] = [];
    await runAgent({
      provider: mockProvider([
        {
          text: 'reply',
          stop_reason: 'end_turn',
          usage: { input: 12, output: 234, cache_read: 5, cache_creation: 0 },
        },
      ]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      db,
      cwd: '/p',
      userPrompt: 'hi',
      onEvent: (e) => events.push(e),
    });
    const usageEvents = events
      .filter((e) => e.type === 'provider_event')
      .map((e) => (e.type === 'provider_event' ? e.event : null))
      .filter((ev): ev is Extract<StreamEvent, { kind: 'usage' }> => ev?.kind === 'usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.usage.output).toBe(234);
  });

  test('bash_background tool surfaces bg_started + bg_ended through onEvent', async () => {
    // E2E for the bg observability wire: loop's createBgManager
    // gets onEvent injected, manager fires on spawn + exit, harness
    // safeEmit translates to HarnessEvent. Skipping the bash_background
    // tool registration because it's wired in src/tools/builtin/index;
    // test uses the bare bg manager via the loop's bgLogDir config.
    // We instead drive a fake tool that calls ctx.bgManager directly.
    const events: HarnessEvent[] = [];
    const r = createToolRegistry();
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmpLogDir = mkdtempSync(join(tmpdir(), 'forja-bg-e2e-'));
    try {
      const fakeSpawn: Tool = {
        name: 'fake_spawn',
        description: 'spawns a quick bg process',
        inputSchema: { type: 'object' },
        metadata: { category: 'misc', writes: false, idempotent: false },
        execute: async (_args, ctx) => {
          if (ctx.bgManager === undefined) {
            return { ok: false };
          }
          const spawned = await ctx.bgManager.spawn({ command: 'echo bg-e2e' });
          // Wait for the natural exit so the test sees both events
          // before the harness tears down at session end.
          await new Promise((res) => setTimeout(res, 50));
          return { id: spawned.id };
        },
      };
      r.register(fakeSpawn as unknown as Tool);
      await runAgent({
        provider: mockProvider([
          {
            tool_uses: [{ id: 'tu1', name: 'fake_spawn', input: {} }],
            stop_reason: 'tool_use',
          },
          { text: 'done', stop_reason: 'end_turn' },
        ]),
        toolRegistry: r,
        permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
        db,
        cwd: '/p',
        userPrompt: 'hi',
        bgLogDir: tmpLogDir,
        onEvent: (e) => events.push(e),
      });
      const started = events.find((e) => e.type === 'bg_started');
      const ended = events.find((e) => e.type === 'bg_ended');
      expect(started).toBeDefined();
      expect(ended).toBeDefined();
      if (started?.type === 'bg_started') {
        expect(started.command).toBe('echo bg-e2e');
      }
      if (ended?.type === 'bg_ended') {
        expect(ended.status).toBe('exited');
        expect(ended.exitCode).toBe(0);
      }
    } finally {
      try {
        rmSync(tmpLogDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
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
