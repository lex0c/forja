import { describe, expect, test } from 'bun:test';
import {
  type OllamaChatRequest,
  type OllamaHttpError,
  createOllamaHttp,
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
