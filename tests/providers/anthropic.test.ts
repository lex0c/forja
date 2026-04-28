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

interface MockClientHandle {
  client: Anthropic;
  streamCalls: StreamCall[];
  countTokensCalls: CountTokensCall[];
}

const mockClient = (
  events: RawAnthropicEvent[],
  countTokensResponse: { input_tokens: number } = { input_tokens: 0 },
): MockClientHandle => {
  const streamCalls: StreamCall[] = [];
  const countTokensCalls: CountTokensCall[] = [];
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
    },
  } as unknown as Anthropic;
  return { client, streamCalls, countTokensCalls };
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
    expect(provider.capabilities.cost_per_1k_input).toBe(0.25);
  });

  test('generateConstrained rejects with not-implemented error in M1', async () => {
    const provider = createAnthropicProvider('claude-sonnet-4-6', { apiKey: 'sk-test' });
    await expect(
      provider.generateConstrained({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        output_schema: { type: 'object' },
      }),
    ).rejects.toThrow(/not implemented in M1/);
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
    expect(events).toEqual([
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
    expect(params.system).toBe('you are concise');
    expect(params.temperature).toBe(0.2);
    expect(params.stop_sequences).toEqual(['END']);
    const tools = params.tools as { name: string }[];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('read_file');
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
