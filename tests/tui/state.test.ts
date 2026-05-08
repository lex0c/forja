import { describe, expect, test } from 'bun:test';
import type { UIEvent } from '../../src/tui/events.ts';
import {
  type LiveState,
  type PermanentItem,
  applyEvent,
  createInitialState,
  flushPendingToolEndBatch,
} from '../../src/tui/state.ts';

const start = (overrides: Partial<UIEvent> = {}): UIEvent =>
  ({
    type: 'session:start',
    ts: 1,
    sessionId: 's1',
    profile: 'autonomous',
    project: 'forja',
    model: 'claude-opus-4-7',
    ...overrides,
  }) as UIEvent;

const drive = (events: UIEvent[]): { state: LiveState; permanent: PermanentItem[] } => {
  let state = createInitialState();
  const permanent: PermanentItem[] = [];
  for (const ev of events) {
    const r = applyEvent(state, ev);
    state = r.state;
    permanent.push(...r.permanent);
  }
  // Slice 3: tests terminate without a natural scrollback-emitting
  // event, so any tool-end items still buffered in
  // `pendingToolEndBatch` would never surface. Force a final flush
  // so per-event tests see the same items they would in production
  // once the next event lands. Tests that specifically want to
  // observe the buffered-but-not-flushed state inspect `state`
  // directly before the helper returns.
  const flushed = flushPendingToolEndBatch(state);
  state = flushed.state;
  permanent.push(...flushed.permanent);
  return { state, permanent };
};

describe('session lifecycle', () => {
  test('session:start populates status fields and emits NO permanent (UI.md §3.2)', () => {
    // Spec change: session:start no longer prints a session-header
    // line. The user-submit inverse bar (§4.10.8) marks turn
    // boundaries; UUID-bearing rules per turn just clutter scrollback.
    // Status state still updates so the footer can show model / steps
    // / cost on the right column.
    const r = applyEvent(createInitialState(), start());
    expect(r.state.status.sessionId).toBe('s1');
    expect(r.state.status.profile).toBe('autonomous');
    expect(r.state.status.project).toBe('forja');
    expect(r.state.status.model).toBe('claude-opus-4-7');
    expect(r.state.status.planMode).toBe(false);
    expect(r.state.ended).toBe(false);
    expect(r.permanent).toEqual([]);
  });

  test('session:start with planMode=true flips status.planMode', () => {
    const r = applyEvent(createInitialState(), start({ planMode: true }));
    expect(r.state.status.planMode).toBe(true);
  });

  test('session:start without planMode field defaults planMode to false', () => {
    // Producer omitted the optional field — reducer treats as false.
    const r = applyEvent(createInitialState(), start());
    expect(r.state.status.planMode).toBe(false);
  });

  test('session:end marks state ended and emits footer item', () => {
    const r = applyEvent(createInitialState(), {
      type: 'session:end',
      ts: 2,
      sessionId: 's1',
      reason: 'done',
    });
    expect(r.state.ended).toBe(true);
    expect(r.permanent).toEqual([{ kind: 'session-footer', reason: 'done' }]);
  });

  test('session:end with abortCause threads it onto the footer item (1.g.3)', () => {
    const r = applyEvent(createInitialState(), {
      type: 'session:end',
      ts: 2,
      sessionId: 's1',
      reason: 'aborted',
      abortCause: 'hard',
    });
    expect(r.permanent).toEqual([
      { kind: 'session-footer', reason: 'aborted', abortCause: 'hard' },
    ]);
  });

  test('session:end without abortCause omits the field (no synthetic value)', () => {
    const r = applyEvent(createInitialState(), {
      type: 'session:end',
      ts: 2,
      sessionId: 's1',
      reason: 'done',
    });
    expect(r.permanent).toEqual([{ kind: 'session-footer', reason: 'done' }]);
    // Type-level: assert the abortCause key is absent (not just undefined).
    const item = r.permanent[0];
    if (item?.kind === 'session-footer') {
      expect('abortCause' in item).toBe(false);
    }
  });

  test('session:banner emits a session-banner permanent without mutating LiveState', () => {
    const initial = createInitialState();
    const r = applyEvent(initial, {
      type: 'session:banner',
      ts: 5,
      app: 'forja',
      version: '0.0.0',
      model: 'anthropic/claude-sonnet-4-6',
      contextWindow: 200000,
      maxOutputTokens: 4096,
      cwd: '/home/lex/forja',
      env: [
        { kind: 'meta', key: 'subagents', value: '0' },
        { kind: 'flag', name: 'checkpoints' },
      ],
    });
    // State unchanged — banner is pure scrollback.
    expect(r.state).toEqual(initial);
    expect(r.permanent).toEqual([
      {
        kind: 'session-banner',
        app: 'forja',
        version: '0.0.0',
        model: 'anthropic/claude-sonnet-4-6',
        contextWindow: 200000,
        maxOutputTokens: 4096,
        cwd: '/home/lex/forja',
        env: [
          { kind: 'meta', key: 'subagents', value: '0' },
          { kind: 'flag', name: 'checkpoints' },
        ],
      },
    ]);
  });
});

describe('user input', () => {
  test('user:submit emits user-submit item and clears input', () => {
    let state = createInitialState();
    state = { ...state, input: { value: 'pending', cursor: 7 } };
    const r = applyEvent(state, { type: 'user:submit', ts: 1, text: 'hello' });
    expect(r.state.input.value).toBe('');
    expect(r.state.input.cursor).toBe(0);
    expect(r.permanent).toEqual([{ kind: 'user-submit', text: 'hello' }]);
  });

  test('multi-line submit preserves text raw (renderer formats indent)', () => {
    const r = applyEvent(createInitialState(), {
      type: 'user:submit',
      ts: 1,
      text: 'first\nsecond\nthird',
    });
    expect(r.permanent).toEqual([{ kind: 'user-submit', text: 'first\nsecond\nthird' }]);
  });
});

