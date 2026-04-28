import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { createOpenAIProvider } from '../../src/providers/openai/index.ts';
import type { RawOpenAIChunk } from '../../src/providers/openai/stream.ts';
import type { StreamEvent } from '../../src/providers/types.ts';

interface Call {
  params: unknown;
}

interface MockClientHandle {
  client: OpenAI;
  createCalls: Call[];
}

const mockClient = (chunks: RawOpenAIChunk[]): MockClientHandle => {
  const createCalls: Call[] = [];
  const client = {
    chat: {
      completions: {
        async create(params: unknown) {
          createCalls.push({ params });
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  } as unknown as OpenAI;
  return { client, createCalls };
};

describe('createOpenAIProvider', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  test('refuses unknown model name', () => {
    expect(() => createOpenAIProvider('gpt-fake', { apiKey: 'sk-test' })).toThrow(
      /unknown OpenAI model/,
    );
  });

  test('throws when no API key is available', () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => createOpenAIProvider('gpt-4o-mini')).toThrow(/API key required/);
  });

  test('reads OPENAI_API_KEY from env when no apiKey option', () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    expect(() => createOpenAIProvider('gpt-4o-mini')).not.toThrow();
  });

  test('exposes canonical id, family, and capabilities', () => {
    const provider = createOpenAIProvider('gpt-4o', { apiKey: 'sk-test' });
    expect(provider.id).toBe('openai/gpt-4o');
    expect(provider.family).toBe('openai');
    expect(provider.capabilities.tools).toBe('native');
    expect(provider.capabilities.cache).toBe('client_only');
    expect(provider.capabilities.context_window).toBe(128_000);
  });

  test('generateConstrained rejects with not-implemented error in M1', async () => {
    const provider = createOpenAIProvider('gpt-4o', { apiKey: 'sk-test' });
    await expect(
      provider.generateConstrained({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        output_schema: { type: 'object' },
      }),
    ).rejects.toThrow(/not implemented in M1/);
  });

  test('generate pipes the SDK stream through the canonical normalizer', async () => {
    const handle = mockClient([
      { id: 'cmpl-x', choices: [{ delta: { content: 'hi' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const provider = createOpenAIProvider('gpt-4o', { client: handle.client });
    const events: StreamEvent[] = [];
    for await (const ev of provider.generate({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
    })) {
      events.push(ev);
    }
    expect(events.filter((e) => e.kind !== 'usage')).toEqual([
      { kind: 'start', message_id: 'cmpl-x' },
      { kind: 'text_delta', text: 'hi' },
      { kind: 'stop', reason: 'end_turn' },
    ]);
  });

  test('generate prepends system as the first message', async () => {
    const handle = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const provider = createOpenAIProvider('gpt-4o-mini', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      system: 'be brief',
    })) {
      // drain
    }
    const params = handle.createCalls[0]?.params as {
      messages: Array<{ role: string; content?: string | null }>;
    };
    expect(params.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(params.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  test('generate forwards tools, temperature, stop_sequences, and stream:true', async () => {
    const handle = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const provider = createOpenAIProvider('gpt-4o', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'q' }],
      max_tokens: 16,
      temperature: 0.3,
      stop_sequences: ['END'],
      tools: [
        {
          name: 'read_file',
          description: 'read a file',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    })) {
      // drain
    }
    const params = handle.createCalls[0]?.params as Record<string, unknown>;
    expect(params.stream).toBe(true);
    expect(params.max_tokens).toBe(16);
    expect(params.temperature).toBe(0.3);
    expect(params.stop).toEqual(['END']);
    const tools = params.tools as Array<{
      type: string;
      function: { name: string; parameters: unknown };
    }>;
    expect(tools[0]?.type).toBe('function');
    expect(tools[0]?.function.name).toBe('read_file');
  });

  test('generate sends stream_options.include_usage by default', async () => {
    const handle = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const provider = createOpenAIProvider('gpt-4o', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    })) {
      // drain
    }
    const params = handle.createCalls[0]?.params as Record<string, unknown>;
    expect(params.stream_options).toEqual({ include_usage: true });
  });

  test('includeUsage:false omits stream_options for compatibility endpoints', async () => {
    const handle = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const provider = createOpenAIProvider('gpt-4o', {
      client: handle.client,
      includeUsage: false,
    });
    for await (const _ of provider.generate({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    })) {
      // drain
    }
    const params = handle.createCalls[0]?.params as Record<string, unknown>;
    expect(params.stream_options).toBeUndefined();
  });

  test('assistant message with tool_use blocks becomes a single message + tool_calls', async () => {
    const handle = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const provider = createOpenAIProvider('gpt-4o', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'gpt-4o',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'using read_file' },
            { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: '/x' } },
          ],
        },
      ],
      max_tokens: 1,
    })) {
      // drain
    }
    const params = handle.createCalls[0]?.params as { messages: Array<Record<string, unknown>> };
    expect(params.messages[0]).toEqual({
      role: 'assistant',
      content: 'using read_file',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"/x"}' },
        },
      ],
    });
  });

  test('user message with tool_result blocks splits into tool-role messages', async () => {
    const handle = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const provider = createOpenAIProvider('gpt-4o', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'output' },
            { type: 'tool_result', tool_use_id: 'call_2', content: 'other' },
          ],
        },
      ],
      max_tokens: 1,
    })) {
      // drain
    }
    const params = handle.createCalls[0]?.params as { messages: Array<Record<string, unknown>> };
    expect(params.messages).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'output' },
      { role: 'tool', tool_call_id: 'call_2', content: 'other' },
    ]);
  });

  test('user message with tool_results AND text emits tool_results first, text last', async () => {
    const handle = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const provider = createOpenAIProvider('gpt-4o', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'output_a' },
            { type: 'tool_result', tool_use_id: 'call_2', content: 'output_b' },
            { type: 'text', text: 'now also do X' },
          ],
        },
      ],
      max_tokens: 1,
    })) {
      // drain
    }
    const params = handle.createCalls[0]?.params as { messages: Array<Record<string, unknown>> };
    // Tool results are answers to the prior assistant call; the user's new
    // text follows them. Reversing this order would make the model see a
    // user prompt before its requested tool results.
    expect(params.messages).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'output_a' },
      { role: 'tool', tool_call_id: 'call_2', content: 'output_b' },
      { role: 'user', content: 'now also do X' },
    ]);
  });

  test('tool_result block on an assistant message throws', async () => {
    const handle = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const provider = createOpenAIProvider('gpt-4o', { client: handle.client });
    const stream = provider.generate({
      model: 'gpt-4o',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_result', tool_use_id: 'x', content: 'output' }],
        },
      ],
      max_tokens: 1,
    });
    let err: Error | null = null;
    try {
      for await (const _ of stream) {
        // shouldn't reach
      }
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/tool_result blocks must appear on user/);
  });

  test('tool_use blocks on a non-assistant message throw', async () => {
    const handle = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const provider = createOpenAIProvider('gpt-4o', { client: handle.client });
    const stream = provider.generate({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_use', id: 'x', name: 'foo', input: {} }],
        },
      ],
      max_tokens: 1,
    });
    let err: Error | null = null;
    try {
      for await (const _ of stream) {
        // shouldn't reach
      }
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/tool_use blocks must appear on assistant/);
  });

  test('countTokens uses the chars/4 heuristic', async () => {
    const provider = createOpenAIProvider('gpt-4o', { apiKey: 'sk-test' });
    // 12 chars / 4 = 3
    const tokens = await provider.countTokens([{ role: 'user', content: 'hello world!' }]);
    expect(tokens).toBe(3);
  });

  test('countTokens accounts for tool_use and tool_result blocks', async () => {
    const provider = createOpenAIProvider('gpt-4o', { apiKey: 'sk-test' });
    const tokens = await provider.countTokens([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 'x', name: 'foo', input: { a: 1 } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'x', content: 'result-text' }],
      },
    ]);
    expect(tokens).toBeGreaterThan(0);
  });
});
