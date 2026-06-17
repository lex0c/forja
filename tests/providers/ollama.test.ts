import { describe, expect, test } from 'bun:test';
import { generateWithRetry } from '../../src/harness/retry.ts';
import type { OllamaChatResponse } from '../../src/providers/ollama/http.ts';
import { createOllamaProvider, parseOllamaHeaders } from '../../src/providers/ollama/index.ts';
import type {
  ConstrainedRequest,
  GenerateRequest,
  StreamEvent,
} from '../../src/providers/types.ts';

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of it) {
    out.push(e);
  }
  return out;
};

const okResponse = (over: Partial<OllamaChatResponse> = {}): Response =>
  new Response(
    JSON.stringify({
      model: 'qwen2.5-coder:14b',
      created_at: '2026-01-01T00:00:00Z',
      message: { role: 'assistant', content: 'hi' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 5,
      eval_count: 2,
      ...over,
    }),
    { status: 200 },
  );

// fetch double: records each request body, returns a fresh Response per call.
const recordingFetch = (make: () => Response) => {
  const bodies: Array<Record<string, unknown>> = [];
  const fn = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return make();
  }) as unknown as typeof fetch;
  return { fn, bodies };
};

const reqGen = (over: Partial<GenerateRequest>): GenerateRequest => ({
  model: 'qwen2.5-coder:14b',
  messages: [],
  max_tokens: 512,
  ...over,
});

const reqCon = (over: Partial<ConstrainedRequest>): ConstrainedRequest => ({
  model: 'qwen2.5-coder:14b',
  messages: [],
  max_tokens: 512,
  output_schema: { type: 'object' },
  output_schema_name: 'out',
  ...over,
});

describe('parseOllamaHeaders', () => {
  test('parses a JSON object of string headers', () => {
    expect(parseOllamaHeaders('{"Authorization":"Bearer x","X-Foo":"y"}')).toEqual({
      Authorization: 'Bearer x',
      'X-Foo': 'y',
    });
  });
  test('undefined for empty / absent / invalid / non-object', () => {
    expect(parseOllamaHeaders(undefined)).toBeUndefined();
    expect(parseOllamaHeaders('')).toBeUndefined();
    expect(parseOllamaHeaders('not json')).toBeUndefined();
    expect(parseOllamaHeaders('["a","b"]')).toBeUndefined();
    expect(parseOllamaHeaders('{}')).toBeUndefined();
  });
  test('drops non-string values', () => {
    expect(parseOllamaHeaders('{"a":"x","b":3,"c":null}')).toEqual({ a: 'x' });
  });
});