describe('assistant streaming', () => {
  test('start opens a buffer; deltas accumulate; end emits assistant item', () => {
    const result = drive([
      { type: 'assistant:start', ts: 1, messageId: 'm1' },
      { type: 'assistant:delta', ts: 2, messageId: 'm1', text: 'Hello, ' },
      { type: 'assistant:delta', ts: 3, messageId: 'm1', text: 'world!' },
      { type: 'assistant:end', ts: 4, messageId: 'm1' },
    ]);
    expect(result.state.pendingAssistant).toBeNull();
    // duration = end.ts (4) - start.ts (1) = 3; no usage event so
    // outputTokens stays null. Renderer (formatPermanent) will show
    // "Generated in 3ms" without the token clause.
    expect(result.permanent).toEqual([
      { kind: 'assistant', text: 'Hello, world!', durationMs: 3, outputTokens: null },
    ]);
  });

  test('multi-line assistant text is preserved as one item with newlines', () => {
    const result = drive([
      { type: 'assistant:start', ts: 1, messageId: 'm1' },
      { type: 'assistant:delta', ts: 2, messageId: 'm1', text: 'line1\nline2\nline3' },
      { type: 'assistant:end', ts: 3, messageId: 'm1' },
    ]);
    expect(result.permanent).toEqual([
      {
        kind: 'assistant',
        text: 'line1\nline2\nline3',
        durationMs: 2,
        outputTokens: null,
      },
    ]);
  });

  test('delta without prior start opens a buffer on the fly', () => {
    const r = applyEvent(createInitialState(), {
      type: 'assistant:delta',
      ts: 1,
      messageId: 'm1',
      text: 'orphan',
    });
    expect(r.state.pendingAssistant?.text).toBe('orphan');
    expect(r.permanent).toEqual([]);
  });

  test('end with empty buffer + no usage emits nothing', () => {
    // Pure "no-op" turn (no text, no tokens reported) produces no
    // scrollback noise. Distinct from the tool-only turn below.
    const result = drive([
      { type: 'assistant:start', ts: 1, messageId: 'm1' },
      { type: 'assistant:end', ts: 2, messageId: 'm1' },
    ]);
    expect(result.permanent).toEqual([]);
  });

  test('end with empty buffer + usage emits NO permanent (tool-only turn)', () => {
    // Provider call that returned tool_use blocks but no text used to
    // emit a metadata-only permanent so formatPermanent could render
    // a `· Generated N tokens` chip header above the tool chips.
    // The chip header was removed (UI.md §4.10.5) — duration shows
    // up in the turn-end marker (§3.2 `Cogitated for X`), tokens
    // roll up into the footer cost. Emitting a metadata-only
    // permanent the formatter would render as [] forces the
    // renderer through writeTransition (erase + full redraw) for no
    // scrollback gain — wasteful in tool-heavy flows. So: don't emit.
    const result = drive([
      { type: 'assistant:start', ts: 1000, messageId: 'm1' },
      {
        type: 'assistant:usage',
        ts: 4200,
        messageId: 'm1',
        inputTokens: 50,
        outputTokens: 47,
        cacheRead: 0,
        cacheCreation: 0,
      },
      { type: 'assistant:end', ts: 4200, messageId: 'm1' },
    ]);
    expect(result.permanent).toEqual([]);
  });

  test('assistant:usage merges token counts onto pendingAssistant', () => {
    const result = drive([
      { type: 'assistant:start', ts: 1, messageId: 'm1' },
      { type: 'assistant:delta', ts: 2, messageId: 'm1', text: 'hi' },
      {
        type: 'assistant:usage',
        ts: 3,
        messageId: 'm1',
        inputTokens: 12,
        outputTokens: 234,
        cacheRead: 5,
        cacheCreation: 0,
      },
    ]);
    expect(result.state.pendingAssistant?.outputTokens).toBe(234);
    expect(result.state.pendingAssistant?.inputTokens).toBe(12);
    expect(result.state.pendingAssistant?.cacheRead).toBe(5);
    expect(result.state.pendingAssistant?.cacheCreation).toBe(0);
  });

  test('multiple assistant:usage events take the running max (monotonic)', () => {
    // Anthropic emits cumulative; a later partial event with smaller
    // counts (hypothetical) must not shrink the totals.
    const result = drive([
      { type: 'assistant:start', ts: 1, messageId: 'm1' },
      {
        type: 'assistant:usage',
        ts: 2,
        messageId: 'm1',
        inputTokens: 10,
        outputTokens: 100,
        cacheRead: 0,
        cacheCreation: 0,
      },
      {
        type: 'assistant:usage',
        ts: 3,
        messageId: 'm1',
        inputTokens: 5,
        outputTokens: 50,
        cacheRead: 0,
        cacheCreation: 0,
      },
    ]);
    expect(result.state.pendingAssistant?.outputTokens).toBe(100);
    expect(result.state.pendingAssistant?.inputTokens).toBe(10);
  });

  test('assistant:usage for unknown messageId is dropped silently', () => {
    const result = drive([
      { type: 'assistant:start', ts: 1, messageId: 'm1' },
      {
        type: 'assistant:usage',
        ts: 2,
        messageId: 'wrong',
        inputTokens: 1,
        outputTokens: 999,
        cacheRead: 0,
        cacheCreation: 0,
      },
    ]);
    expect(result.state.pendingAssistant?.outputTokens).toBeNull();
  });

  test('assistant:end emits permanent with duration + tokens when usage arrived', () => {
    const result = drive([
      { type: 'assistant:start', ts: 1000, messageId: 'm1' },
      { type: 'assistant:delta', ts: 1100, messageId: 'm1', text: 'reply' },
      {
        type: 'assistant:usage',
        ts: 9100,
        messageId: 'm1',
        inputTokens: 12,
        outputTokens: 234,
        cacheRead: 0,
        cacheCreation: 0,
      },
      { type: 'assistant:end', ts: 9200, messageId: 'm1' },
    ]);
    // Duration = end.ts (9200) - start.ts (1000) = 8200ms.
    expect(result.permanent).toEqual([
      { kind: 'assistant', text: 'reply', durationMs: 8200, outputTokens: 234 },
    ]);
  });

  test('consecutive assistant:start events open a fresh turn (startedAt reset)', () => {
    // Provider re-stream / retry: a second assistant:start after the
    // first should anchor a new clock, not inherit the prior turn's
    // startedAt. Otherwise the chip elapsed counter reads the wrong
    // duration for the second turn.
    const r = drive([
      { type: 'assistant:start', ts: 1000, messageId: 'm1' },
      { type: 'assistant:delta', ts: 1100, messageId: 'm1', text: 'first try' },
      { type: 'assistant:start', ts: 5000, messageId: 'm2' },
    ]);
    expect(r.state.pendingAssistant?.messageId).toBe('m2');
    expect(r.state.pendingAssistant?.startedAt).toBe(5000);
    // Text from the first turn does not survive — fresh buffer.
    expect(r.state.pendingAssistant?.text).toBe('');
  });

  test('delta-only path (no start) gets startedAt from delta.ts', () => {
    // Out-of-order arrival shouldn't stamp startedAt at 0 (would
    // render absurd elapsed time on the chip).
    const r = applyEvent(createInitialState(), {
      type: 'assistant:delta',
      ts: 12345,
      messageId: 'm1',
      text: 'orphan',
    });
    expect(r.state.pendingAssistant?.startedAt).toBe(12345);
  });
});

describe('thinking lifecycle', () => {
  test('start sets startedAt; end clears it; delta is a no-op', () => {
    const result = drive([
      { type: 'thinking:start', ts: 100, messageId: 'm1' },
      { type: 'thinking:delta', ts: 200, messageId: 'm1' },
    ]);
    expect(result.state.thinking?.startedAt).toBe(100);
    const after = applyEvent(result.state, { type: 'thinking:end', ts: 300, messageId: 'm1' });
    expect(after.state.thinking).toBeNull();
  });
});

describe('critique lifecycle (Slice D)', () => {
  test('start sets startedAt + stepN + toolPlanWrites; end clears it', () => {
    const result = drive([{ type: 'critique:start', ts: 1000, stepN: 3, toolPlanWrites: false }]);
    expect(result.state.critique).toEqual({
      startedAt: 1000,
      stepN: 3,
      toolPlanWrites: false,
    });
    const after = applyEvent(result.state, { type: 'critique:end', ts: 1500, stepN: 3 });
    expect(after.state.critique).toBeNull();
  });

  test('toolPlanWrites=true is preserved (drives the chip color)', () => {
    const result = drive([{ type: 'critique:start', ts: 1, stepN: 1, toolPlanWrites: true }]);
    expect(result.state.critique?.toolPlanWrites).toBe(true);
  });

  test('critique:ask clears the chip — modal-open marks the critic call as done, wait shifts to operator', () => {
    // Regression: the chip's `startedAt` is the critic LLM call's
    // start. `critique_finished` (which maps to `critique:end`)
    // fires AFTER the operator decides on the modal — so leaving
    // the chip up past `critique:ask` would have its elapsed
    // counter tick across human decision time. Clearing here
    // keeps the live indicator honest about what's actually
    // running.
    const result = drive([{ type: 'critique:start', ts: 1_000, stepN: 2, toolPlanWrites: false }]);
    expect(result.state.critique).not.toBeNull();
    const after = applyEvent(result.state, {
      type: 'critique:ask',
      ts: 3_000,
      promptId: 'p-crit-1',
      issues: [{ message: 'something off', severity: 'medium', confidence: 0.9 }],
    });
    expect(after.state.critique).toBeNull();
    // The modal still opens — the chip clear and the modal open
    // are paired side effects of the same event, not alternatives.
    expect(after.state.modal?.flavor).toBe('critique');
  });

  test('critique:end after critique:ask is a chip no-op (already cleared)', () => {
    // The two clear sites (`ask` and `end`) converge on the same
    // end state; the second clear must not throw / regress.
    const afterAsk = drive([
      { type: 'critique:start', ts: 1_000, stepN: 2, toolPlanWrites: false },
      {
        type: 'critique:ask',
        ts: 3_000,
        promptId: 'p-crit-2',
        issues: [{ message: 'x', severity: 'low', confidence: 0.5 }],
      },
    ]);
    expect(afterAsk.state.critique).toBeNull();
    const afterEnd = applyEvent(afterAsk.state, {
      type: 'critique:end',
      ts: 9_000,
      stepN: 2,
    });
    expect(afterEnd.state.critique).toBeNull();
  });

  test('session:end clears a dangling critique chip (mid-critique abort)', () => {
    // Operator hits Ctrl+C while the critic call is still in
    // flight: the harness signal aborts before `critique_finished`
    // ever fires. Without the boundary cleanup the chip would
    // outlive the session in the live region.
    const result = drive([
      {
        type: 'session:start',
        ts: 0,
        sessionId: 's1',
        profile: 'autonomous',
        project: 'p',
        model: 'mock/m',
      },
      { type: 'critique:start', ts: 100, stepN: 1, toolPlanWrites: false },
    ]);
    expect(result.state.critique).not.toBeNull();
    const after = applyEvent(result.state, {
      type: 'session:end',
      ts: 200,
      sessionId: 's1',
      reason: 'aborted',
    });
    expect(after.state.critique).toBeNull();
  });
});

