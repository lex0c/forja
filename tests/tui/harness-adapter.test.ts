import { describe, expect, test } from 'bun:test';
import type { HarnessEvent, HarnessResult } from '../../src/harness/types.ts';
import type { UIEvent } from '../../src/tui/events.ts';
import { type HarnessAdapterCtx, createHarnessAdapter } from '../../src/tui/harness-adapter.ts';

const baseCtx = (): HarnessAdapterCtx => {
  let counter = 1000;
  return {
    profile: 'autonomous',
    project: 'forja',
    model: 'anthropic/claude-sonnet-4-6',
    maxSteps: 50,
    now: () => counter++,
  };
};

const types = (events: UIEvent[]): string[] => events.map((e) => e.type);

describe('harness-adapter — session lifecycle', () => {
  test('session_start emits session:start + initial step:budget', () => {
    const a = createHarnessAdapter(baseCtx());
    const ev: HarnessEvent = { type: 'session_start', sessionId: 'sess-1' };
    const out = a.translate(ev);
    expect(types(out)).toEqual(['session:start', 'step:budget']);
    const start = out[0] as Extract<UIEvent, { type: 'session:start' }>;
    expect(start.sessionId).toBe('sess-1');
    expect(start.profile).toBe('autonomous');
    expect(start.project).toBe('forja');
    expect(start.model).toBe('anthropic/claude-sonnet-4-6');
    const budget = out[1] as Extract<UIEvent, { type: 'step:budget' }>;
    expect(budget.steps).toBe(0);
    expect(budget.maxSteps).toBe(50);
    expect(budget.costUsd).toBe(0);
    expect(budget.maxCostUsd).toBeUndefined();
  });

  test('maxCostUsd is forwarded into step:budget when set', () => {
    const a = createHarnessAdapter({ ...baseCtx(), maxCostUsd: 1.5 });
    const out = a.translate({ type: 'session_start', sessionId: 's' });
    const budget = out.find((e) => e.type === 'step:budget') as Extract<
      UIEvent,
      { type: 'step:budget' }
    >;
    expect(budget.maxCostUsd).toBe(1.5);
  });

  test('planMode in ctx surfaces on session:start.planMode', () => {
    const a = createHarnessAdapter({ ...baseCtx(), planMode: true });
    const out = a.translate({ type: 'session_start', sessionId: 's' });
    const start = out.find((e) => e.type === 'session:start') as Extract<
      UIEvent,
      { type: 'session:start' }
    >;
    expect(start.planMode).toBe(true);
  });

  test('omitted planMode does not include the field on session:start', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({ type: 'session_start', sessionId: 's' });
    const start = out.find((e) => e.type === 'session:start') as Extract<
      UIEvent,
      { type: 'session:start' }
    >;
    expect(start.planMode).toBeUndefined();
  });

  test('step_start bumps steps and emits step:budget', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({ type: 'step_start', stepN: 3 });
    expect(out).toHaveLength(1);
    const b = out[0] as Extract<UIEvent, { type: 'step:budget' }>;
    expect(b.type).toBe('step:budget');
    expect(b.steps).toBe(3);
  });

  test('session_finished emits final step:budget + session:end', () => {
    const a = createHarnessAdapter(baseCtx());
    const result: HarnessResult = {
      status: 'done',
      reason: 'done',
      sessionId: 'sess-1',
      steps: 7,
      durationMs: 1234,
      usage: { input: 100, output: 50, cache_read: 0, cache_creation: 0 },
      costUsd: 0.0123,
      usageComplete: true,
    };
    const out = a.translate({ type: 'session_finished', result });
    expect(types(out)).toEqual(['step:budget', 'session:end']);
    const budget = out[0] as Extract<UIEvent, { type: 'step:budget' }>;
    expect(budget.steps).toBe(7);
    expect(budget.costUsd).toBe(0.0123);
    const end = out[1] as Extract<UIEvent, { type: 'session:end' }>;
    expect(end.reason).toBe('done');
    expect(end.sessionId).toBe('sess-1');
  });

  test('adverse exit reason collapses to error + emits warn detail', () => {
    const a = createHarnessAdapter(baseCtx());
    const result: HarnessResult = {
      status: 'error',
      reason: 'providerError',
      sessionId: 'sess-2',
      steps: 1,
      durationMs: 10,
      usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
      costUsd: 0,
      usageComplete: true,
      detail: '503 from upstream',
    };
    const out = a.translate({ type: 'session_finished', result });
    expect(types(out)).toEqual(['step:budget', 'warn', 'session:end']);
    const warn = out[1] as Extract<UIEvent, { type: 'warn' }>;
    expect(warn.message).toContain('providerError');
    expect(warn.message).toContain('503 from upstream');
    const end = out[2] as Extract<UIEvent, { type: 'session:end' }>;
    expect(end.reason).toBe('error');
  });

  test('session_finished with abortCause threads it onto session:end (1.g.3)', () => {
    const a = createHarnessAdapter(baseCtx());
    const result: HarnessResult = {
      status: 'interrupted',
      reason: 'aborted',
      sessionId: 'sess-3',
      steps: 2,
      durationMs: 50,
      usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
      costUsd: 0,
      usageComplete: true,
      abortCause: 'soft',
    };
    const out = a.translate({ type: 'session_finished', result });
    const end = out.find((e) => e.type === 'session:end') as Extract<
      UIEvent,
      { type: 'session:end' }
    >;
    expect(end.reason).toBe('aborted');
    expect(end.abortCause).toBe('soft');
  });

  test('session_finished without abortCause omits the field (no synthetic value)', () => {
    const a = createHarnessAdapter(baseCtx());
    const result: HarnessResult = {
      status: 'done',
      reason: 'done',
      sessionId: 'sess-4',
      steps: 1,
      durationMs: 10,
      usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
      costUsd: 0,
      usageComplete: true,
    };
    const out = a.translate({ type: 'session_finished', result });
    const end = out.find((e) => e.type === 'session:end') as Extract<
      UIEvent,
      { type: 'session:end' }
    >;
    expect(end.abortCause).toBeUndefined();
  });

  test('session_finished closes a stranded streaming assistant', () => {
    const a = createHarnessAdapter(baseCtx());
    a.translate({
      type: 'provider_event',
      event: { kind: 'start', message_id: 'm1' },
    });
    const result: HarnessResult = {
      status: 'interrupted',
      reason: 'aborted',
      sessionId: 'sess-3',
      steps: 1,
      durationMs: 5,
      usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
      costUsd: 0,
      usageComplete: true,
    };
    const out = a.translate({ type: 'session_finished', result });
    // Order: assistant:end (close stranded) → step:budget → session:end
    expect(types(out)).toEqual(['assistant:end', 'step:budget', 'session:end']);
    const end = out[2] as Extract<UIEvent, { type: 'session:end' }>;
    expect(end.reason).toBe('aborted');
  });

  test('resume_truncated → warn line', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'resume_truncated',
      sessionId: 's',
      kept: 30,
      dropped: 20,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe('warn');
    expect((out[0] as Extract<UIEvent, { type: 'warn' }>).message).toContain('30 of 50');
  });
});

