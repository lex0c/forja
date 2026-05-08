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
import { listCritiqueRunsBySession } from '../../src/storage/repos/critique-runs.ts';
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
  // Captured request payloads, in call order. Lets tests verify
  // what messages reached the executor (e.g. that a critique-redo
  // hint was actually merged into the user side of the next call).
  readonly requests: readonly GenerateRequest[];
}

const scriptedProvider = (script: ScriptedStep[]): ExecHandle => {
  const state = { calls: 0 };
  const requests: GenerateRequest[] = [];
  const provider: Provider = {
    id: 'mock/exec',
    family: 'anthropic',
    capabilities: baseCaps,
    async *generate(req) {
      requests.push(req);
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
    get requests() {
      return requests;
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
        criticPayloads: [flaggedPayload('first attempt off-target'), cleanPayload()],
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
    // The hint MUST reach the executor on the second attempt —
    // that's how the model knows what to address. Walk the second
    // executor request's messages and confirm the hint phrase
    // landed in the user-side content. Matches the loop's merge
    // rule: when the tail user message is a string, the hint is
    // appended to it; the second exec call's last user message
    // therefore contains both the original prompt and the hint.
    const secondExecReq = exec.requests[1];
    expect(secondExecReq).toBeDefined();
    const tailUserMsg = secondExecReq?.messages[secondExecReq.messages.length - 1];
    expect(tailUserMsg?.role).toBe('user');
    const flatContent =
      typeof tailUserMsg?.content === 'string'
        ? tailUserMsg.content
        : (tailUserMsg?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(flatContent).toContain('reviewed by a critic');
    expect(flatContent).toContain('first attempt off-target');
    // Sanity: critique_finished events fire twice (one per
    // critic call) — first with redo decision, second with
    // no_modal because the retry was clean.
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

describe('runAgent — critique audit rows (migration 031)', () => {
  test('clean critique persists row with code=critique.clean', async () => {
    const { config } = buildHarnessConfig(
      [{ text: 'all good', usage: { input: 100, output: 50 } }],
      { criticPayloads: [cleanPayload()], mode: 'always' },
    );
    const result = await runAgent(config);
    const rows = listCritiqueRunsBySession(db, result.sessionId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.code).toBe('critique.clean');
    expect(row?.strategy).toBe('llm');
    expect(row?.decision).toBe('no_modal');
    expect(row?.filteredCount).toBe(0);
    expect(row?.toolPlanWrites).toBe(false);
    // Threshold matches DEFAULT_CRITIQUE_CONFIG (currently 0.85
    // post-real-eval calibration). Pinned via the constant so a
    // future change to the production default doesn't ask this
    // test to update silently.
    const { DEFAULT_CRITIQUE_CONFIG, DEFAULT_CRITIQUE_PROMPT_VERSION } = await import(
      '../../src/critique/index.ts'
    );
    expect(row?.threshold).toBe(DEFAULT_CRITIQUE_CONFIG.threshold);
    // Operator left promptVersion unset; audit row must record
    // the version that ACTUALLY ran (resolved by the engine),
    // not a hardcoded fallback. Pinned via the constant so the
    // V1 → V2 → V3 progression keeps this assertion honest.
    expect(row?.promptVersion).toBe(DEFAULT_CRITIQUE_PROMPT_VERSION);
  });

  test('flagged + ignore persists row with code=critique.warning_ignored', async () => {
    const { config } = buildHarnessConfig(
      [{ text: 'flagged', usage: { input: 100, output: 50 } }],
      {
        criticPayloads: [flaggedPayload()],
        mode: 'always',
        confirmCritique: async () => 'ignore',
      },
    );
    const result = await runAgent(config);
    const rows = listCritiqueRunsBySession(db, result.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.code).toBe('critique.warning_ignored');
    expect(rows[0]?.decision).toBe('ignore');
    expect(rows[0]?.filteredCount).toBeGreaterThan(0);
  });

  test('flagged + abort persists row with code=critique.warning_abort', async () => {
    const { config } = buildHarnessConfig(
      [{ text: 'flagged', usage: { input: 100, output: 50 } }],
      {
        criticPayloads: [flaggedPayload()],
        mode: 'always',
        confirmCritique: async () => 'abort',
      },
    );
    const result = await runAgent(config);
    const rows = listCritiqueRunsBySession(db, result.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.code).toBe('critique.warning_abort');
    expect(rows[0]?.decision).toBe('abort');
  });

  test('flagged + cancel persists row with code=critique.warning_abort', async () => {
    const { config } = buildHarnessConfig(
      [{ text: 'flagged', usage: { input: 100, output: 50 } }],
      {
        criticPayloads: [flaggedPayload()],
        mode: 'always',
        confirmCritique: async () => 'cancel',
      },
    );
    const result = await runAgent(config);
    const rows = listCritiqueRunsBySession(db, result.sessionId);
    // cancel collapses to warning_abort at the audit layer (decision
    // stays 'cancel' so audit can still tell explicit-rejection from
    // passive-cancel via that field — code is the higher-level
    // grouping spec line 552 wants).
    expect(rows[0]?.code).toBe('critique.warning_abort');
    expect(rows[0]?.decision).toBe('cancel');
  });

  test('flagged + redo persists TWO rows: warning_redo on the rejected turn, then warning_ignored or clean on the retry', async () => {
    let confirmCalls = 0;
    const { config } = buildHarnessConfig(
      [
        { text: 'wrong', usage: { input: 100, output: 50 } },
        { text: 'better', usage: { input: 110, output: 60 } },
      ],
      {
        criticPayloads: [flaggedPayload(), cleanPayload()],
        mode: 'always',
        confirmCritique: async () => {
          confirmCalls++;
          return confirmCalls === 1 ? 'redo' : 'ignore';
        },
      },
    );
    const result = await runAgent(config);
    const rows = listCritiqueRunsBySession(db, result.sessionId);
    expect(rows).toHaveLength(2);
    // Order is by step_n then created_at — the redo row lands
    // first (step_n smaller), the retry's clean row second.
    expect(rows[0]?.code).toBe('critique.warning_redo');
    expect(rows[0]?.decision).toBe('redo');
    expect(rows[1]?.code).toBe('critique.clean');
    expect(rows[1]?.decision).toBe('no_modal');
  });

  test('strategy=failed persists row with code=critique.failed AND reason', async () => {
    const { config } = buildHarnessConfig([{ text: 'output', usage: { input: 100, output: 50 } }], {
      criticPayloads: ['{not valid: json}'],
      mode: 'always',
    });
    const result = await runAgent(config);
    const rows = listCritiqueRunsBySession(db, result.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.code).toBe('critique.failed');
    expect(rows[0]?.strategy).toBe('failed');
    expect(rows[0]?.reason).toBe('parse_failed');
  });

  test('on_writes + writes:true tool plan: row carries tool_plan_writes=true', async () => {
    const { config } = buildHarnessConfig(
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
      },
    );
    const result = await runAgent(config);
    const rows = listCritiqueRunsBySession(db, result.sessionId);
    expect(rows).toHaveLength(2);
    // First row: tool plan critique (toolPlanWrites=true).
    expect(rows[0]?.toolPlanWrites).toBe(true);
    // Second row: end-of-step text critique (no plan).
    expect(rows[1]?.toolPlanWrites).toBe(false);
    expect(rows.every((r) => r.mode === 'on_writes')).toBe(true);
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

  test('critique without usage event flips usageComplete to false', async () => {
    // The critic engine ALWAYS issues a provider.generate request.
    // When the adapter doesn't emit a `usage` event (compat
    // endpoints that drop stream_options, mid-stream errors, older
    // SDKs), the call still bills tokens but our session totals
    // cannot account for them — same lower-bound rule the executor
    // and compaction enforce. This test pins the contract: a
    // missing usage event MUST flip usageComplete on the
    // HarnessResult.
    //
    // Built inline (vs criticProvider helper) because the helper
    // always emits usage; the whole point of this fixture is the
    // missing event.
    const noUsageCritic: Provider = {
      id: 'mock/critic-no-usage',
      family: 'anthropic',
      capabilities: { ...baseCaps, cost_per_1k_input: 1, cost_per_1k_output: 2 },
      async *generate() {
        yield { kind: 'start', message_id: 'cnu' };
        yield {
          kind: 'text_delta',
          text: `${CRITIQUE_MARKER_OPEN}\n{"issues":[],"overall_confidence":1.0}\n${CRITIQUE_MARKER_CLOSE}`,
        };
        // Intentionally NO `usage` event before stop.
        yield { kind: 'stop', reason: 'end_turn' };
      },
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };

    const exec = scriptedProvider([{ text: 'output', usage: { input: 100, output: 50 } }]);
    const registry = createToolRegistry();
    registry.register(readOnlyTool);
    const config = {
      provider: exec.provider,
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(
        { defaults: { mode: 'bypass' as const }, tools: {} },
        { cwd: '/p' },
      ),
      db,
      cwd: '/p',
      userPrompt: 'do the work',
      critiqueProvider: noUsageCritic,
      critique: { mode: 'always' as const, maxOverheadMs: 0 },
    };
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    // Executor reported usage cleanly. Critic did NOT — session
    // totals are now a lower bound.
    expect(result.usageComplete).toBe(false);
  });

  test('caller abort during critique folds partial usage into session totals', async () => {
    // The engine reports usage in CritiqueResult on the soft-fail
    // paths (skipped/failed) but RETHROWS on caller-driven abort,
    // so the loop has to recover any partial usage attached to the
    // CollectStepError before the rethrow propagates to
    // guardedFinish. Without that recovery, billed critic tokens
    // emitted BEFORE the abort drop out of session totals — the
    // operator pays, the audit doesn't see.
    //
    // Critic provider here:
    //   1. Yields start + a usage event (provider already billed),
    //   2. Triggers the harness's abort signal,
    //   3. Stalls forever — the abort propagates through
    //      abortableIterable, collectStep wraps the AbortError in
    //      CollectStepError with partial.usage attached, the
    //      engine rethrows, the loop catches and folds, and
    //      guardedFinish maps the in-flight signal.aborted to
    //      `aborted` for the HarnessResult.
    const abortCtrl = new AbortController();
    const partialUsageCritic: Provider = {
      id: 'mock/critic-partial-then-abort',
      family: 'anthropic',
      capabilities: { ...baseCaps, cost_per_1k_input: 1, cost_per_1k_output: 2 },
      async *generate() {
        yield { kind: 'start', message_id: 'cab' };
        yield {
          kind: 'usage',
          usage: { input: 50, output: 30, cache_read: 0, cache_creation: 0 },
        };
        // Provider has now reported usage. Trip the harness signal
        // — abortableIterable's onAbort listener fires the
        // internal AbortController, the next .next() pull rejects
        // with AbortError.
        abortCtrl.abort();
        // Stall to give the abort time to propagate through the
        // wrapped iterator chain; never resolves on its own.
        await new Promise<never>(() => {});
        yield { kind: 'stop', reason: 'end_turn' };
      },
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };

    const events: HarnessEvent[] = [];
    const exec = scriptedProvider([{ text: 'output', usage: { input: 100, output: 50 } }]);
    const registry = createToolRegistry();
    registry.register(readOnlyTool);
    const config = {
      provider: exec.provider,
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(
        { defaults: { mode: 'bypass' as const }, tools: {} },
        { cwd: '/p' },
      ),
      db,
      cwd: '/p',
      userPrompt: 'do the work',
      critiqueProvider: partialUsageCritic,
      critique: { mode: 'always' as const, maxOverheadMs: 0 },
      signal: abortCtrl.signal,
      onEvent: (e: HarnessEvent) => events.push(e),
    };
    const result = await runAgent(config);
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('aborted');
    expect(result.usageComplete).toBe(false);
    // Partial cost MUST be folded in — 50 input * 1 + 30 output * 2
    // = 110 / 1e6 = $0.00011. Executor pricing is 0. Without the
    // recovery, this would be 0.
    expect(result.costUsd).toBeCloseTo(0.00011, 6);

    // Critique_finished MUST fire on the abort path so the REPL's
    // cumulative.critiqueCostUsd tracker (cli/repl.ts) sees the
    // partial spend. Without this emit, /cost would show the
    // partial in the session total but NOT in the critique
    // subtotal — operator hits Ctrl+C and the breakdown lies.
    const finished = events.find((e) => e.type === 'critique_finished') as
      | Extract<HarnessEvent, { type: 'critique_finished' }>
      | undefined;
    expect(finished).toBeDefined();
    if (finished === undefined) return;
    expect(finished.strategy).toBe('failed');
    expect(finished.reason).toBe('caller_aborted');
    // Same partial cost the session total recovered.
    expect(finished.costUsd).toBeCloseTo(0.00011, 6);
    expect(finished.decision).toBe('no_modal');
  });
});