describe('tool lifecycle', () => {
  // Vocabulary fields are pre-resolved by the adapter; tests pass the
  // resolved verb/subject directly to the events.
  const startBash = (toolId = 't1') => ({
    type: 'tool:start' as const,
    ts: 1,
    toolId,
    name: 'bash',
    activeVerb: 'Executing',
    finalVerb: 'Executed',
    subject: 'ls -la',
  });

  test('start adds an active tool, end emits tool-end item and removes it', () => {
    const result = drive([
      startBash(),
      {
        type: 'tool:end',
        ts: 1500,
        toolId: 't1',
        status: 'done',
        durationMs: 1200,
        summary: '47 entries',
      },
    ]);
    expect(result.state.activeTools.size).toBe(0);
    expect(result.permanent).toEqual([
      {
        kind: 'tool-end',
        name: 'bash',
        verb: 'Executed',
        subject: 'ls -la',
        status: 'done',
        durationMs: 1200,
        summary: '47 entries',
      },
    ]);
  });

  test('tool:end without summary emits item without summary field', () => {
    const result = drive([
      {
        type: 'tool:start',
        ts: 1,
        toolId: 't1',
        name: 'read_file',
        activeVerb: 'Reading file',
        finalVerb: 'Read file',
        subject: '/foo',
      },
      { type: 'tool:end', ts: 200, toolId: 't1', status: 'done', durationMs: 50 },
    ]);
    const item = result.permanent[0];
    if (item?.kind !== 'tool-end') {
      throw new Error(`unexpected item kind: ${item?.kind}`);
    }
    expect(item.summary).toBeUndefined();
    expect(item.verb).toBe('Read file');
    expect(item.subject).toBe('/foo');
  });

  test('parentId from tool:start flows through ActiveTool onto the tool-end item', () => {
    // Slice 2 plumbing: when the adapter sets parentId on a
    // subagent-owned tool:start, the reducer carries it on the
    // ActiveTool record and emits it on the tool-end PermanentItem
    // so the renderer can pick the nested glyph + indent. A
    // regression that lost the field anywhere in the pipeline
    // would render the chip as if it were top-level.
    const result = drive([
      {
        type: 'tool:start',
        ts: 1,
        toolId: 'sub:abc:t1',
        name: 'read_file',
        activeVerb: 'Reading file',
        finalVerb: 'Read file',
        subject: '/foo.ts',
        parentId: 'abc',
      },
      { type: 'tool:end', ts: 100, toolId: 'sub:abc:t1', status: 'done', durationMs: 5 },
    ]);
    const item = result.permanent[0];
    if (item?.kind !== 'tool-end') throw new Error('expected tool-end');
    expect(item.parentId).toBe('abc');
  });

  test('top-level tool:start (no parentId) emits a tool-end without the parentId field', () => {
    // The optional-field shape is load-bearing for existing
    // top-level chips: the renderer's `item.parentId !== undefined`
    // gate must read undefined, not null, when no parent is
    // declared. A regression that always wrote `parentId: null`
    // on the PermanentItem would silently render every top-level
    // chip with the nest glyph.
    const result = drive([
      {
        type: 'tool:start',
        ts: 1,
        toolId: 't1',
        name: 'bash',
        activeVerb: 'Executing',
        finalVerb: 'Executed',
        subject: 'ls',
      },
      { type: 'tool:end', ts: 50, toolId: 't1', status: 'done', durationMs: 5 },
    ]);
    const item = result.permanent[0];
    if (item?.kind !== 'tool-end') throw new Error('expected tool-end');
    expect(item.parentId).toBeUndefined();
  });

  test('null subject from adapter survives the round-trip onto tool-end', () => {
    const result = drive([
      {
        type: 'tool:start',
        ts: 1,
        toolId: 't1',
        name: 'todo_write',
        activeVerb: 'Updating todos',
        finalVerb: 'Updated todos',
        subject: null,
      },
      { type: 'tool:end', ts: 100, toolId: 't1', status: 'done', durationMs: 5 },
    ]);
    const item = result.permanent[0];
    if (item?.kind !== 'tool-end') throw new Error('expected tool-end');
    expect(item.subject).toBeNull();
  });

  test('delta lines feed the preview window, capped at 5 lines', () => {
    let state = createInitialState();
    state = applyEvent(state, startBash()).state;
    const seven = Array.from({ length: 7 }, (_, i) => `line${i}`).join('\n');
    state = applyEvent(state, { type: 'tool:delta', ts: 2, toolId: 't1', text: seven }).state;
    const tool = state.activeTools.get('t1');
    expect(tool?.preview).toEqual(['line2', 'line3', 'line4', 'line5', 'line6']);
  });

  test('delta with trailing newline is not counted as an empty preview row', () => {
    let state = createInitialState();
    state = applyEvent(state, startBash()).state;
    state = applyEvent(state, { type: 'tool:delta', ts: 2, toolId: 't1', text: 'hi\n' }).state;
    const tool = state.activeTools.get('t1');
    expect(tool?.preview).toEqual(['hi']);
  });

  test('delta for unknown toolId is dropped', () => {
    const r = applyEvent(createInitialState(), {
      type: 'tool:delta',
      ts: 1,
      toolId: 'ghost',
      text: 'lost',
    });
    expect(r.state.activeTools.size).toBe(0);
    expect(r.permanent).toEqual([]);
  });

  test('tool:end without preceding tool:start is a no-op (no permanent)', () => {
    const r = applyEvent(createInitialState(), {
      type: 'tool:end',
      ts: 1,
      toolId: 'ghost',
      status: 'done',
      durationMs: 100,
    });
    expect(r.permanent).toEqual([]);
  });

  test('error and denied statuses are preserved on the item (renderer picks verb)', () => {
    const errored = drive([
      startBash('t1'),
      { type: 'tool:end', ts: 100, toolId: 't1', status: 'error', durationMs: 50 },
    ]);
    const denied = drive([
      startBash('t2'),
      { type: 'tool:end', ts: 100, toolId: 't2', status: 'denied', durationMs: 50 },
    ]);
    const e = errored.permanent[0];
    const d = denied.permanent[0];
    if (e?.kind !== 'tool-end' || d?.kind !== 'tool-end') {
      throw new Error('expected tool-end items');
    }
    expect(e.status).toBe('error');
    expect(d.status).toBe('denied');
  });
});

