import { describe, expect, test } from 'bun:test';
import { compactMessages } from '../../src/harness/compaction.ts';
import type {
  GenerateRequest,
  Provider,
  ProviderMessage,
  StreamEvent,
} from '../../src/providers/index.ts';

const baseCaps: Provider['capabilities'] = {
  tools: 'native',
  cache: false,
  vision: false,
  streaming: true,
  constrained: 'tools',
  context_window: 200_000,
  output_max_tokens: 4096,
  cost_per_1k_input: 0,
  cost_per_1k_output: 0,
  notes: [],
};

interface MockProviderHandle {
  provider: Provider;
  generateCalls: GenerateRequest[];
}

const replyText = function* (text: string): Iterable<StreamEvent> {
  yield { kind: 'start', message_id: 'm' };
  yield { kind: 'text_delta', text };
  yield { kind: 'stop', reason: 'end_turn' };
};

const replyTextWithUsage = (
  text: string,
  usage: { input: number; output: number },
): (() => Iterable<StreamEvent>) =>
  function* (): Iterable<StreamEvent> {
    yield { kind: 'start', message_id: 'm' };
    yield { kind: 'text_delta', text };
    yield {
      kind: 'usage',
      usage: { input: usage.input, output: usage.output, cache_read: 0, cache_creation: 0 },
    };
    yield { kind: 'stop', reason: 'end_turn' };
  };

const mockProvider = (
  reply: ((req: GenerateRequest) => Iterable<StreamEvent>) | Error,
): MockProviderHandle => {
  const generateCalls: GenerateRequest[] = [];
  const provider: Provider = {
    id: 'mock/c',
    family: 'anthropic',
    capabilities: baseCaps,
    async *generate(req) {
      generateCalls.push(req);
      if (reply instanceof Error) throw reply;
      for (const ev of reply(req)) yield ev;
    },
    generateConstrained: () => Promise.reject(new Error('n/a')),
    countTokens: () => Promise.resolve(0),
  };
  return { provider, generateCalls };
};

const buildHistory = (turns: number): ProviderMessage[] => {
  const out: ProviderMessage[] = [{ role: 'user', content: 'Original goal: refactor src/auth.ts' }];
  for (let i = 0; i < turns; i++) {
    out.push({
      role: 'assistant',
      content: [
        { type: 'text', text: `step ${i}: looking at file` },
        { type: 'tool_use', id: `tu${i}`, name: 'read_file', input: { path: 'a.ts' } },
      ],
    });
    out.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `tu${i}`,
          name: 'read_file',
          content: `file contents step ${i}, x10 long`.repeat(10),
        },
      ],
    });
  }
  return out;
};

