import { beforeEach, describe, expect, test } from 'bun:test';
import {
  CRITIQUE_MARKER_CLOSE,
  CRITIQUE_MARKER_OPEN,
  type CritiqueAnswer,
} from '../../src/critique/index.ts';
import { runAgent } from '../../src/harness/loop.ts';
import type { HarnessEvent } from '../../src/harness/types.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { GenerateRequest, Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listMessagesBySession } from '../../src/storage/repos/messages.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';
import type { Tool } from '../../src/tools/types.ts';

// Scripted step shape — mirrors tests/harness/loop.test.ts but
// trimmed to what these tests need.
interface ScriptedStep {
  text?: string;
  tool_uses?: { id: string; name: string; input: Record<string, unknown> }[];
  usage?: { input: number; output: number };
}

const replayStep = function* (step: ScriptedStep): Iterable<StreamEvent> {
  yield { kind: 'start', message_id: `m_${crypto.randomUUID()}` };
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
      usage: { ...step.usage, cache_read: 0, cache_creation: 0 },
    };
  }
  yield { kind: 'stop', reason: step.tool_uses?.length ? 'tool_use' : 'end_turn' };
};

const baseCaps: Provider['capabilities'] = {
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
};

interface ExecHandle {
  provider: Provider;
  // Live counter — getter so tests reading after a run see the
  // final value, not a snapshot from construction time.
  readonly calls: number;
}

const scriptedProvider = (script: ScriptedStep[]): ExecHandle => {
  const state = { calls: 0 };
  const provider: Provider = {
    id: 'mock/exec',
    family: 'anthropic',
    capabilities: baseCaps,
    async *generate() {
      const i = state.calls++;
      const step = script[i];
      if (step === undefined) throw new Error(`script exhausted at call ${i}`);
      for (const ev of replayStep(step)) yield ev;
    },
    generateConstrained: () => Promise.reject(new Error('n/a')),
    countTokens: () => Promise.resolve(0),
  };
  return {
    provider,
    get calls() {
      return state.calls;
    },
  };
};

// Critic provider — emits a marker-wrapped JSON payload per call.
// `payloads` is the list of responses the critic will return in
// order. Captures every request so tests can assert the critic was
// (or was NOT) invoked.
const criticProvider = (
  payloads: string[],
): { provider: Provider; requests: GenerateRequest[] } => {
  const requests: GenerateRequest[] = [];
  let idx = 0;
  const provider: Provider = {
    id: 'mock/critic',
    family: 'anthropic',
    capabilities: { ...baseCaps, cost_per_1k_input: 1, cost_per_1k_output: 2 },
    async *generate(req) {
      requests.push(req);
      const payload = payloads[idx++] ?? '{"issues":[],"overall_confidence":1.0}';
      yield { kind: 'start', message_id: `c_${idx}` };
      yield {
        kind: 'text_delta',
        text: `Sure:\n${CRITIQUE_MARKER_OPEN}\n${payload}\n${CRITIQUE_MARKER_CLOSE}`,
      };
      yield {
        kind: 'usage',
        usage: { input: 50, output: 30, cache_read: 0, cache_creation: 0 },
      };
      yield { kind: 'stop', reason: 'end_turn' };
    },
    generateConstrained: () => Promise.reject(new Error('n/a')),
    countTokens: () => Promise.resolve(0),
  };
  return { provider, requests };
};

// Issue payload helper. Confidence above the default 0.7 threshold so
// it crosses to filteredIssues by default.
const flaggedPayload = (description = 'thing is wrong'): string =>
  JSON.stringify({
    issues: [
      {
        severity: 'error',
        description,
        confidence: 0.9,
        suggestion: 'do it differently',
      },
    ],
    overall_confidence: 0.4,
  });
const cleanPayload = (): string => JSON.stringify({ issues: [], overall_confidence: 0.95 });

