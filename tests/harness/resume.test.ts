import { describe, expect, test } from 'bun:test';
import { MAX_RESUME_MESSAGES, messagesToProviderMessages } from '../../src/harness/resume.ts';
import type { Message } from '../../src/storage/repos/messages.ts';

const msg = (role: 'user' | 'assistant' | 'tool', content: unknown): Message => ({
  id: 'm',
  sessionId: 's',
  parentId: null,
  role,
  content,
  tokensIn: null,
  tokensOut: null,
  cachedTokens: null,
  cacheCreationTokens: null,
  costUsd: null,
  createdAt: 0,
});

describe('messagesToProviderMessages', () => {
  test('preserves user and assistant messages in order', () => {
    const r = messagesToProviderMessages([
      msg('user', 'hello'),
      msg('assistant', [{ type: 'text', text: 'hi back' }]),
      msg('user', 'follow up'),
    ]);
    expect(r.messages).toHaveLength(3);
    expect(r.droppedFromHead).toBe(0);
    expect(r.messages[0]).toEqual({ role: 'user', content: 'hello' });
    expect(r.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi back' }],
    });
    expect(r.messages[2]).toEqual({ role: 'user', content: 'follow up' });
  });

  test('preserves ProviderContentBlock[] arrays (tool_result wrapping)', () => {
    // The harness wraps tool results as user-role messages whose
    // content is an array of tool_result blocks. The reconstitution
    // round-trips that shape.
    const toolResultContent = [
      {
        type: 'tool_result' as const,
        tool_use_id: 'abc',
        content: 'output',
      },
    ];
    const r = messagesToProviderMessages([msg('user', toolResultContent)]);
    expect(r.messages[0]?.content).toEqual(toolResultContent);
    expect(r.droppedFromHead).toBe(0);
  });

  test('skips role=tool entries (forward-compat: not currently emitted)', () => {
    // role='tool' exists in the schema but the loop only emits
    // user/assistant. Defensive skip so a future migration that
    // starts emitting it doesn't crash the resume path with an
    // invalid ProviderMessage shape.
    const r = messagesToProviderMessages([
      msg('user', 'hi'),
      msg('tool', { something: 'unknown' }),
      msg('assistant', [{ type: 'text', text: 'hi' }]),
    ]);
    expect(r.messages).toHaveLength(2);
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    // droppedFromHead reflects truncation by MAX_RESUME_MESSAGES,
    // not role-skip filtering — those are different concerns.
    expect(r.droppedFromHead).toBe(0);
  });

  test('empty input returns empty messages and droppedFromHead=0', () => {
    expect(messagesToProviderMessages([])).toEqual({ messages: [], droppedFromHead: 0 });
  });

  test('input below the cap is preserved untruncated', () => {
    // Boundary: exactly MAX_RESUME_MESSAGES rows passes through.
    const rows = Array.from({ length: MAX_RESUME_MESSAGES }, (_, i) => msg('user', `msg ${i}`));
    const r = messagesToProviderMessages(rows);
    expect(r.messages).toHaveLength(MAX_RESUME_MESSAGES);
    expect(r.droppedFromHead).toBe(0);
  });

  test('truncates older head when input exceeds the cap', () => {
    // Adversarial case: 700 persisted messages, cap is 500. The
    // older 200 are dropped; we keep the most recent 500. Recency
    // matters more than depth — model context is most useful for
    // what immediately preceded the new turn.
    const total = MAX_RESUME_MESSAGES + 200;
    const rows = Array.from({ length: total }, (_, i) => msg('user', `msg-${i}`));
    const r = messagesToProviderMessages(rows);
    expect(r.messages).toHaveLength(MAX_RESUME_MESSAGES);
    expect(r.droppedFromHead).toBe(200);
    // First kept message is the (200)th original (0-indexed).
    expect(r.messages[0]?.content).toBe('msg-200');
    // Last kept is the (699)th original.
    expect(r.messages[r.messages.length - 1]?.content).toBe(`msg-${total - 1}`);
  });
});
