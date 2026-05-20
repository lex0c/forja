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

  test('tool-only assistant turn emits nothing (no text → no scrollback row)', () => {
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
    // user:submit lands; assistant text path skipped entirely
    // (no start/delta/end and crucially no orphan session:end
    // footer floating without content).
    expect(events.map((e) => e.type)).toEqual(['user:submit']);
    expect(result.turns).toBe(0);
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

  test('orphan assistant (no prior user) emits with durationMs=0 and start.ts=assistant.createdAt', () => {
    const db = setupSession('s1');
    // Synthetic edge: an assistant message with no preceding user
    // (only happens in pathological histories or test fixtures).
    // Don't crash; emit the text but with a safe-fallback duration.
    appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'text', text: 'orphan reply' }],
      createdAt: 1_000_000,
    });
    const { bus, events } = recordEvents();
    replaySessionMessages(db, 's1', bus);
    const start = events.find((e) => e.type === 'assistant:start');
    const end = events.find((e) => e.type === 'session:end');
    expect(start).toMatchObject({ ts: 1_000_000 });
    expect(end).toMatchObject({ durationMs: 0 });
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

  test('empty assistant text (zero block matches) is treated as tool-only', () => {
    // Defensive: an assistant message whose only blocks are
    // `{type: 'text', text: ''}` (provider quirk) should NOT
    // emit a phantom assistant:end with empty text. The reducer
    // would drop the empty case anyway, but we avoid the noise
    // upstream and skip session:end for it too (no anchor turn).
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
    expect(events.map((e) => e.type)).toEqual(['user:submit']);
    expect(result.turns).toBe(0);
  });
});
