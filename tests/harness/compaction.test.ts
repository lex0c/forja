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
  test('merges summary into the goal message and preserves trailing turn(s)', async () => {
    const handle = mockProvider(() =>
      replyText(
        '[compacted_history]\nGOAL: refactor auth.ts\nDECISIONS: split helpers\nFILES_TOUCHED: a.ts\nERRORS: (none)\nPENDING: tests\n[/compacted_history]',
      ),
    );
    const history = buildHistory(8); // 1 + 16 = 17 messages
    const result = await compactMessages(handle.provider, history, { preserveTail: 3 });

    expect(result.strategy).toBe('llm');
    // The summary is merged into a new user-role goal message; the
    // tail follows starting with an assistant. Two consecutive
    // user messages (Anthropic 400) and orphan tool_results
    // (provider 400) are both prevented this way.
    const wrapped = result.messages[0];
    expect(wrapped?.role).toBe('user');
    expect(typeof wrapped?.content).toBe('string');
    if (typeof wrapped?.content === 'string') {
      // Original goal text is preserved literally inside the wrap.
      expect(wrapped.content).toContain('Original goal');
      // Summary block follows with markers intact.
      expect(wrapped.content).toContain('[compacted_history]');
      expect(wrapped.content).toContain('[/compacted_history]');
    }
    // Tail starts with assistant — keeps tool_use → tool_result
    // pairs intact (the user_tool_result that follows references
    // the tool_use in this assistant message).
    expect(result.messages[1]?.role).toBe('assistant');
    // foldedCount is positive (something was actually folded).
    expect(result.foldedCount).toBeGreaterThan(0);
  });

  test('forces markers when the model omits them', async () => {
    const handle = mockProvider(() => replyText('GOAL: x\nDECISIONS: y'));
    const result = await compactMessages(handle.provider, buildHistory(5), { preserveTail: 3 });
    expect(result.strategy).toBe('llm');
    const wrapped = result.messages[0];
    if (typeof wrapped?.content === 'string') {
      expect(wrapped.content).toContain('[compacted_history]');
      expect(wrapped.content).toContain('[/compacted_history]');
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

  test('tail always starts at an assistant boundary (preserves tool_use/tool_result pairs)', async () => {
    // Regression for orphan-tool_result: the tail must include the
    // assistant message that emitted the tool_use referenced by any
    // user_tool_result in the tail. Naively slicing at length-N can
    // land on a user_tool_result whose matching tool_use ended up
    // in the middle (folded into the summary), producing a 400 from
    // the provider on the next call.
    const handle = mockProvider(() =>
      replyText('[compacted_history]\nGOAL: x\n[/compacted_history]'),
    );
    // length 7: [user, A0, U0, A1, U1, A2, U2]. preserveTail=2
    // naively lands on index 5 (A2, assistant) — happens to be
    // correct without shift. preserveTail=3 lands on index 4 (U1,
    // user) and SHOULD shift to index 3 (A1) so U1's tool_use
    // (in A1) is preserved.
    const history = buildHistory(3);
    const r2 = await compactMessages(handle.provider, history, { preserveTail: 2 });
    expect(r2.messages[1]?.role).toBe('assistant');

    const r3 = await compactMessages(handle.provider, buildHistory(3), { preserveTail: 3 });
    expect(r3.messages[1]?.role).toBe('assistant');
    // Verify the preserved assistant emits the tool_use that
    // the next user_tool_result references.
    const firstTailAssistant = r3.messages[1];
    const nextTailUser = r3.messages[2];
    if (Array.isArray(firstTailAssistant?.content) && Array.isArray(nextTailUser?.content)) {
      const tool_use = firstTailAssistant.content.find((b) => b.type === 'tool_use');
      const tool_result = nextTailUser.content.find((b) => b.type === 'tool_result');
      if (tool_use?.type === 'tool_use' && tool_result?.type === 'tool_result') {
        expect(tool_result.tool_use_id).toBe(tool_use.id);
      }
    }
  });

  test('preserveTail=0 collapses entire history into the wrapped goal (no tail)', async () => {
    // With preserveTail=0 the alignment walks tailStart back from
    // length-0 (=length) to the nearest assistant. Middle is
    // everything between goal and that assistant. Result is just
    // the wrapped goal — no tail to preserve.
    const handle = mockProvider(() =>
      replyText('[compacted_history]\nGOAL: x\n[/compacted_history]'),
    );
    const history = buildHistory(3);
    const result = await compactMessages(handle.provider, history, { preserveTail: 0 });
    expect(result.strategy).toBe('llm');
    // Result depends on where the alignment lands; in this case the
    // last assistant is at index length-2 (A2) since the history
    // ends with user_tool_result. The tail is just that assistant.
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.messages[0]?.role).toBe('user');
    // Markers preserved on the wrapped goal.
    const goalContent = result.messages[0]?.content;
    if (typeof goalContent === 'string') {
      expect(goalContent).toContain('[compacted_history]');
    }
  });

  test('successive compactions do not accumulate prior summary blocks (cumulative growth bug)', async () => {
    // Regression: the wrap previously appended a new summary on
    // every compaction without removing any prior one. After three
    // compactions the goal would carry three summary blocks plus
    // their re-quoted contents inside each. The fix strips prior
    // blocks before re-wrapping so messages[0] is always
    // `original_goal\n\n[latest summary]`.
    const handle = mockProvider(() =>
      replyText('[compacted_history]\nGOAL: refactor\n[/compacted_history]'),
    );
    // Simulate a session that's already been compacted once: the
    // goal carries an old summary block.
    const history: ProviderMessage[] = [
      {
        role: 'user',
        content:
          'Original goal: refactor src/auth.ts\n\n[compacted_history]\nGOAL: refactor\nDECISIONS: prior\n[/compacted_history]',
      },
      ...buildHistory(5).slice(1),
    ];
    const result = await compactMessages(handle.provider, history, { preserveTail: 3 });
    expect(result.strategy).toBe('llm');
    const wrapped = result.messages[0];
    if (typeof wrapped?.content !== 'string') throw new Error('expected string');
    // Exactly one block — the LATEST. No accumulated prior blocks.
    const openCount = wrapped.content.split('[compacted_history]').length - 1;
    expect(openCount).toBe(1);
    // Original goal text is still preserved literally.
    expect(wrapped.content).toContain('Original goal: refactor src/auth.ts');
    // Old "DECISIONS: prior" body must NOT survive (it was inside
    // the stripped block).
    expect(wrapped.content).not.toContain('DECISIONS: prior');
  });

  test('summary text is sanitized of ANSI escapes before reaching context', async () => {
    // Defense in depth: even though the compaction provider is
    // ours, a hijacked or buggy proxy could inject control bytes.
    // The sanitization invariant says no escapes reach the model
    // context — applies to compaction summaries too.
    const handle = mockProvider(() =>
      replyText('[compacted_history]\nGOAL: \x1b[31mscrub\x1b[0m me\n[/compacted_history]'),
    );
    const result = await compactMessages(handle.provider, buildHistory(5), { preserveTail: 3 });
    expect(result.strategy).toBe('llm');
    const wrapped = result.messages[0];
    if (typeof wrapped?.content !== 'string') throw new Error('expected string');
    expect(wrapped.content).not.toContain('\x1b');
    expect(wrapped.content).toContain('scrub me');
  });

  test('wrapSummary tolerates trailing prose around markers (no nested wrap)', async () => {
    const handle = mockProvider(() =>
      replyText('[compacted_history]\nGOAL: x\n[/compacted_history]\n\nNote: best-effort summary.'),
    );
    const result = await compactMessages(handle.provider, buildHistory(5), { preserveTail: 3 });
    const wrapped = result.messages[0];
    if (typeof wrapped?.content !== 'string') throw new Error('expected string content');
    // Exactly one open marker and one close marker — no nesting.
    const openCount = wrapped.content.split('[compacted_history]').length - 1;
    const closeCount = wrapped.content.split('[/compacted_history]').length - 1;
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
    // Goal preserved by reference (fallback doesn't wrap with a
    // summary — there isn't one). Middle elided in-place, tail
    // (starting at assistant boundary) preserved literally.
    expect(result.messages[0]).toBe(history[0]);
    // Middle messages should still be present (not collapsed to
    // a single summary), with tool_result bodies replaced by
    // pointers.
    let foundElidedToolResult = false;
    for (let i = 1; i < result.messages.length; i++) {
      const m = result.messages[i];
      if (typeof m?.content === 'string') continue;
      for (const block of m?.content ?? []) {
        if (block.type === 'tool_result') {
          if (block.content.includes('elided')) {
            foundElidedToolResult = true;
          }
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
    // pointer when bodies-only drop isn't enough. The long
    // assistant text must land in the MIDDLE for fallbackCompact
    // to touch it; with assistant-boundary tail alignment that
    // means we need history long enough that the long message
    // sits before the preserved tail.
    const handle = mockProvider(new Error('rate limited'));
    const longText = 'a'.repeat(5000);
    const history: ProviderMessage[] = [
      { role: 'user', content: 'goal' }, // 0
      { role: 'assistant', content: longText }, // 1 — middle
      { role: 'user', content: 'b' }, // 2 — middle
      { role: 'assistant', content: 'c' }, // 3 — tail starts here
      { role: 'user', content: 'd' }, // 4
      { role: 'assistant', content: 'e' }, // 5
      { role: 'user', content: 'f' }, // 6
    ];
    const result = await compactMessages(handle.provider, history, { preserveTail: 3 });
    expect(result.strategy).toBe('fallback');
    // The long assistant message is in the middle and should be
    // truncated; find it by scanning all post-goal messages.
    const truncatedAssistant = result.messages
      .slice(1)
      .find((m) => typeof m.content === 'string' && m.content.includes('elided'));
    expect(truncatedAssistant).toBeDefined();
    if (truncatedAssistant && typeof truncatedAssistant.content === 'string') {
      expect(truncatedAssistant.content.length).toBeLessThan(longText.length);
    }
  });

  test('fallback truncates long text blocks inside structured content', async () => {
    const handle = mockProvider(new Error('rate limited'));
    const longText = 'b'.repeat(5000);
    const history: ProviderMessage[] = [
      { role: 'user', content: 'goal' }, // 0
      {
        // 1 — middle
        role: 'assistant',
        content: [
          { type: 'text', text: longText },
          { type: 'tool_use', id: 'tu1', name: 'echo', input: { x: 1 } },
        ],
      },
      {
        // 2 — middle
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', name: 'echo', content: 'ok' }],
      },
      { role: 'assistant', content: 'A' }, // 3 — tail starts
      { role: 'user', content: 'B' },
      { role: 'assistant', content: 'C' },
      { role: 'user', content: 'D' },
    ];
    const result = await compactMessages(handle.provider, history, { preserveTail: 3 });
    expect(result.strategy).toBe('fallback');
    // Find the structured-content message in middle.
    const structured = result.messages.find(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'text'),
    );
    expect(structured).toBeDefined();
    if (structured && Array.isArray(structured.content)) {
      const textBlock = structured.content.find((b) => b.type === 'text');
      if (textBlock?.type === 'text') {
        expect(textBlock.text.length).toBeLessThan(longText.length);
        expect(textBlock.text).toContain('elided');
      }
      // tool_use args preserved verbatim — the next turn might
      // reference the tool_use_id.
      const toolUseBlock = structured.content.find((b) => b.type === 'tool_use');
      if (toolUseBlock?.type === 'tool_use') {
        expect(toolUseBlock.input).toEqual({ x: 1 });
      }
    }
  });

  test('fallback leaves short text untouched', async () => {
    // Threshold guard: messages below the truncate cutoff stay
    // verbatim, so short conversations don't get unnecessarily
    // mangled. Short message lands in the middle (post-goal,
    // pre-tail) so fallbackCompact would touch it if it were
    // long enough.
    const handle = mockProvider(new Error('rate limited'));
    const short = 'short content';
    const history: ProviderMessage[] = [
      { role: 'user', content: 'goal' }, // 0
      { role: 'assistant', content: short }, // 1 — middle
      { role: 'user', content: 'a' }, // 2 — middle
      { role: 'assistant', content: 'b' }, // 3 — tail
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
      { role: 'user', content: 'e' },
    ];
    const result = await compactMessages(handle.provider, history, { preserveTail: 3 });
    expect(result.strategy).toBe('fallback');
    // The short content survives unchanged in its position.
    const shortStill = result.messages.find((m) => m.content === short);
    expect(shortStill).toBeDefined();
  });

  test('fallback path preserves partial usage when collectStep throws (CollectStepError)', async () => {
    // Regression: when the compaction summary stream emits a usage
    // event and then throws (disconnect mid-response), collectStep
    // wraps the partial in CollectStepError. compactMessages must
    // unpack and surface that usage so the harness charges for the
    // billed tokens; previously the partial was discarded and the
    // fallback reported usageSeen=false / zero usage.
    const handle = mockProvider(function* (): Iterable<StreamEvent> {
      yield { kind: 'start', message_id: 'm' };
      yield { kind: 'text_delta', text: '[compacted_history]\nGOAL:' };
      yield {
        kind: 'usage',
        usage: { input: 250, output: 30, cache_read: 10, cache_creation: 0 },
      };
      throw new Error('connection reset');
    });
    const result = await compactMessages(handle.provider, buildHistory(5), { preserveTail: 3 });
    expect(result.strategy).toBe('fallback');
    expect(result.usageSeen).toBe(true);
    expect(result.usage.input).toBe(250);
    expect(result.usage.output).toBe(30);
    expect(result.usage.cache_read).toBe(10);
    expect(result.reason).toContain('connection reset');
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
