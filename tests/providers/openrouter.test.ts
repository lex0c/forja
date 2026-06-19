import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { createOpenRouterProvider } from '../../src/providers/openrouter/index.ts';
import type { RawORChunk } from '../../src/providers/openrouter/stream.ts';
import type {
  ConstrainedRequest,
  GenerateRequest,
  ProviderMessage,
  StreamEvent,
} from '../../src/providers/types.ts';

// biome-ignore lint/suspicious/noExplicitAny: test mock body is dynamic.
type Body = Record<string, any>;

// Mock SDK client: captures the request body; returns an async-iterable of
// chunks for streaming calls (`stream:true`), or a plain response object for
// the non-streaming constrained call.
const makeClient = (opts: {
  chunks?: RawORChunk[];
  response?: unknown;
  onBody?: (b: Body) => void;
}): OpenAI =>
  ({
    chat: {
      completions: {
        create: async (body: Body) => {
          opts.onBody?.(body);
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
  model: 'deepseek/deepseek-v3.2',
  messages: [],
  max_tokens: 512,
  ...over,
});

const reqCon = (over: Partial<ConstrainedRequest>): ConstrainedRequest => ({
  model: 'deepseek/deepseek-v3.2',
  messages: [],
  max_tokens: 512,
  output_schema: { type: 'object' },
  output_schema_name: 'out',
  ...over,
});

const textChunks: RawORChunk[] = [
  { id: 'm1', choices: [{ delta: { content: 'hi' } }] },
  {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  },
];

describe('createOpenRouterProvider', () => {
  test('throws on an uncatalogued model', () => {
    expect(() => createOpenRouterProvider('nope/nope', { client: makeClient({}) })).toThrow(
      /unknown OpenRouter model/,
    );
  });

  test('throws without an api key or client', () => {
    expect(() => createOpenRouterProvider('deepseek/deepseek-v3.2')).toThrow(/API key required/);
  });

  test('id carries two slashes; family + native tools', () => {
    const p = createOpenRouterProvider('deepseek/deepseek-v3.2', { client: makeClient({}) });
    expect(p.id).toBe('openrouter/deepseek/deepseek-v3.2');
    expect(p.family).toBe('openrouter');
    expect(p.capabilities.tools).toBe('native');
  });

  test('generate body: stream + max_tokens + transforms:[] + reasoning + usage:{include}, no stream_options', async () => {
    let body: Body = {};
    const p = createOpenRouterProvider('deepseek/deepseek-v3.2', {
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
    expect(body.model).toBe('deepseek/deepseek-v3.2');
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(512);
    expect(body.transforms).toEqual([]);
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.usage).toEqual({ include: true });
    expect('stream_options' in body).toBe(false);
    expect('max_completion_tokens' in body).toBe(false);
  });

  test('reasoning-only assistant turn is dropped (invalid OpenAI-shape message)', async () => {
    let body: Body = {};
    const p = createOpenRouterProvider('deepseek/deepseek-v3.2', {
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
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'reasoning', provider: 'openrouter', data: [{ text: 'r' }] }],
            },
          ],
        }),
      ),
    );
    expect((body.messages as Body[]).find((m) => m.role === 'assistant')).toBeUndefined();
  });

  test('reasoning omitted on a non-reasoning model even with effort', async () => {
    let body: Body = {};
    const p = createOpenRouterProvider('meta-llama/llama-3.3-70b-instruct', {
      client: makeClient({
        chunks: textChunks,
        onBody: (b) => {
          body = b;
        },
      }),
    });
    await collect(
      p.generate(reqGen({ effort: 'high', messages: [{ role: 'user', content: 'x' }] })),
    );
    expect('reasoning' in body).toBe(false);
  });

  test('forwards tools (OpenAI-shape)', async () => {
    let body: Body = {};
    const p = createOpenRouterProvider('deepseek/deepseek-v3.2', {
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
          tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
          messages: [{ role: 'user', content: 'x' }],
        }),
      ),
    );
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools[0]).toEqual({
      type: 'function',
      function: { name: 't', description: 'd', parameters: { type: 'object' } },
    });
  });

  test('explicit-cache model (qwen) sends system as blocks with cache_control on breakpoints', async () => {
    let body: Body = {};
    const p = createOpenRouterProvider('qwen/qwen3-coder-plus', {
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
          system: 'stable\n\nmem',
          systemSegments: [
            { id: 'stable', text: 'stable', cacheBreakpoint: true },
            { id: 'memory', text: 'mem', cacheBreakpoint: true },
          ],
          messages: [{ role: 'user', content: 'x' }],
        }),
      ),
    );
    const sys = (body.messages as Body[])[0];
    expect(sys).toEqual({
      role: 'system',
      content: [
        { type: 'text', text: 'stable\n\n', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'mem', cache_control: { type: 'ephemeral' } },
      ],
    });
    // Concatenating the block texts reproduces the canonical system string
    // (matches flattenSystemSegments and the recorded prompt hash).
    expect((sys?.content as Array<{ text: string }>).map((b) => b.text).join('')).toBe(
      'stable\n\nmem',
    );
  });

  test('non-explicit-cache model keeps a flat string system (no cache_control)', async () => {
    let body: Body = {};
    const p = createOpenRouterProvider('deepseek/deepseek-v3.2', {
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
          system: 'sys',
          systemSegments: [{ id: 'stable', text: 'sys', cacheBreakpoint: true }],
          messages: [{ role: 'user', content: 'x' }],
        }),
      ),
    );
    expect((body.messages as Body[])[0]).toEqual({ role: 'system', content: 'sys' });
  });

  test('thinking_budget 0 disables reasoning via effort:none', async () => {
    let body: Body = {};
    const p = createOpenRouterProvider('deepseek/deepseek-v3.2', {
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
    expect(body.reasoning).toEqual({ effort: 'none' });
  });

  test('reasoning_details replay: round-trips the captured block onto the assistant message', async () => {
    let body: Body = {};
    const p = createOpenRouterProvider('deepseek/deepseek-v3.2', {
      client: makeClient({
        chunks: textChunks,
        onBody: (b) => {
          body = b;
        },
      }),
    });
    const messages: ProviderMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking done' },
          {
            type: 'reasoning',
            provider: 'openrouter',
            data: [{ type: 'reasoning.text', text: 'r' }],
          },
        ],
      },
    ];
    await collect(p.generate(reqGen({ messages })));
    const assistant = (body.messages as Body[]).find((m) => m.role === 'assistant');
    expect(assistant?.reasoning_details).toEqual([{ type: 'reasoning.text', text: 'r' }]);
  });

  test('reasoning replay OFF drops the block (FORJA_OPENROUTER_REASONING_REPLAY=0)', async () => {
    const saved = process.env.FORJA_OPENROUTER_REASONING_REPLAY;
    process.env.FORJA_OPENROUTER_REASONING_REPLAY = '0';
    try {
      let body: Body = {};
      const p = createOpenRouterProvider('deepseek/deepseek-v3.2', {
        client: makeClient({
          chunks: textChunks,
          onBody: (b) => {
            body = b;
          },
        }),
      });
      expect(p.replaysReasoning).toBe(false);
      await collect(
        p.generate(
          reqGen({
            messages: [
              {
                role: 'assistant',
                content: [
                  { type: 'text', text: 'x' },
                  { type: 'reasoning', provider: 'openrouter', data: [{ text: 'r' }] },
                ],
              },
            ],
          }),
        ),
      );
      const assistant = (body.messages as Body[]).find((m) => m.role === 'assistant');
      expect('reasoning_details' in (assistant ?? {})).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.FORJA_OPENROUTER_REASONING_REPLAY;
      else process.env.FORJA_OPENROUTER_REASONING_REPLAY = saved;
    }
  });

  test('generateConstrained forces a schema tool and returns output + usage', async () => {
    let body: Body = {};
    const p = createOpenRouterProvider('deepseek/deepseek-v3.2', {
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
    expect('stream' in body).toBe(false);
  });

  test('generateConstrained rejects caller tools', async () => {
    const p = createOpenRouterProvider('deepseek/deepseek-v3.2', { client: makeClient({}) });
    await expect(
      p.generateConstrained(
        reqCon({ tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }] }),
      ),
    ).rejects.toThrow(/must be empty/);
  });

  test('countTokens returns a positive estimate', async () => {
    const p = createOpenRouterProvider('deepseek/deepseek-v3.2', { client: makeClient({}) });
    const n = await p.countTokens([{ role: 'user', content: 'hello world this is a test' }]);
    expect(n).toBeGreaterThan(0);
  });
});
