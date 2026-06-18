import { describe, expect, test } from 'bun:test';
import type { TodoItemForUI, UIEvent } from '../../src/tui/events.ts';
import {
  type LiveState,
  type PermanentItem,
  applyEvent,
  capReasoning,
  createInitialState,
  flushPendingToolEndBatch,
  liveRegionActive,
} from '../../src/tui/state.ts';

const start = (overrides: Partial<UIEvent> = {}): UIEvent =>
  ({
    type: 'session:start',
    ts: 1,
    sessionId: 's1',
    project: 'forja',
    model: 'claude-opus-4-7',
    ...overrides,
  }) as UIEvent;

const uiTodo = (status: TodoItemForUI['status']): TodoItemForUI => ({
  content: 'x',
  activeForm: 'X',
  status,
});

describe('liveRegionActive', () => {
  test('idle when nothing in the live region is running', () => {
    expect(liveRegionActive(createInitialState())).toBe(false);
  });

  test('an in_progress task keeps it active (drives the Tasks header shimmer)', () => {
    const base = createInitialState();
    expect(liveRegionActive({ ...base, todos: [uiTodo('in_progress')] })).toBe(true);
    // done / pending alone must NOT keep redrawing — only in_progress
    // animates, so a finished list lets the scheduler idle (zero wakeups).
    expect(liveRegionActive({ ...base, todos: [uiTodo('done'), uiTodo('pending')] })).toBe(false);
  });

  test('a stopped turn (ended) idles even with a task frozen in_progress', () => {
    const base = createInitialState();
    // todos persist across the turn boundary (session:end never clears them),
    // so a turn that stops mid-task — notably an abnormal cut like maxCostUsd —
    // leaves a task at in_progress. Once ended, that must NOT keep the
    // scheduler awake, or the Tasks header shimmers forever against a dead
    // turn. Matches renderTodoList's `!live` flat-header path.
    expect(liveRegionActive({ ...base, ended: true, todos: [uiTodo('in_progress')] })).toBe(false);
    // Sanity: the same state while the turn is live (ended:false) stays active.
    expect(liveRegionActive({ ...base, ended: false, todos: [uiTodo('in_progress')] })).toBe(true);
  });

  test('also active for thinking / awaiting-provider (extracted logic intact)', () => {
    const base = createInitialState();
    expect(
      liveRegionActive({ ...base, thinking: { startedAt: 0, messageId: 'm', text: '' } }),
    ).toBe(true);
    expect(liveRegionActive({ ...base, awaitingProvider: { stepN: 1, startedAt: 0 } })).toBe(true);
    // Compaction chip animates its spinner + ticking [elapsed] — must keep
    // the scheduler awake or the chip freezes after a single frame.
    expect(liveRegionActive({ ...base, compacting: { startedAt: 0 } })).toBe(true);
  });
});

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
    expect(r.state.status.project).toBe('forja');
    expect(r.state.status.model).toBe('claude-opus-4-7');
    expect(r.state.ended).toBe(false);
    expect(r.permanent).toEqual([]);
  });

  test('createInitialState defaults operationMode to supervised', () => {
    expect(createInitialState().status.operationMode).toBe('supervised');
  });

  test('session:start preserves the current posture (never resets it)', () => {
    // A new harness session per REPL submit must not silently reset the
    // operator's posture back to supervised.
    let state = applyEvent(createInitialState(), {
      type: 'mode:change',
      ts: 1,
      posture: 'autonomous',
    }).state;
    state = applyEvent(state, start()).state;
    expect(state.status.operationMode).toBe('autonomous');
  });

  test('mode:change updates status.operationMode and emits no permanent', () => {
    const r = applyEvent(createInitialState(), {
      type: 'mode:change',
      ts: 5,
      posture: 'autonomous',
    });
    expect(r.state.status.operationMode).toBe('autonomous');
    expect(r.permanent).toEqual([]);
    const back = applyEvent(r.state, { type: 'mode:change', ts: 6, posture: 'supervised' });
    expect(back.state.status.operationMode).toBe('supervised');
  });

  test('session:banner seeds status.operationMode from the boot posture', () => {
    // The footer cue must be correct from the first frame (e.g. under
    // `--autonomous`), before any user submit / session:start.
    const r = applyEvent(createInitialState(), {
      type: 'session:banner',
      ts: 1,
      app: 'forja',
      version: '0',
      model: 'm',
      contextWindow: 1000,
      maxOutputTokens: 100,
      cwd: '/x',
      env: [],
      operationMode: 'autonomous',
    });
    expect(r.state.status.operationMode).toBe('autonomous');
  });

  test('createInitialState defaults effort to null (no chip until known)', () => {
    expect(createInitialState().status.effort).toBeNull();
  });

  test('effort:change updates status.effort and emits no permanent', () => {
    const r = applyEvent(createInitialState(), { type: 'effort:change', ts: 5, effort: 'low' });
    expect(r.state.status.effort).toBe('low');
    expect(r.permanent).toEqual([]);
    const up = applyEvent(r.state, { type: 'effort:change', ts: 6, effort: 'max' });
    expect(up.state.status.effort).toBe('max');
  });

  test('session:banner seeds status.effort from the boot level', () => {
    const r = applyEvent(createInitialState(), {
      type: 'session:banner',
      ts: 1,
      app: 'forja',
      version: '0',
      model: 'm',
      contextWindow: 1000,
      maxOutputTokens: 100,
      cwd: '/x',
      env: [],
      effort: 'high',
    });
    expect(r.state.status.effort).toBe('high');
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

  test('session:end does NOT fold cost into the footer total (now DB-derived)', () => {
    // The footer's cumulative cost/token/cache totals are pushed via
    // stats:refresh (DB-derived), not folded at the turn boundary. A
    // step:budget + session:end must leave sessionTotalCostUsd untouched.
    let s = createInitialState();
    s = applyEvent(s, { type: 'step:budget', ts: 1, steps: 1, maxSteps: 200, costUsd: 0.4 }).state;
    const r = applyEvent(s, { type: 'session:end', ts: 2, sessionId: 's1', reason: 'done' });
    expect(r.state.status.sessionTotalCostUsd).toBe(0);
  });

  test('stats:refresh SETS the footer cost/token/cache totals (absolute, not summed)', () => {
    let s = createInitialState();
    s = applyEvent(s, {
      type: 'stats:refresh',
      ts: 1,
      costUsd: 0.4,
      totalTokens: 1800,
      cacheTokens: 500,
    }).state;
    expect(s.status.sessionTotalCostUsd).toBe(0.4);
    expect(s.status.sessionTotalTokens).toBe(1800);
    expect(s.status.sessionCacheTokens).toBe(500);
    // A second refresh OVERWRITES (SET semantics) — it does not add.
    s = applyEvent(s, {
      type: 'stats:refresh',
      ts: 2,
      costUsd: 0.65,
      totalTokens: 2500,
      cacheTokens: 700,
    }).state;
    expect(s.status.sessionTotalCostUsd).toBeCloseTo(0.65, 10);
    expect(s.status.sessionTotalTokens).toBe(2500);
    expect(s.status.sessionCacheTokens).toBe(700);
  });

  test('stats:refresh emits no scrollback', () => {
    const r = applyEvent(createInitialState(), {
      type: 'stats:refresh',
      ts: 1,
      costUsd: 0.1,
      totalTokens: 10,
      cacheTokens: 0,
    });
    expect(r.permanent).toEqual([]);
  });

  test('session:banner stamps model + contextWindow onto status and emits the banner permanent', () => {
    const initial = createInitialState();
    const r = applyEvent(initial, {
      type: 'session:banner',
      ts: 5,
      app: 'forja',
      version: '0.0.0',
      model: 'anthropic/claude-sonnet-4-6',
      effort: 'high',
      contextWindow: 200000,
      maxOutputTokens: 4096,
      cwd: '/home/lex/forja',
      env: [
        { kind: 'meta', key: 'subagents', value: '0' },
        { kind: 'flag', name: 'checkpoints' },
      ],
    });
    // Banner is the earliest signal carrying provider capabilities;
    // mirror model + contextWindow + effort onto status here (the banner
    // renders model + effort from the permanent; status mirrors them so
    // other surfaces have them during the idle boot window before the
    // first `session:start`).
    expect(r.state.status.model).toBe('anthropic/claude-sonnet-4-6');
    expect(r.state.status.contextWindow).toBe(200000);
    expect(r.state.status.effort).toBe('high');
    expect(r.permanent).toEqual([
      {
        kind: 'session-banner',
        app: 'forja',
        version: '0.0.0',
        model: 'anthropic/claude-sonnet-4-6',
        effort: 'high',
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

describe('inbox (INBOX §6 — queued input, slice 1)', () => {
  test('inbox:queued appends to the queue AND clears the input buffer', () => {
    let state = createInitialState();
    state = { ...state, input: { value: 'draft', cursor: 5 } };
    const r = applyEvent(state, { type: 'inbox:queued', ts: 1, id: '0', text: 'queued one' });
    expect(r.state.queued).toEqual([{ id: '0', text: 'queued one' }]);
    expect(r.state.input).toEqual({ value: '', cursor: 0 });
    // No scrollback — the bar lives in the live region until drain.
    expect(r.permanent).toEqual([]);
  });

  test('multiple inbox:queued accumulate in FIFO order', () => {
    let state = createInitialState();
    state = applyEvent(state, { type: 'inbox:queued', ts: 1, id: '0', text: 'a' }).state;
    state = applyEvent(state, { type: 'inbox:queued', ts: 2, id: '1', text: 'b' }).state;
    expect(state.queued).toEqual([
      { id: '0', text: 'a' },
      { id: '1', text: 'b' },
    ]);
  });

  test('inbox:drained empties the queue and freezes each item into a user-submit bar', () => {
    let state = createInitialState();
    state = applyEvent(state, { type: 'inbox:queued', ts: 1, id: '0', text: 'a' }).state;
    state = applyEvent(state, { type: 'inbox:queued', ts: 2, id: '1', text: 'b' }).state;
    const r = applyEvent(state, { type: 'inbox:drained', ts: 3, texts: ['a', 'b'] });
    expect(r.state.queued).toEqual([]);
    expect(r.permanent).toEqual([
      { kind: 'user-submit', text: 'a' },
      { kind: 'user-submit', text: 'b' },
    ]);
  });

  test('inbox:drained preserves an in-progress input draft (must not nuke it)', () => {
    let state = createInitialState();
    state = applyEvent(state, { type: 'inbox:queued', ts: 1, id: '0', text: 'a' }).state;
    // operator started typing a fresh message after queueing
    state = { ...state, input: { value: 'half-typed', cursor: 4 } };
    const r = applyEvent(state, { type: 'inbox:drained', ts: 2, texts: ['a'] });
    expect(r.state.input).toEqual({ value: 'half-typed', cursor: 4 });
  });

  test('inbox:edit-start marks the item as editing (it STAYS in the queue)', () => {
    let state = createInitialState();
    state = applyEvent(state, { type: 'inbox:queued', ts: 1, id: '0', text: 'a' }).state;
    state = applyEvent(state, { type: 'inbox:queued', ts: 2, id: '1', text: 'b' }).state;
    const r = applyEvent(state, { type: 'inbox:edit-start', ts: 3, id: '1' });
    expect(r.state.editingId).toBe('1');
    // queue unchanged — the message is never removed, so it can't be lost
    expect(r.state.queued).toEqual([
      { id: '0', text: 'a' },
      { id: '1', text: 'b' },
    ]);
    expect(r.permanent).toEqual([]);
  });

  test('inbox:edit-commit rewrites the item text in place and clears editingId', () => {
    let state = createInitialState();
    state = applyEvent(state, { type: 'inbox:queued', ts: 1, id: '0', text: 'a' }).state;
    state = applyEvent(state, { type: 'inbox:queued', ts: 2, id: '1', text: 'b' }).state;
    state = applyEvent(state, { type: 'inbox:edit-start', ts: 3, id: '1' }).state;
    const r = applyEvent(state, { type: 'inbox:edit-commit', ts: 4, id: '1', text: 'b edited' });
    expect(r.state.queued).toEqual([
      { id: '0', text: 'a' },
      { id: '1', text: 'b edited' },
    ]);
    expect(r.state.editingId).toBeNull();
  });

  test('inbox:edit-cancel clears editingId, leaving the queue unchanged', () => {
    let state = createInitialState();
    state = applyEvent(state, { type: 'inbox:queued', ts: 1, id: '0', text: 'a' }).state;
    state = applyEvent(state, { type: 'inbox:edit-start', ts: 2, id: '0' }).state;
    const r = applyEvent(state, { type: 'inbox:edit-cancel', ts: 3 });
    expect(r.state.editingId).toBeNull();
    expect(r.state.queued).toEqual([{ id: '0', text: 'a' }]);
  });

  test('inbox:remove drops the message from the queue and clears editingId (terminal)', () => {
    let state = createInitialState();
    state = applyEvent(state, { type: 'inbox:queued', ts: 1, id: '0', text: 'a' }).state;
    state = applyEvent(state, { type: 'inbox:queued', ts: 2, id: '1', text: 'b' }).state;
    state = applyEvent(state, { type: 'inbox:queued', ts: 3, id: '2', text: 'c' }).state;
    state = applyEvent(state, { type: 'inbox:edit-start', ts: 4, id: '1' }).state;
    const r = applyEvent(state, { type: 'inbox:remove', ts: 5, id: '1' });
    // Unlike edit-cancel (which restores), the message is gone for good;
    // the surviving siblings keep their FIFO order (removing the MIDDLE one
    // leaves [a, c], not a reorder).
    expect(r.state.queued).toEqual([
      { id: '0', text: 'a' },
      { id: '2', text: 'c' },
    ]);
    expect(r.state.editingId).toBeNull();
    expect(r.permanent).toEqual([]);
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

  test('assistant:end sets last-turn context but does NOT fold the footer token totals', () => {
    const result = drive([
      { type: 'assistant:start', ts: 1000, messageId: 'm1' },
      { type: 'assistant:delta', ts: 1100, messageId: 'm1', text: 'reply' },
      {
        type: 'assistant:usage',
        ts: 9100,
        messageId: 'm1',
        inputTokens: 100,
        outputTokens: 200,
        cacheRead: 1000,
        cacheCreation: 500,
      },
      { type: 'assistant:end', ts: 9200, messageId: 'm1' },
    ]);
    // lastTurnContextTokens = input + cacheRead + cacheCreation = 1600
    // (per-turn snapshot for context occupancy — still derived here).
    expect(result.state.status.lastTurnContextTokens).toBe(1600);
    // The footer's cumulative token/cache totals are DB-derived
    // (stats:refresh), NOT folded at assistant:end — they stay untouched.
    expect(result.state.status.sessionTotalTokens).toBe(0);
    expect(result.state.status.sessionCacheTokens).toBe(0);
  });

  test('assistant:end lastTurnContext REPLACES across turns (snapshot, not a running total)', () => {
    const result = drive([
      { type: 'assistant:start', ts: 1000, messageId: 'm1' },
      {
        type: 'assistant:usage',
        ts: 1100,
        messageId: 'm1',
        inputTokens: 50,
        outputTokens: 100,
        cacheRead: 0,
        cacheCreation: 0,
      },
      { type: 'assistant:end', ts: 1200, messageId: 'm1' },
      { type: 'assistant:start', ts: 2000, messageId: 'm2' },
      {
        type: 'assistant:usage',
        ts: 2100,
        messageId: 'm2',
        inputTokens: 200,
        outputTokens: 300,
        cacheRead: 0,
        cacheCreation: 0,
      },
      { type: 'assistant:end', ts: 2200, messageId: 'm2' },
    ]);
    // Last-turn snapshot REPLACES (does not accumulate): only the
    // most recent turn's input-side tokens, so it reflects current
    // context occupancy, not lifetime usage.
    expect(result.state.status.lastTurnContextTokens).toBe(200);
    // Footer total is not accumulated here.
    expect(result.state.status.sessionTotalTokens).toBe(0);
  });

  test('assistant:end with no usage preserves prior lastTurnContextTokens (no zero flicker)', () => {
    // Provider edge case: a turn ends without an `assistant:usage`
    // event ever landing. The chip would otherwise drop back to
    // 0% — bad UX since the actual context occupancy didn't
    // suddenly empty.
    let state = createInitialState();
    state = { ...state, status: { ...state.status, lastTurnContextTokens: 5000 } };
    state = applyEvent(state, { type: 'assistant:start', ts: 1000, messageId: 'm1' }).state;
    state = applyEvent(state, { type: 'assistant:end', ts: 1200, messageId: 'm1' }).state;
    expect(state.status.lastTurnContextTokens).toBe(5000);
  });

  test('session:start preserves the DB-derived footer totals (must not reset)', () => {
    // The operator thinks of the whole REPL as one session, even
    // though each user submit spawns its own harness `session:*`
    // bracket. The footer totals (set by stats:refresh) must survive a
    // bare session:start so they don't blink to 0 between turns.
    let state = createInitialState();
    state = {
      ...state,
      status: {
        ...state.status,
        sessionTotalTokens: 5000,
        sessionCacheTokens: 1500,
        sessionTotalCostUsd: 0.42,
        lastTurnContextTokens: 1200,
        contextWindow: 200000,
      },
    };
    const result = applyEvent(state, {
      type: 'session:start',
      ts: 100,
      sessionId: 's2',
      project: 'forja',
      model: 'sonnet-4.6',
    });
    expect(result.state.status.sessionTotalTokens).toBe(5000);
    expect(result.state.status.sessionCacheTokens).toBe(1500);
    expect(result.state.status.sessionTotalCostUsd).toBe(0.42);
    expect(result.state.status.lastTurnContextTokens).toBe(1200);
    expect(result.state.status.contextWindow).toBe(200000);
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
  test('start sets startedAt; a textless delta keeps the buffer empty; end clears it', () => {
    const result = drive([
      { type: 'thinking:start', ts: 100, messageId: 'm1' },
      // No `text` (allowed by the event contract) — must NOT concatenate the
      // literal string "undefined" into the reasoning buffer.
      { type: 'thinking:delta', ts: 200, messageId: 'm1' },
    ]);
    expect(result.state.thinking?.startedAt).toBe(100);
    expect(result.state.thinking?.text).toBe('');
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

  test('tool:execution-started rebases the active tool clock', () => {
    // startedAt is set at tool:start (pre-permission); when the body
    // actually begins it is rebased so the live card's [Xs] excludes
    // the permission-modal wait.
    const result = drive([
      startBash('t1'),
      { type: 'tool:execution-started', ts: 9000, toolId: 't1' },
    ]);
    expect(result.state.activeTools.get('t1')?.startedAt).toBe(9000);
  });

  test('tool:execution-started for an unknown tool is a no-op', () => {
    const result = drive([{ type: 'tool:execution-started', ts: 9000, toolId: 'ghost' }]);
    expect(result.state.activeTools.size).toBe(0);
  });

  test('tool:end with a non-zero exitCode emits immediately and carries exitCode', () => {
    // A bash that exited non-zero is status:done but must not coalesce
    // into a batch — it surfaces as its own card with `exitCode` set.
    const result = drive([
      startBash('t1'),
      { type: 'tool:end', ts: 1500, toolId: 't1', status: 'done', durationMs: 30, exitCode: 1 },
    ]);
    expect(result.permanent).toEqual([
      {
        kind: 'tool-end',
        name: 'bash',
        verb: 'Executed',
        subject: 'ls -la',
        status: 'done',
        durationMs: 30,
        exitCode: 1,
      },
    ]);
  });

  test('tool:end with a non-zero exitCode carries outputTruncated too', () => {
    // A failing command whose output was capped — both `exit N` and the
    // `… output truncated` hint belong on the immediately-emitted card.
    const result = drive([
      startBash('t1'),
      {
        type: 'tool:end',
        ts: 1500,
        toolId: 't1',
        status: 'done',
        durationMs: 30,
        exitCode: 2,
        outputTruncated: true,
      },
    ]);
    expect(result.permanent).toEqual([
      {
        kind: 'tool-end',
        name: 'bash',
        verb: 'Executed',
        subject: 'ls -la',
        status: 'done',
        durationMs: 30,
        exitCode: 2,
        outputTruncated: true,
      },
    ]);
  });

  test('tool:end done with a summary bypasses the batch and carries the summary', () => {
    // clarify's `result_detail` arrives as `summary` on a done chip; it
    // must surface as its own card (a coalesced "Called N" head has
    // nowhere to show it), so a done+summary chip bypasses batching.
    const result = drive([
      {
        type: 'tool:start',
        ts: 1,
        toolId: 't1',
        name: 'clarify',
        activeVerb: 'Calling clarify',
        finalVerb: 'Called clarify',
        subject: null,
      },
      {
        type: 'tool:end',
        ts: 200,
        toolId: 't1',
        status: 'done',
        durationMs: 50,
        summary: 'which file? → src/checkout.ts',
      },
    ]);
    expect(result.permanent).toEqual([
      {
        kind: 'tool-end',
        name: 'clarify',
        verb: 'Called clarify',
        subject: null,
        status: 'done',
        durationMs: 50,
        summary: 'which file? → src/checkout.ts',
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
        name: 'todo_create',
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

describe('tool-end batch coalescing', () => {
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

  test('3 consecutive same-name tool:end items coalesce into a single tool-end-batch', () => {
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

  test('a single tool:end below the threshold emits as an individual tool-end', () => {
    // The buffer ALWAYS captures, but flush respects the threshold:
    // a lone item has nothing to coalesce with and unfolds back to
    // a normal per-tool `tool-end` chip.
    const result = drive([...readPair('t1', 'src/a.ts')]);
    expect(result.permanent.map((i) => i.kind)).toEqual(['tool-end']);
  });

  test('2 consecutive same-name tool:end items coalesce (threshold is 2)', () => {
    // Two same-tool runs are the smallest coalescing unit — one
    // card head + two subject rows beats two gap-separated chips.
    const result = drive([...readPair('t1', 'src/a.ts', 100), ...readPair('t2', 'src/b.ts', 200)]);
    expect(result.permanent).toHaveLength(1);
    const item = result.permanent[0];
    if (item?.kind !== 'tool-end-batch') throw new Error('expected tool-end-batch');
    expect(item.count).toBe(2);
    expect(item.totalDurationMs).toBe(300);
    expect(item.subjects).toEqual(['src/a.ts', 'src/b.ts']);
    expect(item.verb).toBe('Read 2 files');
  });

  test('tool:end outputTruncated carries onto an individual tool-end', () => {
    // A lone truncated tool (below the coalesce threshold) keeps the
    // flag on the unfolded `tool-end` item.
    const result = drive([
      {
        type: 'tool:start',
        ts: 1,
        toolId: 't1',
        name: 'bash',
        activeVerb: 'Executing',
        finalVerb: 'Executed',
        subject: 'cat big',
      },
      {
        type: 'tool:end',
        ts: 50,
        toolId: 't1',
        status: 'done',
        durationMs: 49,
        outputTruncated: true,
      },
    ]);
    const item = result.permanent[0];
    if (item?.kind !== 'tool-end') throw new Error('expected tool-end');
    expect(item.outputTruncated).toBe(true);
  });

  test('a batch aggregates outputTruncated when any child truncated', () => {
    const result = drive([
      {
        type: 'tool:start',
        ts: 1,
        toolId: 't1',
        name: 'read_file',
        activeVerb: 'Reading file',
        finalVerb: 'Read file',
        subject: 'a',
      },
      { type: 'tool:end', ts: 2, toolId: 't1', status: 'done', durationMs: 1 },
      {
        type: 'tool:start',
        ts: 3,
        toolId: 't2',
        name: 'read_file',
        activeVerb: 'Reading file',
        finalVerb: 'Read file',
        subject: 'b',
      },
      {
        type: 'tool:end',
        ts: 4,
        toolId: 't2',
        status: 'done',
        durationMs: 1,
        outputTruncated: true,
      },
    ]);
    const item = result.permanent[0];
    if (item?.kind !== 'tool-end-batch') throw new Error('expected tool-end-batch');
    expect(item.outputTruncated).toBe(true);
  });

  test('a batch with no truncated child leaves outputTruncated unset', () => {
    const result = drive([...readPair('t1', 'a'), ...readPair('t2', 'b')]);
    const item = result.permanent[0];
    if (item?.kind !== 'tool-end-batch') throw new Error('expected tool-end-batch');
    expect(item.outputTruncated).toBeUndefined();
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
    // todo_create-style tools (no vocab subject) produce null
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
    // Order: the 2 reads coalesce into one tool-end-batch, then the
    // warn item. Crucially the batch comes FIRST.
    expect(result.permanent.map((i) => i.kind)).toEqual(['tool-end-batch', 'warn']);
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

describe('applyEvent wrapper (flush lifecycle)', () => {
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
    // scrollback — drained before the footer marker. A single
    // buffered item is below the coalesce threshold, so it drains
    // as an individual `tool-end`.
    const dirty: LiveState = {
      ...createInitialState(),
      pendingToolEndBatch: {
        name: 'read_file',
        items: [{ verb: 'Read file', subject: 'a.ts', status: 'done', durationMs: 10 }],
      },
    };
    const r = applyEvent(dirty, {
      type: 'session:end',
      ts: 1,
      sessionId: 's1',
      reason: 'done',
    });
    expect(r.permanent.map((p) => p.kind)).toEqual(['tool-end', 'session-footer']);
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

describe('compacting indicator (compacting:start/end bracket)', () => {
  test('compacting:start sets compacting with ts', () => {
    const r = applyEvent(createInitialState(), { type: 'compacting:start', ts: 100 });
    expect(r.state.compacting).toEqual({ startedAt: 100 });
    expect(r.permanent).toEqual([]);
  });

  test('compacting:end clears the indicator', () => {
    let s = applyEvent(createInitialState(), { type: 'compacting:start', ts: 100 }).state;
    s = applyEvent(s, { type: 'compacting:end', ts: 150 }).state;
    expect(s.compacting).toBeNull();
  });

  test('compacting:end is a no-op when nothing is open (defensive double-close)', () => {
    const r = applyEvent(createInitialState(), { type: 'compacting:end', ts: 1 });
    expect(r.state.compacting).toBeNull();
    expect(r.permanent).toEqual([]);
  });

  test('compacting:start alone does not mark the context stale', () => {
    // Staleness is decided at :end (we don't yet know if the compaction will
    // change anything), so a start that ends 'skipped' never suppresses the %.
    const r = applyEvent(createInitialState(), { type: 'compacting:start', ts: 100 });
    expect(r.state.status.contextStale).toBe(false);
  });

  test('compacting:end with contextChanged marks the context stale (footer suppresses the %)', () => {
    let s = applyEvent(createInitialState(), { type: 'compacting:start', ts: 100 }).state;
    s = applyEvent(s, { type: 'compacting:end', ts: 150, contextChanged: true }).state;
    expect(s.compacting).toBeNull();
    expect(s.status.contextStale).toBe(true);
  });

  test('compacting:end without contextChanged (no-op skipped) keeps the % visible', () => {
    let s = applyEvent(createInitialState(), { type: 'compacting:start', ts: 100 }).state;
    s = applyEvent(s, { type: 'compacting:end', ts: 150, contextChanged: false }).state;
    // Nothing shrank → the displayed count is still accurate → no suppression.
    expect(s.status.contextStale).toBe(false);
  });

  test('assistant:end with usage clears contextStale (footer % returns on provider truth)', () => {
    const result = drive([
      { type: 'compacting:start', ts: 100 },
      { type: 'compacting:end', ts: 150, contextChanged: true },
      { type: 'assistant:start', ts: 1000, messageId: 'm1' },
      { type: 'assistant:delta', ts: 1100, messageId: 'm1', text: 'reply' },
      {
        type: 'assistant:usage',
        ts: 1150,
        messageId: 'm1',
        inputTokens: 100,
        outputTokens: 200,
        cacheRead: 1000,
        cacheCreation: 500,
      },
      { type: 'assistant:end', ts: 1200, messageId: 'm1' },
    ]);
    expect(result.state.status.contextStale).toBe(false);
    expect(result.state.status.lastTurnContextTokens).toBe(1600);
  });

  test('assistant:end without usage keeps contextStale (no fresh measurement)', () => {
    const result = drive([
      { type: 'compacting:start', ts: 100 },
      { type: 'compacting:end', ts: 150, contextChanged: true },
      { type: 'assistant:start', ts: 1000, messageId: 'm1' },
      { type: 'assistant:delta', ts: 1100, messageId: 'm1', text: 'reply' },
      { type: 'assistant:end', ts: 1200, messageId: 'm1' },
    ]);
    expect(result.state.status.contextStale).toBe(true);
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

  test('initial state has zero reminders', () => {
    expect(createInitialState().reminderCount).toBe(0);
  });

  test('reminders:update stores the absolute pending count', () => {
    const { state } = drive([
      { type: 'reminders:update', ts: 1, count: 2 },
      { type: 'reminders:update', ts: 2, count: 1 },
    ]);
    expect(state.reminderCount).toBe(1);
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

  test('session:start PRESERVES bgProcesses across the turn boundary (ORCHESTRATION §3B.1)', () => {
    // bash_background processes survive the turn now, so the renderer
    // map must NOT be zeroed at the boundary — else the `bash bg` chip
    // would vanish on the next turn while the process is still running.
    const { state } = drive([
      { type: 'bg:start', ts: 1, processId: 'p1', command: 'x' },
      start({ ts: 2, sessionId: 's2' }),
    ]);
    expect(state.bgProcesses.size).toBe(1);
    expect(state.bgProcesses.get('p1')?.command).toBe('x');
    // bg:end still removes it once it actually settles.
    const after = applyEvent(state, {
      type: 'bg:end',
      ts: 3,
      processId: 'p1',
      cause: 'exited',
      exitCode: 0,
    });
    expect(after.state.bgProcesses.size).toBe(0);
  });

  test('session:end PRESERVES bgProcesses (cleanup only at session exit now)', () => {
    const { state } = drive([
      { type: 'bg:start', ts: 1, processId: 'p1', command: 'x' },
      { type: 'session:end', ts: 2, sessionId: 's1', reason: 'done' },
    ]);
    expect(state.bgProcesses.size).toBe(1);
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

  test('subagent:start strips control bytes from model-authored name + goal', () => {
    // `goal` is the raw seed prompt and `name` is child-authored; both get
    // repainted into the LIVE region every heartbeat (head + `starting ·`
    // fallback). A malicious child embedding `\x1b[2J` (clear screen),
    // `\x07` (bell), or `\x1b]0;…` (OSC window title) in either field would
    // otherwise hijack the terminal on every redraw. Sanitized at ingress.
    const evilGoal = '\x1b[2J\x1b[H\x1b]0;PWNED\x07audit the diff';
    const evilName = '\x1b[31mreview\x1b[0m';
    const { state } = drive([
      { type: 'subagent:start', ts: 1, subagentId: 'c1', name: evilName, goal: evilGoal },
    ]);
    const entry = state.subagents.get('c1');
    expect(entry?.goal).not.toContain('\x1b');
    expect(entry?.goal).not.toContain('\x07');
    expect(entry?.name).not.toContain('\x1b');
    // The visible text survives the strip.
    expect(entry?.goal).toContain('audit the diff');
    expect(entry?.name).toContain('review');
  });

  test('subagent:update mutates the existing entry in place', () => {
    const { state, permanent } = drive([
      { type: 'subagent:start', ts: 1, subagentId: 'c1', name: 'r', goal: 'g' },
      { type: 'subagent:update', ts: 2, subagentId: 'c1', progress: 'running echo' },
    ]);
    expect(state.subagents.get('c1')?.progress).toBe('running echo');
    expect(permanent).toEqual([]);
  });

  test('currentTool persists across tool finishes; toolDone aggregates by type', () => {
    const { state } = drive([
      { type: 'subagent:start', ts: 1, subagentId: 'c1', name: 'r', goal: 'g' },
      { type: 'subagent:update', ts: 2, subagentId: 'c1', progress: 'x', currentTool: 'read a.ts' },
      // tool finishes: the label must NOT blank (no flap to `starting`),
      // and the per-type count increments.
      { type: 'subagent:update', ts: 3, subagentId: 'c1', progress: 'x', toolDone: 'read_file' },
      { type: 'subagent:update', ts: 4, subagentId: 'c1', progress: 'x', currentTool: 'grep "y"' },
      { type: 'subagent:update', ts: 5, subagentId: 'c1', progress: 'x', toolDone: 'grep' },
      { type: 'subagent:update', ts: 6, subagentId: 'c1', progress: 'x', toolDone: 'read_file' },
    ]);
    const row = state.subagents.get('c1');
    // last tool label survives the finish (not cleared to '')
    expect(row?.currentTool).toBe('grep "y"');
    expect(row?.toolTotal).toBe(3);
    expect(row?.toolCounts.get('read_file')).toBe(2);
    expect(row?.toolCounts.get('grep')).toBe(1);
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
    // First-in-a-run subagent block is preceded by the `Subagents` group
    // title (see the applyEvent wrapper), then the summary itself.
    expect(permanent.length).toBe(2);
    expect(permanent[0]?.kind).toBe('subagent_group_header');
    const item = permanent[1];
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

  test('consecutive subagent ends share ONE Subagents group title; an interruption re-titles', () => {
    const titles = (perm: { kind: string }[]) =>
      perm.filter((p) => p.kind === 'subagent_group_header').length;
    const end = (id: string, ts: number) =>
      ({
        type: 'subagent:end',
        ts,
        subagentId: id,
        status: 'done',
        costUsd: 0,
        summary: '',
        durationMs: 1,
      }) as const;
    // Two back-to-back completions → a single title.
    const a = drive([
      { type: 'subagent:start', ts: 1, subagentId: 'x', name: 'gp', goal: 'g' },
      { type: 'subagent:start', ts: 2, subagentId: 'y', name: 'gp', goal: 'g' },
      end('x', 3),
      end('y', 4),
    ]);
    expect(titles(a.permanent)).toBe(1);
    // A non-subagent scrollback emission between completions breaks the run.
    const b = drive([
      { type: 'subagent:start', ts: 1, subagentId: 'x', name: 'gp', goal: 'g' },
      end('x', 2),
      { type: 'info', ts: 3, message: 'something else' },
      { type: 'subagent:start', ts: 4, subagentId: 'y', name: 'gp', goal: 'g' },
      end('y', 5),
    ]);
    expect(titles(b.permanent)).toBe(2);
  });

  test('a BYPASSED tool-end between two subagent bursts re-titles the second group', () => {
    // A tool-end that emits its chip immediately (failed/denied status,
    // exit code, diff, summary) rather than buffering ends the title-run —
    // else the second subagent block would sit untitled under the first
    // group with the tool wedged between (the wrapper's early-return for
    // tool:end must still clear the flag for the bypass path).
    const titles = (perm: { kind: string }[]) =>
      perm.filter((p) => p.kind === 'subagent_group_header').length;
    const end = (id: string, ts: number) =>
      ({
        type: 'subagent:end',
        ts,
        subagentId: id,
        status: 'done',
        costUsd: 0,
        summary: '',
        durationMs: 1,
      }) as const;
    const { permanent } = drive([
      { type: 'subagent:start', ts: 1, subagentId: 'x', name: 'gp', goal: 'g' },
      end('x', 2),
      {
        type: 'tool:start',
        ts: 3,
        toolId: 't',
        name: 'read_file',
        activeVerb: 'R',
        finalVerb: 'Read',
        subject: 'a',
      },
      { type: 'tool:end', ts: 4, toolId: 't', status: 'error', durationMs: 5 }, // bypass (error)
      { type: 'subagent:start', ts: 5, subagentId: 'y', name: 'gp', goal: 'g' },
      end('y', 6),
    ]);
    expect(titles(permanent)).toBe(2);
  });

  test('the Subagents title-run does not leak across a turn boundary (session:start)', () => {
    const titles = (perm: { kind: string }[]) =>
      perm.filter((p) => p.kind === 'subagent_group_header').length;
    const end = (id: string, ts: number) =>
      ({
        type: 'subagent:end',
        ts,
        subagentId: id,
        status: 'done',
        costUsd: 0,
        summary: '',
        durationMs: 1,
      }) as const;
    // session:start emits no permanent, so the wrapper can't clear the flag
    // — the reducer must reset it at the boundary, else turn 2's first
    // subagent burst inherits turn 1's (scrolled-away) title.
    const { permanent } = drive([
      { type: 'subagent:start', ts: 1, subagentId: 'x', name: 'gp', goal: 'g' },
      end('x', 2),
      { type: 'session:start', ts: 3, sessionId: 's', project: 'p', model: 'm' },
      { type: 'subagent:start', ts: 4, subagentId: 'y', name: 'gp', goal: 'g' },
      end('y', 5),
    ]);
    expect(titles(permanent)).toBe(2);
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
  test('parent confirm renders the fixed "Permission required" title', () => {
    // The permission modal carries one fixed title for every tool;
    // the specific action lives in the preview block. Subject (framing
    // line) and question (decision prompt) are set; subagent
    // attribution becomes a parenthesized suffix on the title
    // (anti-spoof: only the agent's declared name reaches it).
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
      expect(r.state.modal.title).toBe('Permission required');
      expect(r.state.modal.subject).toBe(
        'The agent is requesting permission for the action below.',
      );
      expect(r.state.modal.subjectTone).toBe('secondary');
      expect(r.state.modal.question).toBe('Approve this action?');
      // Action block has blank-line-action-blank-line shape — the
      // breathing room is what sets the action apart visually. The
      // action line is a plain dim string.
      expect(r.state.modal.preview[0]).toBe('');
      expect(r.state.modal.preview[1]).toBe('    rm -rf /');
      expect(r.state.modal.preview[2]).toBe('');
    }
  });

  test('a fetch_url action renders a bold-verb preview line (fetch <url>)', () => {
    const r = applyEvent(createInitialState(), {
      type: 'permission:ask',
      ts: 1,
      promptId: 'p1',
      toolName: 'fetch_url',
      command: 'https://claude.com/product/claude-code',
      cwd: '/p',
    } as UIEvent);
    expect(r.state.modal).not.toBeNull();
    if (r.state.modal !== null) {
      // The url action is a { verb, text } line so the renderer can bold
      // just "fetch" — not the plain dim string the other tools use.
      expect(r.state.modal.preview[1]).toEqual({
        verb: 'fetch',
        text: 'https://claude.com/product/claude-code',
      });
    }
  });

  test('title is the fixed "Permission required" label regardless of tool', () => {
    // The per-tool category labels (Bash command / Editing file / …)
    // were dropped for a single generic title; the command itself
    // carries the specifics in the preview block. Unknown tools get
    // the same title (no fallback branch anymore).
    const tools = [
      'bash',
      'read_file',
      'write_file',
      'edit_file',
      'glob',
      'grep',
      'fetch_url',
      'totally_unknown_tool',
    ];
    for (const tool of tools) {
      const r = applyEvent(createInitialState(), {
        type: 'permission:ask',
        ts: 1,
        promptId: 'p',
        toolName: tool,
        command: 'x',
        cwd: '/p',
      } as UIEvent);
      expect(r.state.modal?.title).toBe('Permission required');
    }
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
    expect(r.state.modal?.preview[1]).toBe('    src/foo.ts');
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
      expect(r.state.modal.title).toBe('Permission required (subagent: explore)');
      // Preview goes straight to the action block — no
      // "subagent: explore (12345678)" prefix line.
      expect(r.state.modal.preview[0]).toBe('');
      expect(r.state.modal.preview[1]).toBe('    ls');
      expect(r.state.modal.preview[2]).toBe('');
      // No row contains the old "subagent: <name> (<idTail>)"
      // prefix shape.
      expect(
        r.state.modal.preview.some((p) =>
          (typeof p === 'string' ? p : p.text).startsWith('subagent: '),
        ),
      ).toBe(false);
    }
  });

  test('options are Yes / No (session-allow option removed)', () => {
    // The previous option 2 ("Yes, don't ask again for: X") was
    // removed. The modal now only offers Yes / No — operator who
    // needs a persistent rule edits `.forja/permissions.yaml`
    // directly (or future `/perms` slash commands), with the full
    // layered policy view in front of them.
    const r = applyEvent(createInitialState(), {
      type: 'permission:ask',
      ts: 1,
      promptId: 'p',
      toolName: 'bash',
      command: 'rm -rf /tmp',
      cwd: '/p',
      rule: 'rm -rf *',
    } as UIEvent);
    expect(r.state.modal?.options.map((o) => o.value)).toEqual(['yes', 'no']);
    expect(r.state.modal?.options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });

  test('footer hints carry only `Esc to cancel` (no unsupported affordances)', () => {
    // Earlier slices pre-flowed `Tab to amend` and `Ctrl+E to
    // explain` expecting handlers to land. The handlers never
    // shipped, and on a permission modal the advertised keys do
    // surprising things (Tab moves selection, Ctrl+E does
    // nothing), which is risky on a security surface — operators
    // expect to "amend" / "explain" and instead silently change
    // the selected answer. Hints reflect ONLY what's actually
    // wired.
    const r = applyEvent(createInitialState(), {
      type: 'permission:ask',
      ts: 1,
      promptId: 'p',
      toolName: 'bash',
      command: 'ls',
      cwd: '/p',
    } as UIEvent);
    expect(r.state.modal?.hints).toEqual(['Esc to cancel']);
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

describe('shared-trust:ask reducer (P0/F1 + P1/M2-rel)', () => {
  // Helpers to drive the reducer with a minimal `shared-trust:ask`
  // event. The flavor's full contract: title, options, preview
  // shape, conservative default, sanitization of attacker-
  // influenced strings.
  const sharedTrustEvent = (overrides: {
    mode: 'first-visit' | 'drift';
    path?: string;
    corpusFiles?: readonly { name: string; bytes: number }[];
  }): UIEvent => ({
    type: 'shared-trust:ask',
    ts: 1,
    promptId: 'p1',
    path: overrides.path ?? '/repo/.forja/memory/shared',
    mode: overrides.mode,
    corpusFiles: overrides.corpusFiles ?? [{ name: 'alpha.md', bytes: 42 }],
  });

  test('drift mode renders the drift-specific prose and revoke option', () => {
    const initial = createInitialState();
    const r = applyEvent(initial, sharedTrustEvent({ mode: 'drift' }));
    const modal = r.state.modal;
    expect(modal).not.toBeNull();
    if (modal === null) return;
    expect(modal.flavor).toBe('shared-trust');
    expect(modal.title).toBe('Shared memory trust:');
    // Drift-mode prose mentions "changed since you last confirmed".
    const previewText = modal.preview.map((p) => (typeof p === 'string' ? p : p.text)).join('\n');
    expect(previewText).toContain('changed since you last confirmed trust');
    expect(previewText).not.toContain('have not yet confirmed');
    // Options: yes + revoke (drift labels).
    expect(modal.options.map((o) => o.label)).toEqual([
      'Yes, I trust the updated corpus',
      'No, revoke trust',
    ]);
  });

  test('first-visit mode renders distinct prose + title + option label', () => {
    const initial = createInitialState();
    const r = applyEvent(initial, sharedTrustEvent({ mode: 'first-visit' }));
    const modal = r.state.modal;
    expect(modal).not.toBeNull();
    if (modal === null) return;
    expect(modal.title).toBe('Shared memory trust (first visit):');
    const previewText = modal.preview.map((p) => (typeof p === 'string' ? p : p.text)).join('\n');
    expect(previewText).toContain('have not yet confirmed');
    expect(previewText).not.toContain('changed since you last confirmed');
    expect(modal.options.map((o) => o.label)).toEqual([
      'Yes, I trust this shared corpus',
      'No, do not load',
    ]);
  });

  test('conservative default selectedIndex points at the "no" option (D65)', () => {
    // Operator hitting Enter without reading must NOT default to
    // trust — that would be the unsafe fail-mode. A regression
    // flipping selectedIndex to 0 in either mode would silently
    // turn the trust gate into a rubber-stamp.
    const initial = createInitialState();
    for (const mode of ['first-visit', 'drift'] as const) {
      const r = applyEvent(initial, sharedTrustEvent({ mode }));
      const modal = r.state.modal;
      if (modal === null) throw new Error('expected modal');
      expect(modal.selectedIndex).toBe(modal.options.length - 1);
      expect(modal.options[modal.selectedIndex]?.value).toBe('no');
    }
  });

  test('P0/F1: ANSI escapes in corpus filenames are stripped', () => {
    // Attacker plants a `.md` file whose name contains terminal
    // control bytes: `\x1b[2J\x1b[H` clears the screen and homes
    // the cursor, `\x1bc` resets the terminal. Without
    // sanitization the renderer would emit these verbatim and
    // give the attacker control over what the operator sees in
    // the trust modal.
    const evil = '\x1b[2J\x1b[H\x1b]0;PWNED\x07evil.md';
    const initial = createInitialState();
    const r = applyEvent(
      initial,
      sharedTrustEvent({
        mode: 'drift',
        corpusFiles: [{ name: evil, bytes: 7 }],
      }),
    );
    const modal = r.state.modal;
    if (modal === null) throw new Error('expected modal');
    const previewText = modal.preview.map((p) => (typeof p === 'string' ? p : p.text)).join('\n');
    expect(previewText).not.toContain('\x1b');
    expect(previewText).not.toContain('\x07');
    // The visible portion of the filename survives.
    expect(previewText).toContain('evil.md');
  });

  test('P0/F1: CR/LF/TAB in filenames are collapsed to spaces', () => {
    // Multi-line filename would break the bounded preview layout
    // and let an attacker push other rows off-screen or pretend
    // their filename "spans" multiple inventory lines.
    const evil = 'line1\nline2\tline3\rline4.md';
    const initial = createInitialState();
    const r = applyEvent(
      initial,
      sharedTrustEvent({
        mode: 'drift',
        corpusFiles: [{ name: evil, bytes: 1 }],
      }),
    );
    const modal = r.state.modal;
    if (modal === null) throw new Error('expected modal');
    // The flag chars must be gone from the FILE LINE specifically
    // (the modal still uses \n between rows; we check the row
    // containing 'line1' has no embedded newline/tab/cr).
    const fileLine = modal.preview
      .map((p) => (typeof p === 'string' ? p : p.text))
      .find((s) => s.includes('line1'));
    expect(fileLine).toBeDefined();
    if (fileLine !== undefined) {
      expect(fileLine).not.toContain('\n');
      expect(fileLine).not.toContain('\r');
      expect(fileLine).not.toContain('\t');
    }
  });

  test('P0/F1: malicious bytes in path are also stripped', () => {
    // Defense-in-depth. `event.path` is operator-derived today,
    // but a future producer that threads attacker-influenced data
    // through the path field shouldn't repaint the modal.
    const initial = createInitialState();
    const r = applyEvent(
      initial,
      sharedTrustEvent({
        mode: 'drift',
        path: '\x1b[31mfake\x1b[0m/.forja/memory/shared',
      }),
    );
    const modal = r.state.modal;
    if (modal === null) throw new Error('expected modal');
    const previewText = modal.preview.map((p) => (typeof p === 'string' ? p : p.text)).join('\n');
    expect(previewText).not.toContain('\x1b');
  });

  test('overflow truncation: > 8 files surfaces "(N more)" suffix', () => {
    const corpusFiles = Array.from({ length: 12 }, (_, i) => ({
      name: `mem-${String(i).padStart(2, '0')}.md`,
      bytes: 100,
    }));
    const initial = createInitialState();
    const r = applyEvent(initial, sharedTrustEvent({ mode: 'drift', corpusFiles }));
    const modal = r.state.modal;
    if (modal === null) throw new Error('expected modal');
    const previewText = modal.preview.map((p) => (typeof p === 'string' ? p : p.text)).join('\n');
    // First 8 surface in the inventory; the 4 overflow names DON'T.
    for (let i = 0; i < 8; i++) {
      expect(previewText).toContain(`mem-${String(i).padStart(2, '0')}.md`);
    }
    expect(previewText).toContain('and 4 more files not shown');
    expect(previewText).not.toContain('mem-08.md');
  });

  test('empty corpus inventory surfaces the explicit "(currently empty)" line', () => {
    const initial = createInitialState();
    const r = applyEvent(initial, sharedTrustEvent({ mode: 'drift', corpusFiles: [] }));
    const modal = r.state.modal;
    if (modal === null) throw new Error('expected modal');
    const previewText = modal.preview.map((p) => (typeof p === 'string' ? p : p.text)).join('\n');
    expect(previewText).toContain('(the corpus is currently empty)');
  });
});

describe('operator-bash:done (the `!cmd` shell escape)', () => {
  test('emits an operator-bash permanent carrying command + output + exit + duration', () => {
    const r = applyEvent(createInitialState(), {
      type: 'operator-bash:done',
      ts: 5,
      command: 'git status',
      output: 'On branch main\n',
      exitCode: 0,
      durationMs: 42,
    });
    expect(r.permanent).toEqual([
      {
        kind: 'operator-bash',
        command: 'git status',
        output: 'On branch main\n',
        exitCode: 0,
        durationMs: 42,
      },
    ]);
  });

  test('flushes a pending tool-end batch before the bash card (ordering)', () => {
    // A buffered done-tool then an operator command: the tool finalizes
    // into scrollback BEFORE the bash card, since the bash event emits a
    // permanent and the applyEvent wrapper flushes the batch first.
    const { permanent } = drive([
      start(),
      {
        type: 'tool:start',
        ts: 2,
        toolId: 't1',
        name: 'read_file',
        activeVerb: 'Reading',
        finalVerb: 'Read',
        subject: 'a.ts',
      },
      { type: 'tool:end', ts: 3, toolId: 't1', status: 'done', durationMs: 10 },
      { type: 'operator-bash:done', ts: 4, command: 'ls', output: '', exitCode: 0, durationMs: 5 },
    ]);
    const kinds = permanent.map((p) => p.kind);
    const toolIdx = kinds.indexOf('tool-end');
    const bashIdx = kinds.indexOf('operator-bash');
    expect(toolIdx).toBeGreaterThan(-1);
    expect(bashIdx).toBeGreaterThan(toolIdx);
  });
});

describe('busy:change (REPL isBusy mirror for the bash-mode gate)', () => {
  test('sets and clears state.busy', () => {
    const initial = createInitialState();
    expect(initial.busy).toBe(false);
    const on = applyEvent(initial, { type: 'busy:change', ts: 1, busy: true });
    expect(on.state.busy).toBe(true);
    expect(on.permanent).toEqual([]);
    const off = applyEvent(on.state, { type: 'busy:change', ts: 2, busy: false });
    expect(off.state.busy).toBe(false);
  });
});

describe('resumemode:ask reducer', () => {
  test('builds a resume-mode modal with full/summary options, cursor on full', () => {
    const r = applyEvent(createInitialState(), {
      type: 'resumemode:ask',
      ts: 1,
      promptId: 'p1',
      totalCount: 1234,
    });
    expect(r.state.modal).not.toBeNull();
    expect(r.state.modal?.flavor).toBe('resume-mode');
    // From-summary is first (recommended) and the default cursor.
    expect(r.state.modal?.options.map((o) => o.value)).toEqual(['summary', 'full']);
    expect(r.state.modal?.selectedIndex).toBe(0);
    expect(r.state.modal?.options[0]?.label).toContain('recommended');
    // totalCount surfaced in the preview so the operator sees the blast radius.
    expect(String(r.state.modal?.preview[0])).toContain('1234');
  });

  test('modal:answer clears the resume-mode modal', () => {
    const opened = applyEvent(createInitialState(), {
      type: 'resumemode:ask',
      ts: 1,
      promptId: 'p1',
      totalCount: 3,
    });
    const closed = applyEvent(opened.state, {
      type: 'modal:answer',
      ts: 2,
      promptId: 'p1',
      decision: 'full',
    });
    expect(closed.state.modal).toBeNull();
  });
});

describe('slash:update ghost threading (inline arg-hint)', () => {
  const sugg = [{ name: 'effort', description: 'set effort' }];

  test('carries the ghost from the event onto state.slash', () => {
    // The popover-nav fix depends on this: a nav re-emit re-sends the
    // ghost and the reducer must mirror it so the hint survives ↑/↓.
    const { state } = drive([
      {
        type: 'slash:update',
        ts: 1,
        suggestions: sugg,
        selectedIdx: 0,
        ghost: ' [low|medium|high]',
      },
    ]);
    expect(state.slash?.ghost).toBe(' [low|medium|high]');
  });

  test('leaves ghost undefined when the event omits it (no exact match)', () => {
    const { state } = drive([{ type: 'slash:update', ts: 1, suggestions: sugg, selectedIdx: 0 }]);
    expect(state.slash).not.toBeNull();
    expect(state.slash?.ghost).toBeUndefined();
  });

  test('the empty + -1 exit signal clears slash (and its ghost)', () => {
    const { state } = drive([
      {
        type: 'slash:update',
        ts: 1,
        suggestions: sugg,
        selectedIdx: 0,
        ghost: ' [low|medium|high]',
      },
      { type: 'slash:update', ts: 2, suggestions: [], selectedIdx: -1 },
    ]);
    expect(state.slash).toBeNull();
  });
});

describe('reasoning (extended-thinking) → scrollback', () => {
  const drive = () => {
    let s = createInitialState();
    return (e: UIEvent): PermanentItem[] => {
      const r = applyEvent(s, e);
      s = r.state;
      return r.permanent;
    };
  };

  test('accumulates thinking deltas and flushes a reasoning block on thinking:end', () => {
    const ev = drive();
    expect(ev({ type: 'thinking:start', ts: 0, messageId: 'm1' })).toEqual([]);
    expect(ev({ type: 'thinking:delta', ts: 1, messageId: 'm1', text: 'first ' })).toEqual([]);
    expect(ev({ type: 'thinking:delta', ts: 2, messageId: 'm1', text: 'second' })).toEqual([]);
    expect(ev({ type: 'thinking:end', ts: 3, messageId: 'm1' })).toEqual([
      { kind: 'reasoning', text: 'first second' },
    ]);
  });

  test('empty / whitespace-only reasoning flushes nothing', () => {
    const ev = drive();
    ev({ type: 'thinking:start', ts: 0, messageId: 'm1' });
    ev({ type: 'thinking:delta', ts: 1, messageId: 'm1', text: '   ' });
    expect(ev({ type: 'thinking:end', ts: 2, messageId: 'm1' })).toEqual([]);
  });

  test('a textless delta between text deltas does not inject "undefined"', () => {
    const ev = drive();
    ev({ type: 'thinking:start', ts: 0, messageId: 'm1' });
    ev({ type: 'thinking:delta', ts: 1, messageId: 'm1', text: 'a' });
    ev({ type: 'thinking:delta', ts: 2, messageId: 'm1' }); // no text
    ev({ type: 'thinking:delta', ts: 3, messageId: 'm1', text: 'b' });
    expect(ev({ type: 'thinking:end', ts: 4, messageId: 'm1' })).toEqual([
      { kind: 'reasoning', text: 'ab' },
    ]);
  });

  test('flush trims surrounding whitespace before capping (no leading blank rows)', () => {
    const ev = drive();
    ev({ type: 'thinking:start', ts: 0, messageId: 'm1' });
    ev({ type: 'thinking:delta', ts: 1, messageId: 'm1', text: '\n\n  weighing options  \n' });
    expect(ev({ type: 'thinking:end', ts: 2, messageId: 'm1' })).toEqual([
      { kind: 'reasoning', text: 'weighing options' },
    ]);
  });
});

describe('capReasoning', () => {
  test('passes short text through; caps long text with a marker', () => {
    expect(capReasoning('short reasoning')).toBe('short reasoning');
    const long = 'x'.repeat(3000);
    const capped = capReasoning(long);
    expect(capped.length).toBeLessThan(long.length);
    expect(capped).toContain('reasoning truncated');
  });

  test('does not split a surrogate pair at the cut boundary', () => {
    // 1499 ASCII chars, then an emoji (surrogate pair) straddling index 1500:
    // the high surrogate is at 1499, low at 1500. A naive slice(0,1500) keeps
    // the lone high surrogate → U+FFFD. capReasoning must drop it.
    const text = `${'x'.repeat(1499)}😀${'y'.repeat(50)}`;
    const capped = capReasoning(text);
    const head = capped.split('\n')[0] ?? '';
    expect(head.endsWith('�')).toBe(false);
    // The trailing unit of the head must not be a lone high surrogate.
    const lastUnit = head.charCodeAt(head.length - 1);
    expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false);
  });
});
