import { describe, expect, test } from 'bun:test';
import {
  createOllamaHttp,
  type OllamaChatRequest,
  type OllamaChatResponse,
  type OllamaHttpError,
} from '../../src/providers/ollama/http.ts';

const REQ: OllamaChatRequest = {
  model: 'qwen2.5-coder:14b',
  messages: [{ role: 'user', content: 'hi' }],
};

const OK_BODY =
  '{"model":"qwen2.5-coder:14b","created_at":"2026-01-01T00:00:00Z","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}';

// A fetch double that records each call and returns whatever `impl` produces
// (a Response, or a thrown error to simulate connection failure / abort).
const mockFetch = (impl: (url: string, init: RequestInit) => Response) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push({ url: u, init: init ?? {} });
    return impl(u, init ?? {});
  }) as unknown as typeof fetch;
  return { fn, calls };
};

// Build a streamed Response from raw byte segments (each `seg` is enqueued as one
// read, so a JSON line can be split across segments to exercise buffering).
const streamResponse = (segments: string[], status = 200): Response => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const s of segments) {
        controller.enqueue(encoder.encode(s));
      }
      controller.close();
    },
  });
  return new Response(body, { status });
};

const collectChunks = async (
  it: AsyncIterable<OllamaChatResponse>,
): Promise<OllamaChatResponse[]> => {
  const out: OllamaChatResponse[] = [];
  for await (const c of it) {
    out.push(c);
  }
  return out;
};