describe('harness-adapter — provider events: text streaming', () => {
  test('start → assistant:start with messageId', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'provider_event',
      event: { kind: 'start', message_id: 'msg-1' },
    });
    expect(types(out)).toEqual(['assistant:start']);
    const e = out[0] as Extract<UIEvent, { type: 'assistant:start' }>;
    expect(e.messageId).toBe('msg-1');
  });

  test('text_delta → assistant:delta inheriting current message', () => {
    const a = createHarnessAdapter(baseCtx());
    a.translate({ type: 'provider_event', event: { kind: 'start', message_id: 'm' } });
    const out = a.translate({
      type: 'provider_event',
      event: { kind: 'text_delta', text: 'hi' },
    });
    expect(types(out)).toEqual(['assistant:delta']);
    const e = out[0] as Extract<UIEvent, { type: 'assistant:delta' }>;
    expect(e.messageId).toBe('m');
    expect(e.text).toBe('hi');
  });

  test('text_delta with no prior start synthesizes assistant:start', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'provider_event',
      event: { kind: 'text_delta', text: 'orphan' },
    });
    expect(types(out)).toEqual(['assistant:start', 'assistant:delta']);
    const start = out[0] as Extract<UIEvent, { type: 'assistant:start' }>;
    const delta = out[1] as Extract<UIEvent, { type: 'assistant:delta' }>;
    expect(delta.messageId).toBe(start.messageId);
  });

  test('stop → assistant:end and clears state', () => {
    const a = createHarnessAdapter(baseCtx());
    a.translate({ type: 'provider_event', event: { kind: 'start', message_id: 'm' } });
    a.translate({ type: 'provider_event', event: { kind: 'text_delta', text: 'x' } });
    const out = a.translate({
      type: 'provider_event',
      event: { kind: 'stop', reason: 'end_turn' },
    });
    expect(types(out)).toEqual(['assistant:end']);
    // A second stop is a no-op (idempotent endAssistant).
    const out2 = a.translate({
      type: 'provider_event',
      event: { kind: 'stop', reason: 'end_turn' },
    });
    expect(out2).toEqual([]);
  });

  test('a new start closes the prior assistant before opening', () => {
    const a = createHarnessAdapter(baseCtx());
    a.translate({ type: 'provider_event', event: { kind: 'start', message_id: 'm1' } });
    const out = a.translate({
      type: 'provider_event',
      event: { kind: 'start', message_id: 'm2' },
    });
    expect(types(out)).toEqual(['assistant:end', 'assistant:start']);
    const end = out[0] as Extract<UIEvent, { type: 'assistant:end' }>;
    expect(end.messageId).toBe('m1');
  });

  test('stream error → ui error event (fatal flag mirrors retryable)', () => {
    const a = createHarnessAdapter(baseCtx());
    const retryable = a.translate({
      type: 'provider_event',
      event: { kind: 'error', code: '503', message: 'busy', retryable: true },
    });
    expect(retryable).toHaveLength(1);
    const r = retryable[0] as Extract<UIEvent, { type: 'error' }>;
    expect(r.fatal).toBeUndefined();
    expect(r.message).toContain('503');
    expect(r.message).toContain('busy');
    const fatal = a.translate({
      type: 'provider_event',
      event: { kind: 'error', code: '400', message: 'bad request', retryable: false },
    });
    expect((fatal[0] as Extract<UIEvent, { type: 'error' }>).fatal).toBe(true);
  });

  test('usage event with prior assistant:start emits assistant:usage with current messageId', () => {
    const a = createHarnessAdapter(baseCtx());
    a.translate({ type: 'provider_event', event: { kind: 'start', message_id: 'mid-7' } });
    const out = a.translate({
      type: 'provider_event',
      event: {
        kind: 'usage',
        usage: { input: 12, output: 234, cache_read: 5, cache_creation: 3 },
      },
    });
    expect(out).toHaveLength(1);
    const ev = out[0] as Extract<UIEvent, { type: 'assistant:usage' }>;
    expect(ev.type).toBe('assistant:usage');
    expect(ev.messageId).toBe('mid-7');
    expect(ev.inputTokens).toBe(12);
    expect(ev.outputTokens).toBe(234);
    expect(ev.cacheRead).toBe(5);
    expect(ev.cacheCreation).toBe(3);
  });

  test('usage event without a prior start is dropped (no synthetic turn)', () => {
    // Out-of-order: better lose one counter than spawn an
    // unattributable assistant lifecycle.
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'provider_event',
      event: {
        kind: 'usage',
        usage: { input: 1, output: 2, cache_read: 0, cache_creation: 0 },
      },
    });
    expect(out).toEqual([]);
  });

  test('usage event AFTER stop is dropped (currentMessageId already cleared)', () => {
    // Anthropic emits usage before stop (verified in
    // providers/anthropic/stream.ts), so this path is defensive
    // against providers (or hypothetical future adapters) that emit
    // usage in the wrong order. Once stop fires, the assistant
    // lifecycle is closed — late usage has nowhere to land.
    // Tracked separately if it becomes a real-world concern with
    // OpenAI/Google.
    const a = createHarnessAdapter(baseCtx());
    a.translate({ type: 'provider_event', event: { kind: 'start', message_id: 'm1' } });
    a.translate({ type: 'provider_event', event: { kind: 'stop', reason: 'end_turn' } });
    const out = a.translate({
      type: 'provider_event',
      event: {
        kind: 'usage',
        usage: { input: 1, output: 2, cache_read: 0, cache_creation: 0 },
      },
    });
    expect(out).toEqual([]);
  });
});

