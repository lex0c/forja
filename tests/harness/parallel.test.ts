import { beforeEach, describe, expect, test } from 'bun:test';
import type { CollectedStep } from '../../src/harness/collect.ts';
import { runAgent } from '../../src/harness/loop.ts';
import type { RunBudget } from '../../src/harness/types.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { Policy } from '../../src/permissions/index.ts';
import type { GenerateRequest, Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';
import { type Tool, toolError } from '../../src/tools/types.ts';

// Replay helper. Mirrors tests/harness/loop.test.ts so parallel
// tests can share the same scripted-provider shape without
// importing private helpers across files.

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

const mockProvider = (
  script: ScriptedStep[],
): { provider: Provider; requests: GenerateRequest[] } => {
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

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

// In-flight tracker captures the maximum concurrent execution count
// observed across all `parallelEcho` invocations during a test run.
// `current` is the live count; `max` is the high-water mark.
const makeTracker = (): { current: number; max: number } => ({ current: 0, max: 0 });

interface Tracker {
  current: number;
  max: number;
}

const parallelEcho = (
  name: string,
  options: {
    delayMs?: number;
    fail?: boolean;
    tracker?: Tracker;
    parallel_safe?: boolean;
  } = {},
): Tool<{ msg?: string }, { echoed: string }> => ({
  name,
  description: `parallel-safe echo (${name})`,
  inputSchema: {
    type: 'object',
    properties: { msg: { type: 'string' } },
  },
  metadata: {
    category: 'misc',
    writes: false,
    idempotent: true,
    parallel_safe: options.parallel_safe ?? true,
  },
  async execute(args, ctx) {
    const tracker = options.tracker;
    if (tracker !== undefined) {
      tracker.current += 1;
      if (tracker.current > tracker.max) tracker.max = tracker.current;
    }
    try {
      if (options.delayMs !== undefined && options.delayMs > 0) {
        await sleep(options.delayMs, ctx.signal);
      }
      if (options.fail === true) {
        return toolError('test.fail', `${name} failed`);
      }
      return { echoed: args.msg ?? name };
    } finally {
      if (tracker !== undefined) tracker.current -= 1;
    }
  },
});

const serialEcho: Tool<{ msg?: string }, { echoed: string }> = {
  name: 'serial_echo',
  description: 'serial-only echo (no parallel_safe flag)',
  inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
  metadata: { category: 'misc', writes: false, idempotent: true },
  async execute(args) {
    return { echoed: args.msg ?? 'serial' };
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
    tools: Tool[];
    policy?: Partial<Policy>;
    signal?: AbortSignal;
    budget?: Partial<RunBudget>;
  },
) => {
  const handle = mockProvider(script);
  const registry = createToolRegistry();
  for (const t of options.tools) registry.register(t);
  return {
    handle,
    config: {
      provider: handle.provider,
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(
        { defaults: { mode: 'strict' }, tools: {}, ...(options.policy ?? {}) },
        { cwd: '/p' },
      ),
      db,
      cwd: '/p',
      userPrompt: 'hi',
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.budget !== undefined ? { budget: options.budget } : {}),
    },
  };
};

describe('parallel tool execution (ORCHESTRATION §1.3)', () => {
  test('all parallel_safe → every tu in flight at the same instant', async () => {
    const tracker = makeTracker();
    const tool = parallelEcho('p_read', { delayMs: 50, tracker });
    const { config } = buildConfig(
      [
        {
          tool_uses: [
            { id: 'tu1', name: 'p_read', input: { msg: 'a' } },
            { id: 'tu2', name: 'p_read', input: { msg: 'b' } },
            { id: 'tu3', name: 'p_read', input: { msg: 'c' } },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
      { tools: [tool], budget: { maxConcurrentToolCalls: 5 } },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    // Cap is 5, batch is 3 — every tu must be in flight at the
    // same instant. Stronger than `>=2` and not flake-prone (the
    // tracker is a deterministic counter, not wall-clock). A
    // serialized run would max out at 1; an undocumented
    // throttle would max out at 2 and fail loudly here.
    expect(tracker.max).toBe(3);
  });

  test('mixed parallel_safe + non-parallel → fully serial fallback', async () => {
    const tracker = makeTracker();
    const tool = parallelEcho('p_read', { delayMs: 30, tracker });
    const { config } = buildConfig(
      [
        {
          tool_uses: [
            { id: 'tu1', name: 'p_read', input: { msg: 'a' } },
            { id: 'tu2', name: 'serial_echo', input: { msg: 'b' } },
            { id: 'tu3', name: 'p_read', input: { msg: 'c' } },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
      { tools: [tool, serialEcho] },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    // Serial path: only one parallel-safe in flight at a time.
    expect(tracker.max).toBe(1);
  });

  test('result order preserved across asymmetric latencies', async () => {
    // tu1 finishes last (slowest), tu2 finishes first (fastest), tu3
    // is in the middle. The tool_result blocks must still appear in
    // tu1, tu2, tu3 order — providers (Anthropic explicitly) require
    // index-aligned pairing with the assistant tool_use blocks.
    const fast = parallelEcho('p_fast', { delayMs: 5 });
    const mid = parallelEcho('p_mid', { delayMs: 30 });
    const slow = parallelEcho('p_slow', { delayMs: 80 });
    const { config, handle } = buildConfig(
      [
        {
          tool_uses: [
            { id: 'tu1', name: 'p_slow', input: { msg: 'first' } },
            { id: 'tu2', name: 'p_fast', input: { msg: 'second' } },
            { id: 'tu3', name: 'p_mid', input: { msg: 'third' } },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
      { tools: [fast, mid, slow] },
    );
    await runAgent(config);
    // Inspect the second provider request's last user message — it
    // contains the tool_result blocks.
    const second = handle.requests[1];
    expect(second).toBeDefined();
    if (second === undefined) return;
    const lastMsg = second.messages[second.messages.length - 1];
    expect(lastMsg?.role).toBe('user');
    const blocks = lastMsg?.content;
    if (!Array.isArray(blocks)) throw new Error('expected array content');
    expect(blocks.length).toBe(3);
    // tool_result blocks in original tu order: tu1, tu2, tu3.
    expect(blocks[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu1' });
    expect(blocks[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu2' });
    expect(blocks[2]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu3' });
  });

  test('sibling failure does not cancel other tools', async () => {
    const ok = parallelEcho('p_ok', { delayMs: 20 });
    const bad = parallelEcho('p_bad', { delayMs: 5, fail: true });
    const { config, handle } = buildConfig(
      [
        {
          tool_uses: [
            { id: 'tu1', name: 'p_ok', input: {} },
            { id: 'tu2', name: 'p_bad', input: {} },
            { id: 'tu3', name: 'p_ok', input: {} },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
      { tools: [ok, bad] },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    // All three results must show up despite one failure.
    const second = handle.requests[1];
    if (second === undefined) throw new Error('missing second request');
    const lastMsg = second.messages[second.messages.length - 1];
    const blocks = lastMsg?.content;
    if (!Array.isArray(blocks)) throw new Error('expected array content');
    expect(blocks.length).toBe(3);
  });

  test('consecutive errors counter folds in original order; bails when threshold crossed mid-batch', async () => {
    const bad = parallelEcho('p_bad', { delayMs: 1, fail: true });
    // 3 parallel-safe tools all failing in one batch with
    // maxToolErrors=2 — the harness must bail when the counter
    // crosses 2 mid-batch. The parallel batch DID execute every
    // sibling (their tool_call rows are committed in DB), so the
    // persisted message includes ALL 3 tool_results — D167.
    const { config, handle } = buildConfig(
      [
        {
          tool_uses: [
            { id: 'tu1', name: 'p_bad', input: { x: 1 } },
            { id: 'tu2', name: 'p_bad', input: { x: 2 } },
            { id: 'tu3', name: 'p_bad', input: { x: 3 } },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'never reached', stop_reason: 'end_turn' },
      ],
      { tools: [bad], budget: { maxToolErrors: 2 } },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('error');
    expect(result.reason).toBe('maxToolErrors');
    // detail snapshots the counter at the moment of crossing,
    // not the post-loop value.
    expect(result.detail).toBe('2 consecutive tool errors');
    // Only one provider request — we bailed before the next turn.
    expect(handle.requests).toHaveLength(1);
  });

  test('parallel bail persists every tool_result in the audit message (D167 audit fidelity)', async () => {
    // Same setup as the consecutive-errors test, but assert on
    // what the persisted user message contained. With D167's
    // no-trim policy the message holds 3 tool_results — one per
    // tool_call row in the DB — so a future replay/recap doesn't
    // see orphan tool_calls.
    const bad = parallelEcho('p_bad', { delayMs: 1, fail: true });
    const { config, handle } = buildConfig(
      [
        {
          tool_uses: [
            { id: 'tu1', name: 'p_bad', input: { x: 1 } },
            { id: 'tu2', name: 'p_bad', input: { x: 2 } },
            { id: 'tu3', name: 'p_bad', input: { x: 3 } },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'never reached', stop_reason: 'end_turn' },
      ],
      { tools: [bad], budget: { maxToolErrors: 2 } },
    );
    await runAgent(config);
    // Even though we bailed before the second provider call, the
    // db should hold the partial user message; the test peeks at
    // the in-memory mock to confirm the SHAPE of the persisted
    // tool_results (the mock provider only sees what was sent
    // before the bail, but the DB row went down regardless —
    // probe via listMessages instead).
    expect(handle.requests).toHaveLength(1);
    // Inspect via DB: listMessages of the session id from the
    // first request's last user message.
    const { listMessageTailBySession, listSessions } = await import('../../src/storage/index.ts');
    const sessions = listSessions(config.db);
    const sid = sessions[0]?.id;
    if (sid === undefined) throw new Error('no session row');
    const tail = listMessageTailBySession(config.db, sid, 1000);
    // The user-role message holding tool_results sits second
    // from the end (the assistant's tool_use turn precedes it).
    const lastUser = tail.messages.filter((m) => m.role === 'user').at(-1);
    if (lastUser === undefined) throw new Error('no user msg');
    const content = lastUser.content;
    if (!Array.isArray(content)) throw new Error('expected array content');
    const toolResultBlocks = content.filter((b: { type?: string }) => b.type === 'tool_result');
    expect(toolResultBlocks).toHaveLength(3);
  });

  test('writes:true + parallel_safe:true tool collapses batch to serial (defense-in-depth runtime guard)', async () => {
    // Construct a misbehaving tool that violates the
    // ToolMetadata contract (parallel_safe MUST NOT be true on
    // a writes-true tool). The runtime guard in loop.ts must
    // refuse the parallel branch and run the batch serially —
    // the tracker.max=1 confirms no overlap occurred.
    const tracker = makeTracker();
    const misbehaving: typeof serialEcho = {
      name: 'broken_writer',
      description: 'misbehaving',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      metadata: {
        category: 'misc',
        writes: true,
        idempotent: false,
        // Violation: writes:true should never appear with
        // parallel_safe:true. Tests the runtime guard.
        parallel_safe: true,
      },
      async execute(args, ctx) {
        tracker.current += 1;
        if (tracker.current > tracker.max) tracker.max = tracker.current;
        await sleep(20, ctx.signal);
        tracker.current -= 1;
        return { echoed: args.msg ?? 'b' };
      },
    };
    const { config } = buildConfig(
      [
        {
          tool_uses: [
            { id: 'tu1', name: 'broken_writer', input: { msg: 'a' } },
            { id: 'tu2', name: 'broken_writer', input: { msg: 'b' } },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
      { tools: [misbehaving] },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    // Serial fallback — never two in flight.
    expect(tracker.max).toBe(1);
  });

  // Slice 135 P1 conc-4: soft-stop signal already aborted when
  // the harness begins a step. The mid-batch test (D173, below)
  // covers signal aborting WHILE tools execute; the pre-step
  // case is the lighter weight scenario the harness must short-
  // circuit on — zero provider requests, no tool execution.
  test('pre-step soft-stop bails before any provider call (slice 135 P1 conc-4)', async () => {
    const softCtrl = new AbortController();
    softCtrl.abort(); // soft-stop already aborted
    const tracker = makeTracker();
    const tool = parallelEcho('p_read', { delayMs: 30, tracker });
    const handle = mockProvider([
      {
        tool_uses: [{ id: 'tu1', name: 'p_read', input: { msg: '1' } }],
        stop_reason: 'tool_use',
      },
    ]);
    const registry = createToolRegistry();
    registry.register(tool);
    const result = await runAgent({
      provider: handle.provider,
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(
        { defaults: { mode: 'strict' as const }, tools: {} },
        { cwd: '/p' },
      ),
      db,
      cwd: '/p',
      userPrompt: 'hi',
      softStopSignal: softCtrl.signal,
    });
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('aborted');
    expect(result.abortCause).toBe('soft');
    // Pre-step bail: provider never invoked, tool never executed.
    expect(handle.requests).toHaveLength(0);
    expect(tracker.max).toBe(0);
  });

  test('soft-stop fired mid-batch lets the batch complete; loop bails at next step (D173)', async () => {
    const softCtrl = new AbortController();
    const tracker = makeTracker();
    const tool = parallelEcho('p_read', { delayMs: 30, tracker });
    const handle = mockProvider([
      {
        tool_uses: [
          { id: 'tu1', name: 'p_read', input: { msg: '1' } },
          { id: 'tu2', name: 'p_read', input: { msg: '2' } },
          { id: 'tu3', name: 'p_read', input: { msg: '3' } },
        ],
        stop_reason: 'tool_use',
      },
      { text: 'never reached', stop_reason: 'end_turn' },
    ]);
    const registry = createToolRegistry();
    registry.register(tool);
    const config = {
      provider: handle.provider,
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(
        { defaults: { mode: 'strict' as const }, tools: {} },
        { cwd: '/p' },
      ),
      db,
      cwd: '/p',
      userPrompt: 'hi',
      softStopSignal: softCtrl.signal,
    };
    // Fire soft-stop right after the batch starts. Workers don't
    // inspect softStopSignal, so the batch must complete; the
    // next top-of-step check then bails with aborted/'soft'.
    const runPromise = runAgent(config);
    setTimeout(() => softCtrl.abort(), 5);
    const result = await runPromise;
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('aborted');
    expect(result.abortCause).toBe('soft');
    // Every tu completed (D173): the batch is atomic per step.
    // Tracker max=3 confirms parallel execution went through;
    // reaching tracker.max=3 requires all three to be in flight,
    // which can't happen if we shortcut some via soft-stop.
    expect(tracker.max).toBe(3);
    // Only one provider request — soft-stop bailed before the
    // second turn.
    expect(handle.requests).toHaveLength(1);
  });

  test('hard abort mid-batch stops dispatch of queued tool_uses (D223)', async () => {
    // Regression: `runPool` had no abort check before
    // dequeuing the next index, so workers continued to
    // invoke queued tool_uses after `signal.aborted` flipped.
    // The serial path checks `signal.aborted` at the top of
    // each iteration; the parallel path now mirrors that
    // check inside `safeInvokeOne`. A tool that doesn't
    // self-cancel via `ctx.signal` would otherwise still run
    // its side effects after Ctrl+C.
    //
    // Test setup: 5 tool_uses, cap=2, each tool delays 1s.
    // Fire abort at 30ms — workers A and B grabbed tu1/tu2
    // and entered execute; their sleep rejects on the abort.
    // Tu3-5 are queued. Without the fix, runPool would
    // dispatch them too (even though they'd fail-fast at
    // sleep, they'd still increment the invocation counter
    // and run any pre-sleep side effects). With the fix,
    // safeInvokeOne returns the abort-skipped placeholder
    // BEFORE invokeOne fires.
    let totalInvoked = 0;
    const counted: Tool<{ msg?: string }, { echoed: string }> = {
      name: 'p_count',
      description: 'parallel-safe counter that delays',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      metadata: {
        category: 'misc',
        writes: false,
        idempotent: true,
        parallel_safe: true,
      },
      async execute(args, ctx) {
        totalInvoked += 1; // increment FIRST so even an
        // immediately-aborted run leaves a trace.
        await sleep(1000, ctx.signal);
        return { echoed: args.msg ?? 'p_count' };
      },
    };
    const ctrl = new AbortController();
    const { config } = buildConfig(
      [
        {
          tool_uses: Array.from({ length: 5 }, (_, i) => ({
            id: `tu${i + 1}`,
            name: 'p_count',
            input: { msg: String(i) },
          })),
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
      {
        tools: [counted],
        signal: ctrl.signal,
        budget: { maxConcurrentToolCalls: 2 },
      },
    );
    const runPromise = runAgent(config);
    setTimeout(() => ctrl.abort(), 30);
    const result = await runPromise;
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('aborted');
    // The load-bearing assertion: only the workers that had
    // already entered execute count. With cap=2 and the abort
    // firing after both workers entered, totalInvoked is 2.
    // Without the fix, queued tu3-5 also dispatch (even if
    // they fail-fast inside sleep), so totalInvoked would
    // climb to 5.
    expect(totalInvoked).toBeLessThanOrEqual(2);
  });

  test('hard abort during parallel batch resolves as aborted', async () => {
    const ctrl = new AbortController();
    const slow = parallelEcho('p_slow', { delayMs: 200 });
    const { config } = buildConfig(
      [
        {
          tool_uses: [
            { id: 'tu1', name: 'p_slow', input: {} },
            { id: 'tu2', name: 'p_slow', input: {} },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
      { tools: [slow], signal: ctrl.signal },
    );
    // Fire the abort just after the parallel batch starts. The tools
    // wake on signal.aborted and return ToolError aborted; the harness
    // sees signal.aborted at the next step boundary and bails.
    const runPromise = runAgent(config);
    setTimeout(() => ctrl.abort(), 20);
    const result = await runPromise;
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('aborted');
    expect(result.abortCause).toBe('hard');
  });

  test('concurrency cap honored: batch of 5 with cap=2 never has more than 2 in flight', async () => {
    const tracker = makeTracker();
    const tool = parallelEcho('p_read', { delayMs: 30, tracker });
    const { config } = buildConfig(
      [
        {
          tool_uses: Array.from({ length: 5 }, (_, i) => ({
            id: `tu${i + 1}`,
            name: 'p_read',
            input: { msg: String(i) },
          })),
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
      { tools: [tool], budget: { maxConcurrentToolCalls: 2 } },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(tracker.max).toBe(2);
  });

  test('degenerate-loop check fires pre-batch even when all parallel_safe', async () => {
    // 3 identical parallel-safe calls in one step — hash window has
    // 3 of the same hash after the precheck, which triggers
    // degenerateLoop BEFORE any tool runs.
    const tracker = makeTracker();
    const tool = parallelEcho('p_read', { delayMs: 50, tracker });
    const { config } = buildConfig(
      [
        {
          tool_uses: [
            { id: 'tu1', name: 'p_read', input: { msg: 'same' } },
            { id: 'tu2', name: 'p_read', input: { msg: 'same' } },
            { id: 'tu3', name: 'p_read', input: { msg: 'same' } },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'never', stop_reason: 'end_turn' },
      ],
      { tools: [tool], budget: { maxRepeatedToolHash: 3 } },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('error');
    expect(result.reason).toBe('degenerateLoop');
    // Bailed before dispatch — tracker shows zero work landed.
    expect(tracker.max).toBe(0);
  });

  test('budget cap=1 forces serial path (no parallel branch entered)', async () => {
    const tracker = makeTracker();
    const tool = parallelEcho('p_read', { delayMs: 30, tracker });
    const { config } = buildConfig(
      [
        {
          tool_uses: [
            { id: 'tu1', name: 'p_read', input: {} },
            { id: 'tu2', name: 'p_read', input: {} },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
      { tools: [tool], budget: { maxConcurrentToolCalls: 1 } },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(tracker.max).toBe(1);
  });

  test('single tool_use never enters the parallel branch', async () => {
    const tracker = makeTracker();
    const tool = parallelEcho('p_read', { delayMs: 30, tracker });
    const { config } = buildConfig(
      [
        {
          tool_uses: [{ id: 'tu1', name: 'p_read', input: {} }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
      { tools: [tool], budget: { maxConcurrentToolCalls: 5 } },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(tracker.max).toBe(1);
  });

  test('one tool_invoking + tool_finished event per parallel call', async () => {
    // Sanity: parallel branch must fire one tool_invoking event per
    // tool_use exactly once. Capture the events stream via onEvent.
    // Inputs must be distinct or the degenerate-loop precheck fires
    // before dispatch — that's a separate test (above).
    const tool = parallelEcho('p_read', { delayMs: 5 });
    const events: string[] = [];
    const { config } = buildConfig(
      [
        {
          tool_uses: [
            { id: 'tu1', name: 'p_read', input: { msg: '1' } },
            { id: 'tu2', name: 'p_read', input: { msg: '2' } },
            { id: 'tu3', name: 'p_read', input: { msg: '3' } },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
      { tools: [tool] },
    );
    const cfgWithEvents = {
      ...config,
      onEvent: (ev: { type: string }) => {
        events.push(ev.type);
      },
    };
    const result = await runAgent(cfgWithEvents);
    expect(result.status).toBe('done');
    const invokings = events.filter((t) => t === 'tool_invoking').length;
    const finished = events.filter((t) => t === 'tool_finished').length;
    expect(invokings).toBe(3);
    expect(finished).toBe(3);
  });
});
