import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { createAnthropicProvider } from '../../src/providers/anthropic/index.ts';
import type { RawAnthropicEvent } from '../../src/providers/anthropic/stream.ts';
import type { StreamEvent } from '../../src/providers/types.ts';

interface StreamCall {
  params: unknown;
}

interface CountTokensCall {
  params: unknown;
}

interface CreateCall {
  params: unknown;
}

interface MockMessageResponse {
  content: Array<
    { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }
  >;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

interface MockClientHandle {
  client: Anthropic;
  streamCalls: StreamCall[];
  countTokensCalls: CountTokensCall[];
  createCalls: CreateCall[];
}

const mockClient = (
  events: RawAnthropicEvent[],
  countTokensResponse: { input_tokens: number } = { input_tokens: 0 },
  createResponse:
    | MockMessageResponse
    | (() => MockMessageResponse | Promise<MockMessageResponse>) = {
    content: [],
    usage: { input_tokens: 0, output_tokens: 0 },
  },
): MockClientHandle => {
  const streamCalls: StreamCall[] = [];
  const countTokensCalls: CountTokensCall[] = [];
  const createCalls: CreateCall[] = [];
  const client = {
    messages: {
      stream(params: unknown) {
        streamCalls.push({ params });
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
      async countTokens(params: unknown) {
        countTokensCalls.push({ params });
        return countTokensResponse;
      },
      async create(params: unknown) {
        createCalls.push({ params });
        return typeof createResponse === 'function' ? await createResponse() : createResponse;
      },
    },
  } as unknown as Anthropic;
  return { client, streamCalls, countTokensCalls, createCalls };
};

describe('createAnthropicProvider', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  test('refuses unknown model name', () => {
    expect(() => createAnthropicProvider('claude-fake', { apiKey: 'sk-test' })).toThrow(
      /unknown Anthropic model/,
    );
  });

  test('throws when no API key is available', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => createAnthropicProvider('claude-sonnet-4-6')).toThrow(/API key required/);
  });