describe('harness-adapter — thinking', () => {
  test('first thinking_delta emits thinking:start + thinking:delta', () => {
    const a = createHarnessAdapter(baseCtx());
    a.translate({ type: 'provider_event', event: { kind: 'start', message_id: 'm' } });
    const out = a.translate({
      type: 'provider_event',
      event: { kind: 'thinking_delta', text: 'hmm' },
    });
    expect(types(out)).toEqual(['thinking:start', 'thinking:delta']);
    const s = out[0] as Extract<UIEvent, { type: 'thinking:start' }>;
    expect(s.messageId).toBe('m');
  });

  test('subsequent thinking_delta does not re-emit thinking:start', () => {
    const a = createHarnessAdapter(baseCtx());
    a.translate({ type: 'provider_event', event: { kind: 'start', message_id: 'm' } });
    a.translate({ type: 'provider_event', event: { kind: 'thinking_delta', text: 'a' } });
    const out = a.translate({
      type: 'provider_event',
      event: { kind: 'thinking_delta', text: 'b' },
    });
    expect(types(out)).toEqual(['thinking:delta']);
  });

  test('text_delta after thinking closes the thinking window', () => {
    const a = createHarnessAdapter(baseCtx());
    a.translate({ type: 'provider_event', event: { kind: 'start', message_id: 'm' } });
    a.translate({ type: 'provider_event', event: { kind: 'thinking_delta', text: 'x' } });
    const out = a.translate({
      type: 'provider_event',
      event: { kind: 'text_delta', text: 'go' },
    });
    expect(types(out)).toEqual(['thinking:end', 'assistant:delta']);
  });

  test('stop also closes thinking', () => {
    const a = createHarnessAdapter(baseCtx());
    a.translate({ type: 'provider_event', event: { kind: 'start', message_id: 'm' } });
    a.translate({ type: 'provider_event', event: { kind: 'thinking_delta', text: 'x' } });
    const out = a.translate({
      type: 'provider_event',
      event: { kind: 'stop', reason: 'end_turn' },
    });
    expect(types(out)).toEqual(['thinking:end', 'assistant:end']);
  });
});

