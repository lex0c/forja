import { describe, expect, test } from 'bun:test';
import { replayProviderMessages, replaySessionMessages } from '../../src/cli/resume-replay.ts';
import type { ProviderMessage } from '../../src/providers/index.ts';
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

describe('replaySessionMessages — text + tool replay (Phase 3)', () => {
  test('empty session emits nothing', () => {
    const db = setupSession('s1');
    const { bus, events } = recordEvents();
    const result = replaySessionMessages(db, 's1', bus);
    expect(events).toEqual([]);
    expect(result).toEqual({ turns: 0, messagesWalked: 0, droppedFromHead: 0 });
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
    expect(result).toEqual({ turns: 1, messagesWalked: 2, droppedFromHead: 0 });
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

  test('a system-source user message replays as info, not an operator-submit bar (migration 075)', () => {
    const db = setupSession('s2');
    appendMessage(db, {
      id: 'u1',
      sessionId: 's2',
      role: 'user',
      content: '[background] `npm test` exited (exit 1). process_id=p1 — read complete output…',
      source: 'system',
      createdAt: 1_000_000,
    });
    appendMessage(db, {
      id: 'a1',
      sessionId: 's2',
      parentId: 'u1',
      role: 'assistant',
      content: [{ type: 'text', text: 'noted' }],
      createdAt: 1_001_000,
    });
    const { bus, events } = recordEvents();
    replaySessionMessages(db, 's2', bus);
    // The harness-injected input must NOT replay as an operator bar.
    expect(events.map((e) => e.type)).not.toContain('user:submit');
    expect(events[0]?.type).toBe('info');
    expect((events[0] as { message?: string }).message).toContain('[background]');
  });

  test('interleaved text blocks emit as separate deltas in block order (no \\n join)', () => {
    // Walker emits one assistant:delta per text block, not a joined
    // concat. The reducer's pendingAssistant accumulates the deltas
    // into a single PermanentItem with text = "Looking..." + "Found
    // it..." (no separator) — matching live streaming behavior where
    // the model's own whitespace dictates separators. The tool_use
    // here HAS a matching tool_result so it replays as a real tool
    // card between the two text deltas; orphan behavior is covered
    // separately below.
    const db = setupSession('s1');
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'do something complex',
      createdAt: 1_000_000,
    });
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
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file body' }],
      createdAt: 1_002_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'text', text: 'wrap up' }],
      createdAt: 1_003_000,
    });
    const { bus, events } = recordEvents();
    replaySessionMessages(db, 's1', bus);
    // First assistant message's two text blocks land as two deltas.
    const a1Deltas = events.filter((e) => e.type === 'assistant:delta' && e.messageId === 'a1');
    expect(a1Deltas).toHaveLength(2);
    expect(a1Deltas[0]).toMatchObject({ text: 'Looking...' });
    expect(a1Deltas[1]).toMatchObject({ text: "Found it, here's the answer." });
    // The tool_use replays as a real card (matching result exists).
    expect(events.find((e) => e.type === 'tool:start')).toMatchObject({ toolId: 'tu1' });
  });

  test('tool-only assistant turn (no text) emits its tool card + interrupted footer', () => {
    // An assistant message with only a tool_use and no text, and
    // no tool_result after it. No assistant:start/end pair
    // (nothing to bracket), but the tool card replays and the
    // run-boundary footer fires. The tool_use is orphan → the run
    // never reached a clean stop, so the footer is 'interrupted',
    // not 'done'.
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
      content: [{ type: 'tool_use', id: 'tu1', name: 'bash', input: { command: 'ls' } }],
      createdAt: 1_001_000,
    });
    const { bus, events } = recordEvents();
    const result = replaySessionMessages(db, 's1', bus);
    // user:submit → tool:start → tool:end (synthetic) → session:end.
    // No assistant:start/end — the message carried no text.
    expect(events.map((e) => e.type)).toEqual([
      'user:submit',
      'tool:start',
      'tool:end',
      'session:end',
    ]);
    expect(events[3]).toMatchObject({
      type: 'session:end',
      durationMs: 1000,
      reason: 'interrupted',
    });
    expect(result.turns).toBe(1);
  });

  test('orphan tool_result inside the window emits no tool:end', () => {
    const db = setupSession('s1');
    // A string prompt opens a safe window head, followed by a user
    // message whose only block is a tool_result with no prior
    // tool_use. The orphan tool_result produces no tool:end —
    // emitting one for a card the reducer never opened would noop
    // at best. The string prompt + a trailing assistant keep the
    // window from collapsing (so this isolates orphan-result
    // handling, not the window cut).
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'kick off',
      createdAt: 1_000_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }],
      createdAt: 1_001_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      createdAt: 1_002_000,
    });
    const { bus, events } = recordEvents();
    replaySessionMessages(db, 's1', bus);
    expect(events.find((e) => e.type === 'tool:end')).toBeUndefined();
    // No truncation indicator — the whole (tiny) session fit.
    expect(events.find((e) => e.type === 'info')).toBeUndefined();
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

    // Order with Phase 3 tool replay:
    //   user:submit
    //   assistant:start (a1) → delta(text) → tool:start(tu1) → assistant:end(a1)
    //   tool:end(tu1)
    //   assistant:start (a2) → delta(text) → assistant:end(a2)
    //   session:end
    expect(events.map((e) => e.type)).toEqual([
      'user:submit',
      'assistant:start',
      'assistant:delta',
      'tool:start',
      'assistant:end',
      'tool:end',
      'assistant:start',
      'assistant:delta',
      'assistant:end',
      'session:end',
    ]);
    // Tool pair landed with status=done and a durationMs proxy
    // sourced from the createdAt gap between the assistant row
    // emitting the use (a1 at 1_001_000) and the user row carrying
    // the result (1_002_000).
    const toolStart = events.find((e) => e.type === 'tool:start');
    const toolEnd = events.find((e) => e.type === 'tool:end');
    expect(toolStart).toMatchObject({
      type: 'tool:start',
      toolId: 'tu1',
      name: 'read_file',
      // read_file's vocab subject extractor pulls `input.path`.
      subject: 'x',
    });
    expect(toolEnd).toMatchObject({
      type: 'tool:end',
      toolId: 'tu1',
      status: 'done',
      durationMs: 1000,
    });
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

  // ── Phase 3 specific coverage ─────────────────────────────────

  test('tool subject extraction uses tool-vocab (read_file → input.path)', () => {
    const db = setupSession('s1');
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'read it',
      createdAt: 1_000_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'src/x.ts' } }],
      createdAt: 1_001_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file body' }],
      createdAt: 1_002_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      createdAt: 1_003_000,
    });
    const { bus, events } = recordEvents();
    replaySessionMessages(db, 's1', bus);
    const start = events.find((e) => e.type === 'tool:start');
    expect(start).toMatchObject({
      toolId: 'tu1',
      name: 'read_file',
      activeVerb: 'Reading file',
      finalVerb: 'Read file',
      subject: 'src/x.ts',
    });
  });

  test('unknown tool name falls back to generic vocab (Calling X / Called X)', () => {
    const db = setupSession('s1');
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'do it',
      createdAt: 1_000_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu1', name: 'made_up_tool', input: {} }],
      createdAt: 1_001_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }],
      createdAt: 1_002_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      createdAt: 1_003_000,
    });
    const { bus, events } = recordEvents();
    replaySessionMessages(db, 's1', bus);
    const start = events.find((e) => e.type === 'tool:start');
    expect(start).toMatchObject({
      name: 'made_up_tool',
      activeVerb: 'Calling made_up_tool',
      finalVerb: 'Called made_up_tool',
      // No subject extractor for unknown tools → null.
      subject: null,
    });
  });

  test('tool_result with is_error=true emits status=error', () => {
    const db = setupSession('s1');
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'try it',
      createdAt: 1_000_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu1', name: 'bash', input: { command: 'false' } }],
      createdAt: 1_001_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'exit 1', is_error: true }],
      createdAt: 1_002_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'text', text: 'oops' }],
      createdAt: 1_003_000,
    });
    const { bus, events } = recordEvents();
    replaySessionMessages(db, 's1', bus);
    expect(events.find((e) => e.type === 'tool:end')).toMatchObject({
      status: 'error',
      durationMs: 1000,
    });
  });

  test('tool_result summary collapses whitespace and truncates at 200 chars', () => {
    const db = setupSession('s1');
    const longContent = `${'a'.repeat(300)}\nmore${'b'.repeat(50)}`;
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'do it',
      createdAt: 1_000_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu1', name: 'bash', input: { command: 'cat big' } }],
      createdAt: 1_001_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: longContent }],
      createdAt: 1_002_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      createdAt: 1_003_000,
    });
    const { bus, events } = recordEvents();
    replaySessionMessages(db, 's1', bus);
    const end = events.find((e) => e.type === 'tool:end');
    const summary = (end as { summary: string }).summary;
    expect(summary).toBeDefined();
    expect(summary.length).toBeLessThanOrEqual(200);
    // ASCII '...' ellipsis — the summary is content text, not a
    // renderer glyph, so it must render on every terminal.
    expect(summary.endsWith('...')).toBe(true);
    // Whitespace collapsed: no embedded `\n` in the summary.
    expect(summary).not.toContain('\n');
  });

  test('orphan tool_use (no matching result) emits tool:start + synthetic error tool:end', () => {
    // Live: an interrupted run can leave a tool_use without a
    // tool_result (hard kill / crash before the tool returned).
    // Dropping it entirely would hide that the tool was attempted;
    // emitting only tool:start would freeze the card as "running…"
    // in the live region. So we emit BOTH: a real tool:start, then
    // a synthetic error tool:end that tells the truth.
    const db = setupSession('s1');
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'do it',
      createdAt: 1_000_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'starting' },
        { type: 'tool_use', id: 'orphan', name: 'bash', input: { command: 'sleep 5' } },
      ],
      createdAt: 1_001_000,
    });
    // No user(tool_result) follow-up — run was interrupted.
    const { bus, events } = recordEvents();
    replaySessionMessages(db, 's1', bus);
    expect(events.find((e) => e.type === 'tool:start')).toMatchObject({ toolId: 'orphan' });
    expect(events.find((e) => e.type === 'tool:end')).toMatchObject({
      toolId: 'orphan',
      status: 'error',
      durationMs: 0,
      summary: '(no result recorded — run interrupted)',
    });
    // The synthetic tool:end lands AFTER assistant:end (the card
    // closes only once the surrounding text has rendered).
    const endIdx = events.findIndex((e) => e.type === 'assistant:end');
    const toolEndIdx = events.findIndex((e) => e.type === 'tool:end');
    expect(toolEndIdx).toBeGreaterThan(endIdx);
    // Text + closing footer still emit.
    expect(events.find((e) => e.type === 'assistant:delta')).toMatchObject({ text: 'starting' });
    // The footer reports 'interrupted', not 'done' — the run had an
    // outstanding tool_use when it died.
    expect(events.find((e) => e.type === 'session:end')).toMatchObject({
      reason: 'interrupted',
    });
  });

  test('interrupted tail (user → assistant with unresolved tool_use) → interrupted footer', () => {
    // The reviewer's scenario. A session whose LAST row is an
    // assistant message carrying a tool_use with no tool_result
    // after it = the run crashed / was killed waiting on the tool.
    // The footer must NOT say 'done' — that would render a
    // successful "Cogitated for Xs" marker over a dead run.
    const db = setupSession('s1');
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'analyze the repo',
      createdAt: 1_000_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Starting the analysis...' },
        { type: 'tool_use', id: 'tu-killed', name: 'bash', input: { command: 'find .' } },
      ],
      createdAt: 1_004_000,
    });
    // Nothing after — the run died here.
    const { bus, events } = recordEvents();
    const result = replaySessionMessages(db, 's1', bus);
    const end = events.find((e) => e.type === 'session:end');
    expect(end).toMatchObject({ reason: 'interrupted', durationMs: 4000 });
    // The turn still counts — it's a turn of history above the
    // prompt, just an incomplete one.
    expect(result.turns).toBe(1);
  });

  test('completed tail (run ends on a tool-free assistant) → done footer', () => {
    // Contrast with the interrupted case: a run that ends on a
    // text-only assistant DID reach a clean stop (the harness
    // ends a run when the model produces a tool-free response).
    // That footer is legitimately 'done'.
    const db = setupSession('s1');
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'analyze the repo',
      createdAt: 1_000_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking...' },
        { type: 'tool_use', id: 'tu1', name: 'bash', input: { command: 'find .' } },
      ],
      createdAt: 1_001_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file list' }],
      createdAt: 1_002_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'text', text: 'Analysis complete.' }],
      createdAt: 1_005_000,
    });
    const { bus, events } = recordEvents();
    replaySessionMessages(db, 's1', bus);
    const ends = events.filter((e) => e.type === 'session:end');
    // One footer for the whole run, reason='done' (the run ended
    // on a tool-free assistant response).
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ reason: 'done', durationMs: 5000 });
  });

  test('orphan tool_result (no matching use) is dropped', () => {
    // Defensive against malformed audit shapes (or a partial
    // import). A tool_result without a known tool_use produces no
    // tool:end — the reducer's activeTools wouldn't have an entry
    // to flush anyway, so emitting one would noop on best case
    // and corrupt on worst.
    const db = setupSession('s1');
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'do it',
      createdAt: 1_000_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'text', text: 'I will do it' }],
      createdAt: 1_001_000,
    });
    // Synthetic stray tool_result with no prior tool_use.
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'phantom', content: 'r' }],
      createdAt: 1_002_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      createdAt: 1_003_000,
    });
    const { bus, events } = recordEvents();
    replaySessionMessages(db, 's1', bus);
    expect(events.find((e) => e.type === 'tool:end')).toBeUndefined();
  });

  test('multi-tool turn: one assistant fires N tool_uses, paired with N tool_results', () => {
    // Assistant emits two tool_uses in one message (parallel
    // tools); the next user message carries both results. Replay
    // emits two tool:start in block order + two tool:end in
    // result-block order, all paired by id.
    const db = setupSession('s1');
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'do both',
      createdAt: 1_000_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'doing both' },
        { type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'x.ts' } },
        { type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'y.ts' } },
      ],
      createdAt: 1_001_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'a body' },
        { type: 'tool_result', tool_use_id: 'b', content: 'b body' },
      ],
      createdAt: 1_002_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      createdAt: 1_003_000,
    });
    const { bus, events } = recordEvents();
    replaySessionMessages(db, 's1', bus);
    const starts = events.filter((e) => e.type === 'tool:start');
    const ends = events.filter((e) => e.type === 'tool:end');
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(starts[0]).toMatchObject({ toolId: 'a', subject: 'x.ts' });
    expect(starts[1]).toMatchObject({ toolId: 'b', subject: 'y.ts' });
    expect(ends[0]).toMatchObject({ toolId: 'a', summary: 'a body' });
    expect(ends[1]).toMatchObject({ toolId: 'b', summary: 'b body' });
  });

  test('block order preserved: text → tool → text → tool → text within one assistant message', () => {
    // Live behavior: when an LLM completion weaves prose around
    // multiple tool calls, the operator sees the text in its
    // emit order with tool cards interleaved beneath the chip.
    // Replay must preserve that order (reducer accepts tool:start
    // while pendingAssistant is open).
    const db = setupSession('s1');
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: 'do x then y',
      createdAt: 1_000_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'first ' },
        { type: 'tool_use', id: 'a', name: 'read_file', input: { path: '1' } },
        { type: 'text', text: 'middle ' },
        { type: 'tool_use', id: 'b', name: 'read_file', input: { path: '2' } },
        { type: 'text', text: 'last' },
      ],
      createdAt: 1_001_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'r1' },
        { type: 'tool_result', tool_use_id: 'b', content: 'r2' },
      ],
      createdAt: 1_002_000,
    });
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'text', text: 'closing' }],
      createdAt: 1_003_000,
    });
    const { bus, events } = recordEvents();
    replaySessionMessages(db, 's1', bus);
    // The 3 text deltas + 2 tool:starts all happen inside the
    // SAME assistant:start/end pair, in source-block order.
    expect(events.map((e) => e.type)).toEqual([
      'user:submit',
      'assistant:start',
      'assistant:delta',
      'tool:start',
      'assistant:delta',
      'tool:start',
      'assistant:delta',
      'assistant:end',
      'tool:end',
      'tool:end',
      'assistant:start',
      'assistant:delta',
      'assistant:end',
      'session:end',
    ]);
  });

  // ── Resume window cap (must match the model's context) ────────

  // Helper: seed a session with `n` independent user→assistant
  // turns, each 1s apart. Returns the db.
  const seedTurns = (sessionId: string, n: number) => {
    const db = setupSession(sessionId);
    for (let i = 0; i < n; i++) {
      const base = 1_000_000 + i * 10_000;
      appendMessage(db, {
        sessionId,
        role: 'user',
        content: `prompt ${i}`,
        createdAt: base,
      });
      appendMessage(db, {
        sessionId,
        role: 'assistant',
        content: [{ type: 'text', text: `reply ${i}` }],
        createdAt: base + 1_000,
      });
    }
    return db;
  };

  test('session within the window: no truncation indicator, droppedFromHead 0', () => {
    const db = seedTurns('s1', 3);
    const { bus, events } = recordEvents();
    // fetchLimit 100 >> 6 messages — whole session fits.
    const result = replaySessionMessages(db, 's1', bus, 100);
    expect(result.droppedFromHead).toBe(0);
    expect(events.find((e) => e.type === 'info')).toBeUndefined();
    expect(result.turns).toBe(3);
  });

  test('session larger than the fetch window: only the capped tail replays', () => {
    // 10 turns = 20 messages. fetchLimit 6 → only the most-recent
    // 6 messages reach the replay. resumeWindowCut may trim the
    // head further to land on a safe boundary.
    const db = seedTurns('s1', 10);
    const { bus, events } = recordEvents();
    const result = replaySessionMessages(db, 's1', bus, 6);
    // 20 total, at most 6 walked.
    expect(result.messagesWalked).toBeLessThanOrEqual(6);
    expect(result.droppedFromHead).toBeGreaterThan(0);
    // droppedFromHead + messagesWalked accounts for every row.
    expect(result.droppedFromHead + result.messagesWalked).toBe(20);
    // The oldest turns are NOT in the replayed scrollback — the
    // model never received them, so neither does the operator.
    const submitted = events
      .filter((e) => e.type === 'user:submit')
      .map((e) => (e as { text: string }).text);
    expect(submitted).not.toContain('prompt 0');
    expect(submitted).not.toContain('prompt 1');
    // The most recent turn IS present.
    expect(submitted).toContain('prompt 9');
  });

  test('truncation indicator is emitted first, in secondary tone, with the dropped count', () => {
    const db = seedTurns('s1', 10);
    const { bus, events } = recordEvents();
    const result = replaySessionMessages(db, 's1', bus, 6);
    const first = events[0];
    expect(first).toMatchObject({ type: 'info', tone: 'secondary' });
    expect((first as { message: string }).message).toContain(`${result.droppedFromHead} earlier`);
    expect((first as { message: string }).message).toContain('not in model context');
  });

  test('truncation count is the exact set of rows outside the window', () => {
    // 5 turns = 10 messages, fetchLimit 4. The tail query returns
    // the newest 4; resumeWindowCut may trim further. Whatever the
    // exact split, dropped + walked must equal the full 10.
    const db = seedTurns('s1', 5);
    const { bus } = recordEvents();
    const result = replaySessionMessages(db, 's1', bus, 4);
    expect(result.droppedFromHead + result.messagesWalked).toBe(10);
    expect(result.droppedFromHead).toBe(10 - result.messagesWalked);
  });
});

