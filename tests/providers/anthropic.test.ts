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
    expect(provider.capabilities.cost_per_1k_input).toBe(1.0);
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

  test('rejects thinking_budget >= max_tokens before leaving the binary', async () => {
    // Anthropic 400s on thinking_budget >= max_tokens. The
    // loader-side gate (`subagents/load.ts`) only catches the
    // case where BOTH values are explicitly declared in playbook
    // frontmatter — when a playbook sets only `thinking_budget`,
    // the runtime resolver picks `capabilities.output_max_tokens`
    // for `max_tokens`, and a small-cap model can produce a pair
    // where budget >= cap. This adapter check is where that
    // runtime-resolved pair gets validated; the mock client must
    // NOT be reached when the cross-check fires.
    const handle = mockClient([{ type: 'message_stop' }]);
    const provider = createAnthropicProvider('claude-sonnet-4-6', { client: handle.client });
    const drain = async () => {
      for await (const _ of provider.generate({
        model: 'claude-sonnet-4-6',
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
    const provider = createAnthropicProvider('claude-sonnet-4-6', { client: handle.client });
    const drain = async () => {
      for await (const _ of provider.generate({
        model: 'claude-sonnet-4-6',
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
    const provider = createAnthropicProvider('claude-sonnet-4-6', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8000,
      thinking_budget: 4000,
    })) {
      // drain
    }
    expect(handle.streamCalls).toHaveLength(1);
    const params = handle.streamCalls[0]?.params as Record<string, unknown>;
    const thinking = params.thinking as { type: string; budget_tokens: number };
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