describe('harness-adapter — tool lifecycle', () => {
  test('tool_invoking → tool:start with stringified args', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'tool_invoking',
      toolUseId: 't1',
      toolName: 'read_file',
      args: { path: '/a' },
    });
    expect(types(out)).toEqual(['tool:start']);
    const e = out[0] as Extract<UIEvent, { type: 'tool:start' }>;
    expect(e.toolId).toBe('t1');
    expect(e.name).toBe('read_file');
    // Adapter resolves the tool name via tool-vocab → activeVerb,
    // finalVerb, and a subject extracted from args.
    expect(e.activeVerb).toBe('Reading file');
    expect(e.finalVerb).toBe('Read file');
    expect(e.subject).toBe('/a');
  });

  test('unknown tool falls back to generic Calling/Called verbs and null subject', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'tool_invoking',
      toolUseId: 't1',
      toolName: 'made_up_tool',
      args: { whatever: 'stuff' },
    });
    const e = out[0] as Extract<UIEvent, { type: 'tool:start' }>;
    expect(e.activeVerb).toBe('Calling made_up_tool');
    expect(e.finalVerb).toBe('Called made_up_tool');
    expect(e.subject).toBeNull();
  });

  test('tool_decided is silent; outcome surfaces via tool_finished', () => {
    const a = createHarnessAdapter(baseCtx());
    a.translate({
      type: 'tool_invoking',
      toolUseId: 't1',
      toolName: 'bash',
      args: { command: 'rm -rf /' },
    });
    const out = a.translate({
      type: 'tool_decided',
      toolUseId: 't1',
      decision: { kind: 'deny', reason: 'rule blocked' },
    });
    expect(out).toEqual([]);
  });

  test('tool_finished after deny → tool:end status=denied', () => {
    const a = createHarnessAdapter(baseCtx());
    a.translate({
      type: 'tool_invoking',
      toolUseId: 't1',
      toolName: 'bash',
      args: { command: 'rm' },
    });
    a.translate({
      type: 'tool_decided',
      toolUseId: 't1',
      decision: { kind: 'deny', reason: 'no' },
    });
    const out = a.translate({
      type: 'tool_finished',
      toolUseId: 't1',
      toolName: 'bash',
      failed: true,
      durationMs: 5,
    });
    const e = out[0] as Extract<UIEvent, { type: 'tool:end' }>;
    expect(e.status).toBe('denied');
    expect(e.durationMs).toBe(5);
    // Engine's deny reason flows through as `summary` so the
    // scrollback chip renders the explanation under the chip
    // (`└─ no rule matched ...`) instead of just "Denied".
    expect(e.summary).toBe('no');
  });

  test('user-rejected confirm surfaces an explicit summary on tool:end', () => {
    // For decision.kind === 'confirm' the engine's reason describes
    // the matching rule, not the user's choice — adapter overrides
    // with a fixed string so the operator sees that THEY rejected,
    // not that the policy denied.
    const a = createHarnessAdapter(baseCtx());
    a.translate({
      type: 'tool_invoking',
      toolUseId: 't1',
      toolName: 'edit_file',
      args: { path: '/foo' },
    });
    a.translate({
      type: 'tool_decided',
      toolUseId: 't1',
      decision: { kind: 'confirm', prompt: 'edit /foo?', reason: 'matched confirm rule: **' },
    });
    const out = a.translate({
      type: 'tool_finished',
      toolUseId: 't1',
      toolName: 'edit_file',
      failed: true,
      durationMs: 3,
      denied: true,
    });
    const e = out[0] as Extract<UIEvent, { type: 'tool:end' }>;
    expect(e.status).toBe('denied');
    expect(e.summary).toBe('rejected at confirmation prompt');
  });

  test('tool_finished with denied=true after confirm → tool:end status=denied (regression)', () => {
    // Pre-fix the adapter only checked decision.kind === 'deny'. A
    // user-rejected confirm modal returns failed=true with the
    // ORIGINAL decision still {kind: 'confirm'}, so the adapter
    // mapped it to 'error' — misstating a permission denial as a
    // tool execution failure. The harness now sets denied=true on
    // the tool_finished event for any denial path; the adapter
    // honors that ahead of the legacy decision-kind check.
    const a = createHarnessAdapter(baseCtx());
    a.translate({
      type: 'tool_invoking',
      toolUseId: 't1',
      toolName: 'edit_file',
      args: { path: '/foo' },
    });
    a.translate({
      type: 'tool_decided',
      toolUseId: 't1',
      decision: { kind: 'confirm', prompt: 'edit /foo?' },
    });
    const out = a.translate({
      type: 'tool_finished',
      toolUseId: 't1',
      toolName: 'edit_file',
      failed: true,
      durationMs: 12,
      denied: true,
    });
    const e = out[0] as Extract<UIEvent, { type: 'tool:end' }>;
    expect(e.status).toBe('denied');
  });

  test('tool_finished with denied absent + decision=confirm + failed → falls through to error', () => {
    // Confirm flow where the user APPROVED but the tool errored
    // after execution. denied is absent on the event (because the
    // failure was a real error, not a denial), decision.kind stays
    // 'confirm'. Must map to 'error', not 'denied'. Without this
    // distinction the new branch would over-claim denials.
    const a = createHarnessAdapter(baseCtx());
    a.translate({
      type: 'tool_invoking',
      toolUseId: 't1',
      toolName: 'bash',
      args: { command: 'false' },
    });
    a.translate({
      type: 'tool_decided',
      toolUseId: 't1',
      decision: { kind: 'confirm', prompt: 'run?' },
    });
    const out = a.translate({
      type: 'tool_finished',
      toolUseId: 't1',
      toolName: 'bash',
      failed: true,
      durationMs: 7,
      // denied intentionally omitted — this was an execution error.
    });
    const e = out[0] as Extract<UIEvent, { type: 'tool:end' }>;
    expect(e.status).toBe('error');
  });

  test('tool_finished after allow + failure → status=error', () => {
    const a = createHarnessAdapter(baseCtx());
    a.translate({
      type: 'tool_invoking',
      toolUseId: 't1',
      toolName: 'bash',
      args: {},
    });
    a.translate({
      type: 'tool_decided',
      toolUseId: 't1',
      decision: { kind: 'allow' },
    });
    const out = a.translate({
      type: 'tool_finished',
      toolUseId: 't1',
      toolName: 'bash',
      failed: true,
      durationMs: 10,
    });
    const e = out[0] as Extract<UIEvent, { type: 'tool:end' }>;
    expect(e.status).toBe('error');
  });

  test('tool_finished without prior decision → status from failed flag', () => {
    const a = createHarnessAdapter(baseCtx());
    a.translate({
      type: 'tool_invoking',
      toolUseId: 't1',
      toolName: 'read_file',
      args: { path: '/a' },
    });
    const out = a.translate({
      type: 'tool_finished',
      toolUseId: 't1',
      toolName: 'read_file',
      failed: false,
      durationMs: 3,
    });
    const e = out[0] as Extract<UIEvent, { type: 'tool:end' }>;
    expect(e.status).toBe('done');
  });

  test('tool tracking is dropped after tool_finished', () => {
    // A second tool_finished with the same id falls back to the
    // failed-flag path — proves the per-id state was dropped.
    const a = createHarnessAdapter(baseCtx());
    a.translate({
      type: 'tool_invoking',
      toolUseId: 't1',
      toolName: 'bash',
      args: {},
    });
    a.translate({
      type: 'tool_decided',
      toolUseId: 't1',
      decision: { kind: 'deny', reason: 'no' },
    });
    a.translate({
      type: 'tool_finished',
      toolUseId: 't1',
      toolName: 'bash',
      failed: true,
      durationMs: 1,
    });
    const out = a.translate({
      type: 'tool_finished',
      toolUseId: 't1',
      toolName: 'bash',
      failed: false,
      durationMs: 1,
    });
    const e = out[0] as Extract<UIEvent, { type: 'tool:end' }>;
    expect(e.status).toBe('done');
  });

  test('provider tool_use_* events are silently dropped (avoids double cards)', () => {
    const a = createHarnessAdapter(baseCtx());
    const e1 = a.translate({
      type: 'provider_event',
      event: { kind: 'tool_use_start', id: 't', name: 'bash' },
    });
    const e2 = a.translate({
      type: 'provider_event',
      event: { kind: 'tool_use_delta', id: 't', partial_args: '{' },
    });
    const e3 = a.translate({
      type: 'provider_event',
      event: { kind: 'tool_use_stop', id: 't', final_args: {} },
    });
    expect(e1).toEqual([]);
    expect(e2).toEqual([]);
    expect(e3).toEqual([]);
  });
});

