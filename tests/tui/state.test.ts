import { describe, expect, test } from 'bun:test';
import type { UIEvent } from '../../src/tui/events.ts';
import {
  type LiveState,
  type PermanentItem,
  applyEvent,
  createInitialState,
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
  return { state, permanent };
};

describe('session lifecycle', () => {
  test('session:start populates status fields and emits a header item', () => {
    const r = applyEvent(createInitialState(), start());
    expect(r.state.status.sessionId).toBe('s1');
    expect(r.state.status.profile).toBe('autonomous');
    expect(r.state.status.project).toBe('forja');
    expect(r.state.status.model).toBe('claude-opus-4-7');
    expect(r.state.status.planMode).toBe(false);
    expect(r.state.ended).toBe(false);
    expect(r.permanent).toEqual([
      {
        kind: 'session-header',
        sessionId: 's1',
        profile: 'autonomous',
        project: 'forja',
        model: 'claude-opus-4-7',
      },
    ]);
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
      env: [{ key: 'subagents', value: '0' }],
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
        env: [{ key: 'subagents', value: '0' }],
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

  test('end with empty buffer + usage emits chip-only permanent (tool-only turn)', () => {
    // Provider call that returned tool_use blocks but no text still
    // consumed real output tokens — operator sees the cost signal as
    // a chip line. text stays '' so formatPermanent emits header
    // alone.
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
    expect(result.permanent).toEqual([
      { kind: 'assistant', text: '', durationMs: 3200, outputTokens: 47 },
    ]);
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
    ['subagent:start', { type: 'subagent:start', ts: 1, subagentId: 'a1', name: 'r', goal: 'g' }],
    ['subagent:update', { type: 'subagent:update', ts: 1, subagentId: 'a1', progress: '...' }],
    [
      'subagent:end',
      { type: 'subagent:end', ts: 1, subagentId: 'a1', status: 'done', summary: '', durationMs: 0 },
    ],
    ['bg:start', { type: 'bg:start', ts: 1, processId: 'b1', command: 'sleep' }],
    ['bg:update', { type: 'bg:update', ts: 1, processId: 'b1', status: 'running' }],
    ['bg:end', { type: 'bg:end', ts: 1, processId: 'b1', exitCode: 0 }],
    ['interrupt', { type: 'interrupt', ts: 1, level: 'soft' }],
    ['checkpoint:create', { type: 'checkpoint:create', ts: 1, checkpointId: 'c1', stepN: 3 }],
  ] as const)('%s does not throw and emits no permanent', (_name, event) => {
    const r = applyEvent(createInitialState(), event as UIEvent);
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
