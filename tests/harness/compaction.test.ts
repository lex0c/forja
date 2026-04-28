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
  test('falls back when the provider throws', async () => {
    const handle = mockProvider(new Error('rate limited'));
    const history = buildHistory(5);
    const result = await compactMessages(handle.provider, history, { preserveTail: 3 });

    expect(result.strategy).toBe('fallback');
    expect(result.reason).toContain('rate limited');
    // Goal preserved + fallback note + middle (with bodies elided) + tail.
    expect(result.messages[0]).toBe(history[0]);
    expect(result.messages.slice(-3)).toEqual(history.slice(-3));
    // Middle messages should still be present (not just a single
    // summary), with tool_result bodies replaced by pointers.
    const fallbackNote = result.messages[1];
    if (typeof fallbackNote?.content === 'string') {
      expect(fallbackNote.content).toContain('deterministic-fallback');
      expect(fallbackNote.content).toContain('rate limited');
    }
    // Find a tool_result inside the elided middle; its content should be
    // a pointer string, not the original body.
    const middleStart = 2; // after goal + fallback note
    const middleEnd = result.messages.length - 3;
    for (let i = middleStart; i < middleEnd; i++) {
      const m = result.messages[i];
      if (typeof m?.content === 'string') continue;
      for (const block of m?.content ?? []) {
        if (block.type === 'tool_result') {
          expect(block.content).toContain('elided');
          expect(block.content).not.toContain('file contents step');
        }
      }
    }
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