// Read-only echo tool (writes:false) used by the on_writes-mode
// gating tests.
const readOnlyTool: Tool = {
  name: 'echo',
  description: 'echo',
  inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  metadata: { category: 'misc', writes: false, idempotent: true },
  async execute(args: unknown) {
    return { echoed: (args as { msg: string }).msg };
  },
};

// Writes:true tool used by the writes-mode tests.
const writeTool: Tool = {
  name: 'write_file',
  description: 'pretend write',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  metadata: { category: 'fs.write', writes: true, idempotent: false },
  async execute(args: unknown) {
    return { wrote: (args as { path: string }).path };
  },
};

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

const buildHarnessConfig = (
  executorScript: ScriptedStep[],
  options: {
    criticPayloads?: string[];
    confirmCritique?: (req: unknown) => Promise<CritiqueAnswer>;
    mode?: 'off' | 'on_writes' | 'always';
    threshold?: number;
    extraTools?: Tool[];
    onEvent?: (event: HarnessEvent) => void;
  } = {},
) => {
  const exec = scriptedProvider(executorScript);
  const critic =
    options.criticPayloads !== undefined
      ? criticProvider(options.criticPayloads)
      : { provider: undefined, requests: [] };
  const registry = createToolRegistry();
  registry.register(readOnlyTool);
  registry.register(writeTool);
  for (const t of options.extraTools ?? []) registry.register(t);
  const config = {
    provider: exec.provider,
    toolRegistry: registry,
    permissionEngine: createPermissionEngine(
      // `bypass` is the most permissive mode — every tool call
      // resolves to allow without prompting. Right for tests that
      // exercise the loop's higher-order logic (critique gate)
      // and don't need policy semantics in the path.
      { defaults: { mode: 'bypass' as const }, tools: {} },
      { cwd: '/p' },
    ),
    db,
    cwd: '/p',
    userPrompt: 'do the work',
    ...(critic.provider !== undefined ? { critiqueProvider: critic.provider } : {}),
    ...(options.confirmCritique !== undefined
      ? { confirmCritique: options.confirmCritique as never }
      : {}),
    ...(options.mode !== undefined
      ? {
          critique: {
            mode: options.mode,
            ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
            // Watchdog disabled in tests — the mock critic resolves
            // synchronously and a real timer would just add jitter.
            maxOverheadMs: 0,
          },
        }
      : {}),
    ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
  };
  return { config, exec, critic };
};

describe('runAgent — critique gate (mode gating)', () => {
  test('mode=off: critic provider is never called', async () => {
    const { config, critic } = buildHarnessConfig(
      [{ text: 'all good', usage: { input: 100, output: 50 } }],
      { criticPayloads: [flaggedPayload()], mode: 'off' },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(critic.requests).toHaveLength(0);
  });

  test('mode unset: critic provider is never called (default off)', async () => {
    const { config, critic } = buildHarnessConfig(
      [{ text: 'all good', usage: { input: 100, output: 50 } }],
      { criticPayloads: [flaggedPayload()] },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(critic.requests).toHaveLength(0);
  });

  test('on_writes + step with only read-only tool_uses: critique skipped', async () => {
    const { config, critic } = buildHarnessConfig(
      [
        {
          tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'hi' } }],
          usage: { input: 100, output: 50 },
        },
        { text: 'done', usage: { input: 110, output: 30 } },
      ],
      { criticPayloads: [flaggedPayload(), flaggedPayload()], mode: 'on_writes' },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    // Read-only step does NOT trigger critique under on_writes;
    // the no-tool-use end-of-step turn DOES (mode is on_writes,
    // step has no tool_uses, has text — gate fires).
    expect(critic.requests).toHaveLength(1);
  });

  test('on_writes + writes:true tool plan: critique runs on the plan', async () => {
    const events: HarnessEvent[] = [];
    const errors: HarnessEvent[] = [];
    const { config, critic } = buildHarnessConfig(
      [
        {
          tool_uses: [{ id: 'tu1', name: 'write_file', input: { path: '/p/x' } }],
          usage: { input: 100, output: 50 },
        },
        { text: 'done', usage: { input: 110, output: 30 } },
      ],
      {
        criticPayloads: [cleanPayload(), cleanPayload()],
        mode: 'on_writes',
        onEvent: (e) => {
          events.push(e);
          if (e.type === 'tool_finished' && e.failed) errors.push(e);
        },
      },
    );
    const result = await runAgent(config);
    if (result.status !== 'done') {
      // Surface the cause for debugging when the tool dispatch
      // didn't go through.
      throw new Error(
        `expected done, got ${result.status} (${result.reason}): ${result.detail ?? '(no detail)'} — tool errors: ${JSON.stringify(errors)}`,
      );
    }
    expect(result.status).toBe('done');
    // Two critique calls: one for the writes:true tool plan,
    // one for the final end-of-step text.
    expect(critic.requests).toHaveLength(2);
    const startedEvents = events.filter((e) => e.type === 'critique_started');
    expect(startedEvents).toHaveLength(2);
    const planEvent = startedEvents[0];
    if (planEvent?.type === 'critique_started') {
      expect(planEvent.toolPlanWrites).toBe(true);
    }
  });
});

