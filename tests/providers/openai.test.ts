import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { createOpenAIProvider, openaiPromptCacheKey } from '../../src/providers/openai/index.ts';
import type { RawOpenAIChunk } from '../../src/providers/openai/stream.ts';
import type { GenerateRequest, ProviderToolDef } from '../../src/providers/types.ts';
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

// Non-streaming mock for the constrained path: `create` returns a plain
// response object (choices + usage) instead of a chunk stream.
const mockConstrainedClient = (response: unknown): MockClientHandle => {
  const createCalls: Call[] = [];
  const client = {
    chat: {
      completions: {
        async create(params: unknown) {
          createCalls.push({ params });
          return response;
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

  test('generateConstrained forces the named tool and returns its JSON arguments', async () => {
    const handle = mockConstrainedClient({
      choices: [
        {
          message: {
            tool_calls: [{ function: { name: 'render_output', arguments: '{"ok":true}' } }],
          },
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 30 },
      },
    });
    const provider = createOpenAIProvider('gpt-4o', { client: handle.client });
    const result = await provider.generateConstrained({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 64,
      system: 'be precise',
      output_schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      output_schema_name: 'render_output',
    });
    expect(result.output).toBe('{"ok":true}');
    // input = prompt(100) − cached(30) = 70; cache_read = 30; no cache write.
    expect(result.usage).toEqual({ input: 70, output: 20, cache_read: 30, cache_creation: 0 });
    const params = handle.createCalls[0]?.params as {
      tool_choice?: unknown;
      tools?: Array<{ function?: { name?: string } }>;
    };
    expect(params.tool_choice).toEqual({ type: 'function', function: { name: 'render_output' } });
    expect(params.tools?.[0]?.function?.name).toBe('render_output');
  });

  test('generateConstrained throws with finish_reason when no matching tool_call', async () => {
    const handle = mockConstrainedClient({
      choices: [{ finish_reason: 'length', message: { tool_calls: [] } }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    });
    const provider = createOpenAIProvider('gpt-4o', { client: handle.client });
    await expect(
      provider.generateConstrained({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'x' }],
        max_tokens: 64,
        output_schema: { type: 'object' },
        output_schema_name: 'render_output',
      }),
      // Surfaces the cause (ran out of max_tokens) — not a bare "no tool_call".
    ).rejects.toThrow(/no tool_call for forced tool 'render_output' \(finish_reason=length\)/);
  });

  test('generateConstrained rejects when caller passes extra tools', async () => {
    const handle = mockConstrainedClient({ choices: [], usage: {} });
    const provider = createOpenAIProvider('gpt-4o', { client: handle.client });
    await expect(
      provider.generateConstrained({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'x' }],
        max_tokens: 64,
        output_schema: { type: 'object' },
        output_schema_name: 'render_output',
        tools: [{ name: 'extra', description: 'd', input_schema: { type: 'object' } }],
      }),
    ).rejects.toThrow(/'tools' must be empty/);
    expect(handle.createCalls).toHaveLength(0);
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

  const drain = async (
    provider: ReturnType<typeof createOpenAIProvider>,
    req: Parameters<typeof provider.generate>[0],
  ) => {
    for await (const _ of provider.generate(req)) {
      // drain
    }
  };

  test('uses max_tokens on a non-reasoning model (gpt-4o)', async () => {
    const handle = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const provider = createOpenAIProvider('gpt-4o', { client: handle.client });
    await drain(provider, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 42,
    });
    const params = handle.createCalls[0]?.params as {
      max_tokens?: number;
      max_completion_tokens?: number;
    };
    expect(params.max_tokens).toBe(42);
    expect(params.max_completion_tokens).toBeUndefined();
  });

  // NB: the reasoning-model paths (max_completion_tokens, temperature/top_p
  // stripping) are now exercised via the Responses API, not Chat Completions —
  // gpt-5.x routes to client.responses (see openai-responses.test.ts). The
  // Chat Completions sampling gate / max_completion_tokens handling remains as
  // defensive code but no current model reaches it (reasoning → Responses,
  // gpt-4o → Chat Completions with max_tokens + sampling).

  test('forwards temperature/top_p on a sampling model (gpt-4o)', async () => {
    const handle = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const provider = createOpenAIProvider('gpt-4o', { client: handle.client });
    await drain(provider, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      temperature: 0.5,
      top_p: 0.9,
    });
    const params = handle.createCalls[0]?.params as { temperature?: number; top_p?: number };
    expect(params.temperature).toBe(0.5);
    expect(params.top_p).toBe(0.9);
  });

  test('sets prompt_cache_key on the request (real OpenAI, no custom baseURL)', async () => {
    const handle = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const provider = createOpenAIProvider('gpt-4o', { client: handle.client });
    await drain(provider, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      system: 'be brief',
    });
    const params = handle.createCalls[0]?.params as { prompt_cache_key?: string };
    expect(typeof params.prompt_cache_key).toBe('string');
    expect(params.prompt_cache_key?.length).toBeGreaterThan(0);
  });

  test('omits prompt_cache_key when a custom baseURL is set (compat endpoint)', async () => {
    const handle = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const provider = createOpenAIProvider('gpt-4o', {
      client: handle.client,
      baseURL: 'https://compat.example/v1',
    });
    await drain(provider, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      system: 'be brief',
    });
    const params = handle.createCalls[0]?.params as { prompt_cache_key?: string };
    expect(params.prompt_cache_key).toBeUndefined();
  });

  test('openaiPromptCacheKey is stable for the same prefix and order-independent on tools', () => {
    const tools: ProviderToolDef[] = [
      {
        name: 'a',
        description: 'A',
        input_schema: { type: 'object', properties: { x: {}, y: {} } },
      },
    ];
    const toolsReordered: ProviderToolDef[] = [
      {
        name: 'a',
        description: 'A',
        input_schema: { type: 'object', properties: { y: {}, x: {} } },
      },
    ];
    const base: GenerateRequest = {
      model: 'gpt-4o',
      messages: [],
      max_tokens: 1,
      system: 's',
      tools,
    };
    const k1 = openaiPromptCacheKey(base);
    const k2 = openaiPromptCacheKey({ ...base, tools: toolsReordered });
    expect(k1).toBe(k2); // same prefix, reordered tool-schema keys → same key
    // A different system prompt yields a different key.
    expect(openaiPromptCacheKey({ ...base, system: 'other' })).not.toBe(k1);
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

  test('seed_in_eval=true derives a deterministic seed for the OpenAI request', async () => {
    // OpenAI's `seed` is the canonical reproducibility surface
    // for Chat Completions. When the playbook frontmatter sets
    // sampling.seed_in_eval: true, the harness threads
    // seed_in_eval onto the GenerateRequest; the adapter must
    // translate boolean intent into a numeric seed. Two calls
    // with the same conversation must produce the same seed
    // (replay reproducibility), and a different conversation
    // must produce a different seed (so step N and step N+1
    // within a run don't collapse to the same output).
    const baseReq = {
      model: 'gpt-4o',
      system: 'be brief',
      messages: [{ role: 'user' as const, content: 'q' }],
      max_tokens: 4,
      seed_in_eval: true,
    };
    const handleA = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const providerA = createOpenAIProvider('gpt-4o', { client: handleA.client });
    for await (const _ of providerA.generate(baseReq)) {
      // drain
    }
    const seedA = (handleA.createCalls[0]?.params as Record<string, unknown>).seed;
    expect(typeof seedA).toBe('number');

    // Same request → same seed.
    const handleB = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const providerB = createOpenAIProvider('gpt-4o', { client: handleB.client });
    for await (const _ of providerB.generate(baseReq)) {
      // drain
    }
    const seedB = (handleB.createCalls[0]?.params as Record<string, unknown>).seed;
    expect(seedB).toBe(seedA);

    // Different conversation → different seed.
    const handleC = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const providerC = createOpenAIProvider('gpt-4o', { client: handleC.client });
    for await (const _ of providerC.generate({
      ...baseReq,
      messages: [{ role: 'user' as const, content: 'different prompt' }],
    })) {
      // drain
    }
    const seedC = (handleC.createCalls[0]?.params as Record<string, unknown>).seed;
    expect(seedC).not.toBe(seedA);
  });

  test('seed_in_eval=true varies the seed across steps within a run', async () => {
    // Within a multi-step run the message history grows each
    // step (model emits assistant turn → tools → next user
    // input). The seed MUST differ across steps; otherwise
    // every seeded step samples from the same trajectory and
    // collapses to repetitive outputs. Pin the property here
    // so a future change that, say, hashes only `system` does
    // not silently regress to step-collapse.
    const reqStep1 = {
      model: 'gpt-4o',
      system: 'be brief',
      messages: [{ role: 'user' as const, content: 'q' }],
      max_tokens: 4,
      seed_in_eval: true,
    };
    const reqStep2 = {
      ...reqStep1,
      messages: [
        { role: 'user' as const, content: 'q' },
        { role: 'assistant' as const, content: 'first answer' },
        { role: 'user' as const, content: 'follow up' },
      ],
    };
    const handle1 = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const provider1 = createOpenAIProvider('gpt-4o', { client: handle1.client });
    for await (const _ of provider1.generate(reqStep1)) {
      // drain
    }
    const seed1 = (handle1.createCalls[0]?.params as Record<string, unknown>).seed;

    const handle2 = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const provider2 = createOpenAIProvider('gpt-4o', { client: handle2.client });
    for await (const _ of provider2.generate(reqStep2)) {
      // drain
    }
    const seed2 = (handle2.createCalls[0]?.params as Record<string, unknown>).seed;

    expect(seed2).not.toBe(seed1);
  });

  test('derived seed lands inside the int32 range (no overflow)', async () => {
    // Gemini's seed is documented int32 (max 2^31 - 1). The
    // derivation lives in shared seed.ts but the consequence
    // surfaces here — pin that the value the OpenAI adapter
    // emits is also a valid int32 so nobody downcasts the
    // helper to uint32 by mistake.
    const handle = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const provider = createOpenAIProvider('gpt-4o', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'gpt-4o',
      messages: [{ role: 'user' as const, content: 'q' }],
      max_tokens: 4,
      seed_in_eval: true,
    })) {
      // drain
    }
    const seed = (handle.createCalls[0]?.params as Record<string, unknown>).seed as number;
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(-2_147_483_648);
    expect(seed).toBeLessThanOrEqual(2_147_483_647);
  });

  test('seed_in_eval omitted leaves the seed param absent', async () => {
    // Counterpart pin: without the flag, the adapter must NOT
    // synthesize a seed — the model is free to use its own
    // sampling. Refusing to default a seed is the right shape
    // because non-eval requests should not be silently pinned
    // to a deterministic trajectory.
    const handle = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const provider = createOpenAIProvider('gpt-4o', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'q' }],
      max_tokens: 4,
    })) {
      // drain
    }
    const params = handle.createCalls[0]?.params as Record<string, unknown>;
    expect(params.seed).toBeUndefined();
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

  test('FORJA_OPENAI_INCLUDE_USAGE=0 disables stream_options when no option passed', async () => {
    // The CLI bootstrap calls entry.factory() with no options, so the
    // adapter must consult the env var for users on broken compat
    // endpoints who can't change code. Recognized falsy values (0,
    // false, no, off; case-insensitive) opt out.
    const original = process.env.FORJA_OPENAI_INCLUDE_USAGE;
    process.env.FORJA_OPENAI_INCLUDE_USAGE = '0';
    try {
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
      expect(params.stream_options).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.FORJA_OPENAI_INCLUDE_USAGE;
      else process.env.FORJA_OPENAI_INCLUDE_USAGE = original;
    }
  });

  test('FORJA_OPENAI_INCLUDE_USAGE=false also disables (case-insensitive)', async () => {
    const original = process.env.FORJA_OPENAI_INCLUDE_USAGE;
    process.env.FORJA_OPENAI_INCLUDE_USAGE = 'False';
    try {
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
      expect(params.stream_options).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.FORJA_OPENAI_INCLUDE_USAGE;
      else process.env.FORJA_OPENAI_INCLUDE_USAGE = original;
    }
  });

  test('explicit includeUsage option overrides the env var', async () => {
    // If both are set, the option wins. Lets a programmatic caller
    // force-enable telemetry even on a host where the operator opted
    // out at the env level (and vice versa).
    const original = process.env.FORJA_OPENAI_INCLUDE_USAGE;
    process.env.FORJA_OPENAI_INCLUDE_USAGE = '0';
    try {
      const handle = mockClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
      const provider = createOpenAIProvider('gpt-4o', {
        client: handle.client,
        includeUsage: true,
      });
      for await (const _ of provider.generate({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      })) {
        // drain
      }
      const params = handle.createCalls[0]?.params as Record<string, unknown>;
      expect(params.stream_options).toEqual({ include_usage: true });
    } finally {
      if (original === undefined) delete process.env.FORJA_OPENAI_INCLUDE_USAGE;
      else process.env.FORJA_OPENAI_INCLUDE_USAGE = original;
    }
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
