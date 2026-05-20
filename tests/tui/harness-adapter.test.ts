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

  test('memoryCount in ctx surfaces on session:start.memoryCount', () => {
    const a = createHarnessAdapter({ ...baseCtx(), memoryCount: 5 });
    const out = a.translate({ type: 'session_start', sessionId: 's' });
    const start = out.find((e) => e.type === 'session:start') as Extract<
      UIEvent,
      { type: 'session:start' }
    >;
    expect(start.memoryCount).toBe(5);
  });

  test('omitted memoryCount does not include the field on session:start', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({ type: 'session_start', sessionId: 's' });
    const start = out.find((e) => e.type === 'session:start') as Extract<
      UIEvent,
      { type: 'session:start' }
    >;
    expect(start.memoryCount).toBeUndefined();
  });

  test('step_start bumps steps and emits step:budget + provider:waiting:start', () => {
    // step_start now dual-emits: status update + the new
    // "Awaiting model" indicator that bridges the gap between
    // the harness handing off the request and the first
    // provider event arriving on the renderer.
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({ type: 'step_start', stepN: 3 });
    expect(out.map((e) => e.type)).toEqual(['step:budget', 'provider:waiting:start']);
    const b = out[0] as Extract<UIEvent, { type: 'step:budget' }>;
    expect(b.steps).toBe(3);
    const w = out[1] as Extract<UIEvent, { type: 'provider:waiting:start' }>;
    expect(w.stepN).toBe(3);
  });

  test('first provider_event after step_start emits provider:waiting:end', () => {
    // The end-of-wait fires on the FIRST provider event, not on
    // assistant:start specifically — covers tool-only turns where
    // the model goes straight to tool_use_start without any
    // assistant content.
    const a = createHarnessAdapter(baseCtx());
    a.translate({ type: 'step_start', stepN: 1 });
    const out = a.translate({
      type: 'provider_event',
      event: { kind: 'start', message_id: 'm1' },
    });
    // Order: provider:waiting:end FIRST (closes the indicator),
    // then the rest of the provider_event translation
    // (assistant:start in this case).
    expect(out[0]?.type).toBe('provider:waiting:end');
    expect(out.map((e) => e.type)).toContain('assistant:start');
  });

  test('subsequent provider events do NOT re-emit provider:waiting:end (idempotent)', () => {
    // The internal flag prevents per-event noise once the
    // indicator already closed. Pinned so a regression that
    // dropped the flag would surface as an extra
    // provider:waiting:end on every text_delta.
    const a = createHarnessAdapter(baseCtx());
    a.translate({ type: 'step_start', stepN: 1 });
    a.translate({ type: 'provider_event', event: { kind: 'start', message_id: 'm1' } });
    const out = a.translate({
      type: 'provider_event',
      event: { kind: 'text_delta', text: 'hi' },
    });
    expect(out.map((e) => e.type)).not.toContain('provider:waiting:end');
  });

  test('two step_starts back to back close the prior gate before opening a new one', () => {
    // Defensive close-before-open in the step_start case.
    // Pinned so a regression that opened a second gate without
    // closing the first would leave the reducer with a stale
    // startedAt and an indicator that never closes.
    const a = createHarnessAdapter(baseCtx());
    a.translate({ type: 'step_start', stepN: 1 });
    const out = a.translate({ type: 'step_start', stepN: 2 });
    // step_start (step 2) must close before opening: end then start.
    const types = out.map((e) => e.type);
    const endIdx = types.indexOf('provider:waiting:end');
    const startIdx = types.indexOf('provider:waiting:start');
    expect(endIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(endIdx);
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

  test('critiqueAborted is NOT collapsed to error (operator-driven termination)', () => {
    // The operator chose `abort` in the critique modal — that's
    // an interrupted/aborted exit, NOT a failure. Without
    // mapExitReason passing the reason through verbatim, the
    // adverse-exit branch above would fire: a `warn` line saying
    // 'exit critiqueAborted — N issue(s) flagged' would render
    // like a crash, and session:end.reason would be 'error'.
    // Both mislead operators and any NDJSON consumer keying off
    // the UI reason.
    const a = createHarnessAdapter(baseCtx());
    const result: HarnessResult = {
      status: 'interrupted',
      reason: 'critiqueAborted',
      sessionId: 'sess-crit',
      steps: 1,
      durationMs: 800,
      usage: { input: 100, output: 50, cache_read: 0, cache_creation: 0 },
      costUsd: 0.001,
      usageComplete: true,
      detail: '2 issue(s) flagged',
    };
    const out = a.translate({ type: 'session_finished', result });
    // No warn line — the run wasn't an error.
    expect(types(out)).toEqual(['step:budget', 'session:end']);
    const end = out[1] as Extract<UIEvent, { type: 'session:end' }>;
    expect(end.reason).toBe('critiqueAborted');
  });

  test('userPromptBlocked is NOT collapsed to error (hook refused turn)', () => {
    // Same misclassification family as critiqueAborted: a
    // UserPromptSubmit hook refusing the turn is operator-driven
    // (the hook is operator policy), not a runtime failure.
    // Maps to status='interrupted' at the harness layer; the UI
    // mapping must follow.
    const a = createHarnessAdapter(baseCtx());
    const result: HarnessResult = {
      status: 'interrupted',
      reason: 'userPromptBlocked',
      sessionId: 'sess-hook',
      steps: 0,
      durationMs: 5,
      usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
      costUsd: 0,
      usageComplete: true,
      detail: 'denied by user hook /etc/agent/hooks.toml',
    };
    const out = a.translate({ type: 'session_finished', result });
    expect(types(out)).toEqual(['step:budget', 'session:end']);
    const end = out[1] as Extract<UIEvent, { type: 'session:end' }>;
    expect(end.reason).toBe('userPromptBlocked');
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

  test('recap_terse_ready → recap:terse line(s) for the scrollback (RECAP §3.3)', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'recap_terse_ready',
      sessionId: 's',
      markdown: 'fix the bug. 1 step, $0.00.\n',
      cacheHit: false,
    });
    expect(types(out)).toEqual(['recap:terse']);
    const ev = out[0] as Extract<UIEvent, { type: 'recap:terse' }>;
    expect(ev.message).toBe('fix the bug. 1 step, $0.00.');
  });

  test('recap_terse_ready filters trailing-empty lines so no blank line is rendered', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'recap_terse_ready',
      sessionId: 's',
      // Some renderers may emit `text\n` or `text\n\n`; the
      // adapter normalizes by dropping empty lines.
      markdown: 'one sentence.\n\n',
      cacheHit: true,
    });
    expect(types(out)).toEqual(['recap:terse']);
    const ev = out[0] as Extract<UIEvent, { type: 'recap:terse' }>;
    expect(ev.message).toBe('one sentence.');
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

  test('text_delta strips ANSI escapes (terminal-mode hijack defense)', () => {
    // Provider output containing escape sequences (model quoting a
    // file's bytes, code about terminal codes, prompt-injection)
    // would otherwise be written raw to the operator's terminal.
    // The most damaging classes are DEC private modes — `\x1b[?2004h`
    // toggles bracketed paste, `\x1b[?25l` hides the cursor,
    // `\x1b[?1049h` switches to the alt screen. From the operator's
    // POV the input "freezes" because feedback goes invisible or
    // keystrokes get reinterpreted. The adapter strips on entry so
    // every downstream consumer (live chip, permanent block, recap
    // snapshots) sees clean text without each having to remember.
    const a = createHarnessAdapter(baseCtx());
    a.translate({ type: 'provider_event', event: { kind: 'start', message_id: 'm' } });
    const out = a.translate({
      type: 'provider_event',
      event: {
        kind: 'text_delta',
        // Mix the worst offenders: SGR color, DEC mode, OSC, plus
        // benign prose that must survive.
        text: 'hello \x1b[31mred\x1b[0m and \x1b[?2004h danger \x1b]0;title\x07 done',
      },
    });
    const delta = out[0] as Extract<UIEvent, { type: 'assistant:delta' }>;
    expect(delta.text).not.toContain('\x1b');
    expect(delta.text).toContain('hello');
    expect(delta.text).toContain('red');
    expect(delta.text).toContain('danger');
    expect(delta.text).toContain('done');
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

describe('harness-adapter — critique lifecycle (Slice D)', () => {
  test('critique_started → critique:start with stepN + toolPlanWrites', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'critique_started',
      stepN: 4,
      toolPlanWrites: true,
    });
    expect(types(out)).toEqual(['critique:start']);
    const start = out[0] as Extract<UIEvent, { type: 'critique:start' }>;
    expect(start.stepN).toBe(4);
    expect(start.toolPlanWrites).toBe(true);
  });

  test('critique_finished → critique:end (regardless of strategy/decision)', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'critique_finished',
      stepN: 4,
      strategy: 'llm',
      filteredCount: 0,
      rawCount: 0,
      overallConfidence: 0.95,
      durationMs: 1200,
      costUsd: 0.0001,
      decision: 'no_modal',
    });
    expect(types(out)).toEqual(['critique:end']);
    const end = out[0] as Extract<UIEvent, { type: 'critique:end' }>;
    expect(end.stepN).toBe(4);
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

  test('errorMessage on tool_finished surfaces as summary on tool:end', () => {
    const a = createHarnessAdapter(baseCtx());
    a.translate({
      type: 'tool_invoking',
      toolUseId: 't1',
      toolName: 'read_file',
      args: { path: '/missing.txt' },
    });
    const out = a.translate({
      type: 'tool_finished',
      toolUseId: 't1',
      toolName: 'read_file',
      failed: true,
      durationMs: 2,
      errorMessage: 'ENOENT: no such file or directory',
    });
    const e = out[0] as Extract<UIEvent, { type: 'tool:end' }>;
    expect(e.status).toBe('error');
    expect(e.summary).toBe('ENOENT: no such file or directory');
  });

  test('outputTruncated on tool_finished carries onto tool:end', () => {
    const a = createHarnessAdapter(baseCtx());
    a.translate({ type: 'tool_invoking', toolUseId: 't1', toolName: 'bash', args: {} });
    a.translate({ type: 'tool_decided', toolUseId: 't1', decision: { kind: 'allow' } });
    const out = a.translate({
      type: 'tool_finished',
      toolUseId: 't1',
      toolName: 'bash',
      failed: false,
      durationMs: 10,
      outputTruncated: true,
    });
    const e = out[0] as Extract<UIEvent, { type: 'tool:end' }>;
    expect(e.status).toBe('done');
    expect(e.outputTruncated).toBe(true);
  });

  test('outputTruncated absent leaves the tool:end flag unset', () => {
    const a = createHarnessAdapter(baseCtx());
    a.translate({ type: 'tool_invoking', toolUseId: 't1', toolName: 'bash', args: {} });
    a.translate({ type: 'tool_decided', toolUseId: 't1', decision: { kind: 'allow' } });
    const out = a.translate({
      type: 'tool_finished',
      toolUseId: 't1',
      toolName: 'bash',
      failed: false,
      durationMs: 10,
    });
    const e = out[0] as Extract<UIEvent, { type: 'tool:end' }>;
    expect(e.outputTruncated).toBeUndefined();
  });

  test('errorMessage absent on done outcomes leaves summary unset', () => {
    const a = createHarnessAdapter(baseCtx());
    a.translate({
      type: 'tool_invoking',
      toolUseId: 't1',
      toolName: 'read_file',
      args: { path: '/ok.txt' },
    });
    const out = a.translate({
      type: 'tool_finished',
      toolUseId: 't1',
      toolName: 'read_file',
      failed: false,
      durationMs: 1,
    });
    const e = out[0] as Extract<UIEvent, { type: 'tool:end' }>;
    expect(e.status).toBe('done');
    expect(e.summary).toBeUndefined();
  });

  test('denied paths prefer decision.reason over errorMessage on summary', () => {
    // Defense in depth: even if a misbehaving producer attached
    // both `denied:true` and `errorMessage` to the same event, the
    // adapter routes through the denied branch (decision.reason).
    // errorMessage is meant for non-denied error paths only.
    const a = createHarnessAdapter(baseCtx());
    a.translate({
      type: 'tool_invoking',
      toolUseId: 't1',
      toolName: 'bash',
      args: { command: 'rm -rf /' },
    });
    a.translate({
      type: 'tool_decided',
      toolUseId: 't1',
      decision: { kind: 'deny', reason: 'matched deny rule: rm -rf /*' },
    });
    const out = a.translate({
      type: 'tool_finished',
      toolUseId: 't1',
      toolName: 'bash',
      failed: true,
      durationMs: 0,
      denied: true,
      errorMessage: 'should not appear',
    });
    const e = out[0] as Extract<UIEvent, { type: 'tool:end' }>;
    expect(e.status).toBe('denied');
    expect(e.summary).toBe('matched deny rule: rm -rf /*');
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

  test('tool_warning translates to a generic warn UIEvent', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'tool_warning',
      toolUseId: 't42',
      toolName: 'memory_read',
      message: '[memory: untrusted] loaded user/foo',
    });
    expect(out).toHaveLength(1);
    const e = out[0] as Extract<UIEvent, { type: 'warn' }>;
    expect(e.type).toBe('warn');
    expect(e.message).toContain('[memory: untrusted]');
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

describe('harness-adapter — subagent observability', () => {
  test('subagent_start translates to subagent:start with name + goal pass-through', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'subagent_start',
      subagentId: 'child-1',
      name: 'explore',
      prompt: 'find the README',
    });
    expect(types(out)).toEqual(['subagent:start']);
    const ev = out[0] as Extract<UIEvent, { type: 'subagent:start' }>;
    expect(ev.subagentId).toBe('child-1');
    expect(ev.name).toBe('explore');
    expect(ev.goal).toBe('find the README');
  });

  test('subagent_progress maps inner step_start to "step N"', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'subagent_progress',
      subagentId: 'c',
      lastEvent: { type: 'step_start', stepN: 3 },
    });
    expect(types(out)).toEqual(['subagent:update']);
    const ev = out[0] as Extract<UIEvent, { type: 'subagent:update' }>;
    expect(ev.progress).toBe('step 3');
  });

  test('subagent_progress maps tool_invoking to "running <name>"', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'subagent_progress',
      subagentId: 'c',
      lastEvent: {
        type: 'tool_invoking',
        toolUseId: 't1',
        toolName: 'echo',
        args: { msg: 'hi' },
      },
    });
    const ev = out[0] as Extract<UIEvent, { type: 'subagent:update' }>;
    expect(ev.progress).toBe('running echo');
  });

  test('subagent_progress maps tool_finished failed/done correctly', () => {
    const a = createHarnessAdapter(baseCtx());
    const okOut = a.translate({
      type: 'subagent_progress',
      subagentId: 'c',
      lastEvent: {
        type: 'tool_finished',
        toolUseId: 't1',
        toolName: 'echo',
        failed: false,
        durationMs: 5,
      },
    });
    expect((okOut[0] as Extract<UIEvent, { type: 'subagent:update' }>).progress).toBe('echo done');

    const failOut = a.translate({
      type: 'subagent_progress',
      subagentId: 'c',
      lastEvent: {
        type: 'tool_finished',
        toolUseId: 't1',
        toolName: 'grep',
        failed: true,
        durationMs: 5,
      },
    });
    expect((failOut[0] as Extract<UIEvent, { type: 'subagent:update' }>).progress).toBe(
      'grep failed',
    );
  });

  test('subagent_progress falls back to inner.type for unmodeled events', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'subagent_progress',
      subagentId: 'c',
      lastEvent: { type: 'bg_started', processId: 'p1', command: 'sleep', label: null },
    });
    expect((out[0] as Extract<UIEvent, { type: 'subagent:update' }>).progress).toBe('bg_started');
  });

  test('subagent_progress with tool_warning inner emits BOTH subagent:update AND a warn UIEvent', () => {
    // S4: child's tool_warning must surface to the operator's
    // permanent scrollback, not just the transient live row that
    // disappears on subagent:end. The adapter dual-emits.
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'subagent_progress',
      subagentId: 'cafebabe-1234-5678-9abc-def012345678',
      lastEvent: {
        type: 'tool_warning',
        toolUseId: 't1',
        toolName: 'memory_read',
        message: '[memory: untrusted]',
      },
    });
    expect(types(out)).toEqual(['subagent:update', 'warn']);
    const warn = out[1] as Extract<UIEvent, { type: 'warn' }>;
    expect(warn.message).toContain('subagent cafebabe');
    expect(warn.message).toContain('memory_read');
    expect(warn.message).toContain('[memory: untrusted]');
  });

  test('subagent_progress with non-warning inner emits ONLY subagent:update', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'subagent_progress',
      subagentId: 'c',
      lastEvent: { type: 'step_start', stepN: 1 },
    });
    expect(types(out)).toEqual(['subagent:update']);
  });

  test('subagent_progress with tool_invoking inner emits BOTH subagent:update AND tool:start', () => {
    // Slice 1: a subagent doing real work shouldn't surface as
    // nothing but a heartbeat row. The adapter dual-emits a
    // permanent tool:start chip alongside the live subagent:update
    // so the operator sees the actual file path / args in
    // scrollback, not just the verb scrolling past on the live
    // region.
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'subagent_progress',
      subagentId: 'deadbeef-1234-5678-9abc-def012345678',
      lastEvent: {
        type: 'tool_invoking',
        toolUseId: 'tu-child-1',
        toolName: 'read_file',
        args: { path: 'src/foo.ts' },
      },
    });
    expect(types(out)).toEqual(['subagent:update', 'tool:start']);
    const start = out[1] as Extract<UIEvent, { type: 'tool:start' }>;
    // toolId is namespaced so concurrent subagents can't clash.
    expect(start.toolId).toBe('sub:deadbeef-1234-5678-9abc-def012345678:tu-child-1');
    expect(start.name).toBe('read_file');
    // Slice 2: parentId carries the subagentId so the renderer
    // can indent the chip with `|_`. Subject stays the raw vocab
    // extractor output (no `[sub …]` prefix — the indent is the
    // attribution signal now).
    expect(start.parentId).toBe('deadbeef-1234-5678-9abc-def012345678');
    expect(start.subject).toBe('src/foo.ts');
  });

  test('subagent_progress tool_finished after tool_invoking → matched tool:end with same namespaced toolId', () => {
    // Pin the round-trip: tool:start and tool:end carry the SAME
    // namespaced toolId so the reducer's per-toolId state machine
    // (state.tools map) matches them. A regression that
    // forgot to namespace one side would leak entries in the
    // map AND render an orphan tool-end with no preceding start.
    const a = createHarnessAdapter(baseCtx());
    a.translate({
      type: 'subagent_progress',
      subagentId: 'aaaaaaaa-1111-2222-3333-444444444444',
      lastEvent: {
        type: 'tool_invoking',
        toolUseId: 'tu-x',
        toolName: 'echo',
        args: { msg: 'hi' },
      },
    });
    const out = a.translate({
      type: 'subagent_progress',
      subagentId: 'aaaaaaaa-1111-2222-3333-444444444444',
      lastEvent: {
        type: 'tool_finished',
        toolUseId: 'tu-x',
        toolName: 'echo',
        failed: false,
        durationMs: 42,
      },
    });
    expect(types(out)).toEqual(['subagent:update', 'tool:end']);
    const end = out[1] as Extract<UIEvent, { type: 'tool:end' }>;
    expect(end.toolId).toBe('sub:aaaaaaaa-1111-2222-3333-444444444444:tu-x');
    expect(end.status).toBe('done');
    expect(end.durationMs).toBe(42);
  });

  test('subagent_progress tool_finished with failed=true → tool:end status=error', () => {
    const a = createHarnessAdapter(baseCtx());
    a.translate({
      type: 'subagent_progress',
      subagentId: 'c',
      lastEvent: {
        type: 'tool_invoking',
        toolUseId: 'tu-fail',
        toolName: 'grep',
        args: { pattern: 'x' },
      },
    });
    const out = a.translate({
      type: 'subagent_progress',
      subagentId: 'c',
      lastEvent: {
        type: 'tool_finished',
        toolUseId: 'tu-fail',
        toolName: 'grep',
        failed: true,
        durationMs: 5,
      },
    });
    const end = out.find((e) => e.type === 'tool:end') as
      | Extract<UIEvent, { type: 'tool:end' }>
      | undefined;
    expect(end?.status).toBe('error');
  });

  test('subagent_progress tool_decided=deny followed by tool_finished → tool:end status=denied with reason', () => {
    // Mirrors the top-level deny path: the decision is captured
    // on tool_decided and surfaces as the chip's `summary` on
    // tool_finished. Without this, an operator who hits a strict
    // policy in a subagent sees "echo failed" with no clue why.
    const a = createHarnessAdapter(baseCtx());
    a.translate({
      type: 'subagent_progress',
      subagentId: 'c',
      lastEvent: {
        type: 'tool_invoking',
        toolUseId: 'tu-deny',
        toolName: 'echo',
        args: { msg: 'x' },
      },
    });
    a.translate({
      type: 'subagent_progress',
      subagentId: 'c',
      lastEvent: {
        type: 'tool_decided',
        toolUseId: 'tu-deny',
        decision: { kind: 'deny', reason: 'policy says no' },
      },
    });
    const out = a.translate({
      type: 'subagent_progress',
      subagentId: 'c',
      lastEvent: {
        type: 'tool_finished',
        toolUseId: 'tu-deny',
        toolName: 'echo',
        failed: false,
        denied: true,
        durationMs: 1,
      },
    });
    const end = out.find((e) => e.type === 'tool:end') as
      | Extract<UIEvent, { type: 'tool:end' }>
      | undefined;
    expect(end?.status).toBe('denied');
    expect(end?.summary).toBe('policy says no');
  });

  test('two concurrent subagents with the SAME local toolUseId do not collide on state.tools', () => {
    // The child generates toolUseIds locally, so two siblings
    // running in parallel both pick "tu1" with high probability
    // (or hand-rolled in tests). Without namespacing, the second
    // tool_invoking would overwrite the first's state entry; on
    // tool_finished, both would resolve to the same map key and
    // the surviving chip status would describe the wrong tool.
    const a = createHarnessAdapter(baseCtx());
    a.translate({
      type: 'subagent_progress',
      subagentId: 'sub-A',
      lastEvent: {
        type: 'tool_invoking',
        toolUseId: 'tu1',
        toolName: 'read_file',
        args: { path: 'a.ts' },
      },
    });
    a.translate({
      type: 'subagent_progress',
      subagentId: 'sub-B',
      lastEvent: {
        type: 'tool_invoking',
        toolUseId: 'tu1',
        toolName: 'read_file',
        args: { path: 'b.ts' },
      },
    });
    // A finishes failed, B finishes ok. If state collided,
    // both would resolve to whichever subagent's invocation
    // lived longer in the map.
    const aOut = a.translate({
      type: 'subagent_progress',
      subagentId: 'sub-A',
      lastEvent: {
        type: 'tool_finished',
        toolUseId: 'tu1',
        toolName: 'read_file',
        failed: true,
        durationMs: 1,
      },
    });
    const bOut = a.translate({
      type: 'subagent_progress',
      subagentId: 'sub-B',
      lastEvent: {
        type: 'tool_finished',
        toolUseId: 'tu1',
        toolName: 'read_file',
        failed: false,
        durationMs: 1,
      },
    });
    const aEnd = aOut.find((e) => e.type === 'tool:end') as
      | Extract<UIEvent, { type: 'tool:end' }>
      | undefined;
    const bEnd = bOut.find((e) => e.type === 'tool:end') as
      | Extract<UIEvent, { type: 'tool:end' }>
      | undefined;
    expect(aEnd?.toolId).toBe('sub:sub-A:tu1');
    expect(aEnd?.status).toBe('error');
    expect(bEnd?.toolId).toBe('sub:sub-B:tu1');
    expect(bEnd?.status).toBe('done');
  });

  test('subagent_finished forwards full status + reason + costUsd to subagent:end', () => {
    // The adapter previously collapsed status to `done | error`,
    // erasing the cause distinction (cost cap, user abort,
    // crash). Pin the new contract: full status preserved,
    // reason forwarded when present, costUsd carried so the
    // permanent chip can render "Exhausted (cost cap, $0.59)"
    // instead of the bare "Failed".
    const a = createHarnessAdapter(baseCtx());
    const okOut = a.translate({
      type: 'subagent_finished',
      subagentId: 'c',
      status: 'done',
      reason: 'done',
      summary: 'README found',
      durationMs: 1234,
      costUsd: 0.001,
    });
    const okEv = okOut[0] as Extract<UIEvent, { type: 'subagent:end' }>;
    expect(okEv.status).toBe('done');
    expect(okEv.reason).toBe('done');
    expect(okEv.costUsd).toBeCloseTo(0.001);
    expect(okEv.summary).toBe('README found');
    expect(okEv.durationMs).toBe(1234);

    // interrupted status is preserved (not collapsed to error).
    const interruptedOut = a.translate({
      type: 'subagent_finished',
      subagentId: 'c',
      status: 'interrupted',
      reason: 'aborted',
      summary: 'aborted',
      durationMs: 9,
      costUsd: 0,
    });
    const interruptedEv = interruptedOut[0] as Extract<UIEvent, { type: 'subagent:end' }>;
    expect(interruptedEv.status).toBe('interrupted');
    expect(interruptedEv.reason).toBe('aborted');

    // exhausted status is preserved with budget reason intact.
    const exhaustedOut = a.translate({
      type: 'subagent_finished',
      subagentId: 'c',
      status: 'exhausted',
      reason: 'maxCostUsd',
      summary: 'budget exceeded',
      durationMs: 9,
      costUsd: 0.59,
    });
    const exhaustedEv = exhaustedOut[0] as Extract<UIEvent, { type: 'subagent:end' }>;
    expect(exhaustedEv.status).toBe('exhausted');
    expect(exhaustedEv.reason).toBe('maxCostUsd');
    expect(exhaustedEv.costUsd).toBeCloseTo(0.59);

    // reason omitted when the producer didn't set one (e.g.
    // legacy spawn-failure path that synthesized the envelope).
    const noReasonOut = a.translate({
      type: 'subagent_finished',
      subagentId: 'c',
      status: 'error',
      summary: 'crashed',
      durationMs: 9,
      costUsd: 0,
    });
    const noReasonEv = noReasonOut[0] as Extract<UIEvent, { type: 'subagent:end' }>;
    expect(noReasonEv.status).toBe('error');
    expect(noReasonEv.reason).toBeUndefined();
  });

  test('subagent_progress with cost_update inner pipes cumulativeCostUsd through (D232)', () => {
    // Per-row cost chip in the live region. The adapter
    // forwards `cumulativeCostUsd` only on the cost_update
    // inner case so other progress events leave the
    // reducer's prior `liveCostUsd` untouched.
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'subagent_progress',
      subagentId: 'c',
      lastEvent: { type: 'cost_update', delta: 0.005, cumulative: 0.018 },
    });
    expect(types(out)).toEqual(['subagent:update']);
    const ev = out[0] as Extract<UIEvent, { type: 'subagent:update' }>;
    expect(ev.cumulativeCostUsd).toBe(0.018);
    expect(ev.progress).toBe('+$0.0050');
  });

  test('cost_soft_cap_warn translates to a permanent warn message', () => {
    // Spec ORCHESTRATION.md §3.5.0. The harness emits this event
    // ONCE per run when cumulative crosses the soft threshold
    // (the playbook's declared `max_cost_usd`). Renderer
    // surfaces it as a permanent warn line so the operator sees
    // the regression signal even after the live region recycles.
    // Half-up rounding matches the `subagent_summary` formatter
    // — pinned so a future refactor doesn't drift between
    // surfaces.
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'cost_soft_cap_warn',
      threshold: 0.3,
      cumulative: 0.585,
    });
    const ev = out.find((e) => e.type === 'warn') as Extract<UIEvent, { type: 'warn' }> | undefined;
    expect(ev).toBeDefined();
    expect(ev?.message).toContain('over budget estimate');
    expect(ev?.message).toContain('$0.30');
    // 0.585 rounds half-up to 0.59 (Math.round*100/100 path).
    expect(ev?.message).toContain('$0.59');
  });

  test('subagent_progress with cost_soft_cap_warn inner surfaces a top-level warn', () => {
    // When a subagent crosses its soft cap, the child emits
    // cost_soft_cap_warn over IPC; the parent's adapter
    // unwraps via subagent_progress.lastEvent. The wrapped path
    // mirrors the standalone case but prefixes the warn with
    // the subagent id so the operator can attribute the
    // regression signal to a specific child run.
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'subagent_progress',
      subagentId: 'sub_01ABC123',
      lastEvent: {
        type: 'cost_soft_cap_warn',
        threshold: 0.3,
        cumulative: 0.585,
      },
    });
    const warn = out.find((e) => e.type === 'warn') as
      | Extract<UIEvent, { type: 'warn' }>
      | undefined;
    expect(warn).toBeDefined();
    expect(warn?.message).toContain('subagent sub_01AB');
    expect(warn?.message).toContain('over budget estimate');
    expect(warn?.message).toContain('$0.59');
    expect(warn?.message).toContain('$0.30');
  });

  test('subagent_progress with non-cost inner omits cumulativeCostUsd', () => {
    // Counterpart guard: a step_start should NOT carry a
    // cumulativeCostUsd, so the reducer keeps the prior
    // value rather than zeroing.
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'subagent_progress',
      subagentId: 'c',
      lastEvent: { type: 'step_start', stepN: 5 },
    });
    const ev = out[0] as Extract<UIEvent, { type: 'subagent:update' }>;
    expect(ev.cumulativeCostUsd).toBeUndefined();
  });

  test('subagent_progress contract: only cost_update inner sets cumulativeCostUsd (review fix)', () => {
    // Pin the contract: the reducer's "undefined = no
    // change" semantic depends on every non-cost inner kind
    // omitting the field. A future addition that forgets to
    // think about cost would silently zero the per-row cost
    // chip every time that inner kind fired. Sweep across
    // every inner kind covered by the adapter switch.
    const a = createHarnessAdapter(baseCtx());
    const innerEvents = [
      { type: 'step_start' as const, stepN: 1 },
      {
        type: 'tool_invoking' as const,
        toolUseId: 't',
        toolName: 'echo',
        args: {},
      },
      {
        type: 'tool_finished' as const,
        toolUseId: 't',
        toolName: 'echo',
        failed: false,
        durationMs: 1,
      },
      {
        type: 'compaction_started' as const,
        promptTokens: 1000,
        threshold: 800,
        contextWindow: 2000,
      },
      {
        type: 'compaction_finished' as const,
        strategy: 'llm' as const,
        foldedCount: 3,
        durationMs: 50,
        usage: { input: 100, output: 50, cache_read: 0, cache_creation: 0 },
        costUsd: 0.001,
      },
      { type: 'todo_updated' as const, sessionId: 's', items: [] },
      {
        type: 'tool_warning' as const,
        toolUseId: 't',
        toolName: 'echo',
        message: 'w',
      },
    ];
    for (const inner of innerEvents) {
      const out = a.translate({
        type: 'subagent_progress',
        subagentId: 'c',
        lastEvent: inner,
      });
      const update = out.find((e) => e.type === 'subagent:update');
      expect(update).toBeDefined();
      const ev = update as Extract<UIEvent, { type: 'subagent:update' }>;
      expect(ev.cumulativeCostUsd).toBeUndefined();
    }
  });

  test('cap_watchdog_fired surfaces as a permanent warn line (D233)', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'cap_watchdog_fired',
      cancelledCount: 3,
      cumulativeUsd: 5.123456,
      capUsd: 5.0,
    });
    expect(types(out)).toEqual(['warn']);
    const ev = out[0] as Extract<UIEvent, { type: 'warn' }>;
    expect(ev.message).toContain('cap watchdog');
    expect(ev.message).toContain('3 subagents');
    expect(ev.message).toContain('$5.1235');
    expect(ev.message).toContain('$5.0000');
  });

  test('parallel_status translates to parallel:status with all counters preserved (D234)', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'parallel_status',
      subagentsRunning: 2,
      subagentsQueued: 3,
      subagentsCap: 3,
      toolsRunning: 1,
      toolsCap: 3,
    });
    expect(types(out)).toEqual(['parallel:status']);
    const ev = out[0] as Extract<UIEvent, { type: 'parallel:status' }>;
    expect(ev.subagentsRunning).toBe(2);
    expect(ev.subagentsQueued).toBe(3);
    expect(ev.subagentsCap).toBe(3);
    expect(ev.toolsRunning).toBe(1);
    expect(ev.toolsCap).toBe(3);
  });

  test('cap_watchdog_fired pluralizes correctly for cancelledCount=1', () => {
    const a = createHarnessAdapter(baseCtx());
    const out = a.translate({
      type: 'cap_watchdog_fired',
      cancelledCount: 1,
      cumulativeUsd: 5.0,
      capUsd: 4.99,
    });
    const ev = out[0] as Extract<UIEvent, { type: 'warn' }>;
    expect(ev.message).toContain('1 subagent ');
    expect(ev.message).not.toContain('1 subagents');
  });
});