describe('createOllamaProvider', () => {
  test('throws on an uncatalogued model', () => {
    expect(() => createOllamaProvider('nope:1b')).toThrow(/unknown Ollama model/);
  });

  test('exposes id, family, native tools, and replaysReasoning=false', () => {
    const p = createOllamaProvider('qwen2.5-coder:14b', { fetch: recordingFetch(okResponse).fn });
    expect(p.id).toBe('ollama/qwen2.5-coder:14b');
    expect(p.family).toBe('ollama');
    expect(p.capabilities.tools).toBe('native');
    expect(p.replaysReasoning).toBe(false);
  });

  test('generate sends num_ctx + stream:true and yields normalized events', async () => {
    const { fn, bodies } = recordingFetch(() =>
      okResponse({ message: { role: 'assistant', content: 'hello' } }),
    );
    const p = createOllamaProvider('qwen2.5-coder:14b', { fetch: fn });
    const ev = await collect(
      p.generate(reqGen({ system: 'sys', messages: [{ role: 'user', content: 'hi' }] })),
    );
    expect(ev.map((e) => e.kind)).toEqual(['start', 'text_delta', 'usage', 'stop']);

    const body = bodies[0] as Record<string, unknown>;
    expect(body.model).toBe('qwen2.5-coder:14b');
    expect(body.stream).toBe(true);
    expect((body.options as Record<string, unknown>).num_ctx).toBe(32_768);
    expect((body.messages as Array<Record<string, unknown>>)[0]).toEqual({
      role: 'system',
      content: 'sys',
    });
  });

  test('generate forwards tools and think for a thinking model', async () => {
    const { fn, bodies } = recordingFetch(okResponse);
    const p = createOllamaProvider('qwen3:8b', { fetch: fn });
    await collect(
      p.generate(
        reqGen({
          effort: 'high',
          tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
          messages: [{ role: 'user', content: 'x' }],
        }),
      ),
    );
    const body = bodies[0] as Record<string, unknown>;
    expect(body.think).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true);
  });

  test('generate forwards keep_alive from the option', async () => {
    const { fn, bodies } = recordingFetch(okResponse);
    const p = createOllamaProvider('qwen2.5-coder:14b', { fetch: fn, keepAlive: '-1' });
    await collect(p.generate(reqGen({ messages: [{ role: 'user', content: 'x' }] })));
    expect((bodies[0] as Record<string, unknown>).keep_alive).toBe('-1');
  });

  test('no keep_alive by default (Ollama default applies)', async () => {
    const { fn, bodies } = recordingFetch(okResponse);
    const p = createOllamaProvider('qwen2.5-coder:14b', { fetch: fn });
    await collect(p.generate(reqGen({ messages: [{ role: 'user', content: 'x' }] })));
    expect('keep_alive' in (bodies[0] as Record<string, unknown>)).toBe(false);
  });

  test('generate surfaces tool calls from the response', async () => {
    const { fn } = recordingFetch(() =>
      okResponse({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a' } } }],
        },
      }),
    );
    const p = createOllamaProvider('qwen2.5-coder:14b', { fetch: fn });
    const ev = await collect(p.generate(reqGen({ messages: [{ role: 'user', content: 'x' }] })));
    expect(ev.some((e) => e.kind === 'tool_use_stop')).toBe(true);
  });

  test('generate propagates http errors (404 → not_loaded)', async () => {
    const fn = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    const p = createOllamaProvider('qwen2.5-coder:14b', { fetch: fn });
    await expect(
      collect(p.generate(reqGen({ messages: [{ role: 'user', content: 'x' }] }))),
    ).rejects.toMatchObject({ code: 'local.model.not_loaded' });
  });

  test('a transient 5xx is retried by generateWithRetry (status-based)', async () => {
    let calls = 0;
    const fn = (async () => {
      calls += 1;
      return calls === 1
        ? new Response('overloaded', { status: 503 })
        : okResponse({ message: { role: 'assistant', content: 'ok' } });
    }) as unknown as typeof fetch;
    const p = createOllamaProvider('qwen2.5-coder:14b', { fetch: fn });
    const ev = await collect(
      generateWithRetry(p, reqGen({ messages: [{ role: 'user', content: 'x' }] }), {
        maxAttempts: 3,
        baseDelayMs: 1,
        sleep: () => Promise.resolve(),
      }),
    );
    expect(calls).toBe(2);
    expect(ev.some((e) => e.kind === 'text_delta' && e.text === 'ok')).toBe(true);
  });

  test('generateConstrained sets format and returns output + usage', async () => {
    const { fn, bodies } = recordingFetch(() =>
      okResponse({
        message: { role: 'assistant', content: '{"ok":true}' },
        prompt_eval_count: 7,
        eval_count: 3,
      }),
    );
    const p = createOllamaProvider('qwen2.5-coder:14b', { fetch: fn });
    const out = await p.generateConstrained(
      reqCon({ messages: [{ role: 'user', content: 'x' }], output_schema: { type: 'object' } }),
    );
    expect(out.output).toBe('{"ok":true}');
    expect(out.usage).toEqual({ input: 7, output: 3, cache_read: 0, cache_creation: 0 });
    expect((bodies[0] as Record<string, unknown>).format).toEqual({ type: 'object' });
  });

  test('generateConstrained rejects caller tools', async () => {
    const p = createOllamaProvider('qwen2.5-coder:14b', { fetch: recordingFetch(okResponse).fn });
    await expect(
      p.generateConstrained(
        reqCon({ tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }] }),
      ),
    ).rejects.toThrow(/must be empty/);
  });

  test('generateConstrained throws on length-truncated output', async () => {
    const { fn } = recordingFetch(() =>
      okResponse({ message: { role: 'assistant', content: '{"partial":' }, done_reason: 'length' }),
    );
    const p = createOllamaProvider('qwen2.5-coder:14b', { fetch: fn });
    await expect(p.generateConstrained(reqCon({}))).rejects.toThrow(/truncated/);
  });

  test('generateConstrained throws on empty content', async () => {
    const { fn } = recordingFetch(() =>
      okResponse({ message: { role: 'assistant', content: '' } }),
    );
    const p = createOllamaProvider('qwen2.5-coder:14b', { fetch: fn });
    await expect(p.generateConstrained(reqCon({}))).rejects.toThrow(/empty content/);
  });

  test('keep_alive from FORJA_OLLAMA_KEEP_ALIVE coerces a bare integer to a number', async () => {
    const saved = process.env.FORJA_OLLAMA_KEEP_ALIVE;
    process.env.FORJA_OLLAMA_KEEP_ALIVE = '300';
    try {
      const { fn, bodies } = recordingFetch(okResponse);
      const p = createOllamaProvider('qwen2.5-coder:14b', { fetch: fn });
      await collect(p.generate(reqGen({ messages: [{ role: 'user', content: 'x' }] })));
      expect((bodies[0] as Record<string, unknown>).keep_alive).toBe(300);
    } finally {
      if (saved === undefined) {
        delete process.env.FORJA_OLLAMA_KEEP_ALIVE;
      } else {
        process.env.FORJA_OLLAMA_KEEP_ALIVE = saved;
      }
    }
  });

  test('countTokens returns a positive estimate', async () => {
    const p = createOllamaProvider('qwen2.5-coder:14b', { fetch: recordingFetch(okResponse).fn });
    const n = await p.countTokens([{ role: 'user', content: 'hello world this is a test' }]);
    expect(n).toBeGreaterThan(0);
  });
});