describe('harness-adapter — compaction & checkpoints', () => {
  test('compaction_started → warn', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'compaction_started',
      promptTokens: 90000,
      threshold: 70000,
      contextWindow: 100000,
    });
    expect(types(out)).toEqual(['warn']);
  });

  test('compaction_finished skipped → no event', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'compaction_finished',
      strategy: 'skipped',
      foldedCount: 0,
      durationMs: 0,
      usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
      costUsd: 0,
    });
    expect(out).toEqual([]);
  });

  test('compaction_finished llm → warn with details', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'compaction_finished',
      strategy: 'llm',
      foldedCount: 12,
      durationMs: 850,
      usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
      costUsd: 0.001,
    });
    expect(types(out)).toEqual(['warn']);
    const w = out[0] as Extract<UIEvent, { type: 'warn' }>;
    expect(w.message).toContain('llm');
    expect(w.message).toContain('12');
    expect(w.message).toContain('850ms');
  });

  test('checkpoint_created → checkpoint:create using current step count', () => {
    const a = createHarnessAdapter(baseCtx());
    a.translate({ type: 'step_start', stepN: 4 });
    const out = a.translate({
      type: 'checkpoint_created',
      checkpointId: 'ckpt-aaaa',
      gitRef: 'refs/checkpoints/x',
      stepId: 'step-x',
      hadBash: false,
    });
    expect(types(out)).toEqual(['checkpoint:create']);
    const e = out[0] as Extract<UIEvent, { type: 'checkpoint:create' }>;
    expect(e.checkpointId).toBe('ckpt-aaaa');
    expect(e.stepN).toBe(4);
  });

  test('checkpoint_created with hadBash=true emits a follow-up warn', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'checkpoint_created',
      checkpointId: 'aabbccddeeff',
      gitRef: 'r',
      stepId: 's',
      hadBash: true,
    });
    expect(types(out)).toEqual(['checkpoint:create', 'warn']);
    const w = out[1] as Extract<UIEvent, { type: 'warn' }>;
    expect(w.message).toContain('bash');
  });

  test('checkpoints_unavailable → warn', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'checkpoints_unavailable',
      reason: 'not a git repo',
    });
    expect(types(out)).toEqual(['warn']);
    expect((out[0] as Extract<UIEvent, { type: 'warn' }>).message).toContain('not a git repo');
  });

  test('bg_started → bg:start with processId + command', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'bg_started',
      processId: 'p1',
      command: 'npm run dev',
      label: 'devserver',
    });
    expect(out).toHaveLength(1);
    const ev = out[0] as Extract<UIEvent, { type: 'bg:start' }>;
    expect(ev.type).toBe('bg:start');
    expect(ev.processId).toBe('p1');
    expect(ev.command).toBe('npm run dev');
  });

  test('bg_ended natural exit → bg:end with cause=exited and no signal', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'bg_ended',
      processId: 'p1',
      status: 'exited',
      exitCode: 0,
    });
    expect(out).toHaveLength(1);
    const ev = out[0] as Extract<UIEvent, { type: 'bg:end' }>;
    expect(ev.type).toBe('bg:end');
    expect(ev.processId).toBe('p1');
    expect(ev.cause).toBe('exited');
    expect(ev.exitCode).toBe(0);
    // signal stays undefined — manager doesn't carry POSIX signal
    // names today (D146 followup); the field is reserved for when
    // it does.
    expect(ev.signal).toBeUndefined();
  });

  test('bg_ended killed → bg:end with cause=killed', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'bg_ended',
      processId: 'p1',
      status: 'killed',
      exitCode: 143,
    });
    const ev = out[0] as Extract<UIEvent, { type: 'bg:end' }>;
    expect(ev.cause).toBe('killed');
    expect(ev.exitCode).toBe(143);
    expect(ev.signal).toBeUndefined();
  });

  test('todo_updated → todo:update with items pass-through', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'todo_updated',
      sessionId: 'sess-1',
      items: [
        { content: 'Implement', activeForm: 'Implementing', status: 'in_progress' },
        { content: 'Test', activeForm: 'Testing', status: 'pending' },
      ],
    });
    expect(types(out)).toEqual(['todo:update']);
    const ev = out[0] as Extract<UIEvent, { type: 'todo:update' }>;
    expect(ev.items).toHaveLength(2);
    expect(ev.items[0]).toEqual({
      content: 'Implement',
      activeForm: 'Implementing',
      status: 'in_progress',
    });
    expect(ev.items[1]?.status).toBe('pending');
  });

  test('todo_updated with empty items still translates (full-replace clear)', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({ type: 'todo_updated', sessionId: 's', items: [] });
    expect(types(out)).toEqual(['todo:update']);
    expect((out[0] as Extract<UIEvent, { type: 'todo:update' }>).items).toEqual([]);
  });
});