describe('tool-end batch coalescing (slice 3)', () => {
  // Helper: build a tool:start + tool:end pair for read_file with
  // a given subject and toolId. Simulates the simplest "model
  // issued read_file" sequence.
  const readPair = (toolId: string, subject: string, durationMs = 100) =>
    [
      {
        type: 'tool:start' as const,
        ts: 1,
        toolId,
        name: 'read_file',
        activeVerb: 'Reading file',
        finalVerb: 'Read file',
        subject,
      },
      {
        type: 'tool:end' as const,
        ts: 1 + durationMs,
        toolId,
        status: 'done' as const,
        durationMs,
      },
    ] satisfies UIEvent[];

  test('3+ consecutive same-name tool:end items coalesce into a single tool-end-batch', () => {
    const result = drive([
      ...readPair('t1', 'src/a.ts', 100),
      ...readPair('t2', 'src/b.ts', 200),
      ...readPair('t3', 'src/c.ts', 150),
    ]);
    expect(result.permanent).toHaveLength(1);
    const item = result.permanent[0];
    if (item?.kind !== 'tool-end-batch') throw new Error('expected tool-end-batch');
    expect(item.name).toBe('read_file');
    expect(item.count).toBe(3);
    expect(item.totalDurationMs).toBe(450);
    expect(item.subjects).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(item.verb).toBe('Read 3 files');
    expect(item.status).toBe('done');
  });

  test('1-2 same-name tool:end items emit individually (no fold below threshold)', () => {
    // The buffer ALWAYS captures, but flush respects the threshold:
    // 1-2 items unfold back into individual `tool-end` chips so the
    // operator gets normal per-tool visibility for small batches
    // without surprise coalescing.
    const result = drive([...readPair('t1', 'src/a.ts'), ...readPair('t2', 'src/b.ts')]);
    expect(result.permanent.map((i) => i.kind)).toEqual(['tool-end', 'tool-end']);
  });

  test('different tool names do NOT merge across the batch', () => {
    // A read followed by a bash followed by a read produces three
    // individual chips, not one cross-tool batch.
    const result = drive([
      ...readPair('t1', 'src/a.ts'),
      {
        type: 'tool:start',
        ts: 100,
        toolId: 't2',
        name: 'bash',
        activeVerb: 'Executing',
        finalVerb: 'Executed',
        subject: 'ls',
      },
      { type: 'tool:end', ts: 110, toolId: 't2', status: 'done', durationMs: 10 },
      ...readPair('t3', 'src/b.ts'),
    ]);
    expect(result.permanent.map((i) => i.kind)).toEqual(['tool-end', 'tool-end', 'tool-end']);
    // Names preserved per chip — no name homogenization across the
    // sequence.
    expect((result.permanent[0] as { name: string }).name).toBe('read_file');
    expect((result.permanent[1] as { name: string }).name).toBe('bash');
    expect((result.permanent[2] as { name: string }).name).toBe('read_file');
  });

  test('different parentIds do NOT merge across the batch (parent vs subagent reads)', () => {
    // Parent's reads and a subagent's reads share the tool name
    // but have different parentIds. They MUST stay in separate
    // batches so attribution doesn't cross the boundary.
    const result = drive([
      ...readPair('t1', '/parent/a.ts'),
      ...readPair('t2', '/parent/b.ts'),
      ...readPair('t3', '/parent/c.ts'),
      // Now three subagent reads with parentId set.
      {
        type: 'tool:start',
        ts: 1000,
        toolId: 'sub:s1:r1',
        name: 'read_file',
        activeVerb: 'Reading file',
        finalVerb: 'Read file',
        subject: '/sub/a.ts',
        parentId: 's1',
      },
      { type: 'tool:end', ts: 1100, toolId: 'sub:s1:r1', status: 'done', durationMs: 100 },
      {
        type: 'tool:start',
        ts: 1100,
        toolId: 'sub:s1:r2',
        name: 'read_file',
        activeVerb: 'Reading file',
        finalVerb: 'Read file',
        subject: '/sub/b.ts',
        parentId: 's1',
      },
      { type: 'tool:end', ts: 1200, toolId: 'sub:s1:r2', status: 'done', durationMs: 100 },
      {
        type: 'tool:start',
        ts: 1200,
        toolId: 'sub:s1:r3',
        name: 'read_file',
        activeVerb: 'Reading file',
        finalVerb: 'Read file',
        subject: '/sub/c.ts',
        parentId: 's1',
      },
      { type: 'tool:end', ts: 1300, toolId: 'sub:s1:r3', status: 'done', durationMs: 100 },
    ]);
    // Two distinct batches each above the threshold → two
    // tool-end-batch items, NOT one merged six-count batch.
    const batches = result.permanent.filter(
      (i): i is Extract<PermanentItem, { kind: 'tool-end-batch' }> => i.kind === 'tool-end-batch',
    );
    expect(batches).toHaveLength(2);
    expect(batches[0]?.parentId).toBeUndefined();
    expect(batches[0]?.count).toBe(3);
    expect(batches[1]?.parentId).toBe('s1');
    expect(batches[1]?.count).toBe(3);
  });

  test('non-done tool:end (error/denied) bypasses the buffer and emits immediately', () => {
    // Real-world UX bug: a denied bash chip sat in the buffer
    // for 51s while the agent paused on the policy refusal,
    // leaving the operator staring at the previous batch with
    // no signal that the NEXT tool was blocked. Errors and
    // denials now skip the buffer entirely and emit as their
    // own tool-end chip in scrollback the moment the event
    // lands.
    const denyState = createInitialState();
    const s = applyEvent(denyState, {
      type: 'tool:start',
      ts: 1,
      toolId: 't-bash',
      name: 'bash',
      activeVerb: 'Executing',
      finalVerb: 'Executed',
      subject: 'ls',
    }).state;
    const r = applyEvent(s, {
      type: 'tool:end',
      ts: 2,
      toolId: 't-bash',
      status: 'denied',
      durationMs: 1,
      summary: 'no policy rule matched',
    });
    // Emitted IMMEDIATELY — no buffer wait.
    expect(r.permanent).toHaveLength(1);
    const item = r.permanent[0];
    if (item?.kind !== 'tool-end') throw new Error('expected tool-end');
    expect(item.status).toBe('denied');
    expect(item.summary).toBe('no policy rule matched');
    // Buffer must not be left holding anything either.
    expect(r.state.pendingToolEndBatch).toBeNull();
  });

  test('error mid-stream flushes the partial green batch FIRST, then emits the error', () => {
    // Trade-off documented in the tool:end case: a failure
    // splits the batch. Operator sees the green prefix, the
    // failure boundary, and any subsequent green continuation
    // as separate chips. More honest than a single batch chip
    // with worst-of status hiding the boundary.
    const result = drive([
      ...readPair('t1', 'src/a.ts', 10),
      {
        type: 'tool:start',
        ts: 11,
        toolId: 't2',
        name: 'read_file',
        activeVerb: 'Reading file',
        finalVerb: 'Read file',
        subject: 'src/b.ts',
      },
      { type: 'tool:end', ts: 20, toolId: 't2', status: 'error', durationMs: 9 },
      ...readPair('t3', 'src/c.ts', 10),
    ]);
    // 3 individual tool-end chips: green prefix (1 item, below
    // threshold), the error, the green suffix (1 item, below
    // threshold). NO tool-end-batch — the failure broke the
    // batch.
    expect(result.permanent.map((p) => p.kind)).toEqual(['tool-end', 'tool-end', 'tool-end']);
    const statuses = result.permanent.map((p) => (p.kind === 'tool-end' ? p.status : null));
    expect(statuses).toEqual(['done', 'error', 'done']);
  });

  test('null subjects are filtered out of the batch continuation list', () => {
    // todo_write-style tools (no vocab subject) produce null
    // subjects. They count toward `count` but don't surface as
    // `|_` continuation lines (a bare `|_ ` with no payload is
    // visual noise). Tested with a non-todo tool name so the
    // batch still triggers via threshold.
    const result = drive([
      {
        type: 'tool:start',
        ts: 1,
        toolId: 't1',
        name: 'echo',
        activeVerb: 'Echoing',
        finalVerb: 'Echoed',
        subject: 'hi',
      },
      { type: 'tool:end', ts: 10, toolId: 't1', status: 'done', durationMs: 9 },
      {
        type: 'tool:start',
        ts: 11,
        toolId: 't2',
        name: 'echo',
        activeVerb: 'Echoing',
        finalVerb: 'Echoed',
        subject: null,
      },
      { type: 'tool:end', ts: 20, toolId: 't2', status: 'done', durationMs: 9 },
      {
        type: 'tool:start',
        ts: 21,
        toolId: 't3',
        name: 'echo',
        activeVerb: 'Echoing',
        finalVerb: 'Echoed',
        subject: 'world',
      },
      { type: 'tool:end', ts: 30, toolId: 't3', status: 'done', durationMs: 9 },
    ]);
    const item = result.permanent[0];
    if (item?.kind !== 'tool-end-batch') throw new Error('expected tool-end-batch');
    expect(item.count).toBe(3);
    expect(item.subjects).toEqual(['hi', 'world']);
  });

  test('non-tool:end events with permanent items flush the batch FIRST (chronological order)', () => {
    // A user:submit (or any scrollback-emitting event) that lands
    // mid-stream after a partial batch must trigger the buffer to
    // flush BEFORE the new event's permanent items hit the log,
    // so chronology stays intact.
    const result = drive([
      ...readPair('t1', 'src/a.ts'),
      ...readPair('t2', 'src/b.ts'),
      // Flush trigger: warn (emits a permanent item).
      { type: 'warn', ts: 200, message: 'something' },
    ]);
    // Order: 2 tool-ends (under threshold so emit individual) +
    // the warn item. Crucially the tool-ends come FIRST.
    expect(result.permanent.map((i) => i.kind)).toEqual(['tool-end', 'tool-end', 'warn']);
  });

  test('batch holds across no-permanent events (status updates do NOT flush)', () => {
    // step:budget emits no permanent — buffer should hold across
    // it. Without this invariant, a parallel batch interleaved
    // with status updates would never coalesce.
    const result = drive([
      ...readPair('t1', 'src/a.ts'),
      ...readPair('t2', 'src/b.ts'),
      // No-op for permanent. Must NOT flush the batch.
      { type: 'step:budget', ts: 50, steps: 1, maxSteps: 200, costUsd: 0.01 },
      ...readPair('t3', 'src/c.ts'),
    ]);
    expect(result.permanent).toHaveLength(1);
    expect(result.permanent[0]?.kind).toBe('tool-end-batch');
  });
});

describe('applyEvent wrapper (flush lifecycle, slice 3)', () => {
  // Direct unit tests for the public `applyEvent` wrapper that
  // sits in front of `applyEventInner`. The integration tests in
  // the batch coalescing block exercise this through `drive`,
  // but a focused test catches a future refactor that splits the
  // wrapper or changes the flush rule without realizing the
  // contract — the `drive` tests would still pass if the bug
  // happens to land on a path they don't probe.
  //
  // We seed `pendingToolEndBatch` directly to isolate the
  // wrapper's behavior from the inner reducer's tool:end logic.
  // Production code never builds this state by hand; the helper
  // here is a one-shot fixture, not an exported pattern.

  const seedBatch = (state: LiveState): LiveState => ({
    ...state,
    pendingToolEndBatch: {
      name: 'read_file',
      items: [
        { verb: 'Read file', subject: 'a.ts', status: 'done', durationMs: 50 },
        { verb: 'Read file', subject: 'b.ts', status: 'done', durationMs: 60 },
        { verb: 'Read file', subject: 'c.ts', status: 'done', durationMs: 70 },
      ],
    },
  });

  test('non-tool:end event with empty inner permanent does NOT flush the buffer', () => {
    // step:budget emits no permanent. The wrapper must leave the
    // buffer untouched — the load-bearing invariant for parallel
    // batches that interleave with status updates / heartbeats.
    const state = seedBatch(createInitialState());
    const r = applyEvent(state, {
      type: 'step:budget',
      ts: 1,
      steps: 1,
      maxSteps: 200,
      costUsd: 0,
    });
    expect(r.permanent).toEqual([]);
    expect(r.state.pendingToolEndBatch).not.toBeNull();
    expect(r.state.pendingToolEndBatch?.items).toHaveLength(3);
  });

  test('non-tool:end event with non-empty inner permanent FLUSHES the buffer first', () => {
    // The flushed items prepend BEFORE the inner's permanent so
    // chronology is preserved (batch chronologically completed
    // before whatever scrollback-emitting event fired next).
    const state = seedBatch(createInitialState());
    const r = applyEvent(state, { type: 'warn', ts: 1, message: 'something' });
    expect(r.permanent.map((p) => p.kind)).toEqual(['tool-end-batch', 'warn']);
    expect(r.state.pendingToolEndBatch).toBeNull();
  });

  test('tool:end event NEVER auto-flushes via the wrapper (inner manages buffer)', () => {
    // The wrapper's `event.type === 'tool:end' → return inner`
    // short-circuit is the only thing standing between
    // coalescing-works and every-tool-end-flushes. A regression
    // that flipped the gate (e.g., flushing on tool:end too)
    // would surface here as immediate emission instead of
    // buffer extension.
    const state = createInitialState();
    // First tool:end starts a fresh batch — emits nothing.
    const r1 = applyEvent(state, {
      type: 'tool:start',
      ts: 1,
      toolId: 't1',
      name: 'read_file',
      activeVerb: 'Reading file',
      finalVerb: 'Read file',
      subject: 'a.ts',
    });
    const r2 = applyEvent(r1.state, {
      type: 'tool:end',
      ts: 50,
      toolId: 't1',
      status: 'done',
      durationMs: 50,
    });
    // Buffer holds; nothing emitted yet.
    expect(r2.permanent).toEqual([]);
    expect(r2.state.pendingToolEndBatch).not.toBeNull();
    expect(r2.state.pendingToolEndBatch?.items).toHaveLength(1);
  });

  test('inner permanent items survive the wrapper unchanged when buffer is empty', () => {
    // Sanity: no buffer, non-tool:end event with permanent → the
    // wrapper passes the inner's permanent through verbatim, no
    // synthetic batch entries inserted. Pinned so a regression
    // that always-prepends an empty batch (or worse, a default
    // tool-end-batch with count 0) would surface immediately.
    const state = createInitialState();
    const r = applyEvent(state, { type: 'info', ts: 1, message: 'hi' });
    expect(r.permanent.map((p) => p.kind)).toEqual(['info']);
    expect(r.state.pendingToolEndBatch).toBeNull();
  });

  test('inner state mutations through the flush survive into the wrapper output', () => {
    // The wrapper must not stomp the inner's state changes when
    // it threads through the flush. Pinned by checking that an
    // event which changes status fields (step:budget under a
    // pending batch — but only when the inner produces
    // permanent... step:budget produces none, so use a flush-
    // triggering event that also mutates state).
    //
    // user:submit clears input and emits a permanent. Both must
    // survive: input cleared AND batch flushed AND user-submit
    // permanent appended.
    const state = seedBatch({
      ...createInitialState(),
      input: { value: 'hello', cursor: 5 },
    });
    const r = applyEvent(state, { type: 'user:submit', ts: 1, text: 'hello' });
    // Inner state mutation preserved.
    expect(r.state.input.value).toBe('');
    // Buffer flushed.
    expect(r.state.pendingToolEndBatch).toBeNull();
    // Both kinds in the right order: batch first, then user-submit.
    expect(r.permanent.map((p) => p.kind)).toEqual(['tool-end-batch', 'user-submit']);
  });
});