describe('compactMessages — LLM path', () => {
  test('preserves goal and trailing K turns; replaces middle with summary', async () => {
    const handle = mockProvider(() =>
      replyText(
        '[compacted_history]\nGOAL: refactor auth.ts\nDECISIONS: split helpers\nFILES_TOUCHED: a.ts\nERRORS: (none)\nPENDING: tests\n[/compacted_history]',
      ),
    );
    const history = buildHistory(8); // 1 + 16 = 17 messages
    const result = await compactMessages(handle.provider, history, { preserveTail: 3 });

    expect(result.strategy).toBe('llm');
    // [goal, summary, ...last 3 messages]
    expect(result.messages).toHaveLength(5);
    expect(result.messages[0]).toBe(history[0]);
    expect(result.messages.slice(-3)).toEqual(history.slice(-3));
    // foldedCount = original middle slice length
    expect(result.foldedCount).toBe(history.length - 1 - 3);
    // Summary message carries the canonical markers.
    const summary = result.messages[1];
    expect(summary?.role).toBe('assistant');
    expect(typeof summary?.content).toBe('string');
    if (typeof summary?.content === 'string') {
      expect(summary.content).toContain('[compacted_history]');
      expect(summary.content).toContain('[/compacted_history]');
    }
  });

  test('forces markers when the model omits them', async () => {
    // Model returns plain prose without markers — wrapper must add them
    // so downstream consumers can locate compaction blocks by scan.
    const handle = mockProvider(() => replyText('GOAL: x\nDECISIONS: y'));
    const result = await compactMessages(handle.provider, buildHistory(5), { preserveTail: 3 });
    expect(result.strategy).toBe('llm');
    const summary = result.messages[1];
    if (typeof summary?.content === 'string') {
      expect(summary.content.startsWith('[compacted_history]')).toBe(true);
      expect(summary.content.endsWith('[/compacted_history]')).toBe(true);
    }
  });

  test('summary call sees temperature 0 and the configured maxTokens', async () => {
    const handle = mockProvider(() =>
      replyText('[compacted_history]\nGOAL: x\n[/compacted_history]'),
    );
    await compactMessages(handle.provider, buildHistory(5), {
      preserveTail: 3,
      maxTokens: 256,
    });
    expect(handle.generateCalls).toHaveLength(1);
    const req = handle.generateCalls[0];
    expect(req?.temperature).toBe(0);
    expect(req?.max_tokens).toBe(256);
    // System prompt is the compaction directive, not the run's prompt.
    expect(req?.system).toContain('summarizing a long conversation');
  });

  test('skips when history is shorter than goal + tail', async () => {
    const handle = mockProvider(() => replyText('should not be called'));
    const short = buildHistory(1); // 3 messages: goal + assistant + tool_result
    const result = await compactMessages(handle.provider, short, { preserveTail: 3 });
    expect(result.strategy).toBe('skipped');
    expect(handle.generateCalls).toHaveLength(0);
    expect(result.messages).toEqual(short);
  });

  test('returns usage and usageSeen from the LLM call', async () => {
    // The harness loop folds these into session totals — without
    // them, compacting sessions silently underreport spend.
    const handle = mockProvider(
      replyTextWithUsage('[compacted_history]\nGOAL: x\n[/compacted_history]', {
        input: 250,
        output: 40,
      }),
    );
    const result = await compactMessages(handle.provider, buildHistory(5), { preserveTail: 3 });
    expect(result.strategy).toBe('llm');
    expect(result.usage.input).toBe(250);
    expect(result.usage.output).toBe(40);
    expect(result.usageSeen).toBe(true);
  });

  test('returns usageSeen=false when the LLM call omits usage', async () => {
    const handle = mockProvider(() =>
      replyText('[compacted_history]\nGOAL: x\n[/compacted_history]'),
    );
    const result = await compactMessages(handle.provider, buildHistory(5), { preserveTail: 3 });
    expect(result.strategy).toBe('llm');
    expect(result.usageSeen).toBe(false);
    expect(result.usage).toEqual({ input: 0, output: 0, cache_read: 0, cache_creation: 0 });
  });

  test('default maxTokens is 1024 when not specified', async () => {
    const handle = mockProvider(() =>
      replyText('[compacted_history]\nGOAL: x\n[/compacted_history]'),
    );
    await compactMessages(handle.provider, buildHistory(5), { preserveTail: 3 });
    expect(handle.generateCalls[0]?.max_tokens).toBe(1024);
  });

  test('even preserveTail expands the slice to keep tail starting with user', async () => {
    // After-trigger history is [user, A, U, A, U, A, U] (length 7,
    // ends with user). preserveTail=2 would naively slice to [A, U]
    // — but inserting [goal, summary_assistant, A, U] sends two
    // consecutive assistants to Anthropic, which 400s. Module must
    // expand to slice [U, A, U] (effectively tail=3) so the summary
    // is followed by a user message.
    const handle = mockProvider(() =>
      replyText('[compacted_history]\nGOAL: x\n[/compacted_history]'),
    );
    const history = buildHistory(3); // 1 + 6 = 7 messages
    const result = await compactMessages(handle.provider, history, { preserveTail: 2 });
    expect(result.strategy).toBe('llm');
    // Tail should start with a user message (alternation invariant).
    const tail = result.messages.slice(2);
    expect(tail[0]?.role).toBe('user');
    // Effective tail is 3 (over-preserved by 1 to align). Result:
    // [goal_user, summary_assistant, U, A, U] = 5 messages.
    expect(result.messages).toHaveLength(5);
  });

  test('preserveTail=0 collapses entire history into a summary (no tail)', async () => {
    // The original `slice(-tail)` had a JS quirk: slice(-0) returns
    // the whole array. With preserveTail=0 the result would have
    // duplicated messages. Length-relative slicing fixes it.
    const handle = mockProvider(() =>
      replyText('[compacted_history]\nGOAL: x\n[/compacted_history]'),
    );
    const history = buildHistory(3);
    const result = await compactMessages(handle.provider, history, { preserveTail: 0 });
    expect(result.strategy).toBe('llm');
    // [goal, summary] only — no preserved trailing turns.
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toBe(history[0]);
    expect(result.messages[1]?.role).toBe('assistant');
  });

  test('odd preserveTail keeps user-start alignment without shifting', async () => {
    const handle = mockProvider(() =>
      replyText('[compacted_history]\nGOAL: x\n[/compacted_history]'),
    );
    const history = buildHistory(4); // length 9
    const result = await compactMessages(handle.provider, history, { preserveTail: 3 });
    expect(result.strategy).toBe('llm');
    // [goal, summary, last 3] = 5 messages, no over-preservation.
    expect(result.messages).toHaveLength(5);
    expect(result.messages.slice(-3)).toEqual(history.slice(-3));
  });

  test('wrapSummary tolerates trailing prose around markers (no nested wrap)', async () => {
    // Model returns a perfectly-marked block but with extra text
    // after the close marker. The strict start/end check would have
    // re-wrapped, producing nested markers. The relaxed `includes`
    // check accepts the original.
    const handle = mockProvider(() =>
      replyText('[compacted_history]\nGOAL: x\n[/compacted_history]\n\nNote: best-effort summary.'),
    );
    const result = await compactMessages(handle.provider, buildHistory(5), { preserveTail: 3 });
    const summary = result.messages[1];
    if (typeof summary?.content !== 'string') throw new Error('expected string content');
    // Exactly one open marker and one close marker — no nesting.
    const openCount = summary.content.split('[compacted_history]').length - 1;
    const closeCount = summary.content.split('[/compacted_history]').length - 1;
    expect(openCount).toBe(1);
    expect(closeCount).toBe(1);
  });
});