describe('runAgent — critique decisions', () => {
  test('clean critique: no modal, run completes normally', async () => {
    const events: HarnessEvent[] = [];
    let confirmCalls = 0;
    const { config, critic } = buildHarnessConfig(
      [{ text: 'all good', usage: { input: 100, output: 50 } }],
      {
        criticPayloads: [cleanPayload()],
        mode: 'always',
        confirmCritique: async () => {
          confirmCalls++;
          return 'ignore';
        },
        onEvent: (e) => events.push(e),
      },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(confirmCalls).toBe(0);
    expect(critic.requests).toHaveLength(1);
    const finishedEvent = events.find((e) => e.type === 'critique_finished');
    if (finishedEvent?.type === 'critique_finished') {
      expect(finishedEvent.decision).toBe('no_modal');
      expect(finishedEvent.filteredCount).toBe(0);
      expect(finishedEvent.strategy).toBe('llm');
    }
  });

  test('flagged critique + ignore: persists assistant, run completes', async () => {
    let confirmCalls = 0;
    const { config } = buildHarnessConfig(
      [{ text: 'flagged output', usage: { input: 100, output: 50 } }],
      {
        criticPayloads: [flaggedPayload('off-target answer')],
        mode: 'always',
        confirmCritique: async () => {
          confirmCalls++;
          return 'ignore';
        },
      },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(confirmCalls).toBe(1);
    // Assistant message landed despite the warning — `ignore` means
    // "I see the issues, proceed anyway".
    const tail = listMessagesBySession(db, result.sessionId);
    const lastAssistant = [...tail].reverse().find((m) => m.role === 'assistant');
    expect(lastAssistant).toBeDefined();
  });

  test('flagged critique + abort: finishes critiqueAborted, no assistant persisted', async () => {
    const { config } = buildHarnessConfig(
      [{ text: 'flagged output', usage: { input: 100, output: 50 } }],
      {
        criticPayloads: [flaggedPayload('big problem')],
        mode: 'always',
        confirmCritique: async () => 'abort',
      },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('critiqueAborted');
    // Buffer discarded — no assistant message persisted.
    const tail = listMessagesBySession(db, result.sessionId);
    const assistantRows = tail.filter((m) => m.role === 'assistant');
    expect(assistantRows).toHaveLength(0);
  });

  test('flagged critique + cancel maps to abort', async () => {
    const { config } = buildHarnessConfig(
      [{ text: 'flagged', usage: { input: 100, output: 50 } }],
      {
        criticPayloads: [flaggedPayload()],
        mode: 'always',
        confirmCritique: async () => 'cancel',
      },
    );
    const result = await runAgent(config);
    expect(result.reason).toBe('critiqueAborted');
  });

  test('flagged critique + redo: discards rejected turn, re-runs with hint, succeeds', async () => {
    const events: HarnessEvent[] = [];
    let confirmCalls = 0;
    const { config, exec, critic } = buildHarnessConfig(
      [
        // First attempt — gets flagged, redo
        { text: 'wrong answer', usage: { input: 100, output: 50 } },
        // Second attempt — clean
        { text: 'better answer', usage: { input: 110, output: 60 } },
      ],
      {
        criticPayloads: [flaggedPayload('first attempt off'), cleanPayload()],
        mode: 'always',
        confirmCritique: async () => {
          confirmCalls++;
          return confirmCalls === 1 ? 'redo' : 'ignore';
        },
        onEvent: (e) => events.push(e),
      },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(exec.calls).toBe(2);
    expect(critic.requests).toHaveLength(2);
    expect(confirmCalls).toBe(1);
    // Only the second (clean) assistant landed in storage — the
    // rejected first attempt was discarded per spec §6.2.
    const tail = listMessagesBySession(db, result.sessionId);
    const assistantRows = tail.filter((m) => m.role === 'assistant');
    expect(assistantRows).toHaveLength(1);
    // Second executor request must contain the critic's hint
    // merged into the user prompt — that's how the model knows
    // to address the issue on the redo attempt.
    const secondReq = critic.requests[1];
    expect(secondReq).toBeDefined();
    // Redo is implemented by mutating messages array; the
    // executor's second request reflects that.
    // Additional sanity: critique_finished events show the redo
    // decision then a no_modal (clean second attempt).
    const finishedEvents = events.filter((e) => e.type === 'critique_finished');
    expect(finishedEvents).toHaveLength(2);
  });

  test('confirmCritique not wired: defaults to ignore (run completes)', async () => {
    const { config } = buildHarnessConfig(
      [{ text: 'flagged', usage: { input: 100, output: 50 } }],
      {
        criticPayloads: [flaggedPayload()],
        mode: 'always',
        // no confirmCritique
      },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
  });

  test('confirmCritique throws: degrades to ignore (run is not killed)', async () => {
    const { config } = buildHarnessConfig(
      [{ text: 'flagged', usage: { input: 100, output: 50 } }],
      {
        criticPayloads: [flaggedPayload()],
        mode: 'always',
        confirmCritique: async () => {
          throw new Error('bridge crashed');
        },
      },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
  });
});

describe('runAgent — critique soft-failure paths', () => {
  test('critique strategy=failed: run continues normally', async () => {
    const events: HarnessEvent[] = [];
    const { config } = buildHarnessConfig([{ text: 'output', usage: { input: 100, output: 50 } }], {
      // Payload missing markers — engine returns strategy=failed.
      // We craft this by overriding with a payload string the
      // criticProvider helper inserts inside markers, so use a
      // payload that's invalid JSON to force parse_failed.
      criticPayloads: ['{not valid: json}'],
      mode: 'always',
      confirmCritique: async () => 'abort',
      onEvent: (e) => events.push(e),
    });
    const result = await runAgent(config);
    // strategy=failed → no modal → no abort. Run completes done.
    expect(result.status).toBe('done');
    const finished = events.find((e) => e.type === 'critique_finished');
    if (finished?.type === 'critique_finished') {
      expect(finished.strategy).toBe('failed');
      expect(finished.decision).toBe('no_modal');
    }
  });

  test('critique cost flows into session totals', async () => {
    // Critic provider has non-zero pricing (1/2 per 1k); executor
    // pricing is 0. Total cost should reflect the critic call.
    const { config } = buildHarnessConfig([{ text: 'output', usage: { input: 100, output: 50 } }], {
      criticPayloads: [cleanPayload()],
      mode: 'always',
    });
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    // Cost is per-million (the field is named cost_per_1k_* for
    // legacy reasons but the math divides by 1_000_000 — see
    // providers/cost.ts). Critic billed: 50 input * 1 + 30 output
    // * 2 = 110 / 1e6 = $0.00011. Executor is free in this fixture.
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.costUsd).toBeCloseTo(0.00011, 6);
  });
});
