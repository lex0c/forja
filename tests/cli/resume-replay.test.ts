import { describe, expect, test } from 'bun:test';
import { replaySessionMessages } from '../../src/cli/resume-replay.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { createBus } from '../../src/tui/bus.ts';
import type { UIEvent } from '../../src/tui/events.ts';

// Capture every event the replay emits, preserving order. The bus's
// onAny hook gives us a stable interception point without coupling
// to the reducer's PermanentItem materialization (that's covered by
// the integration test in tests/cli/repl.test.ts).
const recordEvents = (): { bus: ReturnType<typeof createBus>; events: UIEvent[] } => {
  const bus = createBus();
  const events: UIEvent[] = [];
  bus.onAny((e) => {
    events.push(e);
  });
  return { bus, events };
};

const setupSession = (sessionId: string) => {
  const db = openMemoryDb();
  migrate(db);
  createSession(db, { id: sessionId, model: 'mock/m', cwd: '/tmp/forja-resume' });
  return db;
};

describe('replaySessionMessages — text-only (Phase 2)', () => {
  test('empty session emits nothing', () => {
    const db = setupSession('s1');
    const { bus, events } = recordEvents();
    const result = replaySessionMessages(db, 's1', bus);
    expect(events).toEqual([]);
    expect(result).toEqual({ turns: 0, messagesWalked: 0 });
  });

  test('single user → assistant turn emits the expected sequence', () => {
    const db = setupSession('s1');
    // Seed two messages 5 seconds apart so durationMs reads 5000.
    appendMessage(db, {
      id: 'u1',
      sessionId: 's1',
      role: 'user',
      content: 'write a haiku',
      createdAt: 1_000_000,
    });
    appendMessage(db, {
      id: 'a1',
      sessionId: 's1',
      parentId: 'u1',
      role: 'assistant',
      content: [{ type: 'text', text: "Sure, here's a haiku..." }],
      createdAt: 1_005_000,
    });
    const { bus, events } = recordEvents();
    const result = replaySessionMessages(db, 's1', bus);
    expect(result).toEqual({ turns: 1, messagesWalked: 2 });
    // Sequence: user:submit → assistant:start → assistant:delta →
    // assistant:end → session:end. Order matters — start before
    // delta before end is what the reducer expects.
    expect(events.map((e) => e.type)).toEqual([
      'user:submit',
      'assistant:start',
      'assistant:delta',
      'assistant:end',
      'session:end',
    ]);
    expect(events[0]).toMatchObject({ type: 'user:submit', text: 'write a haiku' });
    expect(events[1]).toMatchObject({ type: 'assistant:start', messageId: 'a1', ts: 1_000_000 });
    expect(events[2]).toMatchObject({
      type: 'assistant:delta',
      messageId: 'a1',
      text: "Sure, here's a haiku...",
      ts: 1_005_000,
    });
    expect(events[3]).toMatchObject({ type: 'assistant:end', messageId: 'a1', ts: 1_005_000 });
    expect(events[4]).toMatchObject({
      type: 'session:end',
      sessionId: 's1',
      reason: 'done',
      durationMs: 5000,
      ts: 1_005_000,
    });
  });

  test('assistant message with interleaved text blocks joins them with newline', () => {
    const db = setupSession('s1');
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'do something complex',
      createdAt: 1_000_000,
    });
    // Anthropic emits this shape when the response weaves prose
    // around tool_use blocks. We skip the tool block (Phase 2) but
    // keep both text fragments so the prose reads continuously.
    appendMessage(db, {
      id: 'a1',
      sessionId: 's1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking...' },
        { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'x' } },
        { type: 'text', text: "Found it, here's the answer." },
      ],
      createdAt: 1_001_000,
    });
    const { bus, events } = recordEvents();
    replaySessionMessages(db, 's1', bus);
    const delta = events.find((e) => e.type === 'assistant:delta');
    expect(delta).toMatchObject({
      type: 'assistant:delta',
      text: "Looking...\nFound it, here's the answer.",
    });
  });

  test('tool-only assistant turn at run boundary: footer fires even without text', () => {
    // The live operator saw a user submit, then tool cards, then a
    // `Cogitated for Xs` footer. We skip the tool cards in this
    // slice (text-only), but the footer still belongs at the run
    // boundary — operator's mental model is "this run ended,
    // here's the timing". Suppressing it would also collapse the
    // turn count, hiding a real conversation step from the anchor.
    const db = setupSession('s1');
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'fix it',
      createdAt: 1_000_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu1', name: 'bash', input: { cmd: 'ls' } }],
      createdAt: 1_001_000,
    });
    const { bus, events } = recordEvents();
    const result = replaySessionMessages(db, 's1', bus);
    // user:submit + session:end (no assistant row in text-only
    // mode; tool-replay slice will fill the gap with chip rows).
    expect(events.map((e) => e.type)).toEqual(['user:submit', 'session:end']);
    expect(events[1]).toMatchObject({
      type: 'session:end',
      durationMs: 1000,
      reason: 'done',
    });
    expect(result.turns).toBe(1);
  });

  test('tool_result-only user message (array content) is skipped', () => {
    const db = setupSession('s1');
    // User's tool_results message — content is an array of
    // tool_result blocks, not a string. We render nothing
    // user-facing for it (Phase 2 leaves tool replay out).
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }],
      createdAt: 1_000_000,
    });
    const { bus, events } = recordEvents();
    replaySessionMessages(db, 's1', bus);
    expect(events).toEqual([]);
  });

  test('multi-turn conversation: each turn produces its own footer', () => {
    const db = setupSession('s1');
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'turn one',
      createdAt: 1_000_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'text', text: 'reply one' }],
      createdAt: 1_002_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'turn two',
      createdAt: 1_010_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'text', text: 'reply two' }],
      createdAt: 1_011_000,
    });
    const { bus, events } = recordEvents();
    const result = replaySessionMessages(db, 's1', bus);
    expect(result.turns).toBe(2);
    const ends = events.filter((e) => e.type === 'session:end');
    expect(ends).toHaveLength(2);
    expect(ends[0]).toMatchObject({ durationMs: 2000 });
    expect(ends[1]).toMatchObject({ durationMs: 1000 });
  });

  test('orphan assistant (no prior user) emits the text row but NO session:end footer', () => {
    // Synthetic edge: an assistant message with no preceding user
    // (only happens in pathological histories or test fixtures).
    // Don't crash; emit the text. Don't emit session:end — there
    // is no user submit above it, so a floating footer would read
    // as a bug to the operator.
    const db = setupSession('s1');
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'text', text: 'orphan reply' }],
      createdAt: 1_000_000,
    });
    const { bus, events } = recordEvents();
    const result = replaySessionMessages(db, 's1', bus);
    expect(events.map((e) => e.type)).toEqual([
      'assistant:start',
      'assistant:delta',
      'assistant:end',
    ]);
    expect(events.find((e) => e.type === 'assistant:start')).toMatchObject({ ts: 1_000_000 });
    expect(result.turns).toBe(0);
  });

  test('plain-string assistant content (legacy / non-block shape) renders as text', () => {
    const db = setupSession('s1');
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'hi',
      createdAt: 1_000_000,
    });
    // Some providers / older harness paths persisted assistant
    // content as a plain string rather than the block array. We
    // accept both shapes so a session from any vintage replays.
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: 'plain text response',
      createdAt: 1_001_000,
    });
    const { bus, events } = recordEvents();
    const result = replaySessionMessages(db, 's1', bus);
    expect(result.turns).toBe(1);
    expect(events.find((e) => e.type === 'assistant:delta')).toMatchObject({
      text: 'plain text response',
    });
  });

  test('empty assistant text (zero block matches) skips text row but still closes the run', () => {
    // Defensive: an assistant message whose only blocks are
    // `{type: 'text', text: ''}` (provider quirk) should NOT
    // emit a phantom assistant:end with empty text. The reducer
    // would drop the empty case anyway, but we avoid the noise
    // upstream. Same shape as a tool-only assistant: footer still
    // fires at the run boundary so the turn count and timing
    // surface in the anchor.
    const db = setupSession('s1');
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'hi',
      createdAt: 1_000_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      createdAt: 1_001_000,
    });
    const { bus, events } = recordEvents();
    const result = replaySessionMessages(db, 's1', bus);
    expect(events.map((e) => e.type)).toEqual(['user:submit', 'session:end']);
    expect(result.turns).toBe(1);
  });

  test('run with mid-stream tool_use → tool_result → final text: ONE footer at the very end', () => {
    // The bug this slice fixes. The harness persists one assistant
    // message per LLM completion; a run that uses tools writes
    // (assistant text+tool_use → user tool_result → assistant
    // text). The live operator saw ONE `Cogitated for Xs` footer
    // covering the whole run. Naive per-assistant-row footer
    // emission would show TWO footers AND collapse the duration
    // of the second to 0 (no preceding "user submit" to anchor).
    const db = setupSession('s1');
    // Original operator prompt at t=1_000_000.
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'read the file and summarize',
      createdAt: 1_000_000,
    });
    // Assistant says "Looking..." and fires a tool_use, at t=1_001_000.
    appendMessage(db, {
      id: 'a1',
      sessionId: 's1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking...' },
        { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'x' } },
      ],
      createdAt: 1_001_000,
    });
    // Tool result lands in a user message with ARRAY content at t=1_002_000.
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file body' }],
      createdAt: 1_002_000,
    });
    // Final assistant text closes the run at t=1_005_000.
    appendMessage(db, {
      id: 'a2',
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'text', text: 'Done. Here is the summary.' }],
      createdAt: 1_005_000,
    });
    const { bus, events } = recordEvents();
    const result = replaySessionMessages(db, 's1', bus);

    // Exactly ONE session:end across the whole run.
    const ends = events.filter((e) => e.type === 'session:end');
    expect(ends).toHaveLength(1);
    // The single footer spans the WHOLE run (operator's prompt
    // through the final assistant): 1_005_000 - 1_000_000 = 5_000.
    expect(ends[0]).toMatchObject({ durationMs: 5000, reason: 'done' });
    // turns reflects user-facing runs, not raw assistant rows.
    expect(result.turns).toBe(1);

    // Both assistant blocks emit start/delta/end with sensible per-block
    // timestamps. First block's start anchors to the user prompt
    // (createdAt 1_000_000), second block's start anchors to the
    // tool_result user message (createdAt 1_002_000) — neither is
    // 0, neither is a guess. Reducer math gives each block its
    // own honest per-completion duration.
    const starts = events.filter((e) => e.type === 'assistant:start');
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ messageId: 'a1', ts: 1_000_000 });
    expect(starts[1]).toMatchObject({ messageId: 'a2', ts: 1_002_000 });

    // Order: user → asst1 (3 events) → asst2 (3 events) → session:end.
    expect(events.map((e) => e.type)).toEqual([
      'user:submit',
      'assistant:start',
      'assistant:delta',
      'assistant:end',
      'assistant:start',
      'assistant:delta',
      'assistant:end',
      'session:end',
    ]);
  });

  test('multi-run with mid-stream tool chain per run: one footer per OPERATOR turn', () => {
    // Two operator turns, each with its own tool chain. Expect
    // exactly two footers — not four (one per assistant row) and
    // not one (collapsed across runs).
    const db = setupSession('s1');
    // Run 1: user → asst (text+tool) → user[tool_result] → asst (text).
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'turn 1 prompt',
      createdAt: 1_000_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [
        { type: 'text', text: 't1 intermediate' },
        { type: 'tool_use', id: 't1tu', name: 'read', input: {} },
      ],
      createdAt: 1_001_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1tu', content: 'r' }],
      createdAt: 1_002_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'text', text: 't1 final' }],
      createdAt: 1_003_000,
    });
    // Run 2: user → asst (text+tool) → user[tool_result] → asst (text).
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'turn 2 prompt',
      createdAt: 1_010_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [
        { type: 'text', text: 't2 intermediate' },
        { type: 'tool_use', id: 't2tu', name: 'bash', input: {} },
      ],
      createdAt: 1_011_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't2tu', content: 'r' }],
      createdAt: 1_012_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'text', text: 't2 final' }],
      createdAt: 1_020_000,
    });
    const { bus, events } = recordEvents();
    const result = replaySessionMessages(db, 's1', bus);
    const ends = events.filter((e) => e.type === 'session:end');
    expect(ends).toHaveLength(2);
    // Each footer spans its OWN run's full wall clock.
    expect(ends[0]).toMatchObject({ durationMs: 3000 });
    expect(ends[1]).toMatchObject({ durationMs: 10000 });
    expect(result.turns).toBe(2);
  });
});