describe('session boundary handling of pendingToolEndBatch', () => {
  // Reviewer-flagged defect: the wrapper skips flushing when
  // inner.permanent is empty, so a session:start that follows a
  // session that terminated mid-batch (process killed, harness
  // crash, headless invocation that bypassed session:end) would
  // carry the stale buffer forward and emit those items as
  // scrollback under the WRONG session boundary. Boundary
  // events must handle the buffer explicitly, not depend on
  // the wrapper's permanent-emit trigger.

  test('session:start drops a stale pendingToolEndBatch (chronology cleanup)', () => {
    // Build a state with a half-pending batch, then fire a fresh
    // session:start. Items in the buffer at that moment belong
    // to a session that didn't reach session:end — emitting
    // them under the new session would misattribute the
    // chronology. Drop > flush.
    const dirty: LiveState = {
      ...createInitialState(),
      pendingToolEndBatch: {
        name: 'read_file',
        items: [{ verb: 'Read file', subject: 'a.ts', status: 'done', durationMs: 10 }],
      },
    };
    const r = applyEvent(dirty, start());
    expect(r.state.pendingToolEndBatch).toBeNull();
    // Crucially the items are NOT emitted as permanent. Wrong
    // session attribution would be worse than dropping silently.
    expect(r.permanent).toEqual([]);
  });

  test('session:end flushes the buffer BEFORE the footer (correct chronology)', () => {
    // The session that emitted the tool calls is the one ending,
    // so the buffer's items DO belong in this session's
    // scrollback — drained before the footer marker.
    const dirty: LiveState = {
      ...createInitialState(),
      pendingToolEndBatch: {
        name: 'read_file',
        items: [
          { verb: 'Read file', subject: 'a.ts', status: 'done', durationMs: 10 },
          { verb: 'Read file', subject: 'b.ts', status: 'done', durationMs: 20 },
        ],
      },
    };
    const r = applyEvent(dirty, {
      type: 'session:end',
      ts: 1,
      sessionId: 's1',
      reason: 'done',
    });
    // Two tool-end items (under the threshold of 3, so each
    // emits individually) come BEFORE the session-footer.
    expect(r.permanent.map((p) => p.kind)).toEqual(['tool-end', 'tool-end', 'session-footer']);
    expect(r.state.pendingToolEndBatch).toBeNull();
  });

  test('session:end with a coalesce-eligible buffer flushes as a single tool-end-batch', () => {
    // 3+ items in the buffer flush as `tool-end-batch`, not
    // as N individual chips. Pinned so the boundary flush
    // respects the same threshold logic the regular path uses.
    const dirty: LiveState = {
      ...createInitialState(),
      pendingToolEndBatch: {
        name: 'read_file',
        items: [
          { verb: 'Read file', subject: 'a.ts', status: 'done', durationMs: 10 },
          { verb: 'Read file', subject: 'b.ts', status: 'done', durationMs: 20 },
          { verb: 'Read file', subject: 'c.ts', status: 'done', durationMs: 30 },
        ],
      },
    };
    const r = applyEvent(dirty, {
      type: 'session:end',
      ts: 1,
      sessionId: 's1',
      reason: 'done',
    });
    expect(r.permanent.map((p) => p.kind)).toEqual(['tool-end-batch', 'session-footer']);
    const batch = r.permanent[0];
    if (batch?.kind !== 'tool-end-batch') throw new Error('expected tool-end-batch');
    expect(batch.count).toBe(3);
    expect(batch.subjects).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  test('session:end with no buffer emits ONLY the footer (no synthetic items)', () => {
    // Sanity: the explicit flush in session:end must not
    // synthesize items when the buffer was empty. Pinned to
    // catch a regression that always emits at least one
    // tool-end-batch (e.g., a count-zero artifact).
    const r = applyEvent(createInitialState(), {
      type: 'session:end',
      ts: 1,
      sessionId: 's1',
      reason: 'done',
    });
    expect(r.permanent.map((p) => p.kind)).toEqual(['session-footer']);
  });
});

describe('awaitingProvider indicator (provider:waiting bracket)', () => {
  test('provider:waiting:start sets awaitingProvider with stepN + ts', () => {
    const r = applyEvent(createInitialState(), {
      type: 'provider:waiting:start',
      ts: 100,
      stepN: 3,
    });
    expect(r.state.awaitingProvider).toEqual({ stepN: 3, startedAt: 100 });
    expect(r.permanent).toEqual([]);
  });

  test('provider:waiting:end clears the indicator', () => {
    let s = applyEvent(createInitialState(), {
      type: 'provider:waiting:start',
      ts: 100,
      stepN: 1,
    }).state;
    s = applyEvent(s, { type: 'provider:waiting:end', ts: 150 }).state;
    expect(s.awaitingProvider).toBeNull();
  });

  test('provider:waiting:end is a no-op when nothing is pending (defensive double-close)', () => {
    const r = applyEvent(createInitialState(), { type: 'provider:waiting:end', ts: 1 });
    expect(r.state.awaitingProvider).toBeNull();
    expect(r.permanent).toEqual([]);
  });

  test('assistant:start clears awaitingProvider (more specific chip takes the slot)', () => {
    let s = applyEvent(createInitialState(), {
      type: 'provider:waiting:start',
      ts: 100,
      stepN: 1,
    }).state;
    expect(s.awaitingProvider).not.toBeNull();
    s = applyEvent(s, { type: 'assistant:start', ts: 200, messageId: 'm1' }).state;
    expect(s.awaitingProvider).toBeNull();
    expect(s.pendingAssistant).not.toBeNull();
  });

  test('thinking:start clears awaitingProvider', () => {
    let s = applyEvent(createInitialState(), {
      type: 'provider:waiting:start',
      ts: 100,
      stepN: 1,
    }).state;
    s = applyEvent(s, { type: 'thinking:start', ts: 200, messageId: 'm1' }).state;
    expect(s.awaitingProvider).toBeNull();
    expect(s.thinking).not.toBeNull();
  });

  test('session:start / session:end clear awaitingProvider (boundary cleanup)', () => {
    let s = applyEvent(createInitialState(), {
      type: 'provider:waiting:start',
      ts: 100,
      stepN: 1,
    }).state;
    // Session boundary should drop the indicator regardless of
    // direction (start of a new turn or end of the current run).
    s = applyEvent(s, start()).state;
    expect(s.awaitingProvider).toBeNull();
    s = applyEvent(s, {
      type: 'provider:waiting:start',
      ts: 200,
      stepN: 2,
    }).state;
    expect(s.awaitingProvider).not.toBeNull();
    s = applyEvent(s, { type: 'session:end', ts: 300, sessionId: 's1', reason: 'done' }).state;
    expect(s.awaitingProvider).toBeNull();
  });
});

describe('budget + diagnostics', () => {
  test('step:budget updates status fields without emitting permanent', () => {
    const r = applyEvent(createInitialState(), {
      type: 'step:budget',
      ts: 1,
      steps: 10,
      maxSteps: 50,
      costUsd: 0.123,
      maxCostUsd: 5,
    });
    expect(r.state.status.steps).toBe(10);
    expect(r.state.status.maxSteps).toBe(50);
    expect(r.state.status.costUsd).toBe(0.123);
    expect(r.state.status.maxCostUsd).toBe(5);
    expect(r.permanent).toEqual([]);
  });

  test('error event emits an error item', () => {
    const r = applyEvent(createInitialState(), {
      type: 'error',
      ts: 1,
      message: 'provider down',
    });
    expect(r.permanent).toEqual([{ kind: 'error', message: 'provider down' }]);
  });

  test('warn event emits a warn item', () => {
    const r = applyEvent(createInitialState(), {
      type: 'warn',
      ts: 1,
      message: 'budget at 80%',
    });
    expect(r.permanent).toEqual([{ kind: 'warn', message: 'budget at 80%' }]);
  });
});

describe('todo:update', () => {
  test('initial state has empty todo list', () => {
    expect(createInitialState().todos).toEqual([]);
  });

  test('todo:update populates state.todos and emits no permanent', () => {
    const r = applyEvent(createInitialState(), {
      type: 'todo:update',
      ts: 1,
      items: [
        { content: 'Implement', activeForm: 'Implementing', status: 'in_progress' },
        { content: 'Test', activeForm: 'Testing', status: 'pending' },
      ],
    });
    expect(r.permanent).toEqual([]);
    expect(r.state.todos).toHaveLength(2);
    expect(r.state.todos[0]?.status).toBe('in_progress');
    expect(r.state.todos[1]?.content).toBe('Test');
  });

  test('second update full-replaces (no merge)', () => {
    const { state } = drive([
      {
        type: 'todo:update',
        ts: 1,
        items: [
          { content: 'A', activeForm: 'A-ing', status: 'pending' },
          { content: 'B', activeForm: 'B-ing', status: 'pending' },
          { content: 'C', activeForm: 'C-ing', status: 'pending' },
        ],
      },
      {
        type: 'todo:update',
        ts: 2,
        items: [{ content: 'A', activeForm: 'A-ing', status: 'done' }],
      },
    ]);
    // Full-replace: B and C are gone, A's status flipped to done.
    expect(state.todos).toHaveLength(1);
    expect(state.todos[0]?.status).toBe('done');
  });

  test('todo:update with empty items clears the list', () => {
    const { state } = drive([
      {
        type: 'todo:update',
        ts: 1,
        items: [{ content: 'X', activeForm: 'Xing', status: 'pending' }],
      },
      { type: 'todo:update', ts: 2, items: [] },
    ]);
    expect(state.todos).toEqual([]);
  });
});

describe('interrupt (soft / hard)', () => {
  test('initial state has softInterrupted false', () => {
    expect(createInitialState().softInterrupted).toBe(false);
  });

  test('interrupt soft sets softInterrupted true (no permanent)', () => {
    const r = applyEvent(createInitialState(), { type: 'interrupt', ts: 1, level: 'soft' });
    expect(r.state.softInterrupted).toBe(true);
    expect(r.permanent).toEqual([]);
  });

  test('interrupt hard does not flip softInterrupted (purely diagnostic today)', () => {
    const r = applyEvent(createInitialState(), { type: 'interrupt', ts: 1, level: 'hard' });
    expect(r.state.softInterrupted).toBe(false);
    expect(r.permanent).toEqual([]);
  });

  test('repeated soft interrupts are idempotent (already true stays true)', () => {
    const { state } = drive([
      { type: 'interrupt', ts: 1, level: 'soft' },
      { type: 'interrupt', ts: 2, level: 'soft' },
      { type: 'interrupt', ts: 3, level: 'soft' },
    ]);
    expect(state.softInterrupted).toBe(true);
  });

  test('session:end clears softInterrupted (ready for next turn)', () => {
    const { state } = drive([
      start(),
      { type: 'interrupt', ts: 2, level: 'soft' },
      { type: 'session:end', ts: 3, sessionId: 's1', reason: 'aborted' },
    ]);
    expect(state.softInterrupted).toBe(false);
    expect(state.ended).toBe(true);
  });

  test('session:start clears softInterrupted (boundary cleanup before resume)', () => {
    const { state } = drive([
      { type: 'interrupt', ts: 1, level: 'soft' },
      start({ ts: 2, sessionId: 's2' }),
    ]);
    expect(state.softInterrupted).toBe(false);
  });
});

describe('idle Ctrl+C exit gate (UI.md §5.4)', () => {
  test('initial state has exitArmed null', () => {
    expect(createInitialState().exitArmed).toBeNull();
  });

  test('interrupt:exit-arm sets exitArmed with the event timestamp', () => {
    const r = applyEvent(createInitialState(), { type: 'interrupt:exit-arm', ts: 42 });
    expect(r.state.exitArmed).toEqual({ at: 42 });
    expect(r.permanent).toEqual([]);
  });

  test('interrupt:exit-cancel clears exitArmed', () => {
    const { state } = drive([
      { type: 'interrupt:exit-arm', ts: 1 },
      { type: 'interrupt:exit-cancel', ts: 2 },
    ]);
    expect(state.exitArmed).toBeNull();
  });

  test('interrupt:exit-cancel on null state is idempotent (no permanent emit)', () => {
    const r = applyEvent(createInitialState(), { type: 'interrupt:exit-cancel', ts: 1 });
    expect(r.state.exitArmed).toBeNull();
    expect(r.permanent).toEqual([]);
  });

  test('repeated interrupt:exit-arm refreshes the timestamp (latest press wins)', () => {
    const { state } = drive([
      { type: 'interrupt:exit-arm', ts: 100 },
      { type: 'interrupt:exit-arm', ts: 250 },
    ]);
    expect(state.exitArmed).toEqual({ at: 250 });
  });

  test('session:start clears exitArmed (boundary cleanup before turn)', () => {
    const { state } = drive([{ type: 'interrupt:exit-arm', ts: 1 }, start({ ts: 2 })]);
    expect(state.exitArmed).toBeNull();
  });

  test('session:end clears exitArmed (boundary cleanup after turn)', () => {
    const { state } = drive([
      start(),
      { type: 'interrupt:exit-arm', ts: 2 },
      { type: 'session:end', ts: 3, sessionId: 's1', reason: 'done' },
    ]);
    expect(state.exitArmed).toBeNull();
  });
});

describe('bg lifecycle', () => {
  test('initial state has empty bgProcesses', () => {
    expect(createInitialState().bgProcesses.size).toBe(0);
  });

  test('bg:start adds an entry, bg:end removes it', () => {
    const { state } = drive([
      { type: 'bg:start', ts: 1, processId: 'p1', command: 'npm run dev' },
      { type: 'bg:start', ts: 2, processId: 'p2', command: 'pytest --watch' },
      { type: 'bg:end', ts: 3, processId: 'p1', cause: 'exited', exitCode: 0 },
    ]);
    expect(state.bgProcesses.size).toBe(1);
    expect(state.bgProcesses.has('p2')).toBe(true);
    expect(state.bgProcesses.get('p2')?.command).toBe('pytest --watch');
  });

  test('bg:end for unknown processId is a no-op', () => {
    const { state } = drive([
      { type: 'bg:end', ts: 1, processId: 'never-started', cause: 'exited', exitCode: 0 },
    ]);
    expect(state.bgProcesses.size).toBe(0);
  });

  test('bg:start with duplicate processId overwrites silently', () => {
    // Producer bug shouldn't crash — Map.set semantics keep the
    // count correct (still 1) and the renderer shows the latest
    // command on a future per-process tray.
    const { state } = drive([
      { type: 'bg:start', ts: 1, processId: 'p1', command: 'first' },
      { type: 'bg:start', ts: 2, processId: 'p1', command: 'second' },
    ]);
    expect(state.bgProcesses.size).toBe(1);
    expect(state.bgProcesses.get('p1')?.command).toBe('second');
  });

  test('bg:update does not flap the count (no producer today)', () => {
    const { state } = drive([
      { type: 'bg:start', ts: 1, processId: 'p1', command: 'x' },
      { type: 'bg:update', ts: 2, processId: 'p1', status: 'cpu high' },
    ]);
    expect(state.bgProcesses.size).toBe(1);
  });

  test('session:start clears bgProcesses (fresh session boundary)', () => {
    const { state } = drive([
      { type: 'bg:start', ts: 1, processId: 'p1', command: 'x' },
      start({ ts: 2, sessionId: 's2' }),
    ]);
    expect(state.bgProcesses.size).toBe(0);
  });
});

describe('subagent lifecycle', () => {
  test('initial state has empty subagents map', () => {
    expect(createInitialState().subagents.size).toBe(0);
  });

  test('subagent:start adds an entry keyed by subagentId', () => {
    const { state, permanent } = drive([
      { type: 'subagent:start', ts: 100, subagentId: 'c1', name: 'explore', goal: 'find README' },
    ]);
    expect(state.subagents.size).toBe(1);
    const entry = state.subagents.get('c1');
    expect(entry?.name).toBe('explore');
    expect(entry?.goal).toBe('find README');
    expect(entry?.startedAt).toBe(100);
    expect(entry?.progress).toBe('');
    expect(permanent).toEqual([]);
  });

  test('subagent:update mutates the existing entry in place', () => {
    const { state, permanent } = drive([
      { type: 'subagent:start', ts: 1, subagentId: 'c1', name: 'r', goal: 'g' },
      { type: 'subagent:update', ts: 2, subagentId: 'c1', progress: 'running echo' },
    ]);
    expect(state.subagents.get('c1')?.progress).toBe('running echo');
    expect(permanent).toEqual([]);
  });

  test('subagent:update for unknown id is a silent no-op', () => {
    const { state, permanent } = drive([
      { type: 'subagent:update', ts: 1, subagentId: 'never', progress: '...' },
    ]);
    expect(state.subagents.size).toBe(0);
    expect(permanent).toEqual([]);
  });

  test('subagent:end removes the entry and emits subagent_summary permanent', () => {
    const { state, permanent } = drive([
      { type: 'subagent:start', ts: 1, subagentId: 'c1', name: 'explore', goal: 'g' },
      {
        type: 'subagent:end',
        ts: 1234,
        subagentId: 'c1',
        status: 'done',
        costUsd: 0,
        summary: 'README at /repo/README.md',
        durationMs: 5_000,
      },
    ]);
    expect(state.subagents.size).toBe(0);
    expect(permanent.length).toBe(1);
    const item = permanent[0];
    if (item?.kind === 'subagent_summary') {
      expect(item.subagentId).toBe('c1');
      expect(item.name).toBe('explore');
      expect(item.status).toBe('done');
      expect(item.summary).toBe('README at /repo/README.md');
      expect(item.durationMs).toBe(5_000);
    } else {
      throw new Error('expected subagent_summary permanent');
    }
  });

  test('subagent:end without a prior start emits no permanent (defensive)', () => {
    // Out-of-order producer would otherwise produce a half-formed
    // summary line. Reducer's policy: drop silently.
    const { state, permanent } = drive([
      {
        type: 'subagent:end',
        ts: 1,
        subagentId: 'orphan',
        status: 'error',
        costUsd: 0,
        summary: 'lost',
        durationMs: 0,
      },
    ]);
    expect(state.subagents.size).toBe(0);
    expect(permanent).toEqual([]);
  });

  test('multiple concurrent subagents render as independent entries', () => {
    const { state } = drive([
      { type: 'subagent:start', ts: 1, subagentId: 'a', name: 'explore', goal: 'g1' },
      { type: 'subagent:start', ts: 2, subagentId: 'b', name: 'audit', goal: 'g2' },
      { type: 'subagent:update', ts: 3, subagentId: 'a', progress: 'step 1' },
      { type: 'subagent:update', ts: 4, subagentId: 'b', progress: 'step 1' },
    ]);
    expect(state.subagents.size).toBe(2);
    expect(state.subagents.get('a')?.progress).toBe('step 1');
    expect(state.subagents.get('b')?.progress).toBe('step 1');
  });

  test('session:start clears the subagents map (fresh session boundary)', () => {
    const { state } = drive([
      { type: 'subagent:start', ts: 1, subagentId: 'c1', name: 'r', goal: 'g' },
      start({ ts: 2, sessionId: 's2' }),
    ]);
    expect(state.subagents.size).toBe(0);
  });

  test('session:end clears the subagents map', () => {
    const { state } = drive([
      { type: 'subagent:start', ts: 1, subagentId: 'c1', name: 'r', goal: 'g' },
      { type: 'session:end', ts: 2, sessionId: 's', reason: 'done', durationMs: 100 },
    ]);
    expect(state.subagents.size).toBe(0);
  });
});

describe('permission:ask modal (UI.md §4.10.13)', () => {
  test('parent confirm renders the per-tool context label', () => {
    // Modal redesign (design/permission-modal-redesign.md): the
    // title slot carries a per-tool context label instead of the
    // generic "Run command". bash family → "Bash command".
    // Subject is null (the context label IS the subject row);
    // question is null (numbered options are self-evident).
    const r = applyEvent(createInitialState(), {
      type: 'permission:ask',
      ts: 1,
      promptId: 'p1',
      toolName: 'bash',
      command: 'rm -rf /',
      cwd: '/p',
    } as UIEvent);
    expect(r.state.modal).not.toBeNull();
    if (r.state.modal !== null) {
      expect(r.state.modal.title).toBe('Bash command');
      expect(r.state.modal.subject).toBeNull();
      expect(r.state.modal.question).toBeNull();
      // Action block has blank-line-action-blank-line shape — the
      // breathing room is what sets the action apart visually.
      // Action line carries `tone: 'bold'` so the renderer paints
      // it bold (operator's eye lands on the command first).
      expect(r.state.modal.preview[0]).toBe('');
      expect(r.state.modal.preview[1]).toEqual({
        text: '    $ rm -rf /',
        tone: 'bold',
      });
      expect(r.state.modal.preview[2]).toBe('');
      // cwd follows the action block.
      expect(r.state.modal.preview[3]).toBe('cwd: /p');
    }
  });

  test('per-tool context labels (bash / fs.* / web.fetch / search)', () => {
    // Pins the per-tool mapping. A drift here would surface as a
    // generic "Tool call" label for a known tool, which loses the
    // operator's category cue.
    const cases: Array<{ tool: string; label: string }> = [
      { tool: 'bash', label: 'Bash command' },
      { tool: 'bash_background', label: 'Bash command' },
      { tool: 'bash_kill', label: 'Bash command' },
      { tool: 'read_file', label: 'Accessing workspace:' },
      { tool: 'write_file', label: 'Editing file' },
      { tool: 'edit_file', label: 'Editing file' },
      { tool: 'glob', label: 'Searching workspace' },
      { tool: 'grep', label: 'Searching workspace' },
      { tool: 'fetch_url', label: 'Network access' },
    ];
    for (const c of cases) {
      const r = applyEvent(createInitialState(), {
        type: 'permission:ask',
        ts: 1,
        promptId: 'p',
        toolName: c.tool,
        command: 'x',
        cwd: '/p',
      } as UIEvent);
      expect(r.state.modal?.title).toBe(c.label);
    }
  });

  test('unknown tool falls back to generic "Tool call" label', () => {
    const r = applyEvent(createInitialState(), {
      type: 'permission:ask',
      ts: 1,
      promptId: 'p',
      toolName: 'totally_unknown_tool',
      command: 'x',
      cwd: '/p',
    } as UIEvent);
    expect(r.state.modal?.title).toBe('Tool call');
  });

  test('non-bash tools omit the "$ " action prefix', () => {
    const r = applyEvent(createInitialState(), {
      type: 'permission:ask',
      ts: 1,
      promptId: 'p',
      toolName: 'write_file',
      command: 'src/foo.ts',
      cwd: '/p',
    } as UIEvent);
    // Preview action line is the path verbatim, no shell prefix.
    // Wrapped as a `{text, tone}` object so the renderer paints bold.
    expect(r.state.modal?.preview[1]).toEqual({
      text: '    src/foo.ts',
      tone: 'bold',
    });
  });

  test('subagent attribution becomes a parenthesized title suffix (not a preview row)', () => {
    // Spec docs/spec/IPC.md §7: child-proxied asks must label the
    // subagent so the operator can distinguish parent vs child
    // requests. New layout: attribution is a suffix on the context
    // label, not a separate preview line — keeps the action block
    // visually atomic.
    const r = applyEvent(createInitialState(), {
      type: 'permission:ask',
      ts: 1,
      promptId: 'p2',
      toolName: 'bash',
      command: 'ls',
      cwd: '/p',
      subagent: { sessionId: 'abcdef-12345678', name: 'explore' },
    } as UIEvent);
    expect(r.state.modal).not.toBeNull();
    if (r.state.modal !== null) {
      expect(r.state.modal.title).toBe('Bash command (subagent: explore)');
      // Preview goes straight to the action block — no
      // "subagent: explore (12345678)" prefix line.
      expect(r.state.modal.preview[0]).toBe('');
      expect(r.state.modal.preview[1]).toEqual({ text: '    $ ls', tone: 'bold' });
      expect(r.state.modal.preview[2]).toBe('');
      expect(r.state.modal.preview[3]).toBe('cwd: /p');
      // No row contains the old "subagent: <name> (<idTail>)"
      // prefix shape.
      expect(
        r.state.modal.preview.some((p) =>
          (typeof p === 'string' ? p : p.text).startsWith('subagent: '),
        ),
      ).toBe(false);
    }
  });

  test('option 2 promotes the matched rule pattern when present', () => {
    // The session-allow option's label carries the literal rule
    // ("Yes, don't ask again for: rm -rf *") so the operator
    // reads a policy promotion, not a vague runtime toggle. Falls
    // back to the per-tool wording when rule is absent.
    const withRule = applyEvent(createInitialState(), {
      type: 'permission:ask',
      ts: 1,
      promptId: 'p',
      toolName: 'bash',
      command: 'rm -rf /tmp',
      cwd: '/p',
      rule: 'rm -rf *',
    } as UIEvent);
    const opt2WithRule = withRule.state.modal?.options[1];
    expect(opt2WithRule?.label).toBe("Yes, don't ask again for: rm -rf *");

    const noRule = applyEvent(createInitialState(), {
      type: 'permission:ask',
      ts: 2,
      promptId: 'p2',
      toolName: 'bash',
      command: 'whoami',
      cwd: '/p',
    } as UIEvent);
    const opt2NoRule = noRule.state.modal?.options[1];
    expect(opt2NoRule?.label).toBe('Yes, allow all bash during this session');
  });

  test('footer hints carry Tab to amend + Ctrl+E to explain', () => {
    // Pre-flowing the footer for handlers that land in later
    // slices. Without this reservation, the layout would re-flow
    // when Tab/Ctrl+E ship and operators would see a layout
    // change between minor versions.
    const r = applyEvent(createInitialState(), {
      type: 'permission:ask',
      ts: 1,
      promptId: 'p',
      toolName: 'bash',
      command: 'ls',
      cwd: '/p',
    } as UIEvent);
    expect(r.state.modal?.hints).toEqual(['Esc to cancel', 'Tab to amend', 'Ctrl+E to explain']);
  });
});

describe('modal:queue-depth (live count of asks queued behind active)', () => {
  test('matching promptId updates state.modal.queueDepth', () => {
    const opened = applyEvent(createInitialState(), {
      type: 'permission:ask',
      ts: 1,
      promptId: 'p1',
      toolName: 'bash',
      command: 'rm',
      cwd: '/p',
    } as UIEvent);
    expect(opened.state.modal?.queueDepth).toBe(0);
    const bumped = applyEvent(opened.state, {
      type: 'modal:queue-depth',
      ts: 2,
      promptId: 'p1',
      depth: 3,
    } as UIEvent);
    expect(bumped.state.modal?.queueDepth).toBe(3);
  });

  test('mismatched promptId is dropped silently (no state churn)', () => {
    const opened = applyEvent(createInitialState(), {
      type: 'permission:ask',
      ts: 1,
      promptId: 'p1',
      toolName: 'bash',
      command: 'rm',
      cwd: '/p',
    } as UIEvent);
    const stale = applyEvent(opened.state, {
      type: 'modal:queue-depth',
      ts: 2,
      promptId: 'p-other',
      depth: 99,
    } as UIEvent);
    expect(stale.state).toBe(opened.state);
    expect(stale.state.modal?.queueDepth).toBe(0);
  });

  test('event after the modal closed is dropped silently', () => {
    const r = applyEvent(createInitialState(), {
      type: 'modal:queue-depth',
      ts: 1,
      promptId: 'p1',
      depth: 5,
    } as UIEvent);
    expect(r.state.modal).toBeNull();
    expect(r.permanent).toEqual([]);
  });

  test('negative depth clamps to 0 (defensive)', () => {
    const opened = applyEvent(createInitialState(), {
      type: 'permission:ask',
      ts: 1,
      promptId: 'p1',
      toolName: 'bash',
      command: 'rm',
      cwd: '/p',
    } as UIEvent);
    const bad = applyEvent(opened.state, {
      type: 'modal:queue-depth',
      ts: 2,
      promptId: 'p1',
      depth: -7,
    } as UIEvent);
    expect(bad.state.modal?.queueDepth).toBe(0);
  });
});

describe('not-yet-wired events accept silently', () => {
  test.each([
    [
      'permission:ask',
      { type: 'permission:ask', ts: 1, promptId: 'p1', toolName: 'bash', command: 'rm', cwd: '/' },
    ],
    ['modal:answer', { type: 'modal:answer', ts: 1, promptId: 'p1', decision: 'no' }],
    ['trust:ask', { type: 'trust:ask', ts: 1, promptId: 'p1', path: '/repo', agentsMd: false }],
    [
      'memory:write:ask',
      {
        type: 'memory:write:ask',
        ts: 1,
        promptId: 'p1',
        scope: 'project_local',
        name: 'x',
        body: 'y',
      },
    ],
    [
      'memory:user-scope:ask',
      {
        type: 'memory:user-scope:ask',
        ts: 1,
        promptId: 'p1',
        name: 'x',
        body: 'y',
      },
    ],
    [
      'plan:review',
      {
        type: 'plan:review',
        ts: 1,
        promptId: 'p1',
        steps: [],
        estimatedCalls: 0,
        estimatedCostUsd: 0,
      },
    ],
    ['critique:ask', { type: 'critique:ask', ts: 1, promptId: 'p1', issues: [] }],
    ['bg:start', { type: 'bg:start', ts: 1, processId: 'b1', command: 'sleep' }],
    ['bg:update', { type: 'bg:update', ts: 1, processId: 'b1', status: 'running' }],
    ['bg:end', { type: 'bg:end', ts: 1, processId: 'b1', cause: 'exited', exitCode: 0 }],
    ['interrupt', { type: 'interrupt', ts: 1, level: 'soft' }],
    ['checkpoint:create', { type: 'checkpoint:create', ts: 1, checkpointId: 'c1', stepN: 3 }],
  ] as const)('%s does not throw and emits no permanent', (_name, event) => {
    const r = applyEvent(createInitialState(), event as UIEvent);
    expect(r.permanent).toEqual([]);
  });
});

describe('parallel:status reducer (D234)', () => {
  test('initial state has parallelStatus null', () => {
    expect(createInitialState().parallelStatus).toBeNull();
  });

  test('parallel:status writes the snapshot into state.parallelStatus', () => {
    const r = applyEvent(createInitialState(), {
      type: 'parallel:status',
      ts: 1,
      subagentsRunning: 2,
      subagentsQueued: 3,
      subagentsCap: 4,
      toolsRunning: 1,
      toolsCap: 3,
    });
    expect(r.permanent).toEqual([]);
    expect(r.state.parallelStatus).toEqual({
      subagentsRunning: 2,
      subagentsQueued: 3,
      subagentsCap: 4,
      toolsRunning: 1,
      toolsCap: 3,
    });
  });

  test('subsequent parallel:status events overwrite the snapshot', () => {
    const after1 = applyEvent(createInitialState(), {
      type: 'parallel:status',
      ts: 1,
      subagentsRunning: 1,
      subagentsQueued: 5,
      subagentsCap: 3,
      toolsRunning: 0,
      toolsCap: 0,
    });
    const after2 = applyEvent(after1.state, {
      type: 'parallel:status',
      ts: 2,
      subagentsRunning: 2,
      subagentsQueued: 4,
      subagentsCap: 3,
      toolsRunning: 0,
      toolsCap: 0,
    });
    expect(after2.state.parallelStatus?.subagentsRunning).toBe(2);
    expect(after2.state.parallelStatus?.subagentsQueued).toBe(4);
  });

  test('session:start clears parallelStatus to null (boundary reset)', () => {
    const seeded = applyEvent(createInitialState(), {
      type: 'parallel:status',
      ts: 1,
      subagentsRunning: 2,
      subagentsQueued: 0,
      subagentsCap: 3,
      toolsRunning: 0,
      toolsCap: 0,
    });
    expect(seeded.state.parallelStatus).not.toBeNull();
    const after = applyEvent(seeded.state, {
      type: 'session:start',
      ts: 2,
      sessionId: 's1',
      profile: 'autonomous',
      project: 'p',
      model: 'm',
    });
    expect(after.state.parallelStatus).toBeNull();
  });
});

describe('history-clear modal (HISTORY.md §2.3)', () => {
  test('history-clear:ask opens a modal with three options + last selected', () => {
    const r = applyEvent(createInitialState(), {
      type: 'history-clear:ask',
      ts: 1,
      promptId: 'hc-1',
      entryCount: 42,
      projectRoot: '/project/root',
    });
    expect(r.state.modal).not.toBeNull();
    if (r.state.modal === null) return;
    expect(r.state.modal.flavor).toBe('history-clear');
    // projectRoot lives in preview (matching trust-modal layout) so a
    // long path clips cleanly via truncateToWidth; subject is null.
    expect(r.state.modal.subject).toBeNull();
    expect(r.state.modal.preview[0]).toBe('/project/root');
    expect(r.state.modal.options.map((o) => o.value)).toEqual(['yes', 'yes-disable', 'no']);
    // Conservative-default: last option (No) selected.
    expect(r.state.modal.selectedIndex).toBe(2);
    // Blast radius surfaces in the preview.
    expect(r.state.modal.preview.join(' ')).toContain('42 entries');
  });

  test('singular entry count uses singular phrasing', () => {
    const r = applyEvent(createInitialState(), {
      type: 'history-clear:ask',
      ts: 1,
      promptId: 'hc-2',
      entryCount: 1,
      projectRoot: '/p',
    });
    if (r.state.modal === null) return;
    expect(r.state.modal.preview.join(' ')).toContain('1 entry');
  });
});

describe('reverse-search overlay (HISTORY.md §2.2)', () => {
  test('reverse-search:update opens the overlay with the payload shape', () => {
    const initial = createInitialState();
    expect(initial.reverseSearch).toBeNull();
    const r = applyEvent(initial, {
      type: 'reverse-search:update',
      ts: 1,
      query: 'que',
      results: ['como rodar bun em watch?'],
      selectedIdx: 0,
    });
    expect(r.state.reverseSearch).toEqual({
      query: 'que',
      results: ['como rodar bun em watch?'],
      selectedIdx: 0,
    });
    expect(r.permanent).toEqual([]);
  });

  test('reverse-search:update with no matches keeps overlay open + selectedIdx -1', () => {
    const r = applyEvent(createInitialState(), {
      type: 'reverse-search:update',
      ts: 1,
      query: 'xyz',
      results: [],
      selectedIdx: -1,
    });
    expect(r.state.reverseSearch).toEqual({ query: 'xyz', results: [], selectedIdx: -1 });
  });

  test('reverse-search:close clears state.reverseSearch', () => {
    const opened = applyEvent(createInitialState(), {
      type: 'reverse-search:update',
      ts: 1,
      query: 'a',
      results: ['x'],
      selectedIdx: 0,
    }).state;
    const r = applyEvent(opened, { type: 'reverse-search:close', ts: 2 });
    expect(r.state.reverseSearch).toBeNull();
    expect(r.permanent).toEqual([]);
  });

  test('reverse-search:close on already-closed state is idempotent', () => {
    const r = applyEvent(createInitialState(), { type: 'reverse-search:close', ts: 1 });
    expect(r.state.reverseSearch).toBeNull();
    expect(r.permanent).toEqual([]);
  });
});

describe('state immutability', () => {
  test('applyEvent does not mutate the input state', () => {
    const initial = createInitialState();
    const snapshot = JSON.stringify({
      input: initial.input,
      status: initial.status,
      tools: Array.from(initial.activeTools.entries()),
      pendingAssistant: initial.pendingAssistant,
      thinking: initial.thinking,
      ended: initial.ended,
    });
    applyEvent(initial, start());
    applyEvent(initial, {
      type: 'tool:start',
      ts: 1,
      toolId: 't1',
      name: 'bash',
      activeVerb: 'Executing',
      finalVerb: 'Executed',
      subject: 'ls',
    });
    const after = JSON.stringify({
      input: initial.input,
      status: initial.status,
      tools: Array.from(initial.activeTools.entries()),
      pendingAssistant: initial.pendingAssistant,
      thinking: initial.thinking,
      ended: initial.ended,
    });
    expect(after).toBe(snapshot);
  });
});
