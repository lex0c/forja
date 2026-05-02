import { describe, expect, test } from 'bun:test';
import type { UIEvent } from '../../src/tui/events.ts';
import { type LiveState, applyEvent, createInitialState } from '../../src/tui/state.ts';

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

const drive = (events: UIEvent[]): { state: LiveState; permanent: string[] } => {
  let state = createInitialState();
  const permanent: string[] = [];
  for (const ev of events) {
    const r = applyEvent(state, ev);
    state = r.state;
    permanent.push(...r.permanent);
  }
  return { state, permanent };
};

describe('session lifecycle', () => {
  test('session:start populates status fields and prints a header', () => {
    const r = applyEvent(createInitialState(), start());
    expect(r.state.status.sessionId).toBe('s1');
    expect(r.state.status.profile).toBe('autonomous');
    expect(r.state.status.project).toBe('forja');
    expect(r.state.status.model).toBe('claude-opus-4-7');
    expect(r.state.ended).toBe(false);
    expect(r.permanent).toHaveLength(1);
    expect(r.permanent[0]).toContain('s1');
    expect(r.permanent[0]).toContain('autonomous');
  });

  test('session:end marks state ended and emits summary', () => {
    const r = applyEvent(createInitialState(), {
      type: 'session:end',
      ts: 2,
      sessionId: 's1',
      reason: 'done',
    });
    expect(r.state.ended).toBe(true);
    expect(r.permanent[0]).toContain('done');
  });
});

describe('user input', () => {
  test('user:submit echoes prompt to scrollback and clears input', () => {
    let state = createInitialState();
    state = { ...state, input: { value: 'pending', cursor: 7 } };
    const r = applyEvent(state, { type: 'user:submit', ts: 1, text: 'hello' });
    expect(r.state.input.value).toBe('');
    expect(r.state.input.cursor).toBe(0);
    expect(r.permanent).toEqual(['> hello']);
  });

  test('multi-line submit indents continuation lines', () => {
    const r = applyEvent(createInitialState(), {
      type: 'user:submit',
      ts: 1,
      text: 'first\nsecond\nthird',
    });
    expect(r.permanent).toEqual(['> first', '  second', '  third']);
  });
});

describe('assistant streaming', () => {
  test('start opens a buffer; deltas accumulate; end flushes to scrollback', () => {
    const result = drive([
      { type: 'assistant:start', ts: 1, messageId: 'm1' },
      { type: 'assistant:delta', ts: 2, messageId: 'm1', text: 'Hello, ' },
      { type: 'assistant:delta', ts: 3, messageId: 'm1', text: 'world!' },
      { type: 'assistant:end', ts: 4, messageId: 'm1' },
    ]);
    expect(result.state.pendingAssistant).toBeNull();
    expect(result.permanent).toEqual(['Hello, world!']);
  });

  test('multi-line assistant flushes one permanent line per source line', () => {
    const result = drive([
      { type: 'assistant:start', ts: 1, messageId: 'm1' },
      { type: 'assistant:delta', ts: 2, messageId: 'm1', text: 'line1\nline2\nline3' },
      { type: 'assistant:end', ts: 3, messageId: 'm1' },
    ]);
    expect(result.permanent).toEqual(['line1', 'line2', 'line3']);
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

  test('end with empty buffer emits nothing', () => {
    const result = drive([
      { type: 'assistant:start', ts: 1, messageId: 'm1' },
      { type: 'assistant:end', ts: 2, messageId: 'm1' },
    ]);
    expect(result.permanent).toEqual([]);
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
  test('start adds an active tool, end emits a permanent summary and removes it', () => {
    const result = drive([
      { type: 'tool:start', ts: 1, toolId: 't1', name: 'bash', args: 'ls -la' },
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
    expect(result.permanent).toHaveLength(2);
    expect(result.permanent[0]).toContain('bash');
    expect(result.permanent[0]).toContain('1.2s');
    expect(result.permanent[1]).toBe('  47 entries');
  });

  test('delta lines feed the preview window, capped at 5 lines', () => {
    let state = createInitialState();
    state = applyEvent(state, {
      type: 'tool:start',
      ts: 1,
      toolId: 't1',
      name: 'bash',
      args: 'long-running',
    }).state;
    const seven = Array.from({ length: 7 }, (_, i) => `line${i}`).join('\n');
    state = applyEvent(state, { type: 'tool:delta', ts: 2, toolId: 't1', text: seven }).state;
    const tool = state.activeTools.get('t1');
    expect(tool?.preview).toEqual(['line2', 'line3', 'line4', 'line5', 'line6']);
  });

  test('delta with trailing newline is not counted as an empty preview row', () => {
    let state = createInitialState();
    state = applyEvent(state, {
      type: 'tool:start',
      ts: 1,
      toolId: 't1',
      name: 'bash',
      args: 'echo',
    }).state;
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

  test('error status uses x glyph and ms units for sub-1s durations', () => {
    const result = drive([
      { type: 'tool:start', ts: 1, toolId: 't1', name: 'read', args: 'foo' },
      { type: 'tool:end', ts: 200, toolId: 't1', status: 'error', durationMs: 850 },
    ]);
    expect(result.permanent[0]).toContain('x read');
    expect(result.permanent[0]).toContain('850ms');
  });

  test('denied uses a different glyph from error', () => {
    // Spec UI.md §4.1/§4.6: users must be able to tell "policy blocked
    // me" from "tool crashed" at a glance. Same glyph would conflate
    // them.
    const errored = drive([
      { type: 'tool:start', ts: 1, toolId: 't1', name: 'bash', args: 'rm' },
      { type: 'tool:end', ts: 100, toolId: 't1', status: 'error', durationMs: 50 },
    ]);
    const denied = drive([
      { type: 'tool:start', ts: 1, toolId: 't2', name: 'bash', args: 'rm' },
      { type: 'tool:end', ts: 100, toolId: 't2', status: 'denied', durationMs: 50 },
    ]);
    const errorGlyph = errored.permanent[0]?.charAt(0);
    const deniedGlyph = denied.permanent[0]?.charAt(0);
    expect(errorGlyph).toBeDefined();
    expect(deniedGlyph).toBeDefined();
    expect(errorGlyph).not.toBe(deniedGlyph);
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

  test('error event prints a permanent line', () => {
    const r = applyEvent(createInitialState(), {
      type: 'error',
      ts: 1,
      message: 'provider down',
    });
    expect(r.permanent).toEqual(['error: provider down']);
  });

  test('warn event prints a permanent line', () => {
    const r = applyEvent(createInitialState(), {
      type: 'warn',
      ts: 1,
      message: 'budget at 80%',
    });
    expect(r.permanent).toEqual(['warn: budget at 80%']);
  });
});

describe('not-yet-wired events accept silently', () => {
  test.each([
    [
      'permission:ask',
      { type: 'permission:ask', ts: 1, promptId: 'p1', toolName: 'bash', command: 'rm', cwd: '/' },
    ],
    ['permission:answer', { type: 'permission:answer', ts: 1, promptId: 'p1', decision: 'reject' }],
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
    ['todo:update', { type: 'todo:update', ts: 1, items: [] }],
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
    applyEvent(initial, { type: 'tool:start', ts: 1, toolId: 't1', name: 'bash', args: 'ls' });
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