describe('compactMessages — deterministic fallback', () => {
  test('falls back when the provider throws — preserves middle with elided bodies', async () => {
    const handle = mockProvider(new Error('rate limited'));
    const history = buildHistory(5);
    const result = await compactMessages(handle.provider, history, { preserveTail: 3 });

    expect(result.strategy).toBe('fallback');
    expect(result.reason).toContain('rate limited');
    // Goal preserved + middle (with bodies elided) + tail. NO synthetic
    // note inserted — that would put an assistant-role message right
    // after the goal_user, immediately followed by the middle's first
    // assistant turn (two consecutive assistants → wire-level break).
    expect(result.messages[0]).toBe(history[0]);
    expect(result.messages.slice(-3)).toEqual(history.slice(-3));
    // Middle messages should still be present (not just a single
    // summary), with tool_result bodies replaced by pointers.
    const middleStart = 1; // immediately after the goal
    const middleEnd = result.messages.length - 3;
    let foundElidedToolResult = false;
    for (let i = middleStart; i < middleEnd; i++) {
      const m = result.messages[i];
      if (typeof m?.content === 'string') continue;
      for (const block of m?.content ?? []) {
        if (block.type === 'tool_result') {
          expect(block.content).toContain('elided');
          expect(block.content).not.toContain('file contents step');
          foundElidedToolResult = true;
        }
      }
    }
    expect(foundElidedToolResult).toBe(true);
  });

  test('fallback path preserves user/assistant alternation (no consecutive same-role)', async () => {
    // Regression: an earlier version inserted a synthetic
    // assistant-role note between goal and the elided middle, which
    // sat next to middle[0] (also assistant) — OpenAI Chat
    // Completions rejects consecutive assistant messages with 400,
    // and Anthropic warns against the pattern. Defense: scan the
    // returned messages and ensure no two adjacent share a role.
    const handle = mockProvider(new Error('rate limited'));
    const result = await compactMessages(handle.provider, buildHistory(5), { preserveTail: 3 });
    expect(result.strategy).toBe('fallback');
    for (let i = 1; i < result.messages.length; i++) {
      expect(result.messages[i]?.role).not.toBe(result.messages[i - 1]?.role);
    }
  });

  test('llm path preserves user/assistant alternation (no consecutive same-role)', async () => {
    // Same regression check on the happy path. The summary message
    // is assistant-role; it must sit between goal_user and a
    // user-starting tail (the alignment shift handles even
    // preserveTail values to keep this invariant).
    const handle = mockProvider(() =>
      replyText('[compacted_history]\nGOAL: x\n[/compacted_history]'),
    );
    const result = await compactMessages(handle.provider, buildHistory(5), { preserveTail: 3 });
    expect(result.strategy).toBe('llm');
    for (let i = 1; i < result.messages.length; i++) {
      expect(result.messages[i]?.role).not.toBe(result.messages[i - 1]?.role);
    }
  });

  test('fallback path preserves any partial usage seen before stream errors', async () => {
    // Some providers emit usage events even when the stream
    // ultimately errors. The compaction call may have been billed
    // for those tokens — return them so the caller folds the cost.
    const handle = mockProvider(function* (): Iterable<StreamEvent> {
      yield { kind: 'start', message_id: 'm' };
      yield {
        kind: 'usage',
        usage: { input: 200, output: 0, cache_read: 0, cache_creation: 0 },
      };
      yield {
        kind: 'error',
        code: 'tool_args_parse_error',
        message: 'malformed',
        retryable: false,
      };
      yield { kind: 'stop', reason: 'end_turn' };
    });
    const result = await compactMessages(handle.provider, buildHistory(5), { preserveTail: 3 });
    expect(result.strategy).toBe('fallback');
    expect(result.usageSeen).toBe(true);
    expect(result.usage.input).toBe(200);
  });

  test('fallback truncates long string-content messages (text-heavy chat)', async () => {
    // Regression: the prior fallback only elided tool_result blocks.
    // A chat-heavy session with few tool calls would sail through
    // unchanged — same context size, same 400 on the next call.
    // Spec ORCHESTRATION §4.6 step 6: head+tail truncate with size
    // pointer when bodies-only drop isn't enough.
    const handle = mockProvider(new Error('rate limited'));
    const longText = 'a'.repeat(5000);
    const history: ProviderMessage[] = [
      { role: 'user', content: 'goal' },
      { role: 'assistant', content: longText },
      { role: 'user', content: 'follow-up' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'final' },
    ];
    const result = await compactMessages(handle.provider, history, { preserveTail: 3 });
    expect(result.strategy).toBe('fallback');
    // The long middle assistant message should be truncated, not
    // returned verbatim.
    const middle = result.messages[1];
    expect(middle?.role).toBe('assistant');
    const middleContent =
      typeof middle?.content === 'string' ? middle.content : JSON.stringify(middle?.content);
    expect(middleContent.length).toBeLessThan(longText.length);
    expect(middleContent).toContain('elided');
  });

  test('fallback truncates long text blocks inside structured content', async () => {
    const handle = mockProvider(new Error('rate limited'));
    const longText = 'b'.repeat(5000);
    const history: ProviderMessage[] = [
      { role: 'user', content: 'goal' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: longText },
          { type: 'tool_use', id: 'tu1', name: 'echo', input: { x: 1 } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', name: 'echo', content: 'ok' }],
      },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'final' },
    ];
    const result = await compactMessages(handle.provider, history, { preserveTail: 3 });
    expect(result.strategy).toBe('fallback');
    const middle = result.messages[1];
    if (Array.isArray(middle?.content)) {
      const textBlock = middle.content.find((b) => b.type === 'text');
      if (textBlock?.type === 'text') {
        expect(textBlock.text.length).toBeLessThan(longText.length);
        expect(textBlock.text).toContain('elided');
      }
      // tool_use args preserved verbatim — the next turn might
      // reference the tool_use_id.
      const toolUseBlock = middle.content.find((b) => b.type === 'tool_use');
      if (toolUseBlock?.type === 'tool_use') {
        expect(toolUseBlock.input).toEqual({ x: 1 });
      }
    }
  });

  test('fallback leaves short text untouched', async () => {
    // Threshold guard: messages below the truncate cutoff stay
    // verbatim, so short conversations don't get unnecessarily
    // mangled.
    const handle = mockProvider(new Error('rate limited'));
    const short = 'short content';
    const history: ProviderMessage[] = [
      { role: 'user', content: 'goal' },
      { role: 'assistant', content: short },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    const result = await compactMessages(handle.provider, history, { preserveTail: 3 });
    expect(result.strategy).toBe('fallback');
    const middle = result.messages[1];
    expect(middle?.content).toBe(short);
  });

  test('skipped path returns zero usage and usageSeen=false', async () => {
    const handle = mockProvider(() => replyText('not called'));
    const short = buildHistory(1);
    const result = await compactMessages(handle.provider, short, { preserveTail: 3 });
    expect(result.strategy).toBe('skipped');
    expect(result.usage).toEqual({ input: 0, output: 0, cache_read: 0, cache_creation: 0 });
    expect(result.usageSeen).toBe(false);
  });

  test('falls back when the stream yields only errors', async () => {
    const handle = mockProvider(function* (): Iterable<StreamEvent> {
      yield { kind: 'start', message_id: 'm' };
      yield {
        kind: 'error',
        code: 'tool_args_parse_error',
        message: 'malformed',
        retryable: false,
      };
      yield { kind: 'stop', reason: 'end_turn' };
    });
    const result = await compactMessages(handle.provider, buildHistory(5), { preserveTail: 3 });
    expect(result.strategy).toBe('fallback');
    expect(result.reason).toContain('compaction stream errored');
  });

  test('falls back when the stream yields no text', async () => {
    const handle = mockProvider(function* (): Iterable<StreamEvent> {
      yield { kind: 'start', message_id: 'm' };
      yield { kind: 'stop', reason: 'end_turn' };
    });
    const result = await compactMessages(handle.provider, buildHistory(5), { preserveTail: 3 });
    expect(result.strategy).toBe('fallback');
    expect(result.reason).toContain('empty summary');
  });

  test('forwards abort signal through to the provider call', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handle = mockProvider(() => replyText('summary')); // would succeed if not aborted
    const result = await compactMessages(handle.provider, buildHistory(5), {
      preserveTail: 3,
      signal: ctrl.signal,
    });
    // abortableIterable surfaces the abort as a thrown error → fallback.
    expect(result.strategy).toBe('fallback');
  });
});
