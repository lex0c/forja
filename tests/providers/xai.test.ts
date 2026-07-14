import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { computeCost } from '../../src/providers/cost.ts';
import type {
  ConstrainedRequest,
  GenerateRequest,
  ProviderCapabilities,
  StreamEvent,
} from '../../src/providers/types.ts';
import { XAI_CAPS } from '../../src/providers/xai/capabilities.ts';
import { createXaiProvider } from '../../src/providers/xai/index.ts';
import type { RawXaiChunk } from '../../src/providers/xai/stream.ts';

// biome-ignore lint/suspicious/noExplicitAny: test mock body is dynamic.
type Body = Record<string, any>;

const makeClient = (opts: {
  chunks?: RawXaiChunk[];
  response?: unknown;
  onBody?: (b: Body) => void;
  onOptions?: (o: Body | undefined) => void;
}): OpenAI =>
  ({
    chat: {
      completions: {
        create: async (body: Body, options?: Body) => {
          opts.onBody?.(body);
          opts.onOptions?.(options);
          if (body.stream === true) {
            return (async function* () {
              for (const c of opts.chunks ?? []) yield c;
            })();
          }
          return opts.response;
        },
      },
    },
  }) as unknown as OpenAI;

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

const reqGen = (over: Partial<GenerateRequest>): GenerateRequest => ({
  model: 'grok-4.5',
  messages: [],
  max_tokens: 512,
  ...over,
});

const reqCon = (over: Partial<ConstrainedRequest>): ConstrainedRequest => ({
  model: 'grok-4.5',
  messages: [],
  max_tokens: 512,
  output_schema: { type: 'object' },
  output_schema_name: 'out',
  ...over,
});

const textChunks: RawXaiChunk[] = [
  { id: 'm1', choices: [{ delta: { content: 'hi' } }] },
  {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  },
];