  test('reads ANTHROPIC_API_KEY from env when no apiKey option', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env';
    expect(() => createAnthropicProvider('claude-sonnet-4-6')).not.toThrow();
  });

  test('exposes canonical id and family', () => {
    const provider = createAnthropicProvider('claude-sonnet-4-6', { apiKey: 'sk-test' });
    expect(provider.id).toBe('anthropic/claude-sonnet-4-6');
    expect(provider.family).toBe('anthropic');
  });

  test('exposes capabilities matching the registry table', () => {
    const provider = createAnthropicProvider('claude-haiku-4-5', { apiKey: 'sk-test' });
    expect(provider.capabilities.tools).toBe('native');
    expect(provider.capabilities.cache).toBe('server_5min');
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.vision).toBe(true);
    expect(provider.capabilities.constrained).toBe('tools');
    expect(provider.capabilities.context_window).toBe(200_000);
    expect(provider.capabilities.cost_per_1k_input).toBe(1.0);
  });

  test('generateConstrained forces tool_choice and returns stringified tool_use input', async () => {
    const handle = mockClient([], undefined, {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'render_recap_pr',
          input: { summary: ['did stuff'], changes: [], test_plan: [], notes: [] },
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 30,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
      },
    });
    const provider = createAnthropicProvider('claude-haiku-4-5', { client: handle.client });
    const result = await provider.generateConstrained({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'render this' }],
      max_tokens: 256,
      output_schema: { type: 'object', properties: {} },
      output_schema_name: 'render_recap_pr',
      output_schema_description: 'Render a recap as a PR description.',
    });
    expect(result.output).toBe(
      JSON.stringify({ summary: ['did stuff'], changes: [], test_plan: [], notes: [] }),
    );
    expect(result.usage).toEqual({
      input: 100,
      output: 30,
      cache_read: 50,
      cache_creation: 10,
    });
    expect(handle.createCalls).toHaveLength(1);
    const sent = handle.createCalls[0]?.params as {
      tool_choice: { type: string; name: string };
      tools: Array<{ name: string; input_schema: unknown }>;
    };
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'render_recap_pr' });
    expect(sent.tools[0]?.name).toBe('render_recap_pr');
  });

  test('generateConstrained rejects when caller passes extra tools', async () => {
    const handle = mockClient([]);
    const provider = createAnthropicProvider('claude-haiku-4-5', { client: handle.client });
    await expect(
      provider.generateConstrained({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'x' }],
        max_tokens: 64,
        output_schema: { type: 'object' },
        output_schema_name: 'render_recap_pr',
        tools: [{ name: 'extra', description: 'd', input_schema: { type: 'object' } }],
      }),
    ).rejects.toThrow(/'tools' must be empty/);
    expect(handle.createCalls).toHaveLength(0);
  });

  test('generateConstrained throws when response has no matching tool_use', async () => {
    const handle = mockClient([], undefined, {
      content: [{ type: 'text', text: 'sorry, plain prose' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = createAnthropicProvider('claude-haiku-4-5', { client: handle.client });
    await expect(
      provider.generateConstrained({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'x' }],
        max_tokens: 64,
        output_schema: { type: 'object' },
        output_schema_name: 'render_recap_pr',
      }),
    ).rejects.toThrow(/no tool_use for forced tool 'render_recap_pr'/);
  });

  test('generateConstrained zero-fills missing cache_* usage fields', async () => {
    const handle = mockClient([], undefined, {
      content: [{ type: 'tool_use', id: 't1', name: 'render_recap_pr', input: {} }],
      usage: { input_tokens: 5, output_tokens: 1 }, // no cache_* fields
    });
    const provider = createAnthropicProvider('claude-haiku-4-5', { client: handle.client });
    const result = await provider.generateConstrained({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 64,
      output_schema: { type: 'object' },
      output_schema_name: 'render_recap_pr',
    });
    expect(result.usage.cache_read).toBe(0);
    expect(result.usage.cache_creation).toBe(0);
  });

  test('generate pipes the SDK stream through the canonical normalizer', async () => {
    const handle = mockClient([
      { type: 'message_start', message: { id: 'mock_msg' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]);
    const provider = createAnthropicProvider('claude-sonnet-4-6', { client: handle.client });
    const events: StreamEvent[] = [];
    for await (const ev of provider.generate({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
    })) {
      events.push(ev);
    }
    expect(events.filter((e) => e.kind !== 'usage')).toEqual([
      { kind: 'start', message_id: 'mock_msg' },
      { kind: 'text_delta', text: 'hi' },
      { kind: 'stop', reason: 'end_turn' },
    ]);
    expect(handle.streamCalls).toHaveLength(1);
  });

  test('generate forwards model, max_tokens, system, tools to the SDK', async () => {
    const handle = mockClient([{ type: 'message_stop' }]);
    const provider = createAnthropicProvider('claude-sonnet-4-6', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'do thing' }],
      max_tokens: 16,
      system: 'you are concise',
      tools: [
        {
          name: 'read_file',
          description: 'read a file',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
      temperature: 0.2,
      stop_sequences: ['END'],
    })) {
      // drain
    }
    const params = handle.streamCalls[0]?.params as Record<string, unknown>;
    expect(params).toBeDefined();
    expect(params.model).toBe('claude-sonnet-4-6');
    expect(params.max_tokens).toBe(16);
    // System is wrapped into a TextBlockParam[] (single block) so
    // cache_control can attach. The text payload round-trips
    // unchanged.
    const systemBlocks = params.system as Array<{ type: string; text: string }>;
    expect(systemBlocks).toHaveLength(1);
    expect(systemBlocks[0]?.type).toBe('text');
    expect(systemBlocks[0]?.text).toBe('you are concise');
    expect(params.temperature).toBe(0.2);
    expect(params.stop_sequences).toEqual(['END']);
    const tools = params.tools as { name: string }[];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('read_file');
  });

  test('generate anchors cache breakpoints on system, last tool, and tail message', async () => {
    // Three breakpoints land per the layout in
    // src/providers/anthropic/cache.ts. This test pins the wire
    // shape so a regression in cache wiring (forgotten attach,
    // accidental over-marking) shows up here, not as silent cost
    // bloat in production.
    const handle = mockClient([{ type: 'message_stop' }]);
    const provider = createAnthropicProvider('claude-sonnet-4-6', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'first turn' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second turn' },
      ],
      max_tokens: 8,
      system: 'agent contract',
      tools: [
        {
          name: 'grep',
          description: 'g',
          input_schema: { type: 'object', properties: {} },
        },
        {
          name: 'read_file',
          description: 'r',
          input_schema: { type: 'object', properties: {} },
        },
      ],
    })) {
      // drain
    }
    const params = handle.streamCalls[0]?.params as Record<string, unknown>;
    // System breakpoint: cache_control on the (only) text block.
    const systemBlocks = params.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    expect(systemBlocks[0]?.cache_control).toEqual({ type: 'ephemeral' });
    // Tools breakpoint: cache_control attaches ONLY to the last
    // tool. Earlier tools share the same cache by virtue of being
    // in the prefix.
    const tools = params.tools as Array<{ name: string; cache_control?: { type: string } }>;
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.cache_control).toEqual({ type: 'ephemeral' });
    // Tail message breakpoint: only the LAST message is anchored.
    // String content gets expanded into a TextBlockParam so the
    // marker has somewhere to attach; earlier messages stay as
    // strings.
    const messages = params.messages as Array<{
      role: string;
      content: string | Array<{ type: string; text?: string; cache_control?: { type: string } }>;
    }>;
    expect(typeof messages[0]?.content).toBe('string');
    expect(typeof messages[1]?.content).toBe('string');
    const tailBlocks = messages[2]?.content as Array<{
      text: string;
      cache_control?: { type: string };
    }>;
    expect(tailBlocks[0]?.text).toBe('second turn');
    expect(tailBlocks[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('generate strips temperature/top_p when supports_sampling=false (Opus 4.7)', async () => {
    // Regression: Opus 4.7 deprecated `temperature` (and `top_p`)
    // at the Messages API — passing either returns HTTP 400
    // ("`temperature` is deprecated for this model."). Without
    // the per-model gate every workflow that follows TOKEN_TUNING
    // §9 (recap LLM render and others) would 400 on this model.
    // Cap is `supports_sampling: false` for Opus 4.7; adapter
    // strips both params before send. Sampling-accepting models
    // (sonnet/haiku) keep forwarding them — covered above.
    const handle = mockClient([{ type: 'message_stop' }]);
    const provider = createAnthropicProvider('claude-opus-4-7', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'do thing' }],
      max_tokens: 16,
      temperature: 0.2,
      top_p: 0.95,
    })) {
      // drain
    }
    const params = handle.streamCalls[0]?.params as Record<string, unknown>;
    expect(params).toBeDefined();
    expect('temperature' in params).toBe(false);
    expect('top_p' in params).toBe(false);
  });

  test('generateConstrained strips temperature/top_p when supports_sampling=false (Opus 4.7)', async () => {
    // Same gate on the constrained path — recap's LLM render
    // would 400 against Opus 4.7 without it.
    const handle = mockClient([], undefined, {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'render_recap_pr',
          input: { schemaVersion: 'pr-v1', summary: ['x'], changes: [] },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = createAnthropicProvider('claude-opus-4-7', { client: handle.client });
    await provider.generateConstrained({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'render' }],
      max_tokens: 64,
      temperature: 0.2,
      top_p: 0.95,
      output_schema: { type: 'object' },
      output_schema_name: 'render_recap_pr',
    });
    const sent = handle.createCalls[0]?.params as Record<string, unknown>;
    expect(sent).toBeDefined();
    expect('temperature' in sent).toBe(false);
    expect('top_p' in sent).toBe(false);
  });

  test('generate sends only temperature when BOTH temperature and top_p are set', async () => {
    // Regression (found via real Haiku eval of recap LLM render):
    // current Anthropic models accept sampling but reject
    // `temperature` and `top_p` TOGETHER — HTTP 400 "`temperature`
    // and `top_p` cannot both be specified for this model". recap's
    // TOKEN_TUNING §9 sampling sets both, so every recap LLM render
    // 400'd and silently fell back to deterministic. The adapter now
    // forwards temperature only (Anthropic's recommended single
    // knob); top_p is dropped.
    const handle = mockClient([{ type: 'message_stop' }]);
    const provider = createAnthropicProvider('claude-haiku-4-5', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'do thing' }],
      max_tokens: 16,
      temperature: 0.2,
      top_p: 0.95,
    })) {
      // drain
    }
    const params = handle.streamCalls[0]?.params as Record<string, unknown>;
    expect(params.temperature).toBe(0.2);
    expect('top_p' in params).toBe(false);
  });

  test('generateConstrained sends only temperature when BOTH are set', async () => {
    const handle = mockClient([], undefined, {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'render_recap_pr',
          input: { schemaVersion: 'pr-v1', summary: ['x'], changes: [] },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = createAnthropicProvider('claude-haiku-4-5', { client: handle.client });
    await provider.generateConstrained({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'render' }],
      max_tokens: 64,
      temperature: 0.2,
      top_p: 0.95,
      output_schema: { type: 'object' },
      output_schema_name: 'render_recap_pr',
    });
    const sent = handle.createCalls[0]?.params as Record<string, unknown>;
    expect(sent.temperature).toBe(0.2);
    expect('top_p' in sent).toBe(false);
  });

  test('generate forwards top_p alone when temperature is absent', async () => {
    // The drop rule is "at most one"; a caller that sets only top_p
    // still gets it through.
    const handle = mockClient([{ type: 'message_stop' }]);
    const provider = createAnthropicProvider('claude-haiku-4-5', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'do thing' }],
      max_tokens: 16,
      top_p: 0.9,
    })) {
      // drain
    }
    const params = handle.streamCalls[0]?.params as Record<string, unknown>;
    expect(params.top_p).toBe(0.9);
    expect('temperature' in params).toBe(false);
  });

  test('generate omits optional fields that were not provided', async () => {
    const handle = mockClient([{ type: 'message_stop' }]);
    const provider = createAnthropicProvider('claude-sonnet-4-6', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    })) {
      // drain
    }
    const params = handle.streamCalls[0]?.params as Record<string, unknown>;
    expect(params).toBeDefined();
    expect('system' in params).toBe(false);
    expect('tools' in params).toBe(false);
    expect('temperature' in params).toBe(false);
    expect('stop_sequences' in params).toBe(false);
  });

  test('forwards xhigh effort on a model that supports it (opus-4-8)', async () => {
    const handle = mockClient([{ type: 'message_stop' }]);
    const provider = createAnthropicProvider('claude-opus-4-8', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
      effort: 'xhigh',
    })) {
      // drain
    }
    const params = handle.streamCalls[0]?.params as { output_config?: { effort?: string } };
    expect(params.output_config?.effort).toBe('xhigh');
  });

  test('clamps xhigh effort to high on a model that lacks it (sonnet-4-6)', async () => {
    const handle = mockClient([{ type: 'message_stop' }]);
    const provider = createAnthropicProvider('claude-sonnet-4-6', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
      effort: 'xhigh',
    })) {
      // drain
    }
    const params = handle.streamCalls[0]?.params as { output_config?: { effort?: string } };
    expect(params.output_config?.effort).toBe('high');
  });

  describe('reasoning replay (Phase 2, FORJA_ANTHROPIC_REASONING_REPLAY)', () => {
    const withReplay = async (on: boolean, fn: () => Promise<void>): Promise<void> => {
      const prev = process.env.FORJA_ANTHROPIC_REASONING_REPLAY;
      if (on) process.env.FORJA_ANTHROPIC_REASONING_REPLAY = '1';
      else delete process.env.FORJA_ANTHROPIC_REASONING_REPLAY;
      try {
        await fn();
      } finally {
        if (prev === undefined) delete process.env.FORJA_ANTHROPIC_REASONING_REPLAY;
        else process.env.FORJA_ANTHROPIC_REASONING_REPLAY = prev;
      }
    };

    const assistantWithReasoning = {
      role: 'assistant' as const,
      content: [
        {
          type: 'reasoning' as const,
          provider: 'anthropic' as const,
          data: { thinking: 'pondering', signature: 'SIGBYTES' },
        },
        { type: 'text' as const, text: 'answer' },
        // Foreign-tagged: must be dropped regardless of flag.
        { type: 'reasoning' as const, provider: 'openai' as const, data: { foo: 1 } },
      ],
    };

    test('off (default): reasoning blocks are dropped from messages', async () => {
      await withReplay(false, async () => {
        const handle = mockClient([{ type: 'message_stop' }]);
        const provider = createAnthropicProvider('claude-sonnet-4-6', { client: handle.client });
        for await (const _ of provider.generate({
          model: 'claude-sonnet-4-6',
          max_tokens: 16,
          messages: [assistantWithReasoning, { role: 'user', content: 'go' }],
        })) {
          // drain
        }
        const params = handle.streamCalls[0]?.params as {
          messages: Array<{ content: Array<{ type: string }> }>;
        };
        expect(params.messages[0]?.content.map((b) => b.type)).toEqual(['text']);
      });
    });

    test('on: anthropic reasoning replays as a signed thinking block first; foreign dropped', async () => {
      await withReplay(true, async () => {
        const handle = mockClient([{ type: 'message_stop' }]);
        const provider = createAnthropicProvider('claude-sonnet-4-6', { client: handle.client });
        for await (const _ of provider.generate({
          model: 'claude-sonnet-4-6',
          max_tokens: 16,
          messages: [assistantWithReasoning, { role: 'user', content: 'go' }],
        })) {
          // drain
        }
        const params = handle.streamCalls[0]?.params as {
          messages: Array<{
            content: Array<{ type: string; thinking?: string; signature?: string }>;
          }>;
        };
        const blocks = params.messages[0]?.content ?? [];
        // thinking first (contract), text after, openai reasoning dropped.
        expect(blocks.map((b) => b.type)).toEqual(['thinking', 'text']);
        // signature round-trips byte-identical.
        expect(blocks[0]).toEqual({
          type: 'thinking',
          thinking: 'pondering',
          signature: 'SIGBYTES',
        });
      });
    });

    test('on: lifts the thinking suppression gate on tool-bearing turns', async () => {
      await withReplay(true, async () => {
        const handle = mockClient([{ type: 'message_stop' }]);
        const provider = createAnthropicProvider('claude-sonnet-4-6', { client: handle.client });
        for await (const _ of provider.generate({
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 4096,
          thinking_budget: 1000,
          tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
        })) {
          // drain
        }
        const params = handle.streamCalls[0]?.params as Record<string, unknown>;
        expect('thinking' in params).toBe(true);
      });
    });

    test('on: strips sampling when thinking is engaged (Sonnet accepts both → 400 otherwise)', async () => {
      // Sonnet 4.6 is adaptive AND accepts sampling; Anthropic rejects
      // thinking + temperature/top_p together. With replay on + a thinking_budget
      // + a configured temperature (an eval's default temperature:0), thinking is
      // sent — so temperature/top_p MUST be dropped or the request 400s.
      await withReplay(true, async () => {
        const handle = mockClient([{ type: 'message_stop' }]);
        const provider = createAnthropicProvider('claude-sonnet-4-6', { client: handle.client });
        for await (const _ of provider.generate({
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 4096,
          thinking_budget: 1000,
          temperature: 0,
          top_p: 0.9,
          tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
        })) {
          // drain
        }
        const params = handle.streamCalls[0]?.params as Record<string, unknown>;
        expect('thinking' in params).toBe(true);
        expect('temperature' in params).toBe(false);
        expect('top_p' in params).toBe(false);
      });
    });

    test('off (default): thinking stays suppressed on tool-bearing turns', async () => {
      await withReplay(false, async () => {
        const handle = mockClient([{ type: 'message_stop' }]);
        const provider = createAnthropicProvider('claude-sonnet-4-6', { client: handle.client });
        for await (const _ of provider.generate({
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 4096,
          thinking_budget: 1000,
          tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
        })) {
          // drain
        }
        const params = handle.streamCalls[0]?.params as Record<string, unknown>;
        expect('thinking' in params).toBe(false);
      });
    });

    test('on: redacted_thinking replays as a native redacted_thinking block', async () => {
      await withReplay(true, async () => {
        const handle = mockClient([{ type: 'message_stop' }]);
        const provider = createAnthropicProvider('claude-sonnet-4-6', { client: handle.client });
        for await (const _ of provider.generate({
          model: 'claude-sonnet-4-6',
          max_tokens: 16,
          messages: [
            {
              role: 'assistant',
              content: [
                { type: 'reasoning', provider: 'anthropic', data: { redacted_thinking: 'ENC' } },
                { type: 'text', text: 'a' },
              ],
            },
            { role: 'user', content: 'go' },
          ],
        })) {
          // drain
        }
        const params = handle.streamCalls[0]?.params as {
          messages: Array<{ content: Array<{ type: string; data?: string }> }>;
        };
        expect(params.messages[0]?.content?.[0]).toEqual({
          type: 'redacted_thinking',
          data: 'ENC',
        });
      });
    });

    test('gated off for non-adaptive models even when the flag is on (haiku)', async () => {
      await withReplay(true, async () => {
        const handle = mockClient([{ type: 'message_stop' }]);
        const provider = createAnthropicProvider('claude-haiku-4-5', { client: handle.client });
        for await (const _ of provider.generate({
          model: 'claude-haiku-4-5',
          max_tokens: 16,
          messages: [assistantWithReasoning, { role: 'user', content: 'go' }],
        })) {
          // drain
        }
        // Haiku is non-adaptive → replay gated off → reasoning dropped.
        const params = handle.streamCalls[0]?.params as {
          messages: Array<{ content: Array<{ type: string }> }>;
        };
        expect((params.messages[0]?.content ?? []).map((b) => b.type)).toEqual(['text']);
      });
    });
  });

  test('rejects thinking_budget >= max_tokens before leaving the binary', async () => {
    // Anthropic 400s on thinking_budget >= max_tokens. The
    // loader-side gate (`subagents/load.ts`) only catches the
    // case where BOTH values are explicitly declared in playbook
    // frontmatter — when a playbook sets only `thinking_budget`,
    // the runtime resolver picks `capabilities.output_max_tokens`
    // for `max_tokens`, and a small-cap model can produce a pair
    // where budget >= cap. This adapter check is where that
    // runtime-resolved pair gets validated; the mock client must
    // NOT be reached when the cross-check fires. Uses a LEGACY
    // (non-adaptive) model on purpose: adaptive models route
    // thinking through `type:'adaptive'` and drop budget_tokens, so
    // the cross-check is skipped there (see anthropic-effort.test.ts).
    const handle = mockClient([{ type: 'message_stop' }]);
    const provider = createAnthropicProvider('claude-haiku-4-5', { client: handle.client });
    const drain = async () => {
      for await (const _ of provider.generate({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 4096,
        thinking_budget: 10_000,
      })) {
        // drain
      }
    };
    await expect(drain()).rejects.toThrow(
      /'thinking_budget' \(10000\) must be strictly less than 'max_tokens' \(4096\)/,
    );
    // The SDK was never called — the throw fires at request build
    // time, before the cache helpers and stream open.
    expect(handle.streamCalls).toHaveLength(0);
  });

  test('thinking_budget equal to max_tokens is rejected (strict <)', async () => {
    // The 400 contract is strict less-than; equality also fails.
    // A regression that switched the operator to `>` would let
    // equal pass the check and surface as the same 400 we wanted
    // to prevent — pin the comparison.
    const handle = mockClient([{ type: 'message_stop' }]);
    const provider = createAnthropicProvider('claude-haiku-4-5', { client: handle.client });
    const drain = async () => {
      for await (const _ of provider.generate({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 8000,
        thinking_budget: 8000,
      })) {
        // drain
      }
    };
    await expect(drain()).rejects.toThrow(/must be strictly less than/);
  });

  test('thinking_budget < max_tokens passes the check and reaches the SDK', async () => {
    // Positive case for the runtime cross-check. Without an
    // explicit "valid budget gets through" test, the negative
    // tests above only confirm the throw path; a regression that
    // unconditionally threw would still pass them. Existing tests
    // ("generate forwards model, max_tokens, ..." etc) provide
    // implicit coverage by not setting thinking_budget at all,
    // but transitive confidence is weaker than direct.
    const handle = mockClient([{ type: 'message_stop' }]);
    const provider = createAnthropicProvider('claude-haiku-4-5', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8000,
      thinking_budget: 4000,
    })) {
      // drain
    }
    expect(handle.streamCalls).toHaveLength(1);
    const params = handle.streamCalls[0]?.params as Record<string, unknown>;
    const thinking = params.thinking as { type: string; budget_tokens: number };
    // Legacy (non-adaptive) model keeps the manual enabled+budget path.
    expect(thinking).toEqual({ type: 'enabled', budget_tokens: 4000 });
    expect(params.max_tokens).toBe(8000);
  });

  test('thinking_budget=0 (disable idiom) skips the check', async () => {
    // PLAYBOOKS.md §1.1 declares budget=0 as the disable idiom —
    // the adapter omits the thinking block entirely. The check
    // must not trip on it (any max_tokens > 0 satisfies a "0 <
    // max_tokens" test, but the > 0 gate exists to make the
    // intent explicit and survives a future refactor that
    // changes how the disable signal flows).
    const handle = mockClient([{ type: 'message_stop' }]);
    const provider = createAnthropicProvider('claude-sonnet-4-6', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
      thinking_budget: 0,
    })) {
      // drain
    }
    expect(handle.streamCalls).toHaveLength(1);
    const params = handle.streamCalls[0]?.params as Record<string, unknown>;
    expect('thinking' in params).toBe(false);
  });

  test('thinking is suppressed when tools are present (signature round-trip not implemented)', async () => {
    // Anthropic requires the thinking-block signature to be replayed with the
    // next turn's tool_result; Forja can't round-trip it yet, so a
    // tool-bearing turn must NOT engage thinking — even with a budget set.
    const handle = mockClient([{ type: 'message_stop' }]);
    const provider = createAnthropicProvider('claude-sonnet-4-6', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8000,
      thinking_budget: 4000,
      tools: [{ name: 'grep', description: 'g', input_schema: { type: 'object', properties: {} } }],
    })) {
      // drain
    }
    expect(handle.streamCalls).toHaveLength(1);
    const params = handle.streamCalls[0]?.params as Record<string, unknown>;
    expect('thinking' in params).toBe(false);
  });

  test('thinking_budget >= max_tokens does NOT throw when tools are present (budget never sent)', async () => {
    // The budget-vs-max_tokens cross-check pre-empts a real HTTP 400 only on
    // the legacy path that actually SENDS budget_tokens. With tools present
    // thinking is suppressed entirely, so no budget leaves the binary and the
    // pair is never seen by the API — throwing here would reject a valid
    // request. Haiku 4.5 is legacy (no adaptive thinking).
    const handle = mockClient([{ type: 'message_stop' }]);
    const provider = createAnthropicProvider('claude-haiku-4-5', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 4096,
      thinking_budget: 10_000, // >= max_tokens: would throw without the tools guard
      tools: [{ name: 'grep', description: 'g', input_schema: { type: 'object', properties: {} } }],
    })) {
      // drain — must not throw
    }
    expect(handle.streamCalls).toHaveLength(1);
    const params = handle.streamCalls[0]?.params as Record<string, unknown>;
    // Thinking suppressed (tools present); budget never sent.
    expect('thinking' in params).toBe(false);
  });

  test('thinking is engaged on a no-tool turn with the same budget', async () => {
    // Counterpart to the suppression test: with no tools, the identical
    // budget must still turn thinking on — the gate keys on tools, not on
    // disabling thinking outright.
    const handle = mockClient([{ type: 'message_stop' }]);
    const provider = createAnthropicProvider('claude-haiku-4-5', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8000,
      thinking_budget: 4000,
    })) {
      // drain
    }
    const params = handle.streamCalls[0]?.params as Record<string, unknown>;
    expect(params.thinking).toEqual({ type: 'enabled', budget_tokens: 4000 });
  });

  test('countTokens returns the SDK input_tokens value', async () => {
    const handle = mockClient([], { input_tokens: 137 });
    const provider = createAnthropicProvider('claude-haiku-4-5', { client: handle.client });
    const tokens = await provider.countTokens([{ role: 'user', content: 'hello' }]);
    expect(tokens).toBe(137);
    expect(handle.countTokensCalls).toHaveLength(1);
    const params = handle.countTokensCalls[0]?.params as Record<string, unknown>;
    expect(params.model).toBe('claude-haiku-4-5');
    expect(params.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
});

describe('createAnthropicProvider — 1h extended cache flag', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.FORJA_ANTHROPIC_CACHE_TTL;
    delete process.env.FORJA_ANTHROPIC_CACHE_TTL;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.FORJA_ANTHROPIC_CACHE_TTL;
    else process.env.FORJA_ANTHROPIC_CACHE_TTL = original;
  });

  test('default (5m): cache-write rate is the 5-minute tier', () => {
    const p = createAnthropicProvider('claude-opus-4-7', { apiKey: 'sk-test' });
    expect(p.capabilities.cost_per_1k_cache_write).toBe(6.25);
  });

  test('cacheTtl 1h swaps in the 1-hour write rate (so cost stays exact)', () => {
    const p = createAnthropicProvider('claude-opus-4-7', { apiKey: 'sk-test', cacheTtl: '1h' });
    expect(p.capabilities.cost_per_1k_cache_write).toBe(10);
    // The shared ANTHROPIC_CAPS const must stay untouched — a default
    // instance still reports the 5-minute rate.
    const d = createAnthropicProvider('claude-opus-4-7', { apiKey: 'sk-test' });
    expect(d.capabilities.cost_per_1k_cache_write).toBe(6.25);
  });

  test('FORJA_ANTHROPIC_CACHE_TTL=1h opts in without an explicit option', () => {
    process.env.FORJA_ANTHROPIC_CACHE_TTL = '1h';
    const p = createAnthropicProvider('claude-opus-4-7', { apiKey: 'sk-test' });
    expect(p.capabilities.cost_per_1k_cache_write).toBe(10);
  });

  test('1h tags the request cache_control markers with ttl:1h', async () => {
    const handle = mockClient([{ type: 'message_stop' }]);
    const provider = createAnthropicProvider('claude-opus-4-7', {
      client: handle.client,
      cacheTtl: '1h',
    });
    for await (const _ of provider.generate({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
      system: 'concise',
    })) {
      // drain
    }
    const params = handle.streamCalls[0]?.params as { system?: Array<{ cache_control?: unknown }> };
    expect(params.system?.[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  test('default request markers carry no ttl (5-minute)', async () => {
    const handle = mockClient([{ type: 'message_stop' }]);
    const provider = createAnthropicProvider('claude-opus-4-7', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
      system: 'concise',
    })) {
      // drain
    }
    const params = handle.streamCalls[0]?.params as { system?: Array<{ cache_control?: unknown }> };
    expect(params.system?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('1h also tags the generateConstrained request markers (priced TTL == request TTL)', async () => {
    const handle = mockClient([], undefined, {
      content: [{ type: 'tool_use', id: 't1', name: 'render_recap_pr', input: {} }],
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    const provider = createAnthropicProvider('claude-opus-4-7', {
      client: handle.client,
      cacheTtl: '1h',
    });
    await provider.generateConstrained({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 64,
      system: 'concise',
      output_schema: { type: 'object' },
      output_schema_name: 'render_recap_pr',
    });
    const params = handle.createCalls[0]?.params as { system?: Array<{ cache_control?: unknown }> };
    expect(params.system?.[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
});
