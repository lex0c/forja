import { describe, expect, test } from 'bun:test';
import { messagesToProviderMessages } from '../../src/harness/resume.ts';
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
    expect(r).toHaveLength(3);
    expect(r[0]).toEqual({ role: 'user', content: 'hello' });
    expect(r[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'hi back' }] });
    expect(r[2]).toEqual({ role: 'user', content: 'follow up' });
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
    expect(r[0]?.content).toEqual(toolResultContent);
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
    expect(r).toHaveLength(2);
    expect(r.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  test('empty input returns empty array', () => {
    expect(messagesToProviderMessages([])).toEqual([]);
  });
});