describe('replayProviderMessages — compacted-array replay (resume "from summary")', () => {
  test('renders the summary head as secondary info, then replays the preserved tail', () => {
    const { bus, events } = recordEvents();
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'goal\n\n[compacted_history]\nfolded stuff\n[/compacted_history]' },
      { role: 'user', content: 'recent prompt' },
      { role: 'assistant', content: [{ type: 'text', text: 'recent answer' }] },
    ];
    const result = replayProviderMessages(messages, 's1', bus, 0);
    // Summary head → info channel, all secondary tone (scaffold, not content).
    const infos = events.filter((e) => e.type === 'info');
    expect(infos.length).toBeGreaterThan(0);
    expect(infos.every((e) => (e as { tone?: string }).tone === 'secondary')).toBe(true);
    // Preserved prompt replays as a real user:submit (inverse bar).
    expect(
      events.some(
        (e) => e.type === 'user:submit' && (e as { text: string }).text === 'recent prompt',
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === 'assistant:delta')).toBe(true);
    expect(result.turns).toBe(1);
  });

  test('preserved tail starting at an assistant (prompt folded) still emits a footer', () => {
    // Compaction aligns the preserved tail to start at an ASSISTANT — the user
    // prompt that opened that run was folded into the summary. The summary head
    // is the user-side anchor, so the assistant run boundary must still close
    // (session:end + turn count); otherwise the latest response shows with no
    // footer until a later real prompt.
    const { bus, events } = recordEvents();
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'goal\n\n[compacted_history]\nfolded\n[/compacted_history]' },
      { role: 'assistant', content: [{ type: 'text', text: 'latest answer' }] },
    ];
    const result = replayProviderMessages(messages, 's1', bus, 0);
    expect(events.some((e) => e.type === 'session:end')).toBe(true);
    expect(result.turns).toBe(1);
  });

  test('the synthetic summary head is NOT replayed as a user:submit', () => {
    const { bus, events } = recordEvents();
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'goal\n\n[compacted_history]\nx\n[/compacted_history]' },
      { role: 'user', content: 'hi' },
    ];
    replayProviderMessages(messages, 's1', bus, 0);
    const submits = events.filter((e) => e.type === 'user:submit');
    expect(submits).toHaveLength(1);
    expect((submits[0] as { text: string }).text).toBe('hi');
  });

  test('no summary marker (noop compaction) → head replays as a turn + fallback anchor', () => {
    // summary mode on a session too small to fold: no [compacted_history] head.
    // The head replays as a real turn, and a history/new-turns anchor still
    // fires (parity with capped/full) — never left without a separator.
    const { bus, events } = recordEvents();
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'just a prompt' },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    ];
    const result = replayProviderMessages(messages, 's1', bus, 0);
    expect(
      events.some(
        (e) => e.type === 'user:submit' && (e as { text: string }).text === 'just a prompt',
      ),
    ).toBe(true);
    // No summary block, but the fallback anchor for the one replayed turn.
    expect(result.turns).toBe(1);
    const infos = events.filter((e) => e.type === 'info');
    expect(infos).toHaveLength(1);
    expect((infos[0] as { message: string }).message).toContain('resumed 1 prior turn');
  });
});
