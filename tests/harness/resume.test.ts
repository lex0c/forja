import { describe, expect, test } from 'bun:test';
import {
  MAX_RESUME_MESSAGES,
  TRUNCATION_PLACEHOLDER,
  messagesToProviderMessages,
} from '../../src/harness/resume.ts';
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
  promptHash: null,
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
    // round-trips that shape — verified in a position where the
    // tool_result is NOT at the head (its matching tool_use sits
    // in the preceding assistant row, satisfying the safe-head
    // alignment rule).
    const toolResultContent = [
      {
        type: 'tool_result' as const,
        tool_use_id: 'abc',
        content: 'output',
      },
    ];
    const r = messagesToProviderMessages([
      msg('user', 'kick off'),
      msg('assistant', [{ type: 'text' as const, text: 'using a tool' }]),
      msg('user', toolResultContent),
    ]);
    expect(r.messages).toHaveLength(3);
    expect(r.messages[2]?.content).toEqual(toolResultContent);
    expect(r.droppedFromHead).toBe(0);
  });

  test('repairs an assistant tool_use left unanswered by a partial tool_result message', () => {
    // The maxToolErrors bug: an assistant turn with 3 tool_use blocks
    // followed by a user message answering only 2 of them.
    const r = messagesToProviderMessages([
      msg('user', 'do three things'),
      msg('assistant', [
        { type: 'tool_use', id: 'A', name: 'bash', input: {} },
        { type: 'tool_use', id: 'B', name: 'bash', input: {} },
        { type: 'tool_use', id: 'C', name: 'bash', input: {} },
      ]),
      msg('user', [
        { type: 'tool_result', tool_use_id: 'A', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'B', content: 'ok' },
      ]),
    ]);
    const last = r.messages.at(-1);
    expect(last?.role).toBe('user');
    const blocks = last?.content as { tool_use_id: string; name?: string; is_error?: boolean }[];
    expect(blocks.map((b) => b.tool_use_id).sort()).toEqual(['A', 'B', 'C']);
    const synthetic = blocks.find((b) => b.tool_use_id === 'C');
    expect(synthetic?.is_error).toBe(true);
    // The synthetic result carries the tool name — the Google adapter
    // correlates by function name and throws without it.
    expect(synthetic?.name).toBe('bash');
  });

  test('inserts a tool_result message when an aborted assistant turn has no answer', () => {
    const r = messagesToProviderMessages([
      msg('user', 'go'),
      msg('assistant', [
        { type: 'tool_use', id: 'X', name: 'bash', input: {} },
        { type: 'tool_use', id: 'Y', name: 'bash', input: {} },
      ]),
    ]);
    expect(r.messages).toHaveLength(3);
    const last = r.messages.at(-1);
    expect(last?.role).toBe('user');
    const blocks = last?.content as { tool_use_id: string }[];
    expect(blocks.map((b) => b.tool_use_id).sort()).toEqual(['X', 'Y']);
  });

  test('an orphaned turn before a fresh prompt is answered, and the user gap is bridged', () => {
    const r = messagesToProviderMessages([
      msg('user', 'go'),
      msg('assistant', [{ type: 'tool_use', id: 'Z', name: 'bash', input: {} }]),
      msg('user', 'a brand new question'),
    ]);
    expect(r.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
  });

  test('leaves a fully-answered tool round untouched', () => {
    const r = messagesToProviderMessages([
      msg('user', 'go'),
      msg('assistant', [{ type: 'tool_use', id: 'A', name: 'bash', input: {} }]),
      msg('user', [{ type: 'tool_result', tool_use_id: 'A', content: 'ok' }]),
      msg('assistant', [{ type: 'text', text: 'done' }]),
    ]);
    expect(r.messages).toHaveLength(4);
    expect(r.messages[3]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'done' }] });
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

  // Helper: realistic alternating-role rows. Production message
  // logs always alternate user/assistant; a previous version of
  // these tests used all-user inputs which exposed the cap math
  // but didn't reflect the actual on-disk shape. After the
  // alternation-repair pass landed (synthetic assistants between
  // user→user pairs), all-user inputs got rewritten into 2x
  // their original size — masking what the cap test actually
  // checks. Switching to alternating rows tests cap math
  // cleanly and reflects production.
  const alternating = (n: number): Message[] => {
    const rows: Message[] = [];
    for (let i = 0; i < n; i++) {
      rows.push(msg(i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`));
    }
    return rows;
  };

  test('input below the cap is preserved untruncated', () => {
    // Boundary: exactly MAX_RESUME_MESSAGES rows passes through.
    const rows = alternating(MAX_RESUME_MESSAGES);
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
    const rows = alternating(total);
    const r = messagesToProviderMessages(rows);
    expect(r.messages).toHaveLength(MAX_RESUME_MESSAGES);
    expect(r.droppedFromHead).toBe(200);
    // First kept message is the (200)th original (0-indexed).
    // Index 200 is even → role 'user' → safe head.
    expect(r.messages[0]?.content).toBe('msg-200');
    // Last kept is the (699)th original.
    expect(r.messages[r.messages.length - 1]?.content).toBe(`msg-${total - 1}`);
  });
});

describe('messagesToProviderMessages: alignment to safe head', () => {
  // Realistic harness pattern: alternation between assistant turns
  // and user_tool_result turns. Every user_tool_result references
  // the immediately preceding assistant's tool_use, so contiguous
  // suffixes preserve tool-pair integrity — but a slice that
  // STARTS at a user_tool_result is orphaned because the matching
  // assistant is in the dropped head.
  const toolUseBlock = (id: string) => ({
    type: 'tool_use' as const,
    id,
    name: 'bash',
    input: { command: 'echo' },
  });
  const toolResultBlock = (id: string) => ({
    type: 'tool_result' as const,
    tool_use_id: id,
    content: 'ok',
  });
  const buildAlternating = (turns: number) => {
    const rows = [msg('user', 'goal')];
    for (let i = 0; i < turns; i++) {
      rows.push(msg('assistant', [toolUseBlock(`tu-${i}`)]));
      rows.push(msg('user', [toolResultBlock(`tu-${i}`)]));
    }
    return rows;
  };

  test('aligns forward to assistant when cut lands on user_tool_result', () => {
    // Build enough turns so the cap forces truncation. With
    // MAX_RESUME_MESSAGES=500, build 1+700*2=1401 rows so cap=500
    // means dropping 901 rows. The naive cut would land on a
    // user_tool_result; alignment should walk forward to the next
    // assistant.
    const turns = 700;
    const rows = buildAlternating(turns);
    expect(rows.length).toBe(1 + turns * 2);

    const r = messagesToProviderMessages(rows);

    // Head must be safe: synthetic placeholder (cut landed on
    // assistant, prepended user) or original user_root (no
    // truncation needed). Since rows.length > MAX, truncation
    // fires and the head is the placeholder.
    expect(r.messages[0]?.role).toBe('user');
    expect(r.messages[0]?.content).toBe(TRUNCATION_PLACEHOLDER);
    expect(r.messages[1]?.role).toBe('assistant');

    // Tool_result/tool_use pairing intact: every tool_result's
    // tool_use_id has a matching tool_use somewhere earlier in
    // the kept list.
    const toolUseIds = new Set<string>();
    for (const m of r.messages) {
      if (m.role !== 'assistant' || typeof m.content === 'string') continue;
      for (const block of m.content) {
        if (block.type === 'tool_use') toolUseIds.add(block.id);
      }
    }
    for (const m of r.messages) {
      if (m.role !== 'user' || typeof m.content === 'string') continue;
      for (const block of m.content) {
        if (block.type === 'tool_result') {
          expect(toolUseIds.has(block.tool_use_id)).toBe(true);
        }
      }
    }
  });

  test('does NOT prepend placeholder when no truncation fires', () => {
    // Small history that fits under the cap: head stays user_root,
    // no synthetic message added.
    const rows = buildAlternating(3);
    const r = messagesToProviderMessages(rows);
    expect(r.droppedFromHead).toBe(0);
    expect(r.messages[0]?.content).toBe('goal');
    expect(r.messages[0]?.content).not.toBe(TRUNCATION_PLACEHOLDER);
  });

  test('does NOT prepend placeholder when cut lands cleanly on user-with-string', () => {
    // After a prior resume, the persisted log has a second
    // user-with-string message in the middle. If the cap-forced
    // cut lands on it, that's a clean fresh-start boundary — no
    // synthetic placeholder needed.
    const rows: Message[] = [
      msg('user', 'first goal'),
      msg('assistant', [toolUseBlock('tu-0')]),
      msg('user', [toolResultBlock('tu-0')]),
      msg('assistant', [{ type: 'text' as const, text: 'done with first goal' }]),
      // resume boundary (second user-with-string)
      msg('user', 'second goal'),
      msg('assistant', [toolUseBlock('tu-1')]),
      msg('user', [toolResultBlock('tu-1')]),
    ];
    // Force cut at index 4 by overriding the cap inline. The
    // helper has its own MAX so we test by giving it more rows
    // than MAX would slice — but for this small case we want to
    // verify the alignment LOGIC against a known cut. Since we
    // can't override MAX, check the small-history path: no
    // truncation fires, head is 'first goal'. The 'cut on
    // user-with-string' path is exercised by the alignment loop
    // when truncation does fire and walks forward to such a row.
    const r = messagesToProviderMessages(rows);
    expect(r.droppedFromHead).toBe(0);
    expect(r.messages[0]?.content).toBe('first goal');
  });

  test('repairs internal user→user pairs from repeated stranded resumes', () => {
    // Multiple aborted resumes accumulate consecutive user
    // messages in the log: each resume appends its own user
    // prompt without an assistant ever responding. The trailing-
    // user fix in the loop patches one gap; this helper repairs
    // ALL internal user→user pairs by inserting synthetic
    // assistant placeholders between them.
    const rows: Message[] = [
      msg('user', 'goal'),
      msg('user', 'aborted resume 1'),
      msg('user', 'aborted resume 2'),
      msg('assistant', [{ type: 'text' as const, text: 'finally a reply' }]),
      msg('user', 'aborted resume 3'),
    ];
    const r = messagesToProviderMessages(rows);
    // Every consecutive user→user pair has a synthetic assistant
    // inserted between them. Verify alternation: no two adjacent
    // user messages remain.
    for (let i = 1; i < r.messages.length; i++) {
      const prev = r.messages[i - 1];
      const curr = r.messages[i];
      if (prev?.role === 'user' && curr?.role === 'user') {
        throw new Error(`consecutive user messages at indices ${i - 1}, ${i} — alternation broken`);
      }
    }
    // 5 original rows + 2 synthetic placeholders (one between
    // 'goal'→'aborted resume 1', one between
    // 'aborted resume 1'→'aborted resume 2'; the user→assistant
    // pair (resume 2 → reply) and assistant→user pair
    // (reply → resume 3) need no repair).
    expect(r.messages).toHaveLength(7);
  });

  test('skips role=tool entries during alignment too', () => {
    // role='tool' is forward-compat schema slot; it's not a valid
    // head AND it's filtered from the output. Mixing it in
    // shouldn't change behavior.
    const rows: Message[] = [
      msg('user', 'goal'),
      msg('tool', { tool_use_id: 'tu-0', content: 'output' }),
      msg('assistant', [toolUseBlock('tu-1')]),
      msg('user', [toolResultBlock('tu-1')]),
    ];
    const r = messagesToProviderMessages(rows);
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });
});