describe('createOllamaHttp', () => {
  test('POSTs to /api/chat with stream:false and returns the parsed response', async () => {
    const body = {
      model: 'qwen2.5-coder:14b',
      created_at: '2026-01-01T00:00:00Z',
      message: { role: 'assistant', content: 'hello' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 10,
      eval_count: 3,
    };
    const { fn, calls } = mockFetch(() => new Response(JSON.stringify(body), { status: 200 }));
    const http = createOllamaHttp({ baseUrl: 'http://localhost:11434', fetch: fn });

    const res = await http.chat(REQ);

    expect(res.message.content).toBe('hello');
    expect(res.prompt_eval_count).toBe(10);
    expect(res.eval_count).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://localhost:11434/api/chat');
    expect(calls[0]?.init.method).toBe('POST');
    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent.stream).toBe(false);
    expect(sent.model).toBe('qwen2.5-coder:14b');
  });

  test('strips trailing slashes from baseUrl', async () => {
    const { fn, calls } = mockFetch(() => new Response(OK_BODY, { status: 200 }));
    const http = createOllamaHttp({ baseUrl: 'http://host:11434///', fetch: fn });
    await http.chat(REQ);
    expect(calls[0]?.url).toBe('http://host:11434/api/chat');
  });

  test('sends content-type plus custom headers', async () => {
    const { fn, calls } = mockFetch(() => new Response(OK_BODY, { status: 200 }));
    const http = createOllamaHttp({ fetch: fn, headers: { authorization: 'Bearer x' } });
    await http.chat(REQ);
    const h = calls[0]?.init.headers as Record<string, string>;
    expect(h['content-type']).toBe('application/json');
    expect(h.authorization).toBe('Bearer x');
  });

  test('404 → local.model.not_loaded, not retryable, with a pull hint', async () => {
    const { fn } = mockFetch(() => new Response('model not found', { status: 404 }));
    const http = createOllamaHttp({ fetch: fn });

    let caught: OllamaHttpError | undefined;
    try {
      await http.chat(REQ);
    } catch (e) {
      caught = e as OllamaHttpError;
    }
    expect(caught?.code).toBe('local.model.not_loaded');
    expect(caught?.retryable).toBe(false);
    expect(caught?.status).toBe(404);
    expect(caught?.message).toContain('ollama pull qwen2.5-coder:14b');
  });

  test('5xx → local.http_error, retryable', async () => {
    const { fn } = mockFetch(() => new Response('boom', { status: 500 }));
    const http = createOllamaHttp({ fetch: fn });
    await expect(http.chat(REQ)).rejects.toMatchObject({
      code: 'local.http_error',
      retryable: true,
      status: 500,
    });
  });

  test('connection failure → local.daemon.unavailable with a serve hint', async () => {
    const { fn } = mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const http = createOllamaHttp({ fetch: fn, baseUrl: 'http://localhost:11434' });

    let caught: OllamaHttpError | undefined;
    try {
      await http.chat(REQ);
    } catch (e) {
      caught = e as OllamaHttpError;
    }
    expect(caught?.code).toBe('local.daemon.unavailable');
    expect(caught?.message).toContain('ollama serve');
  });

  test('abort propagates as AbortError, not masked as a daemon error', async () => {
    const { fn } = mockFetch(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const http = createOllamaHttp({ fetch: fn });
    await expect(http.chat(REQ)).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('200 with a malformed body (no message) → local.http_error', async () => {
    const { fn } = mockFetch(() => new Response('{"done":true}', { status: 200 }));
    const http = createOllamaHttp({ fetch: fn });
    await expect(http.chat(REQ)).rejects.toMatchObject({ code: 'local.http_error' });
  });
});

describe('chatStream', () => {
  test('yields one chunk per NDJSON line', async () => {
    const lines = [
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"he"},"done":false}\n',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"llo"},"done":true,"done_reason":"stop","eval_count":2}\n',
    ];
    const { fn } = mockFetch(() => streamResponse(lines));
    const http = createOllamaHttp({ fetch: fn });
    const chunks = await collectChunks(http.chatStream(REQ));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.message.content).toBe('he');
    expect(chunks[1]?.message.content).toBe('llo');
    expect(chunks[1]?.done).toBe(true);
  });

  test('sends stream:true', async () => {
    const { fn, calls } = mockFetch(() => streamResponse([OK_BODY, '\n']));
    const http = createOllamaHttp({ fetch: fn });
    await collectChunks(http.chatStream(REQ));
    expect(JSON.parse(String(calls[0]?.init.body)).stream).toBe(true);
  });

  test('buffers a JSON line split across reads', async () => {
    const reads = [
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"hel',
      'lo"},"done":false}\n{"model":"m","created_at":"t","message":{"role":"assistant","content":"!"},"done":true}\n',
    ];
    const { fn } = mockFetch(() => streamResponse(reads));
    const http = createOllamaHttp({ fetch: fn });
    const chunks = await collectChunks(http.chatStream(REQ));
    expect(chunks.map((c) => c.message.content)).toEqual(['hello', '!']);
  });

  test('parses a final line with no trailing newline', async () => {
    const { fn } = mockFetch(() =>
      streamResponse([
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"x"},"done":true}',
      ]),
    );
    const http = createOllamaHttp({ fetch: fn });
    const chunks = await collectChunks(http.chatStream(REQ));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.message.content).toBe('x');
  });

  test('a null JSON line → local.http_error (no opaque deref)', async () => {
    const { fn } = mockFetch(() => streamResponse(['null\n']));
    const http = createOllamaHttp({ fetch: fn });
    await expect(collectChunks(http.chatStream(REQ))).rejects.toMatchObject({
      code: 'local.http_error',
    });
  });

  test('throws a typed error on a stream error chunk', async () => {
    const { fn } = mockFetch(() => streamResponse(['{"error":"model runner crashed"}\n']));
    const http = createOllamaHttp({ fetch: fn });
    await expect(collectChunks(http.chatStream(REQ))).rejects.toMatchObject({
      code: 'local.http_error',
    });
  });

  test('abandoning the stream cancels the body reader (best-effort abort)', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            '{"model":"m","created_at":"t","message":{"role":"assistant","content":"a"},"done":false}\n',
          ),
        );
        // intentionally left open — simulates an in-flight generation
      },
      cancel() {
        cancelled = true;
      },
    });
    const fn = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const http = createOllamaHttp({ fetch: fn });
    for await (const chunk of http.chatStream(REQ)) {
      expect(chunk.message.content).toBe('a');
      break; // abandon after the first chunk
    }
    expect(cancelled).toBe(true);
  });
});