describe('createXaiProvider', () => {
  test('throws on an uncatalogued model', () => {
    expect(() => createXaiProvider('nope', { client: makeClient({}) })).toThrow(
      /unknown xAI model/,
    );
  });

  test('throws without an api key or client', () => {
    expect(() => createXaiProvider('grok-4.5')).toThrow(/API key required/);
  });

  test('id, family, native tools, does not replay reasoning', () => {
    const p = createXaiProvider('grok-4.5', { client: makeClient({}) });
    expect(p.id).toBe('xai/grok-4.5');
    expect(p.family).toBe('xai');
    expect(p.capabilities.tools).toBe('native');
    expect(p.replaysReasoning).toBe(false);
  });

  test('costs are per-million tokens (guards the $/1k → $/1M unit)', () => {
    const caps = XAI_CAPS['grok-4.5'];
    expect(caps).toBeDefined();
    if (caps === undefined) return;
    // 1M input tokens should cost the headline input rate ($2.00), not 1000× less.
    const cost = computeCost(caps, {
      input: 1_000_000,
      output: 0,
      cache_read: 0,
      cache_creation: 0,
    });
    expect(cost).toBeCloseTo(2.0, 4);
  });

  test('generate body: stream + max_completion_tokens + include_usage + flat reasoning_effort', async () => {
    let body: Body = {};
    const p = createXaiProvider('grok-4.5', {
      client: makeClient({
        chunks: textChunks,
        onBody: (b) => {
          body = b;
        },
      }),
    });
    const ev = await collect(
      p.generate(reqGen({ effort: 'high', messages: [{ role: 'user', content: 'hi' }] })),
    );
    expect(ev.map((e) => e.kind)).toEqual(['start', 'text_delta', 'usage', 'stop']);
    expect(body.model).toBe('grok-4.5');
    expect(body.stream).toBe(true);
    expect(body.max_completion_tokens).toBe(512);
    expect('max_tokens' in body).toBe(false);
    expect(body.stream_options).toEqual({ include_usage: true });
    // Flat field (Chat Completions shape), NOT OpenRouter's nested `reasoning`.
    expect(body.reasoning_effort).toBe('high');
    expect('reasoning' in body).toBe(false);
  });

  test('effort xhigh/max clamp to high (grok has no xhigh/none)', async () => {
    const run = async (effort: NonNullable<GenerateRequest['effort']>): Promise<Body> => {
      let body: Body = {};
      const p = createXaiProvider('grok-4.5', {
        client: makeClient({
          chunks: textChunks,
          onBody: (b) => {
            body = b;
          },
        }),
      });
      await collect(p.generate(reqGen({ effort, messages: [{ role: 'user', content: 'x' }] })));
      return body;
    };
    expect((await run('xhigh')).reasoning_effort).toBe('high');
    expect((await run('max')).reasoning_effort).toBe('high');
    expect((await run('low')).reasoning_effort).toBe('low');
  });

  test('thinking_budget:0 does NOT force a reasoning_effort (grok-4.5 cannot disable reasoning)', async () => {
    let body: Body = {};
    const p = createXaiProvider('grok-4.5', {
      client: makeClient({
        chunks: textChunks,
        onBody: (b) => {
          body = b;
        },
      }),
    });
    await collect(
      p.generate(reqGen({ thinking_budget: 0, messages: [{ role: 'user', content: 'x' }] })),
    );
    expect('reasoning_effort' in body).toBe(false);
  });

  test('stop_sequences are NOT sent to a reasoning model (xAI rejects stop there)', async () => {
    let body: Body = {};
    const p = createXaiProvider('grok-4.5', {
      client: makeClient({
        chunks: textChunks,
        onBody: (b) => {
          body = b;
        },
      }),
    });
    await collect(
      p.generate(reqGen({ stop_sequences: ['END'], messages: [{ role: 'user', content: 'x' }] })),
    );
    expect('stop' in body).toBe(false);
  });

  test('stop_sequences ARE sent for a non-reasoning model', async () => {
    let body: Body = {};
    const nonReasoning: ProviderCapabilities = {
      tools: 'native',
      cache: false,
      vision: false,
      streaming: true,
      constrained: 'tools',
      context_window: 131_072,
      output_max_tokens: 16_384,
      cost_per_1k_input: 0.1,
      cost_per_1k_output: 0.3,
      notes: ['synthetic non-reasoning grok for the stop-gating test'],
    };
    const p = createXaiProvider('grok-mini', {
      capabilities: nonReasoning,
      client: makeClient({
        chunks: textChunks,
        onBody: (b) => {
          body = b;
        },
      }),
    });
    await collect(
      p.generate(reqGen({ stop_sequences: ['END'], messages: [{ role: 'user', content: 'x' }] })),
    );
    expect(body.stop).toEqual(['END']);
    // Non-reasoning model must NOT get reasoning_effort even with effort set.
    await collect(
      p.generate(reqGen({ effort: 'high', messages: [{ role: 'user', content: 'x' }] })),
    );
    expect('reasoning_effort' in body).toBe(false);
  });

  test('forwards system + tools (OpenAI-shape)', async () => {
    let body: Body = {};
    const p = createXaiProvider('grok-4.5', {
      client: makeClient({
        chunks: textChunks,
        onBody: (b) => {
          body = b;
        },
      }),
    });
    await collect(
      p.generate(
        reqGen({
          system: 'you are terse',
          tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
          messages: [{ role: 'user', content: 'x' }],
        }),
      ),
    );
    expect((body.messages as Body[])[0]).toEqual({ role: 'system', content: 'you are terse' });
    expect(body.tools[0]).toEqual({
      type: 'function',
      function: { name: 't', description: 'd', parameters: { type: 'object' } },
    });
  });

  test('temperature/top_p forwarded (grok accepts sampling)', async () => {
    let body: Body = {};
    const p = createXaiProvider('grok-4.5', {
      client: makeClient({
        chunks: textChunks,
        onBody: (b) => {
          body = b;
        },
      }),
    });
    await collect(
      p.generate(
        reqGen({ temperature: 0.3, top_p: 0.9, messages: [{ role: 'user', content: 'x' }] }),
      ),
    );
    expect(body.temperature).toBe(0.3);
    expect(body.top_p).toBe(0.9);
  });

  test('sends x-grok-conv-id, stable across a session (sticky prompt-cache routing)', async () => {
    const capture = async (over: Partial<GenerateRequest>): Promise<Body | undefined> => {
      let options: Body | undefined;
      const p = createXaiProvider('grok-4.5', {
        client: makeClient({
          chunks: textChunks,
          onOptions: (o) => {
            options = o;
          },
        }),
      });
      await collect(
        p.generate(
          reqGen({
            system: 'you are terse',
            tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
            ...over,
          }),
        ),
      );
      return options;
    };
    // Turn 1 and a later turn (same system+tools, an appended message) must carry
    // the SAME conv-id so both route to the cache-warm server.
    const o1 = await capture({ messages: [{ role: 'user', content: 'first' }] });
    const o2 = await capture({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' },
      ],
    });
    const id1 = o1?.headers?.['x-grok-conv-id'] as string | undefined;
    const id2 = o2?.headers?.['x-grok-conv-id'] as string | undefined;
    expect(typeof id1).toBe('string');
    expect((id1 ?? '').length).toBeGreaterThan(0);
    expect(id2).toBe(id1);
    // A different system prefix → a different conv-id (distinct cache bucket).
    const o3 = await capture({
      system: 'different',
      messages: [{ role: 'user', content: 'first' }],
    });
    expect(o3?.headers?.['x-grok-conv-id']).not.toBe(id1);
  });

  test('x-grok-conv-id is NOT sent when a custom base_url (proxy) is pinned', async () => {
    let options: Body | undefined = { sentinel: true };
    const p = createXaiProvider('grok-4.5', {
      baseURL: 'https://proxy.internal/v1',
      client: makeClient({
        chunks: textChunks,
        onOptions: (o) => {
          options = o;
        },
      }),
    });
    await collect(p.generate(reqGen({ messages: [{ role: 'user', content: 'x' }] })));
    // convIdOptions returns undefined off the real api.x.ai path → create called
    // with no request options.
    expect(options).toBeUndefined();
  });

  test('x-grok-conv-id IS sent when base_url is the canonical api.x.ai (trailing slash ignored)', async () => {
    const headerFor = async (baseURL: string): Promise<unknown> => {
      let options: Body | undefined;
      const p = createXaiProvider('grok-4.5', {
        baseURL,
        client: makeClient({
          chunks: textChunks,
          onOptions: (o) => {
            options = o;
          },
        }),
      });
      await collect(
        p.generate(reqGen({ system: 's', messages: [{ role: 'user', content: 'x' }] })),
      );
      return options?.headers?.['x-grok-conv-id'];
    };
    // Pinning the real endpoint in the catalog must NOT lose sticky cache routing.
    expect(typeof (await headerFor('https://api.x.ai/v1'))).toBe('string');
    expect(typeof (await headerFor('https://api.x.ai/v1/'))).toBe('string');
  });

  test('generateConstrained forces a schema tool and returns output + usage', async () => {
    let body: Body = {};
    const p = createXaiProvider('grok-4.5', {
      client: makeClient({
        onBody: (b) => {
          body = b;
        },
        response: {
          choices: [
            { message: { tool_calls: [{ function: { name: 'out', arguments: '{"ok":true}' } }] } },
          ],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 3,
            prompt_tokens_details: { cached_tokens: 2 },
          },
        },
      }),
    });
    const out = await p.generateConstrained(reqCon({ messages: [{ role: 'user', content: 'x' }] }));
    expect(out.output).toBe('{"ok":true}');
    expect(out.usage).toEqual({ input: 5, output: 3, cache_read: 2, cache_creation: 0 });
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'out' } });
    expect(body.max_completion_tokens).toBe(512);
    expect('stream' in body).toBe(false);
  });

  test('generateConstrained adds reasoning_tokens to output (billed separately)', async () => {
    const p = createXaiProvider('grok-4.5', {
      client: makeClient({
        response: {
          choices: [
            { message: { tool_calls: [{ function: { name: 'out', arguments: '{"ok":true}' } }] } },
          ],
          usage: {
            prompt_tokens: 50,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 10 },
            completion_tokens_details: { reasoning_tokens: 120 },
          },
        },
      }),
    });
    const out = await p.generateConstrained(reqCon({ messages: [{ role: 'user', content: 'x' }] }));
    // output = completion (4) + reasoning (120) = 124; input = 50 - 10.
    expect(out.usage).toEqual({ input: 40, output: 124, cache_read: 10, cache_creation: 0 });
  });

  test('generateConstrained rejects caller tools', async () => {
    const p = createXaiProvider('grok-4.5', { client: makeClient({}) });
    await expect(
      p.generateConstrained(
        reqCon({ tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }] }),
      ),
    ).rejects.toThrow(/must be empty/);
  });

  test('generateConstrained throws (naming finish_reason) when the forced tool_call is absent', async () => {
    const p = createXaiProvider('grok-4.5', {
      client: makeClient({
        // Model ran out of budget before emitting the forced tool call.
        response: { choices: [{ finish_reason: 'length', message: { tool_calls: [] } }] },
      }),
    });
    await expect(
      p.generateConstrained(reqCon({ messages: [{ role: 'user', content: 'x' }] })),
    ).rejects.toThrow(/no tool_call for forced tool 'out' \(finish_reason=length\)/);
  });

  test('includeUsage:false omits stream_options (param-strict proxy escape hatch)', async () => {
    let body: Body = {};
    const p = createXaiProvider('grok-4.5', {
      includeUsage: false,
      client: makeClient({
        chunks: textChunks,
        onBody: (b) => {
          body = b;
        },
      }),
    });
    await collect(p.generate(reqGen({ messages: [{ role: 'user', content: 'x' }] })));
    expect('stream_options' in body).toBe(false);
  });

  test('countTokens returns a positive estimate', async () => {
    const p = createXaiProvider('grok-4.5', { client: makeClient({}) });
    const n = await p.countTokens([{ role: 'user', content: 'hello world this is a test' }]);
    expect(n).toBeGreaterThan(0);
  });
});
